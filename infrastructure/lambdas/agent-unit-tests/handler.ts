import { AgentRequest, AgentResponse, AgentReport, Finding } from '../shared/types';
import { callClaude, ResponseTruncatedError } from '../shared/llm-client';
import {
  formatFileForReview,
  parseClaudeCodeResponse,
  rejectionToFinding,
  truncationToFinding,
  parseFindingsErrorToFinding,
} from '../shared/git-operations';
import { SYSTEM_PROMPT } from './prompt';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type FindingsParseResult =
  | { status: 'parsed'; findings: Finding[] }
  | { status: 'error'; detail: string };

function parseFindings(text: string): FindingsParseResult {
  const jsonBlockMatch = text.match(/```json\s*\n([\s\S]*?)\n?\s*```/);
  if (jsonBlockMatch) {
    try {
      const parsed = JSON.parse(jsonBlockMatch[1]);
      if (Array.isArray(parsed)) return { status: 'parsed', findings: parsed as Finding[] };
      return { status: 'error', detail: 'json block did not contain an array' };
    } catch (err) {
      return { status: 'error', detail: `json block parse error: ${(err as Error).message}` };
    }
  }
  const arrayMatch = text.match(/\[\s*\{[\s\S]*?"severity"[\s\S]*?\}\s*\]/);
  if (arrayMatch) {
    try {
      return { status: 'parsed', findings: JSON.parse(arrayMatch[0]) as Finding[] };
    } catch (err) {
      return { status: 'error', detail: `fallback array parse error: ${(err as Error).message}` };
    }
  }
  return { status: 'parsed', findings: [] };
}

/**
 * Unit tests agent status: capped at "warn" for normal findings. New generated
 * tests may not pass immediately and always require human review to tune
 * assertions and mocks. But critical findings from the safety gates DO fail
 * the agent — those indicate bad output, not just imperfect tests.
 */
function determineStatus(findings: Finding[]): 'pass' | 'fail' | 'warn' {
  const unfixed = findings.filter((f) => !f.fixed);
  if (unfixed.some((f) => f.severity === 'critical')) return 'fail';
  if (findings.length === 0) return 'pass';
  return 'warn';
}

function detectTestFramework(files: Record<string, string>): string {
  const packageJsonEntry = Object.entries(files).find(([fp]) =>
    fp === 'package.json' || fp.endsWith('/package.json'),
  );

  if (!packageJsonEntry) return 'vitest';

  try {
    const pkg = JSON.parse(packageJsonEntry[1]) as Record<string, unknown>;
    const allDeps = {
      ...((pkg.dependencies as Record<string, string>) ?? {}),
      ...((pkg.devDependencies as Record<string, string>) ?? {}),
    };

    if ('vitest' in allDeps) return 'vitest';
    if ('jest' in allDeps) return 'jest';
  } catch {
    // ignore malformed package.json
  }

  return 'vitest';
}

function partitionFiles(files: Record<string, string>): {
  sourceFiles: Record<string, string>;
  existingTestFiles: Record<string, string>;
} {
  const sourceFiles: Record<string, string> = {};
  const existingTestFiles: Record<string, string> = {};

  for (const [fp, content] of Object.entries(files)) {
    const isTest =
      fp.includes('.test.') ||
      fp.includes('.spec.') ||
      fp.includes('__tests__/') ||
      fp === 'package.json' ||
      fp.endsWith('/package.json');

    if (isTest && fp !== 'package.json' && !fp.endsWith('/package.json')) {
      existingTestFiles[fp] = content;
    } else if (!fp.endsWith('/package.json') && fp !== 'package.json') {
      sourceFiles[fp] = content;
    }
  }

  return { sourceFiles, existingTestFiles };
}

function isTestPath(filepath: string): boolean {
  return (
    filepath.includes('.test.') ||
    filepath.includes('.spec.') ||
    filepath.includes('__tests__/')
  );
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Agent 4 — Unit Tests
 *
 * Detects the test framework from package.json, includes any existing test
 * file contents alongside source files, then asks Claude to generate or
 * augment tests. Status is capped at "warn" since generated tests may need
 * human tuning before they pass.
 *
 * Uses `allowNewFiles: true` because this agent creates brand-new test files
 * that don't exist in event.files. The syntax check still runs on every new
 * file; the shrink / import-export gates are skipped (no original to compare).
 */
export const handler = async (event: AgentRequest): Promise<AgentResponse> => {
  const testFramework = detectTestFramework(event.files);
  const { sourceFiles, existingTestFiles } = partitionFiles(event.files);

  const sourceSections = Object.entries(sourceFiles)
    .map(([fp, content]) => formatFileForReview(fp, content))
    .join('\n\n---\n\n');

  const existingTestSections =
    Object.keys(existingTestFiles).length > 0
      ? `\n\n## Existing Test Files\n\n` +
        Object.entries(existingTestFiles)
          .map(([fp, content]) => formatFileForReview(fp, content))
          .join('\n\n---\n\n')
      : '\n\n## Existing Test Files\nNone found — generate test files from scratch.';

  const frameworkNote = `\n\n## Test Framework\nUse **${testFramework}** for all test files.`;

  const previousReportSection =
    event.previous_reports.length > 0
      ? `\n\n## Previous Agent Reports (fixes already applied)\n\`\`\`json\n${JSON.stringify(event.previous_reports, null, 2)}\n\`\`\``
      : '';

  const userMessage =
    `## Source Files\n\n${sourceSections}` +
    existingTestSections +
    frameworkNote +
    previousReportSection;

  const findings: Finding[] = [];
  const fixedFiles: Record<string, string> = {};
  let inputTokens = 0;
  let outputTokens = 0;

  try {
    const result = await callClaude(SYSTEM_PROMPT, userMessage, 8192);
    inputTokens = result.inputTokens;
    outputTokens = result.outputTokens;

    // Parser runs against existing test files (so test edits can be validated
    // against the original) and allows new paths for brand-new test files.
    const { blocks, rejections } = parseClaudeCodeResponse(
      result.text,
      existingTestFiles,
      { allowNewFiles: true },
    );
    for (const r of rejections) findings.push(rejectionToFinding(r));

    const parsed = parseFindings(result.text);
    if (parsed.status === 'error') {
      findings.push(parseFindingsErrorToFinding(parsed.detail));
    } else {
      findings.push(...parsed.findings);
    }

    for (const block of blocks) {
      if (!isTestPath(block.filepath)) continue;
      const existing = existingTestFiles[block.filepath];
      if (!existing || block.content.trim() !== existing.trim()) {
        fixedFiles[block.filepath] = block.content;
      }
    }
  } catch (err) {
    if (err instanceof ResponseTruncatedError) {
      findings.push(truncationToFinding(Object.keys(sourceFiles), err.message));
      outputTokens = err.outputTokens;
    } else {
      throw err;
    }
  }

  const filesModified = Object.keys(fixedFiles);

  const report: AgentReport = {
    agent: 'agent-unit-tests',
    status: determineStatus(findings),
    timestamp: new Date().toISOString(),
    files_analyzed: Object.keys(sourceFiles),
    files_modified: filesModified,
    findings,
    summary: buildSummary(findings, filesModified, testFramework),
    token_usage: { input_tokens: inputTokens, output_tokens: outputTokens },
  };

  return { report, fixed_files: fixedFiles };
};

function buildSummary(
  findings: Finding[],
  filesModified: string[],
  framework: string,
): string {
  if (filesModified.length === 0 && findings.length === 0) {
    return 'All source files already have adequate test coverage.';
  }
  const parts: string[] = [];
  if (filesModified.length > 0) {
    parts.push(`Generated/updated ${filesModified.length} test file(s) using ${framework}.`);
  }
  if (findings.length > 0) {
    parts.push(`${findings.length} coverage finding(s) reported.`);
  }
  parts.push('Tests require human review before merging.');
  return parts.join(' ');
}
