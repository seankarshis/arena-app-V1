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
 * Agent 2 — Security
 *
 * Comment-only mode: findings are reported but fixed_files is always empty.
 * Security changes are too load-bearing to auto-apply; humans review every fix.
 */
export const handler = async (event: AgentRequest): Promise<AgentResponse> => {
  const bearerReport = event.additional_context?.bearer_report;

  const fileSections = Object.entries(event.files)
    .map(([filepath, content]) => formatFileForReview(filepath, content))
    .join('\n\n---\n\n');

  const bearerSection = bearerReport
    ? `\n\n## Bearer SAST Scan Results\n\`\`\`json\n${JSON.stringify(bearerReport, null, 2)}\n\`\`\``
    : '\n\n## Bearer SAST Scan Results\nNo Bearer report provided.';

  const previousReportSection =
    event.previous_reports.length > 0
      ? `\n\n## Previous Agent Reports\n\`\`\`json\n${JSON.stringify(event.previous_reports, null, 2)}\n\`\`\``
      : '';

  const userMessage =
    `## Files to Review\n\n${fileSections}` +
    bearerSection +
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
    agent: 'agent-security',
    status: determineStatus(findings),
    timestamp: new Date().toISOString(),
    files_analyzed: Object.keys(event.files),
    files_modified: [],
    findings,
    summary: buildSummary(findings),
    token_usage: { input_tokens: inputTokens, output_tokens: outputTokens },
  };

  // Comment-only mode: never auto-apply security fixes.
  return { report, fixed_files: {} };
};

function buildSummary(findings: Finding[]): string {
  if (findings.length === 0) return 'No security issues found.';
  const critical = findings.filter((f) => f.severity === 'critical').length;
  const high = findings.filter((f) => f.severity === 'high').length;
  const parts: string[] = [`Found ${findings.length} security finding(s)`];
  if (critical > 0 || high > 0) parts.push(`(${critical} critical, ${high} high)`);
  parts.push('— comment-only, no auto-fix');
  return parts.join(' ') + '.';
}
