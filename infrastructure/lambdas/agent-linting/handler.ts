import { AgentRequest, AgentResponse, AgentReport, Finding } from '../shared/types';
import { callClaude } from '../shared/llm-client';
import { formatFileForReview, parseClaudeCodeResponse } from '../shared/git-operations';
import { SYSTEM_PROMPT } from './prompt';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseFindings(text: string): Finding[] {
  // Prefer a ```json block
  const jsonBlockMatch = text.match(/```json\s*\n([\s\S]*?)\n?\s*```/);
  if (jsonBlockMatch) {
    try {
      const parsed = JSON.parse(jsonBlockMatch[1]);
      if (Array.isArray(parsed)) return parsed as Finding[];
    } catch {
      // fall through
    }
  }
  // Fallback: find any JSON array containing a "severity" key
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
 * Agent 1 — Linting / Code Style
 *
 * Processes each file individually (per spec). All files run in parallel via
 * Promise.all to avoid serialising N Claude calls.
 */
export const handler = async (event: AgentRequest): Promise<AgentResponse> => {
  const filesEntries = Object.entries(event.files);

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  const allFindings: Finding[] = [];
  const fixedFiles: Record<string, string> = {};

  // Process each file independently, in parallel
  const results = await Promise.all(
    filesEntries.map(async ([filepath, content]) => {
      const formatted = formatFileForReview(filepath, content);
      const userMessage = `Please review and fix the following TypeScript file:\n\n${formatted}`;

      const { text, inputTokens, outputTokens } = await callClaude(
        SYSTEM_PROMPT,
        userMessage,
      );

      const codeBlocks = parseClaudeCodeResponse(text);
      const findings = parseFindings(text);

      return { filepath, content, codeBlocks, findings, inputTokens, outputTokens };
    }),
  );

  for (const { filepath, content, codeBlocks, findings, inputTokens, outputTokens } of results) {
    totalInputTokens += inputTokens;
    totalOutputTokens += outputTokens;
    allFindings.push(...findings);

    // Collect fixed file contents — use the block whose filepath matches
    for (const block of codeBlocks) {
      // Accept exact match or trailing-segment match (e.g., Claude may strip path prefix)
      if (block.filepath === filepath || filepath.endsWith(block.filepath)) {
        if (block.content.trim() !== content.trim()) {
          fixedFiles[filepath] = block.content;
        }
      }
    }
  }

  const filesModified = Object.keys(fixedFiles);

  const report: AgentReport = {
    agent: 'agent-linting',
    status: determineStatus(allFindings),
    timestamp: new Date().toISOString(),
    files_analyzed: Object.keys(event.files),
    files_modified: filesModified,
    findings: allFindings,
    summary: buildSummary(allFindings, filesModified),
    token_usage: {
      input_tokens: totalInputTokens,
      output_tokens: totalOutputTokens,
    },
  };

  return { report, fixed_files: fixedFiles };
};

function buildSummary(findings: Finding[], filesModified: string[]): string {
  if (findings.length === 0) return 'No linting issues found.';
  const fixed = findings.filter((f) => f.fixed).length;
  const unfixed = findings.length - fixed;
  const parts: string[] = [`Found ${findings.length} linting issue(s).`];
  if (fixed > 0) parts.push(`Fixed ${fixed} in ${filesModified.length} file(s).`);
  if (unfixed > 0) parts.push(`${unfixed} could not be auto-fixed.`);
  return parts.join(' ');
}
