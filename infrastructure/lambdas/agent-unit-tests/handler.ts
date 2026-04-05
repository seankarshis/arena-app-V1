import { AgentRequest, AgentResponse, AgentReport, Finding } from '../shared/types';
import { callClaude } from '../shared/llm-client';
import { formatFileForReview, parseClaudeCodeResponse } from '../shared/git-operations';
import { SYSTEM_PROMPT } from './prompt';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseFindings(text: string): Finding[] {
  const jsonBlockMatch = text.match(/```json\s*\n([\s\S]*?)\n?\s*```/);
  if (jsonBlockMatch) {
    try {
      const parsed = JSON.parse(jsonBlockMatch[1]);
      if (Array.isArray(parsed)) return parsed as Finding[];
    } catch {
      // fall through
    }
  }
  const arrayMatch = text.match(/\[\s*\{[\s\S]*?"severity"[\s\S]*?\}\s*\]/);
  if (arrayMatch) {
    try {
      return JSON.parse(arrayMatch[0]) as Finding[];
    } catch {
      // ignore
    }
  }
  return [];
}

/**
 * Unit tests agent status: capped at "warn" — never "fail".
 * New generated tests may not pass immediately and always require human review
 * to tune assertions and mocks. Blocking on test failures would break CI for
 * every PR that adds new code.
 */
function determineStatus(findings: Finding[]): 'pass' | 'warn' {
  if (findings.length === 0) return 'pass';
  return 'warn';
}

/**
 * Detect the test framework from a package.json string.
 * Returns "vitest" (project default per CLAUDE.md) if the framework cannot
 * be determined.
 */
function detectTestFramework(files: Record<string, string>): string {
  // Look for package.json anywhere in the files map (GitHub Actions step should include it)
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

/**
 * Separate source files from test files and existing test file contents.
 *
 * The GitHub Actions step is expected to include existing test files in the
 * `files` map alongside the source files it wants tested.
 */
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
 */
export const handler = async (event: AgentRequest): Promise<AgentResponse> => {
  const testFramework = detectTestFramework(event.files);
  const { sourceFiles, existingTestFiles } = partitionFiles(event.files);

  // Build the user message with source files, existing tests, and context
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

  const { text, inputTokens, outputTokens } = await callClaude(
    SYSTEM_PROMPT,
    userMessage,
    8192, // Test generation can be verbose
  );

  const codeBlocks = parseClaudeCodeResponse(text);
  const findings = parseFindings(text);

  // Collect generated/updated test files
  const fixedFiles: Record<string, string> = {};
  for (const block of codeBlocks) {
    // Accept test files (new or existing paths)
    const isTestPath =
      block.filepath.includes('.test.') ||
      block.filepath.includes('.spec.') ||
      block.filepath.includes('__tests__/');

    if (isTestPath) {
      // Only store if content differs from the existing test file (if any)
      const existingContent = existingTestFiles[block.filepath];
      if (!existingContent || block.content.trim() !== existingContent.trim()) {
        fixedFiles[block.filepath] = block.content;
      }
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
