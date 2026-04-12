import { LinearClient as LinearSDKClient } from '@linear/sdk';

import { AgentReport, Finding } from '../shared/types';

export interface PRContext {
  pr_number: number;
  pr_title: string;
  pr_author: string;
  pr_url: string;
}

export interface TicketGroup {
  agentName: string;
  primaryFile: string;
  findings: Finding[];
}

export interface CreatedTicket {
  id: string;
  identifier: string; // e.g. "LIN-1234"
  title: string;
  url: string;
}

const TICKET_CAP = 10;
const TICKETABLE_SEVERITIES = new Set(['critical', 'high', 'medium']);
const MESSAGE_TRUNCATE_LENGTH = 80;
const MESSAGE_TRUNCATE_SUFFIX = 77;

// Priority map per spec: 1=urgent, 2=high, 3=normal
const SEVERITY_PRIORITY: Record<string, number> = {
  critical: 1,
  high: 2,
  medium: 3,
};

// Ordinal for severity comparison (higher = more severe)
const SEVERITY_ORDER: Record<string, number> = {
  info: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

const AGENT_PREFIX = 'agent-';
const DEFAULT_SEVERITY = 'info';
const DEFAULT_PRIORITY = 3;
const SUMMARY_TICKET_PRIORITY = 2;
const PR_TITLE_MAX_LENGTH = 60;

function agentDisplayName(agentName: string): string {
  return agentName
    .replace(`^${AGENT_PREFIX}`, '')
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function maxSeverity(findings: Finding[]): string {
  return findings.reduce((acc, f) => {
    return (SEVERITY_ORDER[f.severity] ?? 0) > (SEVERITY_ORDER[acc] ?? 0) ? f.severity : acc;
  }, DEFAULT_SEVERITY);
}

function buildTicketTitle(agentName: string, findings: Finding[]): string {
  const display = agentDisplayName(agentName);
  if (findings.length === 1) {
    // Truncate long messages so title stays readable
    const msg = findings[0].message.length > MESSAGE_TRUNCATE_LENGTH
      ? findings[0].message.slice(0, MESSAGE_TRUNCATE_SUFFIX) + '...'
      : findings[0].message;
    return `[${display}] ${msg}`;
  }
  const basename = findings[0].file.split('/').pop() ?? findings[0].file;
  return `[${display}] ${findings.length} issues in ${basename}`;
}

function buildTicketDescription(group: TicketGroup, ctx: PRContext): string {
  const display = agentDisplayName(group.agentName);
  const highest = maxSeverity(group.findings);
  const primary = group.findings[0];
  const primaryLoc = primary.line ? `${primary.file}:${primary.line}` : primary.file;

  const findingsSection = group.findings
    .map((f) => {
      const loc = f.line ? `\`${f.file}:${f.line}\`` : `\`${f.file}\``;
      const fix = f.fix_description ? `\n  - **Recommended Fix:** ${f.fix_description}` : '';
      return `- **[${f.severity.toUpperCase()}]** ${loc}\n  ${f.message}${fix}`;
    })
    .join('\n');

  const whyNotFixed =
    group.findings.length === 1
      ? 'The AI agent identified this issue but determined it requires human judgment to fix safely.'
      : `The AI agent identified these ${group.findings.length} issues but determined they require human judgment to fix safely.`;

  return `## Auto-Generated CI Finding

**Source:** PR #${ctx.pr_number} — ${ctx.pr_title}
**Author:** ${ctx.pr_author}
**Agent:** ${display}
**Severity:** ${highest}
**File:** \`${primaryLoc}\`

### Issue
${primary.message}

### All Findings in This Group
${findingsSection}

### Why This Wasn't Auto-Fixed
${whyNotFixed}

### Recommended Fix
${primary.fix_description ?? 'See individual finding details above for recommended fixes.'}

### Context
This ticket was automatically created by the CI pipeline synthesis agent.
The AI agent identified this issue but determined it requires human judgment to fix safely.

**PR Link:** ${ctx.pr_url}`;
}

function buildSummaryTicketDescription(groups: TicketGroup[], ctx: PRContext): string {
  const totalFindings = groups.reduce((n, g) => n + g.findings.length, 0);

  const byAgent = groups.reduce<Record<string, number>>((acc, g) => {
    acc[g.agentName] = (acc[g.agentName] ?? 0) + g.findings.length;
    return acc;
  }, {});

  const agentBreakdown = Object.entries(byAgent)
    .map(([agent, count]) => `- ${agentDisplayName(agent)}: ${count} finding(s)`)
    .join('\n');

  const fileList = [...new Set(groups.map((g) => g.primaryFile))]
    .map((f) => `- \`${f}\``)
    .join('\n');

  return `## Auto-Generated CI Summary — Too Many Findings to Ticket Individually

**Source:** PR #${ctx.pr_number} — ${ctx.pr_title}
**Author:** ${ctx.pr_author}
**Total Unfixed Findings:** ${totalFindings}
**Ticket Groups Identified:** ${groups.length} (capped at ${TICKET_CAP} — using summary ticket)

This PR generated more finding groups than the per-ticket cap (${TICKET_CAP}).
All findings are captured here rather than flooding the board with individual tickets.

### Breakdown by Agent
${agentBreakdown}

### Files Affected
${fileList}

### Full Details
See the PR comment for the complete list of findings and recommended fixes.

**PR Link:** ${ctx.pr_url}`;
}

/**
 * Groups unfixed ticketable findings by agent + file.
 * Returns the resulting groups (caller handles the cap check).
 */
export function groupFindings(reports: AgentReport[]): TicketGroup[] {
  const groupMap = new Map<string, TicketGroup>();

  for (const report of reports) {
    const findings = Array.isArray(report?.findings) ? report.findings : [];
    for (const finding of findings) {
      if (!finding || finding.fixed || !TICKETABLE_SEVERITIES.has(finding.severity)) continue;

      const key = `${report.agent}::${finding.file}`;
      if (!groupMap.has(key)) {
        groupMap.set(key, {
          agentName: report.agent,
          primaryFile: finding.file,
          findings: [],
        });
      }
      groupMap.get(key)!.findings.push(finding);
    }
  }

  // Sort groups: most severe first so the cap retains the highest-priority tickets
  return Array.from(groupMap.values()).sort((a, b) => {
    const diff =
      (SEVERITY_ORDER[maxSeverity(b.findings)] ?? 0) -
      (SEVERITY_ORDER[maxSeverity(a.findings)] ?? 0);
    return diff !== 0 ? diff : a.agentName.localeCompare(b.agentName);
  });
}

export class LinearClient {
  private sdk: LinearSDKClient;
  private teamId: string;
  // Cache label name → id to avoid repeated lookups within a single run
  private labelCache = new Map<string, string>();

  constructor() {
    const apiKey = process.env.LINEAR_API_KEY;
    const teamId = process.env.LINEAR_TEAM_ID;
    if (!apiKey) throw new Error('LINEAR_API_KEY environment variable not set');
    if (!teamId) throw new Error('LINEAR_TEAM_ID environment variable not set');
    this.sdk = new LinearSDKClient({ apiKey });
    this.teamId = teamId;
  }

  private async resolveLabelId(name: string): Promise<string | undefined> {
    if (this.labelCache.has(name)) return this.labelCache.get(name);
    try {
      const result = await this.sdk.issueLabels({ filter: { name: { eq: name } } });
      const label = result.nodes[0];
      if (label) {
        this.labelCache.set(name, label.id);
        return label.id;
      }
    } catch {
      // Label lookup failure is non-fatal — ticket creation proceeds without this label
    }
    return undefined;
  }

  private async resolveLabelIds(names: string[]): Promise<string[]> {
    const ids = await Promise.all(names.map((n) => this.resolveLabelId(n)));
    return ids.filter((id): id is string => id !== undefined);
  }

  /**
   * Creates Linear tickets for all unfixed critical/high/medium findings.
   * Applies grouping (same agent + file → one ticket) and the TICKET_CAP.
   * Failures on individual tickets are logged but do not abort the run.
   */
  async createTickets(reports: AgentReport[], ctx: PRContext): Promise<CreatedTicket[]> {
    const groups = groupFindings(reports);
    if (groups.length === 0) return [];

    const baseLabelIds = await this.resolveLabelIds(['ci-pipeline', 'auto-generated']);
    const created: CreatedTicket[] = [];

    if (groups.length > TICKET_CAP) {
      // Collapse everything into one summary ticket
      const title = `[CI Pipeline] ${groups.length} finding groups in PR #${ctx.pr_number} — ${ctx.pr_title.slice(0, PR_TITLE_MAX_LENGTH)}`;
      const description = buildSummaryTicketDescription(groups, ctx);
      try {
        const payload = await this.sdk.createIssue({
          teamId: this.teamId,
          title,
          description,
          priority: SUMMARY_TICKET_PRIORITY,
          labelIds: baseLabelIds,
        });
        const issue = await payload.issue;
        if (issue) {
          created.push({ id: issue.id, identifier: issue.identifier, title, url: issue.url });
        }
      } catch (err) {
        console.error('[linear-client] Failed to create summary ticket:', err);
      }
      return created;
    }

    // One ticket per group (already sorted most-severe first)
    for (const group of groups) {
      const highest = maxSeverity(group.findings);
      const priority = SEVERITY_PRIORITY[highest] ?? DEFAULT_PRIORITY;
      const title = buildTicketTitle(group.agentName, group.findings);
      const description = buildTicketDescription(group, ctx);

      // Resolve agent-specific label (best-effort)
      const agentLabel = group.agentName.replace(new RegExp(`^${AGENT_PREFIX}`), '');
      const agentLabelIds = await this.resolveLabelIds([agentLabel]);
      const allLabelIds = [...new Set([...baseLabelIds, ...agentLabelIds])];

      try {
        const payload = await this.sdk.createIssue({
          teamId: this.teamId,
          title,
          description,
          priority,
          labelIds: allLabelIds,
        });
        const issue = await payload.issue;
        if (issue) {
          created.push({ id: issue.id, identifier: issue.identifier, title, url: issue.url });
        }
      } catch (err) {
        console.error(
          `[linear-client] Failed to create ticket for ${group.agentName}::${group.primaryFile}:`,
          err,
        );
      }
    }

    return created;
  }
}
