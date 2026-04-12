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
 * Documentation agent status: capped at "warn".
 * Missing docs is informational — it should never block a PR.
 */
function determineStatus(findings: Finding[]): 'pass' | 'warn' {
  const unfixed = findings.filter((f) => !f.fixed);
  if (unfixed.length > 0) return 'warn';
  return 'pass';
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Agent 5 — Documentation
 *
 * Sends all files in a single Claude call. Documentation often requires
 * understanding the relationships between functions across a file, so a
 * single-call approach gives Claude the full picture.
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

  const { text, inputTokens, outputTokens } = await callClaude(
    SYSTEM_PROMPT,
    userMessage,
    8192, // Documentation can add significant volume to each file
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
