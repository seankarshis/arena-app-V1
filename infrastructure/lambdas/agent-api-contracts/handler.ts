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

function determineStatus(findings: Finding[]): 'pass' | 'fail' | 'warn' {
  const unfixed = findings.filter((f) => !f.fixed);
  if (unfixed.some((f) => f.severity === 'critical' || f.severity === 'high')) return 'fail';
  if (unfixed.some((f) => f.severity === 'medium')) return 'warn';
  return 'pass';
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Agent 6 — API Contract Validation
 *
 * Comment-only mode: API contract edits can silently break callers across the
 * frontend/backend boundary and need human review.
 */
export const handler = async (event: AgentRequest): Promise<AgentResponse> => {
  const fileSections = Object.entries(event.files)
    .map(([filepath, content]) => formatFileForReview(filepath, content))
    .join('\n\n---\n\n');

  const blastRadiusNote =
    event.blast_radius.length > 0
      ? `\n\n## Full Blast Radius (${event.blast_radius.length} files in scope)\n` +
        event.blast_radius.map((f) => `- ${f}`).join('\n')
      : '';

  const previousReportSection =
    event.previous_reports.length > 0
      ? `\n\n## Previous Agent Reports\n\`\`\`json\n${JSON.stringify(event.previous_reports, null, 2)}\n\`\`\``
      : '';

  const userMessage =
    `## Files to Validate\n\n${fileSections}` +
    blastRadiusNote +
    previousReportSection;

  const findings: Finding[] = [];
  let inputTokens = 0;
  let outputTokens = 0;

  try {
    const result = await callClaude(SYSTEM_PROMPT, userMessage, 8192);
    inputTokens = result.inputTokens;
    outputTokens = result.outputTokens;

    const { rejections } = parseClaudeCodeResponse(result.text, event.files);
    for (const r of rejections) findings.push(rejectionToFinding(r));

    const parsed = parseFindings(result.text);
    if (parsed.status === 'error') {
      findings.push(parseFindingsErrorToFinding(parsed.detail));
    } else {
      findings.push(...parsed.findings);
    }
  } catch (err) {
    if (err instanceof ResponseTruncatedError) {
      findings.push(truncationToFinding(Object.keys(event.files), err.message));
      outputTokens = err.outputTokens;
    } else {
      throw err;
    }
  }

  const report: AgentReport = {
    agent: 'agent-api-contracts',
    status: determineStatus(findings),
    timestamp: new Date().toISOString(),
    files_analyzed: Object.keys(event.files),
    files_modified: [],
    findings,
    summary: buildSummary(findings),
    token_usage: { input_tokens: inputTokens, output_tokens: outputTokens },
  };

  // Comment-only mode: never auto-apply contract edits.
  return { report, fixed_files: {} };
};

function buildSummary(findings: Finding[]): string {
  if (findings.length === 0) return 'No API contract violations found.';
  return `Found ${findings.length} contract issue(s) — comment-only, no auto-fix.`;
}
