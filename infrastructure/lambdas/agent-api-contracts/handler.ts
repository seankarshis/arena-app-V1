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
 * Agent 6 — API Contract Validation
 *
 * Receives the full blast-radius file set (frontend + backend) so it can
 * compare API definitions on both sides. Sends all files in a single Claude
 * call for cross-file contract analysis.
 */
export const handler = async (event: AgentRequest): Promise<AgentResponse> => {
  // Include ALL files in scope (not just the changed ones) — contract analysis
  // requires seeing both sides of every API boundary.
  const fileSections = Object.entries(event.files)
    .map(([filepath, content]) => formatFileForReview(filepath, content))
    .join('\n\n---\n\n');

  // Provide the full blast radius list so Claude knows which files are in scope
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

  const { text, inputTokens, outputTokens } = await callClaude(
    SYSTEM_PROMPT,
    userMessage,
    8192,
  );

  const codeBlocks = parseClaudeCodeResponse(text);
  const findings = parseFindings(text);

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
    agent: 'agent-api-contracts',
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
  if (findings.length === 0) return 'No API contract violations found.';
  const fixed = findings.filter((f) => f.fixed).length;
  const needsHuman = findings.filter((f) => !f.fixed).length;
  const parts: string[] = [`Found ${findings.length} contract issue(s).`];
  if (fixed > 0) parts.push(`Auto-fixed ${fixed} in ${filesModified.length} file(s).`);
  if (needsHuman > 0) parts.push(`${needsHuman} require human review.`);
  return parts.join(' ');
}
