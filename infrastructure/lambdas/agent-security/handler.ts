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
 * Receives Bearer CLI SAST results via additional_context.bearer_report.
 * Sends all files plus Bearer output to Claude in a single call for full context.
 */
export const handler = async (event: AgentRequest): Promise<AgentResponse> => {
  const bearerReport = event.additional_context?.bearer_report;

  // Build a single user message that combines all file contents + Bearer output
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

  const { text, inputTokens, outputTokens } = await callClaude(
    SYSTEM_PROMPT,
    userMessage,
    8192, // Security analysis benefits from a larger output budget
  );

  const codeBlocks = parseClaudeCodeResponse(text);
  const findings = parseFindings(text);

  // Map fixed file content back to original filepaths
  const fixedFiles: Record<string, string> = {};
  for (const block of codeBlocks) {
    const originalPath = Object.keys(event.files).find(
      (fp) => fp === block.filepath || fp.endsWith(block.filepath),
    );
    if (originalPath && block.content.trim() !== event.files[originalPath].trim()) {
      fixedFiles[originalPath] = block.content;
    }
  }

  const filesModified = Object.keys(fixedFiles);

  const report: AgentReport = {
    agent: 'agent-security',
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
  if (findings.length === 0) return 'No security issues found.';
  const critical = findings.filter((f) => f.severity === 'critical').length;
  const high = findings.filter((f) => f.severity === 'high').length;
  const fixed = findings.filter((f) => f.fixed).length;
  const unfixed = findings.filter((f) => !f.fixed).length;
  const parts: string[] = [`Found ${findings.length} security finding(s)`];
  if (critical > 0) parts.push(`(${critical} critical, ${high} high)`);
  if (fixed > 0) parts.push(`— fixed ${fixed} in ${filesModified.length} file(s)`);
  if (unfixed > 0) parts.push(`— ${unfixed} require human review`);
  return parts.join(' ') + '.';
}
