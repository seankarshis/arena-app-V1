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
 * Documentation agent status: capped at "warn" for normal findings.
 * Missing docs is informational — it should never block a PR. However,
 * synthetic critical findings from the parser/truncation gates DO block,
 * because they indicate a real safety problem with the output.
 */
function determineStatus(findings: Finding[]): 'pass' | 'fail' | 'warn' {
  const unfixed = findings.filter((f) => !f.fixed);
  if (unfixed.some((f) => f.severity === 'critical')) return 'fail';
  if (unfixed.length > 0) return 'warn';
  return 'pass';
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Agent 5 — Documentation
 *
 * Retains auto-apply under the parser gates. Comment/docblock edits are the
 * lowest-risk auto-apply category because they can't change runtime behavior.
 */
export const handler = async (event: AgentRequest): Promise<AgentResponse> => {
  const fileSections = Object.entries(event.files)
    .map(([filepath, content]) => formatFileForReview(filepath, content))
    .join('\n\n---\n\n');

  const previousReportSection =
    event.previous_reports.length > 0
      ? `\n\n## Previous Agent Reports (for context on what changed)\n\`\`\`json\n${JSON.stringify(event.previous_reports, null, 2)}\n\`\`\``
      : '';

  const userMessage = `## Files to Document\n\n${fileSections}${previousReportSection}`;

  const findings: Finding[] = [];
  const fixedFiles: Record<string, string> = {};
  let inputTokens = 0;
  let outputTokens = 0;

  try {
    const result = await callClaude(SYSTEM_PROMPT, userMessage, 8192);
    inputTokens = result.inputTokens;
    outputTokens = result.outputTokens;

    const { blocks, rejections } = parseClaudeCodeResponse(result.text, event.files);
    for (const r of rejections) findings.push(rejectionToFinding(r));

    const parsed = parseFindings(result.text);
    if (parsed.status === 'error') {
      findings.push(parseFindingsErrorToFinding(parsed.detail));
    } else {
      findings.push(...parsed.findings);
    }

    for (const block of blocks) {
      const original = event.files[block.filepath];
      if (original !== undefined && block.content.trim() !== original.trim()) {
        fixedFiles[block.filepath] = block.content;
      }
    }
  } catch (err) {
    if (err instanceof ResponseTruncatedError) {
      findings.push(truncationToFinding(Object.keys(event.files), err.message));
      outputTokens = err.outputTokens;
    } else {
      throw err;
    }
  }

  const filesModified = Object.keys(fixedFiles);

  const report: AgentReport = {
    agent: 'agent-documentation',
    status: determineStatus(findings),
    timestamp: new Date().toISOString(),
    files_analyzed: Object.keys(event.files),
    files_modified: filesModified,
    findings,
    summary: buildSummary(findings, filesModified),
    token_usage: { input_tokens: inputTokens, output_tokens: outputTokens },
  };

  return { report, fixed_files: fixedFiles };
};

function buildSummary(findings: Finding[], filesModified: string[]): string {
  if (filesModified.length === 0) return 'All files had sufficient documentation.';
  return `Added documentation to ${filesModified.length} file(s). ${findings.length} finding(s) reported.`;
}
