import { AgentReport } from '../shared/types';
import { callClaude } from '../shared/llm-client';
import { SYSTEM_PROMPT } from './prompt';
import { LinearClient, CreatedTicket, PRContext } from './linear-client';

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
const AUTO_FIX_DASH_AGENTS = new Set(['agent-unit-tests', 'agent-documentation']);

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

  // More than 3 unfixed high → fail
  const unfixedHighCount = unfixed.filter((f) => f.severity === 'high').length;
  if (unfixedHighCount > 3) return 'fail';

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

  const bySeverity: Record<string, number> = {};
  for (const f of allFindings) {
    bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1;
  }

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
// Claude user message builder
// ---------------------------------------------------------------------------

function statusEmoji(status: string): string {
  if (status === 'pass') return '✅';
  if (status === 'fail') return '❌';
  return '⚠️';
}

function buildUserMessage(
  event: SynthesisRequest,
  reportMap: Map<string, AgentReport>,
  overallStatus: 'pass' | 'fail',
  createdTickets: CreatedTicket[],
): string {
  // Build a concise per-agent summary
  const agentLines = EXPECTED_AGENTS.map((agentName) => {
    const report = reportMap.get(agentName);
    const display = AGENT_DISPLAY[agentName] ?? agentName;

    if (!report) {
      return `**${display}:** ❌ MISSING — agent did not produce a report`;
    }

    const unfixed = report.findings.filter((f) => !f.fixed);
    const fixedCount = report.findings.filter((f) => f.fixed).length;
    const useDash = AUTO_FIX_DASH_AGENTS.has(agentName);

    const lines = [
      `**${display}:** ${statusEmoji(report.status)} ${report.status.toUpperCase()} | ` +
        `findings=${report.findings.length} fixed=${useDash ? '—' : fixedCount} attention=${unfixed.length}`,
    ];

    if (unfixed.length > 0) {
      for (const f of unfixed) {
        const loc = f.line ? `${f.file}:${f.line}` : f.file;
        // Find if there's a created ticket for this finding
        // (ticket titles contain the file name or finding message as a substring)
        const ticket = createdTickets.find(
          (t) =>
            t.title.toLowerCase().includes(f.file.split('/').pop()?.toLowerCase() ?? '') ||
            t.title.toLowerCase().includes(f.message.slice(0, 40).toLowerCase()),
        );
        const ticketRef = ticket ? ` [${ticket.identifier}](${ticket.url})` : '';
        lines.push(`  - [${f.severity.toUpperCase()}] \`${loc}\` — ${f.message}${ticketRef}`);
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
**PR #${event.pr_number}:** ${event.pr_title}
**Author:** ${event.pr_author}
**Repository:** ${event.repository}
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

export const handler = async (event: SynthesisRequest): Promise<SynthesisResponse> => {
  const reportMap = new Map<string, AgentReport>(
    event.agent_reports.map((r) => [r.agent, r]),
  );

  const overallStatus = determineOverallStatus(event.agent_reports, reportMap);

  // Create Linear tickets for all unfixed critical/high/medium findings.
  // This happens even for passing PRs when there are ≤3 unfixed high findings.
  let createdTickets: CreatedTicket[] = [];
  const prContext: PRContext = {
    pr_number: event.pr_number,
    pr_title: event.pr_title,
    pr_author: event.pr_author,
    pr_url: event.pr_url,
  };

  try {
    const linearClient = new LinearClient();
    createdTickets = await linearClient.createTickets(event.agent_reports, prContext);
  } catch (err) {
    // Linear being down must not fail the synthesis — CI still needs a comment
    console.error('[synthesis] Linear ticket creation failed:', err);
  }

  // Call Claude to generate the PR comment
  const userMessage = buildUserMessage(event, reportMap, overallStatus, createdTickets);
  const { text: prComment, inputTokens, outputTokens } = await callClaude(
    SYSTEM_PROMPT,
    userMessage,
    3000,
  );

  const summary = computeSummary(event.agent_reports, inputTokens, outputTokens);

  return {
    overall_status: overallStatus,
    pr_comment: prComment,
    linear_tickets: createdTickets,
    summary,
  };
};
