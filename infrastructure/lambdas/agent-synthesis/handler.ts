import { AgentReport } from '../shared/types';
import { callClaude } from '../shared/llm-client';
import { SYSTEM_PROMPT } from './prompt';
import { LinearClient, CreatedTicket, PRContext } from './linear-client';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const EXPECTED_AGENTS = [
  'agent-linting',
  'agent-security',
  'agent-speed',
  'agent-unit-tests',
  'agent-documentation',
  'agent-api-contracts',
] as const;

const AGENT_DISPLAY: Record<string, string> = {
  'agent-linting': 'Linting',
  'agent-security': 'Security',
  'agent-speed': 'Speed',
  'agent-unit-tests': 'Unit Tests',
  'agent-documentation': 'Documentation',
  'agent-api-contracts': 'API Contracts',
};

// Unit tests and documentation never auto-fix in the traditional sense
const AUTO_FIX_AGENTS = new Set(['agent-unit-tests', 'agent-documentation']);

// Maximum unfixed high-severity findings before PR fails
const MAX_UNFIXED_HIGH_FINDINGS = 3;

// Maximum tokens to request from Claude for synthesis
const CLAUDE_MAX_TOKENS = 3000;

// Maximum input validation constraints
const MAX_PR_TITLE_LENGTH = 500;
const MAX_PR_AUTHOR_LENGTH = 256;
const MAX_REPOSITORY_NAME_LENGTH = 256;
const MAX_FINDINGS_PER_REPORT = 1000;

// ---------------------------------------------------------------------------
// Input / output types
// ---------------------------------------------------------------------------

interface SynthesisRequest {
  pr_number: number;
  pr_title: string;
  pr_author: string;
  pr_url: string;
  repository: string;
  agent_reports: AgentReport[];
  blast_radius_stats: {
    changed_count: number;
    total_scope: number;
  };
}

interface SynthesisResponse {
  overall_status: 'pass' | 'fail';
  pr_comment: string;
  linear_tickets: CreatedTicket[];
  summary: {
    total_findings: number;
    fixed_count: number;
    unfixed_count: number;
    by_severity: Record<string, number>;
    by_agent: Record<string, { status: string; findings: number; fixes: number }>;
    total_token_usage: { input_tokens: number; output_tokens: number };
  };
}

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

function validateSynthesisRequest(event: unknown): SynthesisRequest {
  const req = event as Record<string, unknown>;

  // Validate required fields
  if (typeof req.pr_number !== 'number' || req.pr_number < 0) {
    throw new Error('Invalid pr_number: must be a non-negative number');
  }

  if (typeof req.pr_title !== 'string' || req.pr_title.length === 0 || req.pr_title.length > MAX_PR_TITLE_LENGTH) {
    throw new Error(`Invalid pr_title: must be a non-empty string up to ${MAX_PR_TITLE_LENGTH} characters`);
  }

  if (typeof req.pr_author !== 'string' || req.pr_author.length === 0 || req.pr_author.length > MAX_PR_AUTHOR_LENGTH) {
    throw new Error(`Invalid pr_author: must be a non-empty string up to ${MAX_PR_AUTHOR_LENGTH} characters`);
  }

  if (typeof req.pr_url !== 'string' || !isValidUrl(req.pr_url)) {
    throw new Error('Invalid pr_url: must be a valid URL');
  }

  if (typeof req.repository !== 'string' || req.repository.length === 0 || req.repository.length > MAX_REPOSITORY_NAME_LENGTH) {
    throw new Error(`Invalid repository: must be a non-empty string up to ${MAX_REPOSITORY_NAME_LENGTH} characters`);
  }

  if (!Array.isArray(req.agent_reports)) {
    throw new Error('Invalid agent_reports: must be an array');
  }

  // Validate agent reports structure and enforce limits
  for (const report of req.agent_reports) {
    if (!report || typeof report !== 'object') {
      throw new Error('Invalid agent_reports: contains non-object element');
    }
    const findings = (report as Record<string, unknown>).findings;
    if (Array.isArray(findings) && findings.length > MAX_FINDINGS_PER_REPORT) {
      throw new Error(`Invalid report: findings count exceeds maximum of ${MAX_FINDINGS_PER_REPORT}`);
    }
  }

  if (typeof req.blast_radius_stats !== 'object' || req.blast_radius_stats === null) {
    throw new Error('Invalid blast_radius_stats: must be an object');
  }

  const stats = req.blast_radius_stats as Record<string, unknown>;
  if (typeof stats.changed_count !== 'number' || typeof stats.total_scope !== 'number') {
    throw new Error('Invalid blast_radius_stats: must contain changed_count and total_scope numbers');
  }

  return req as unknown as SynthesisRequest;
}

function isValidUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Report normalization — guarantees arrays/objects exist before any access.
// Without this, an agent that returned `findings: undefined` (or no token_usage)
// would crash flatMap/reduce downstream.
// ---------------------------------------------------------------------------

function normalizeReport(report: AgentReport): AgentReport {
  return {
    ...report,
    findings: Array.isArray(report?.findings) ? report.findings.filter(Boolean) : [],
    files_analyzed: Array.isArray(report?.files_analyzed) ? report.files_analyzed : [],
    files_modified: Array.isArray(report?.files_modified) ? report.files_modified : [],
    token_usage: {
      input_tokens: report?.token_usage?.input_tokens ?? 0,
      output_tokens: report?.token_usage?.output_tokens ?? 0,
    },
    summary: report?.summary ?? '',
  };
}

// ---------------------------------------------------------------------------
// Pass / fail logic (deterministic — no Claude required)
// ---------------------------------------------------------------------------

function determineOverallStatus(
  reports: AgentReport[],
  reportMap: Map<string, AgentReport>,
): 'pass' | 'fail' {
  // Any expected agent missing → fail
  for (const expected of EXPECTED_AGENTS) {
    if (!reportMap.has(expected)) return 'fail';
  }

  // Any agent explicitly reported fail → fail
  if (reports.some((r) => r.status === 'fail')) return 'fail';

  const allFindings = reports.flatMap((r) => r.findings);
  const unfixed = allFindings.filter((f) => !f.fixed);

  // Any unfixed critical → fail
  if (unfixed.some((f) => f.severity === 'critical')) return 'fail';

  // More than MAX_UNFIXED_HIGH_FINDINGS unfixed high → fail
  const unfixedHighCount = unfixed.filter((f) => f.severity === 'high').length;
  if (unfixedHighCount > MAX_UNFIXED_HIGH_FINDINGS) return 'fail';

  return 'pass';
}

// ---------------------------------------------------------------------------
// Summary statistics
// ---------------------------------------------------------------------------

function computeSummary(
  reports: AgentReport[],
  synthInputTokens: number,
  synthOutputTokens: number,
): SynthesisResponse['summary'] {
  const allFindings = reports.flatMap((r) => r.findings);

  const bySeverity = allFindings.reduce<Record<string, number>>((acc, finding) => {
    acc[finding.severity] = (acc[finding.severity] ?? 0) + 1;
    return acc;
  }, {});

  let totalInput = synthInputTokens;
  let totalOutput = synthOutputTokens;
  const byAgent: Record<string, { status: string; findings: number; fixes: number }> = {};

  for (const report of reports) {
    byAgent[report.agent] = {
      status: report.status,
      findings: report.findings.length,
      fixes: report.findings.filter((f) => f.fixed).length,
    };
    totalInput += report.token_usage.input_tokens;
    totalOutput += report.token_usage.output_tokens;
  }

  return {
    total_findings: allFindings.length,
    fixed_count: allFindings.filter((f) => f.fixed).length,
    unfixed_count: allFindings.filter((f) => !f.fixed).length,
    by_severity: bySeverity,
    by_agent: byAgent,
    total_token_usage: { input_tokens: totalInput, output_tokens: totalOutput },
  };
}

// ---------------------------------------------------------------------------
// Utility functions for user message building
// ---------------------------------------------------------------------------

function statusEmoji(status: string): string {
  if (status === 'pass') return '✅';
  if (status === 'fail') return '❌';
  return '⚠️';
}

function sanitizeForPrompt(input: string, maxLength: number = 200): string {
  // Remove potential prompt injection characters and limit length
  return input
    .substring(0, maxLength)
    .replace(/[\n\r`]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function findRelatedTicket(
  finding: { file: string; message: string },
  createdTickets: CreatedTicket[],
): CreatedTicket | undefined {
  const fileName = finding.file.split('/').pop() ?? '';
  const messagePreview = finding.message.slice(0, 40);

  return createdTickets.find(
    (ticket) =>
      ticket.title.toLowerCase().includes(fileName.toLowerCase()) ||
      ticket.title.toLowerCase().includes(messagePreview.toLowerCase()),
  );
}

// ---------------------------------------------------------------------------
// Claude user message builder
// ---------------------------------------------------------------------------

function buildUserMessage(
  event: SynthesisRequest,
  reportMap: Map<string, AgentReport>,
  overallStatus: 'pass' | 'fail',
  createdTickets: CreatedTicket[],
): string {
  // Sanitize user inputs to prevent prompt injection
  const sanitizedTitle = sanitizeForPrompt(event.pr_title, MAX_PR_TITLE_LENGTH);
  const sanitizedAuthor = sanitizeForPrompt(event.pr_author, MAX_PR_AUTHOR_LENGTH);
  const sanitizedRepository = sanitizeForPrompt(event.repository, MAX_REPOSITORY_NAME_LENGTH);

  // Build a concise per-agent summary
  const agentLines = EXPECTED_AGENTS.map((agentName) => {
    const report = reportMap.get(agentName);
    const display = AGENT_DISPLAY[agentName] ?? agentName;

    if (!report) {
      return `**${display}:** ❌ MISSING — agent did not produce a report`;
    }

    const unfixed = report.findings.filter((f) => !f.fixed);
    const fixedCount = report.findings.filter((f) => f.fixed).length;
    const useDash = AUTO_FIX_AGENTS.has(agentName);

    const lines = [
      `**${display}:** ${statusEmoji(report.status)} ${report.status.toUpperCase()} | ` +
        `findings=${report.findings.length} fixed=${useDash ? '—' : fixedCount} attention=${unfixed.length}`,
    ];

    if (unfixed.length > 0) {
      for (const finding of unfixed) {
        const location = finding.line ? `${finding.file}:${finding.line}` : finding.file;
        const relatedTicket = findRelatedTicket(finding, createdTickets);
        const ticketRef = relatedTicket ? ` [${relatedTicket.identifier}](${relatedTicket.url})` : '';
        lines.push(`  - [${finding.severity.toUpperCase()}] \`${location}\` — ${finding.message}${ticketRef}`);
      }
    } else {
      lines.push(`  Summary: ${report.summary}`);
    }

    return lines.join('\n');
  });

  const totalInput = event.agent_reports.reduce((n, r) => n + r.token_usage.input_tokens, 0);
  const totalOutput = event.agent_reports.reduce((n, r) => n + r.token_usage.output_tokens, 0);
  const agentCommits = event.agent_reports.filter((r) => r.commit_sha).length;

  const ticketSummary =
    createdTickets.length > 0
      ? `\n## Linear Tickets Created (${createdTickets.length})\n` +
        createdTickets.map((t) => `- ${t.identifier}: ${t.title} — ${t.url}`).join('\n')
      : '';

  return `## Synthesis Request

**Overall Status:** ${overallStatus.toUpperCase()}
**PR #${event.pr_number}:** ${sanitizedTitle}
**Author:** ${sanitizedAuthor}
**Repository:** ${sanitizedRepository}
**PR URL:** ${event.pr_url}

## Blast Radius
- Changed files: ${event.blast_radius_stats.changed_count}
- Total in scope: ${event.blast_radius_stats.total_scope}

## Agent Reports
${agentLines.join('\n\n')}

## Pipeline Stats
- Files in scope: ${event.blast_radius_stats.changed_count} (of ${event.blast_radius_stats.total_scope} total)
- Agent commits: ${agentCommits}
- Tokens used across all agents: ~${totalInput.toLocaleString()} input / ~${totalOutput.toLocaleString()} output
${ticketSummary}

Generate the PR comment markdown for this pipeline run.`;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const handler = async (event: unknown): Promise<SynthesisResponse> => {
  let synthesisRequest: SynthesisRequest;

  try {
    synthesisRequest = validateSynthesisRequest(event);
  } catch (err) {
    console.error('[synthesis] Input validation failed:', err instanceof Error ? err.message : String(err));
    throw new Error('Invalid synthesis request: validation failed');
  }

  const reports: AgentReport[] = Array.isArray(synthesisRequest.agent_reports)
    ? synthesisRequest.agent_reports.filter(Boolean).map(normalizeReport)
    : [];

  const reportMap = new Map<string, AgentReport>(reports.map((r) => [r.agent, r]));

  const overallStatus = determineOverallStatus(reports, reportMap);

  // Create Linear tickets for all unfixed critical/high/medium findings.
  // This happens even for passing PRs when there are ≤3 unfixed high findings.
  let createdTickets: CreatedTicket[] = [];
  const prContext: PRContext = {
    pr_number: synthesisRequest.pr_number,
    pr_title: synthesisRequest.pr_title,
    pr_author: synthesisRequest.pr_author,
    pr_url: synthesisRequest.pr_url,
  };

  try {
    const linearClient = new LinearClient();
    createdTickets = await linearClient.createTickets(reports, prContext);
  } catch (err) {
    // Linear being down must not fail the synthesis — CI still needs a comment
    console.error('[synthesis] Linear ticket creation failed:', err instanceof Error ? err.message : 'Unknown error');
  }

  // Call Claude to generate the PR comment
  const normalizedEvent: SynthesisRequest = { ...synthesisRequest, agent_reports: reports };
  const userMessage = buildUserMessage(normalizedEvent, reportMap, overallStatus, createdTickets);
  let prComment: string;
  let inputTokens: number;
  let outputTokens: number;

  try {
    const result = await callClaude(SYSTEM_PROMPT, userMessage, CLAUDE_MAX_TOKENS);
    prComment = result.text;
    inputTokens = result.inputTokens;
    outputTokens = result.outputTokens;
  } catch (err) {
    console.error('[synthesis] Claude synthesis failed:', err instanceof Error ? err.message : 'Unknown error');
    throw err;
  }

  const summary = computeSummary(reports, inputTokens, outputTokens);

  return {
    overall_status: overallStatus,
    pr_comment: prComment,
    linear_tickets: createdTickets,
    summary,
  };
};
