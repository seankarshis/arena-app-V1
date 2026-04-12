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
  // No findings block at all is legitimate — empty findings.
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

  const results = await Promise.all(
    filesEntries.map(async ([filepath, content]) => {
      const formatted = formatFileForReview(filepath, content);
      const userMessage = `Please review and fix the following TypeScript file:\n\n${formatted}`;

      try {
        const { text, inputTokens, outputTokens } = await callClaude(
          SYSTEM_PROMPT,
          userMessage,
        );

        const { blocks, rejections } = parseClaudeCodeResponse(text, { [filepath]: content });
        const findingsResult = parseFindings(text);

        return {
          filepath,
          content,
          blocks,
          rejections,
          findingsResult,
          inputTokens,
          outputTokens,
          truncationDetail: null as string | null,
        };
      } catch (err) {
        if (err instanceof ResponseTruncatedError) {
          return {
            filepath,
            content,
            blocks: [],
            rejections: [],
            findingsResult: { status: 'parsed', findings: [] } as FindingsParseResult,
            inputTokens: 0,
            outputTokens: err.outputTokens,
            truncationDetail: err.message,
          };
        }
        throw err;
      }
    }),
  );

  for (const res of results) {
    totalInputTokens += res.inputTokens;
    totalOutputTokens += res.outputTokens;

    if (res.truncationDetail) {
      allFindings.push(truncationToFinding([res.filepath], res.truncationDetail));
      continue;
    }

    for (const r of res.rejections) {
      allFindings.push(rejectionToFinding(r));
    }

    if (res.findingsResult.status === 'error') {
      allFindings.push(parseFindingsErrorToFinding(res.findingsResult.detail));
    } else {
      allFindings.push(...res.findingsResult.findings);
    }

    for (const block of res.blocks) {
      if (block.content.trim() !== res.content.trim()) {
        fixedFiles[block.filepath] = block.content;
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
