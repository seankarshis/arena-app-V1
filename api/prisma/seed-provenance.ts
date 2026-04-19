/**
 * ============================================================================
 * PROVENANCE M&A INTEGRATION — ARENA SEED SCRIPT
 * ============================================================================
 *
 * PURPOSE
 * -------
 * This script seeds the Arena interview platform with the Provenance M&A
 * Integration interview framework: questions, tags, templates, and their
 * relationships. It populates everything needed to test the full interview
 * flow for both acquiring-side and acquired-side stakeholder interviews.
 *
 * WHAT IT CREATES
 * ---------------
 * - 5 tags (Strategic, Risk, Operational, People, Safety)
 * - ~166 questions (core, role-specific, and follow-up probes)
 * - 16 interview templates organized by side (acquiring/acquired) and role
 * - All question-tag associations
 * - All template-question associations with ordering, bucketing, required/
 *   optional flags, and follow-up triggers
 *
 * TEMPLATE ARCHITECTURE
 * ---------------------
 * Acquiring Side (7 templates):
 *   1. Core Questions — run first for all acquiring-side interviewees
 *   2. CEO/President
 *   3. CFO
 *   4. CTO/CIO
 *   5. Technology & Infrastructure (VP Infra + VP Security + VP Engineering)
 *   6. Commercial Operations (CRO/VP Sales + VP CS + VP RevOps)
 *   7. Governance & Delivery (CHRO/VP People + VP Legal + VP PMO)
 *
 * Acquired Side (9 templates):
 *   8. Core Questions — includes opening framing in description
 *   9. CEO/Founder
 *  10. CTO/CIO
 *  11. Data & Product (CPO/VP Product + VP Data & Analytics)
 *  12. CHRO/VP People
 *  13. Technology & Infrastructure (mirrored from acquiring)
 *  14. Commercial Operations (mirrored from acquiring)
 *  15. Governance & Delivery (mirrored from acquiring)
 *  16. Closing Sequence — run last for all acquired-side interviewees
 *
 * HOW TO USE
 * ----------
 * 1. Make sure your .env has DATABASE_URL pointing to your dev Postgres.
 *
 * 2. Choose your mode:
 *
 *    ADDITIVE MODE (default) — adds data on top of whatever exists.
 *    Safe to run multiple times thanks to skipDuplicates and upsert.
 *
 *      npx tsx prisma/seed-provenance.ts
 *
 *    CLEAN MODE — truncates all seeded tables first, then loads fresh.
 *    WARNING: This deletes ALL data in these tables, not just seed data.
 *
 *      SEED_MODE=clean npx tsx prisma/seed-provenance.ts
 *
 * 3. Verify in Prisma Studio:
 *
 *      npx prisma studio
 *
 *    Check: tags (5), questions (~166), interview_templates (16),
 *    template_questions (~166 rows with triggers), question_tags (~300+).
 *
 * IDEMPOTENCY
 * -----------
 * All IDs are deterministic (hardcoded UUIDs). All createMany calls use
 * skipDuplicates: true. Templates use upsert. Re-running in additive mode
 * is safe and will not create duplicates or fail on conflicts.
 *
 * NOTE ON USER ASSIGNMENTS
 * ------------------------
 * This script does NOT assign templates to users. User-template assignments
 * should be done manually through the admin UI or a separate script when
 * you're ready to test interview flows with specific users.
 *
 * ============================================================================
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// ============================================================================
// MODE SELECTION
// ============================================================================
const SEED_MODE = process.env.SEED_MODE || 'additive'; // 'additive' | 'clean'

// ============================================================================
// DETERMINISTIC IDS
// ============================================================================

// Tags: 10000000-0000-4000-a000-0000000000XX
const TAG_IDS = {
  strategic:   '10000000-0000-4000-a000-000000000001',
  risk:        '10000000-0000-4000-a000-000000000002',
  operational: '10000000-0000-4000-a000-000000000003',
  people:      '10000000-0000-4000-a000-000000000004',
  safety:      '10000000-0000-4000-a000-000000000005',
} as const;

// Templates: 30000000-0000-4000-a000-0000000000XX
const TMPL = {
  acqCore:    '30000000-0000-4000-a000-000000000001',
  acqCeo:     '30000000-0000-4000-a000-000000000002',
  acqCfo:     '30000000-0000-4000-a000-000000000003',
  acqCto:     '30000000-0000-4000-a000-000000000004',
  acqTechInf: '30000000-0000-4000-a000-000000000005',
  acqCommOps: '30000000-0000-4000-a000-000000000006',
  acqGovDel:  '30000000-0000-4000-a000-000000000007',
  acdCore:    '30000000-0000-4000-a000-000000000008',
  acdCeo:     '30000000-0000-4000-a000-000000000009',
  acdCto:     '30000000-0000-4000-a000-000000000010',
  acdDataProd:'30000000-0000-4000-a000-000000000011',
  acdPeople:  '30000000-0000-4000-a000-000000000012',
  acdTechInf: '30000000-0000-4000-a000-000000000013',
  acdCommOps: '30000000-0000-4000-a000-000000000014',
  acdGovDel:  '30000000-0000-4000-a000-000000000015',
  acdClosing: '30000000-0000-4000-a000-000000000016',
} as const;

// Questions: 20000000-0000-4000-a000-0000000XXXXX
// Numbering scheme:
//   001-008: Acquiring Core
//   010-015: Acquiring CEO
//   020-024: Acquiring CFO
//   030-034: Acquiring CTO
//   040-054: Acquiring Tech & Infra
//   060-073: Acquiring Commercial Ops
//   080-094: Acquiring Governance & Delivery
//   100-107: Acquired Core
//   110-120: Acquired CEO + probes
//   130-141: Acquired CTO + probes
//   150-161: Acquired Data & Product + probes
//   170-182: Acquired CHRO/People + probes
//   190-204: Acquired Tech & Infra (mirrored)
//   210-223: Acquired Commercial Ops (mirrored)
//   230-244: Acquired Governance & Delivery (mirrored)
//   250-261: Acquired Closing + probes
const Q = (n: number) => `20000000-0000-4000-a000-${String(n).padStart(12, '0')}`;

// TemplateQuestion IDs: 40000000-0000-4000-a000-TT0000000QQQ
// TT = template number (01-16), QQQ = question number (padded to 10 digits)
// Deterministic so triggers can reference them before DB insertion.
const tqId = (templateId: string, questionId: string): string => {
  const tNum = parseInt(templateId.split('-').pop()!, 10);
  const qNum = parseInt(questionId.split('-').pop()!, 10);
  return `40000000-0000-4000-a000-${String(tNum).padStart(2, '0')}${String(qNum).padStart(10, '0')}`;
};


// ============================================================================
// TAG DATA
// ============================================================================
const tags = [
  { id: TAG_IDS.strategic,   label: 'Strategic',    isActive: true },
  { id: TAG_IDS.risk,        label: 'Risk',         isActive: true },
  { id: TAG_IDS.operational, label: 'Operational',  isActive: true },
  { id: TAG_IDS.people,      label: 'People',       isActive: true },
  { id: TAG_IDS.safety,      label: 'Safety',       isActive: true },
];


// ============================================================================
// QUESTION DATA
// ============================================================================

// Helper type
interface QuestionDef {
  id: string;
  text: string;
  intent: string;
  category: string;
  tagIds: string[];
}

// ── Acquiring Core (Q1-Q8) ─────────────────────────────────────────────────
const acqCoreQuestions: QuestionDef[] = [
  { id: Q(1), text: 'In your own words, why did we make this acquisition? What problem does it solve or what opportunity does it unlock?', intent: "Capture the leader's unrehearsed articulation of the deal rationale. Divergence across leaders answering this same question is the earliest signal of thesis misalignment.", category: 'strategic-intent', tagIds: [TAG_IDS.strategic] },
  { id: Q(2), text: 'What does success look like for you personally, 12 months from now? What would make you say this integration went well?', intent: 'Anchor the concrete definition of success — specific metrics, milestones, or outcomes. Vagueness here forecasts ambiguity in how progress will be judged later.', category: 'strategic-intent', tagIds: [TAG_IDS.strategic] },
  { id: Q(3), text: 'What is the single thing you are most worried about in this integration?', intent: "Surface the top-of-mind risk, not an abstract risk register. If the answer is hedged or general, that hesitation itself is data — the real concern is often hard to say aloud.", category: 'risk-surface', tagIds: [TAG_IDS.risk] },
  { id: Q(4), text: 'Is there anything important about the acquired company that you believe the integration team may underestimate or overlook?', intent: "Extract tacit knowledge that no diligence deck would show. This is often the single most valuable answer in the core — give it air.", category: 'risk-surface', tagIds: [TAG_IDS.strategic, TAG_IDS.risk] },
  { id: Q(5), text: 'What, if anything, about the acquired company should be preserved exactly as-is?', intent: "Identify the non-negotiables. These are the boundaries any integration plan must respect — or deliberately renegotiate with the person who named them.", category: 'strategic-intent', tagIds: [TAG_IDS.strategic] },
  { id: Q(6), text: 'What decisions are already made and should not be re-opened? What is still genuinely up for discussion?', intent: "Separate settled decisions from live ones. Prevents the integration team from relitigating closed matters — or assuming closure that doesn't exist.", category: 'operational-detail', tagIds: [TAG_IDS.strategic] },
  { id: Q(7), text: 'What is your read on the relationship between the two leadership teams right now? Where is there trust, and where is there friction?', intent: "Capture the interpersonal temperature. Named trust and friction points guide who should be paired on workstreams — and where to invest in bridge-building.", category: 'people-dynamics', tagIds: [TAG_IDS.people] },
  { id: Q(8), text: 'What would cause you to intervene directly in the integration? What threshold signals a problem serious enough to need your personal attention?', intent: "Define the escalation contract in the leader's own words — the implicit agreement for when to page them vs. handle it at the workstream level.", category: 'risk-surface', tagIds: [TAG_IDS.risk, TAG_IDS.operational] },
];

// ── Acquiring CEO (Q10-Q15) ────────────────────────────────────────────────
const acqCeoQuestions: QuestionDef[] = [
  { id: Q(10), text: 'What was the strategic thesis that made this deal worth doing? What has to be true for that thesis to be validated?', intent: "Nail down the validation criteria. Theses stated at the narrative level without a 'what must be true' test are the top source of integration drift.", category: 'strategic-intent', tagIds: [TAG_IDS.strategic] },
  { id: Q(11), text: 'What value do you expect to be able to capture in the first 90 days? What value is locked behind longer integration work?', intent: "Separate quick wins from compounding value. Misalignment between CEO timeline and operational reality on this split is a frequent failure mode.", category: 'strategic-intent', tagIds: [TAG_IDS.strategic] },
  { id: Q(12), text: 'How would you describe the relative priority between speed of integration and preservation of the acquired company\'s culture and operating model?', intent: "Force a concrete articulation of the tradeoff. Most CEOs will claim 'both' — press until they pick a leaning, because workstream prioritization depends on it.", category: 'strategic-intent', tagIds: [TAG_IDS.strategic, TAG_IDS.people] },
  { id: Q(13), text: 'What commitments — public, board-level, or to the acquired company\'s leadership — have already been made about how this integration will be handled?', intent: "Surface constraints already locked in. Public statements, board promises, and handshakes with the acquired CEO bind what the integration team can change.", category: 'risk-surface', tagIds: [TAG_IDS.risk, TAG_IDS.operational] },
  { id: Q(14), text: 'Who on your leadership team is most invested in making this work? Who has reservations?', intent: "Map internal allies and skeptics by name. Reservations aren't disqualifying — but they predict where integration proposals will meet friction.", category: 'people-dynamics', tagIds: [TAG_IDS.people] },
  { id: Q(15), text: 'What is the board\'s level of visibility into this integration, and what will they be watching most closely?', intent: "Identify what the board is watching, and therefore what reporting cadence is non-negotiable. Determines which KPIs the integration team must instrument first.", category: 'operational-detail', tagIds: [TAG_IDS.operational, TAG_IDS.risk] },
];

// Acquiring CEO follow-up probes (for testing triggers on acquiring side)
const acqCeoProbes: QuestionDef[] = [
  { id: Q(16), text: 'Can you be more specific about the timeline for that thesis validation? What milestones would you expect to see at 90 days, 6 months, and 12 months?', intent: "Extract concrete 90d/6mo/12mo milestones when the initial thesis answer stayed directional. Board-visible reporting structure begins here.", category: 'strategic-intent', tagIds: [TAG_IDS.strategic] },
  { id: Q(17), text: 'You mentioned reservations on the leadership team. Can you help me understand what those reservations are rooted in — strategic disagreement, execution concern, or something else?', intent: "Distinguish strategic disagreement from execution concern from personal friction. Each requires a different intervention from integration leadership.", category: 'people-dynamics', tagIds: [TAG_IDS.people, TAG_IDS.risk] },
];

// ── Acquiring CFO (Q20-Q24) ────────────────────────────────────────────────
const acqCfoQuestions: QuestionDef[] = [
  { id: Q(20), text: 'What synergy targets — cost, revenue, or both — are committed to the board or investors, and on what timeline?', intent: "Capture committed numbers and timelines. This is the anchor for every financial workstream — and the figure most likely to conflict with operational reality elsewhere.", category: 'strategic-intent', tagIds: [TAG_IDS.strategic, TAG_IDS.risk] },
  { id: Q(21), text: 'Which financial systems (ERP, billing, revenue recognition, general ledger) are in scope for consolidation, and what is the target state?', intent: "Map the ERP/billing/GL consolidation scope. Financial system migrations have the longest tails in M&A and need early, specific scoping.", category: 'operational-detail', tagIds: [TAG_IDS.operational] },
  { id: Q(22), text: 'Are there earn-out provisions, deferred consideration, or financial performance clauses in the deal that create specific integration milestones?', intent: "Flag deal-mechanics milestones that constrain integration sequencing. Missing an earn-out trigger date has direct P&L impact.", category: 'risk-surface', tagIds: [TAG_IDS.risk, TAG_IDS.strategic] },
  { id: Q(23), text: 'What is your current level of confidence in the financial data provided during due diligence? Are there areas where you expect surprises?', intent: "Draw out where the CFO expects surprises. Low-confidence areas deserve first-week integration diligence, not steady-state review.", category: 'risk-surface', tagIds: [TAG_IDS.risk] },
  { id: Q(24), text: 'What is the financial risk tolerance for integration-related disruption to customers or operations?', intent: "Define the cost ceiling for integration-caused disruption. Sets the boundary for migration-risk calls downstream.", category: 'risk-surface', tagIds: [TAG_IDS.risk, TAG_IDS.strategic] },
];

// ── Acquiring CTO (Q30-Q34) ────────────────────────────────────────────────
const acqCtoQuestions: QuestionDef[] = [
  { id: Q(30), text: 'What is the intended long-term outcome for the acquired company\'s product infrastructure — full migration to your platform, parallel operation, or maintained separately?', intent: "Nail the end-state intent. Every downstream technical workstream inherits this decision; ambiguity at this level cascades into months of rework.", category: 'strategic-intent', tagIds: [TAG_IDS.strategic, TAG_IDS.operational] },
  { id: Q(31), text: 'Which systems at the acquired company are business-critical and cannot be disrupted during integration?', intent: "Build the 'do not disrupt' list. These systems set the sequencing and risk envelope for any integration activity that touches them.", category: 'risk-surface', tagIds: [TAG_IDS.risk, TAG_IDS.operational] },
  { id: Q(32), text: 'Are there data sovereignty, residency, or contractual data obligations that will constrain how we migrate or consolidate infrastructure?', intent: "Surface regulatory and contractual constraints on data movement. Missing one here can block an integration plan mid-execution.", category: 'operational-detail', tagIds: [TAG_IDS.risk, TAG_IDS.operational] },
  { id: Q(33), text: 'What AI or automation initiatives are currently underway at either company? Which ones should be accelerated, merged, or stopped?', intent: "Identify which initiatives to accelerate, merge, or kill. AI/automation work often has sunk emotional investment — explicit direction now prevents zombie projects.", category: 'strategic-intent', tagIds: [TAG_IDS.strategic, TAG_IDS.operational] },
  { id: Q(34), text: 'Where do you see the most significant architectural incompatibility between the two companies\' systems?', intent: "Surface the CTO's gut read on where the platforms don't mesh. These become the hardest integration workstreams — architects should be paired early.", category: 'risk-surface', tagIds: [TAG_IDS.risk, TAG_IDS.strategic] },
];

// ── Acquiring Tech & Infrastructure (Q40-Q54) ──────────────────────────────
// VP Infrastructure (40-44), VP Security (45-49), VP Engineering (50-54)
const acqTechInfQuestions: QuestionDef[] = [
  // VP Infrastructure
  { id: Q(40), text: 'What end-of-life or unsupported infrastructure is currently in production? What has been deferred for remediation?', intent: "Enumerate what's running past support. Integration activity often accelerates remediation — or makes deferred remediation explode under load.", category: 'risk-surface', tagIds: [TAG_IDS.risk] },
  { id: Q(41), text: 'What are the most fragile or single-point-of-failure systems in the current environment?', intent: "Identify where the environment cannot absorb additional stress. Integration work near these systems needs isolation windows, not normal change procedures.", category: 'risk-surface', tagIds: [TAG_IDS.risk] },
  { id: Q(42), text: 'What managed service providers or outsourced infrastructure contracts exist? What are the terms and notice periods?', intent: "Map vendor dependencies and termination windows. Contract notice periods frequently dictate achievable migration timelines.", category: 'operational-detail', tagIds: [TAG_IDS.operational, TAG_IDS.risk] },
  { id: Q(43), text: 'What monitoring and observability tooling is in place? How mature is alerting and incident response?', intent: "Assess how quickly problems become visible. Weak observability compounds integration risk — you won't know what broke until customers complain.", category: 'operational-detail', tagIds: [TAG_IDS.operational, TAG_IDS.risk] },
  { id: Q(44), text: 'Walk me through the current infrastructure footprint — cloud providers, data centers, co-location, and on-premises.', intent: "Complete ledger of where compute runs. On-prem pockets and shadow-IT assets are disproportionately often the source of mid-integration surprises.", category: 'operational-detail', tagIds: [TAG_IDS.operational] },
  // VP Security
  { id: Q(45), text: 'What security certifications or compliance frameworks is the acquired company currently operating under?', intent: "List the frameworks in effect — SOC 2, ISO, HIPAA, etc. These set the compliance floor that integration activity must not fall below.", category: 'operational-detail', tagIds: [TAG_IDS.risk, TAG_IDS.operational] },
  { id: Q(46), text: 'Are any of those certifications currently in scope, in audit, or pending renewal? What would integration activity put at risk?', intent: "Flag audit windows integration could jeopardize. A failed audit caused by integration timing is a pure unforced error.", category: 'risk-surface', tagIds: [TAG_IDS.risk] },
  { id: Q(47), text: 'Have there been any security incidents, data breaches, or regulatory investigations in the past 24 months?', intent: "Surface incident history honestly. Breaches shape risk posture and determine what insurance carriers and customers need to know post-close.", category: 'risk-surface', tagIds: [TAG_IDS.risk] },
  { id: Q(48), text: 'What penetration testing or red team activity has been conducted recently? What findings remain open?', intent: "Enumerate open findings. Integration expands attack surface — unremediated findings carry forward into the merged environment.", category: 'risk-surface', tagIds: [TAG_IDS.risk] },
  { id: Q(49), text: 'What security concerns do you have specifically about the integration process itself — not the steady state, but the transition period?', intent: "Distinguish steady-state risk from transition-period risk. Credential sprawl, dual-admin periods, and trust-boundary changes are the big integration-specific exposures.", category: 'risk-surface', tagIds: [TAG_IDS.risk] },
  // VP Engineering
  { id: Q(50), text: 'What is the current state of the CI/CD pipeline and development tooling? How automated is the path from code to production?', intent: "Gauge how automated the path to production is. Weak CI/CD means integration changes will break things silently; strong CI/CD absorbs more risk.", category: 'operational-detail', tagIds: [TAG_IDS.operational] },
  { id: Q(51), text: 'Where is the most significant technical debt in the product? What has been deliberately deferred and what is genuinely unknown?', intent: "Distinguish debt engineers know is owed from debt that's genuinely uncharted. The second category is where integration surprises live.", category: 'risk-surface', tagIds: [TAG_IDS.risk, TAG_IDS.operational] },
  { id: Q(52), text: 'How does the engineering team feel about this acquisition? What are the most common concerns you\'re hearing?', intent: "Read the morale temperature. Concerns teams are saying aloud preview retention and productivity risk over the next 6-12 months.", category: 'people-dynamics', tagIds: [TAG_IDS.people, TAG_IDS.risk] },
  { id: Q(53), text: 'Which engineers are most critical to retain? What retention risk exists and what has already been done?', intent: "Names, not roles. Retention spending needs specific targets; this list is the input to compensation and career conversations owed in weeks, not months.", category: 'people-dynamics', tagIds: [TAG_IDS.people, TAG_IDS.risk] },
  { id: Q(54), text: 'What AI coding tools or automation are currently in use by the engineering team? What has been tried and abandoned?', intent: "Understand what's adopted, tried, and abandoned. Tool-chain harmonization is a near-term ask; knowing what teams have already rejected saves re-litigation.", category: 'operational-detail', tagIds: [TAG_IDS.operational, TAG_IDS.strategic] },
];

// ── Acquiring Commercial Operations (Q60-Q73) ─────────────────────────────
// CRO/VP Sales (60-63), VP Customer Success (64-68), VP RevOps (69-73)
const acqCommOpsQuestions: QuestionDef[] = [
  // CRO / VP Sales
  { id: Q(60), text: 'What customer-facing commitments — contractual, verbal, or implied — were made to the acquired company\'s customers during or after the deal announcement?', intent: "Surface promises made during the deal noise. Verbal or implied often matter more than contractual — unmet commitments from this window create the first churn wave.", category: 'risk-surface', tagIds: [TAG_IDS.risk, TAG_IDS.operational] },
  { id: Q(61), text: 'Are there customers at the acquired company who are at meaningful churn risk? Who are they and what would stabilize them?', intent: "Name the specific at-risk accounts and what would stabilize each. Generic answers here mean this work hasn't been done.", category: 'risk-surface', tagIds: [TAG_IDS.risk, TAG_IDS.strategic] },
  { id: Q(62), text: 'Are there contracts at the acquired company that contain change-of-control provisions that need to be actively managed?', intent: "List contracts requiring active management. Missed notices trigger termination rights — a pure unforced-error category.", category: 'risk-surface', tagIds: [TAG_IDS.risk, TAG_IDS.operational] },
  { id: Q(63), text: 'What cross-sell or upsell opportunities does this acquisition unlock? Which are time-sensitive?', intent: "Identify opportunities and their time sensitivity. Cross-sell windows close as customers re-evaluate post-deal — the first 90 days disproportionately matter.", category: 'strategic-intent', tagIds: [TAG_IDS.strategic] },
  // VP Customer Success
  { id: Q(64), text: 'Which customers are at meaningful churn risk right now — before any integration disruption — and what are the reasons?', intent: "Pre-existing churn risk, separate from integration-caused risk. Separating these prevents integration from being blamed for churn it did not cause.", category: 'risk-surface', tagIds: [TAG_IDS.risk] },
  { id: Q(65), text: 'Are there customers who have a strong personal relationship with someone at your company who may be leaving?', intent: "Identify relationship-held accounts. These need planned relationship transitions — not generic handoff emails.", category: 'people-dynamics', tagIds: [TAG_IDS.risk, TAG_IDS.people] },
  { id: Q(66), text: 'What commitments — service levels, named contacts, response times — have been made to customers in ways not captured in contracts?', intent: "SLAs, contacts, response norms promised verbally or through habit. These feel contractual to customers even when they aren't.", category: 'risk-surface', tagIds: [TAG_IDS.risk, TAG_IDS.operational] },
  { id: Q(67), text: 'What do customers most value about working with your team that they\'re afraid they\'ll lose?', intent: "Capture the intangibles customers associate with the team. These become the design constraints for any customer-facing integration change.", category: 'strategic-intent', tagIds: [TAG_IDS.strategic, TAG_IDS.risk] },
  { id: Q(68), text: 'Are there customer contracts that contain SLA penalties, service credits, or termination clauses that could be triggered during the transition?', intent: "List contract tripwires. Prioritize customer-facing integration plans around these — they convert operational disruption into financial hits.", category: 'risk-surface', tagIds: [TAG_IDS.risk] },
  // VP Revenue Operations
  { id: Q(69), text: 'Walk me through the full commercial technology stack — CRM, marketing automation, CPQ, billing, revenue recognition, BI.', intent: "Full stack map. Consolidation scope, integration touchpoints, and data flows all depend on having this ledger before planning starts.", category: 'operational-detail', tagIds: [TAG_IDS.operational] },
  { id: Q(70), text: 'What is the current state of CRM data quality — contact completeness, account hierarchy, opportunity hygiene?', intent: "Honest CRM hygiene assessment. Bad CRM data poisons every analysis downstream; no migration plan is complete without this baseline.", category: 'operational-detail', tagIds: [TAG_IDS.operational, TAG_IDS.risk] },
  { id: Q(71), text: 'Are there customizations, automations, or integrations in the CRM not documented anywhere and live only in someone\'s head?', intent: "Surface tribal knowledge. Customizations living in one admin's head are the #1 cause of broken reports and workflows post-migration.", category: 'risk-surface', tagIds: [TAG_IDS.risk, TAG_IDS.operational] },
  { id: Q(72), text: 'What is the most important data in your commercial systems that must not be lost or degraded in a migration?', intent: "The data the business cannot afford to lose or degrade. Becomes migration non-negotiables and integrity-test candidates.", category: 'risk-surface', tagIds: [TAG_IDS.risk, TAG_IDS.operational] },
  { id: Q(73), text: 'What rev ops work is currently in flight that would be disrupted if it had to pause?', intent: "Current-state projects that would be disrupted by pause. Decides what to protect vs. what to reabsorb into integration planning.", category: 'operational-detail', tagIds: [TAG_IDS.operational, TAG_IDS.risk] },
];

// ── Acquiring Governance & Delivery (Q80-Q94) ──────────────────────────────
// CHRO/VP People (80-84), VP Legal (85-89), VP PMO (90-94)
const acqGovDelQuestions: QuestionDef[] = [
  // CHRO / VP People
  { id: Q(80), text: 'Are there redundant roles that will need to be eliminated? Has leadership aligned on the timeline and communication approach?', intent: "Probe both fact and communication readiness. Tempo and message alignment separate a clean reduction from a morale collapse.", category: 'operational-detail', tagIds: [TAG_IDS.operational, TAG_IDS.risk] },
  { id: Q(81), text: 'How do total compensation, benefits, and equity structures at the acquired company compare to your own? What harmonization is required and by when?', intent: "Identify harmonization gaps and deadlines. Employees will discover these on their own — admins must get ahead of the discovery or lose trust.", category: 'operational-detail', tagIds: [TAG_IDS.operational, TAG_IDS.risk] },
  { id: Q(82), text: 'Who are the most critical people to retain from the acquired company? What specific retention risk exists for each of them?', intent: "Names and specific risk per person. Retention programs are budget-constrained; this list determines allocation.", category: 'people-dynamics', tagIds: [TAG_IDS.people, TAG_IDS.risk] },
  { id: Q(83), text: 'What is the communication plan for the acquired company\'s employees? What has already been communicated, and what remains to be said?', intent: "Separate what's been said from what's still pending. Message consistency across leaders is where integrations win or lose employee confidence.", category: 'people-dynamics', tagIds: [TAG_IDS.people, TAG_IDS.operational] },
  { id: Q(84), text: 'Are there employment law, works council, or union considerations that constrain how we can proceed?', intent: "Flag jurisdictional constraints that alter integration sequencing. Works council consultation in the EU alone can add months.", category: 'risk-surface', tagIds: [TAG_IDS.risk, TAG_IDS.operational] },
  // VP Legal / General Counsel
  { id: Q(85), text: 'What material contracts have change-of-control provisions triggered by this acquisition? What is the status of notification or consent for each?', intent: "Build the contract-notification tracker. Each row has a deadline and a consent status — missing any is an unforced legal error.", category: 'risk-surface', tagIds: [TAG_IDS.risk, TAG_IDS.operational] },
  { id: Q(86), text: 'Are there open or threatened litigation matters at the acquired company that the integration team should be aware of?', intent: "Surface litigation exposure. Integration team needs awareness even when legal owns the matter — communications and people decisions can prejudice cases.", category: 'risk-surface', tagIds: [TAG_IDS.risk] },
  { id: Q(87), text: 'What data processing agreements exist between the acquired company and its customers? Are they compliant with GDPR, CCPA, or other applicable privacy regulations?', intent: "Check DPA/GDPR/CCPA exposure. Data migration or consolidation can trip obligations that didn't apply pre-deal.", category: 'risk-surface', tagIds: [TAG_IDS.risk, TAG_IDS.operational] },
  { id: Q(88), text: 'Are there open indemnification obligations or warranty claims from customer contracts that could become material?', intent: "Identify contingent financial exposure. Claims crystallize at awkward moments — early visibility enables reserve planning.", category: 'risk-surface', tagIds: [TAG_IDS.risk] },
  { id: Q(89), text: 'What legal concerns specific to the integration process itself do you want to flag now, before work begins?', intent: "Distinguish ongoing legal posture from issues specific to the transition — IP transfers, employee assignment, data novation.", category: 'risk-surface', tagIds: [TAG_IDS.risk] },
  // VP PMO
  { id: Q(90), text: 'What projects are currently in flight across the acquired company? Which ones are on the critical path and cannot be disrupted?', intent: "Critical-path projects integration must not disrupt. Determines which workstreams need isolation vs. re-prioritization.", category: 'operational-detail', tagIds: [TAG_IDS.operational, TAG_IDS.risk] },
  { id: Q(91), text: 'What project or program failures in the past 12–18 months should inform how we approach this integration?', intent: "Draw on recent incident memory. Organizations repeat failure modes — the integration approach should explicitly counter them.", category: 'risk-surface', tagIds: [TAG_IDS.risk, TAG_IDS.operational] },
  { id: Q(92), text: 'What dependencies exist between in-flight projects and integration workstreams that we need to map and manage?', intent: "Map where in-flight work shares resources or sequencing with integration. Dependency conflicts stay invisible until they aren't.", category: 'operational-detail', tagIds: [TAG_IDS.operational, TAG_IDS.risk] },
  { id: Q(93), text: 'Who are the most effective project leaders at the acquired company who should be brought into the integration workstream structure?', intent: "Names of people to co-opt into integration workstreams. Integration tempo follows leader quality.", category: 'people-dynamics', tagIds: [TAG_IDS.people, TAG_IDS.operational] },
  { id: Q(94), text: 'What change management capability exists at the acquired company?', intent: "Gauge the muscle the organization has for absorbing change. Thin capacity means integration leadership must bring its own.", category: 'operational-detail', tagIds: [TAG_IDS.operational] },
];

// ── Acquired Core (Q100-Q107) ──────────────────────────────────────────────
const acdCoreQuestions: QuestionDef[] = [
  { id: Q(100), text: 'In your own words, why did we make this acquisition? What problem does it solve or what opportunity does it unlock?', intent: "Capture how the acquired leader has internalized the deal rationale. Divergence from the acquiring side's version is the first signal of narrative misalignment that must be reconciled.", category: 'strategic-intent', tagIds: [TAG_IDS.strategic] },
  { id: Q(101), text: 'What does success look like for you personally, 12 months from now? What would make you say this integration went well?', intent: "Understand what 'winning' looks like to this person. Their definition often reveals quieter motivations — autonomy, team protection, product continuity — that the acquirer must hear.", category: 'strategic-intent', tagIds: [TAG_IDS.strategic] },
  { id: Q(102), text: 'What is the single thing you are most worried about in this integration?', intent: "The acquired-side top-of-mind risk. If hedged, the hesitation itself is data — create space rather than pressing.", category: 'risk-surface', tagIds: [TAG_IDS.risk] },
  { id: Q(103), text: 'Is there anything important about your company that you believe the integration team may underestimate or overlook?', intent: "The highest-value answer in the core. Extract tacit knowledge the acquirer has no other way to learn.", category: 'risk-surface', tagIds: [TAG_IDS.strategic, TAG_IDS.risk] },
  { id: Q(104), text: 'What, if anything, about your company should be preserved exactly as-is?', intent: "Identify the non-negotiables from the acquired side. These often surprise the acquirer — getting them on record early prevents later conflicts.", category: 'strategic-intent', tagIds: [TAG_IDS.strategic] },
  { id: Q(105), text: 'What decisions are already made and should not be re-opened? What is still genuinely up for discussion?', intent: "The acquired leader's belief about what's settled. Misperception here is a dangerous mismatch with the acquirer's view — flag any gap for reconciliation.", category: 'operational-detail', tagIds: [TAG_IDS.strategic] },
  { id: Q(106), text: 'What is your read on the relationship between the two leadership teams right now? Where is there trust, and where is there friction?', intent: "Trust and friction from the acquired side. Often diverges from the acquirer's read — both versions are data.", category: 'people-dynamics', tagIds: [TAG_IDS.people] },
  { id: Q(107), text: 'What would cause you to intervene directly in the integration? What threshold signals a problem serious enough to need your personal attention?', intent: "Define escalation from the acquired leader's perspective. Contract for when to loop them in — and preservation of their authority within their own organization.", category: 'risk-surface', tagIds: [TAG_IDS.risk, TAG_IDS.operational] },
];

// ── Acquired CEO/Founder (Q110-Q115) + Probes (Q116-Q120) ─────────────────
const acdCeoQuestions: QuestionDef[] = [
  { id: Q(110), text: 'Before we get into specifics — what were you building, and what were you most proud of?', intent: "Start backward-looking and pride-enabling. The answer frames everything after it — and often reveals the cultural DNA the integration must protect.", category: 'strategic-intent', tagIds: [TAG_IDS.strategic, TAG_IDS.safety] },
  { id: Q(111), text: 'What was your personal motivation for agreeing to this acquisition? What outcome for your company — and for yourself — were you hoping for?', intent: "Surface the personal calculus — financial, strategic, exhaustion, vision alignment. Founders rarely volunteer this; what is said here shapes retention and role expectations.", category: 'strategic-intent', tagIds: [TAG_IDS.strategic, TAG_IDS.safety] },
  { id: Q(112), text: 'What do you most want the acquiring company to understand about how your company operates that might not be obvious from the outside?', intent: "Extract cultural and operational invariants that diligence missed. The integration team's most common mistake is assuming they've seen the company they acquired.", category: 'strategic-intent', tagIds: [TAG_IDS.strategic, TAG_IDS.safety] },
  { id: Q(113), text: 'What are you most worried about losing in this integration?', intent: "Force naming of the specific fears. 'Culture' is too vague — keep pressing for concrete things: people, practices, products, pace.", category: 'risk-surface', tagIds: [TAG_IDS.risk, TAG_IDS.safety] },
  { id: Q(114), text: 'Are there commitments you made to your team, your customers, or your investors that the integration team should know about?', intent: "Enumerate promises the founder considers binding. Breaking one of these costs the integration credibility disproportionate to its material impact.", category: 'risk-surface', tagIds: [TAG_IDS.risk, TAG_IDS.operational] },
  { id: Q(115), text: 'Is there anything you haven\'t been asked yet that you think the integration team needs to know?', intent: "The safety valve. Give it space — the most important content in the interview often surfaces only after this open-ended prompt.", category: 'strategic-intent', tagIds: [TAG_IDS.safety, TAG_IDS.strategic] },
];

const acdCeoProbes: QuestionDef[] = [
  { id: Q(116), text: 'Was there a specific moment or milestone that stands out as defining what made this company different?', intent: "Anchor the founder's origin story to a concrete moment. Stories travel further than abstractions in post-close communications.", category: 'strategic-intent', tagIds: [TAG_IDS.strategic, TAG_IDS.safety] },
  { id: Q(117), text: 'Beyond the financial outcome — were there mission or product goals that this acquisition advances?', intent: "Probe for mission alignment beyond the check. Mission-aligned founders stay; transactionally-motivated founders leave — this calibrates retention expectations.", category: 'strategic-intent', tagIds: [TAG_IDS.strategic, TAG_IDS.safety] },
  { id: Q(118), text: 'Can you give me a concrete example — a decision you made that illustrates that culture in action?', intent: "A specific decision that illustrates the claimed culture. Forces the answer past buzzwords into behavior the integration can actually preserve or replicate.", category: 'strategic-intent', tagIds: [TAG_IDS.strategic, TAG_IDS.safety] },
  { id: Q(119), text: 'Which specific people are you most concerned about? What would it take to retain them?', intent: "Name the people and what it would take. Generic concern becomes a retention plan only once specific.", category: 'people-dynamics', tagIds: [TAG_IDS.people, TAG_IDS.risk] },
  { id: Q(120), text: 'Sometimes commitments are implicit — things people understood to be true. Are there any of the implicit kind we should know about?', intent: "Unwritten understandings — 'we always do X,' 'we never Y.' Culture-binding rules that show up in no contract but govern the place. Miss them and trust evaporates.", category: 'risk-surface', tagIds: [TAG_IDS.risk, TAG_IDS.operational] },
];

// ── Acquired CTO/CIO (Q130-Q135) + Probes (Q136-Q137) ─────────────────────
const acdCtoQuestions: QuestionDef[] = [
  { id: Q(130), text: 'Walk me through the system the way you\'d explain it to a new senior engineer joining your team. What\'s the architecture, what are you proud of, and what would you warn them about?', intent: "A voluntary tour — proud points and warnings alike. The voluntary warnings are the valuable part; if none surface, use the fragile-areas probe.", category: 'operational-detail', tagIds: [TAG_IDS.operational, TAG_IDS.safety] },
  { id: Q(131), text: 'What technical decisions have you made that you\'d make differently if you were starting over today?', intent: "Honest rearview. Decisions the CTO already regrets shouldn't be entrenched by integration — and often reveal unspoken remediation wishes.", category: 'risk-surface', tagIds: [TAG_IDS.risk, TAG_IDS.operational] },
  { id: Q(132), text: 'What does your team do exceptionally well that you\'d want the acquiring company to adopt or learn from — rather than replace?', intent: "Counter the 'integration = absorption' default. Captures practices the acquiring side should learn from — often the single most generative prompt in the session.", category: 'strategic-intent', tagIds: [TAG_IDS.strategic, TAG_IDS.safety] },
  { id: Q(133), text: 'Which engineers on your team are most critical to retain? What would each of them walk out the door with if they left?', intent: "Names, criticality, and knowledge loss if they leave. Informs both retention spend and knowledge-capture urgency.", category: 'people-dynamics', tagIds: [TAG_IDS.people, TAG_IDS.risk] },
  { id: Q(134), text: 'What AI or automation work is currently underway on your team? What\'s working, what\'s been abandoned, and what\'s on the roadmap?', intent: "What's working, abandoned, and on the roadmap. Prevents integration from forcing a redo of work the team has already validated or ruled out.", category: 'strategic-intent', tagIds: [TAG_IDS.strategic, TAG_IDS.operational] },
  { id: Q(135), text: 'What should the acquiring company\'s technical leadership understand about your team that won\'t be obvious from an org chart or a codebase review?', intent: "Implicit team norms, decision rights, collaboration patterns. These shape whether integration feels respectful or colonial.", category: 'people-dynamics', tagIds: [TAG_IDS.safety, TAG_IDS.people] },
];

const acdCtoProbes: QuestionDef[] = [
  { id: Q(136), text: 'Every system has areas where the team moves carefully. What are yours?', intent: "Called when the walkthrough skipped warnings. The 'moves carefully' framing is psychologically safer and usually surfaces what was initially held back.", category: 'risk-surface', tagIds: [TAG_IDS.risk, TAG_IDS.operational] },
  { id: Q(137), text: 'For each of those people — what would make them want to stay? What are they most uncertain about right now?', intent: "Person-by-person uncertainty and stay drivers. Targeted retention spend starts here.", category: 'people-dynamics', tagIds: [TAG_IDS.people, TAG_IDS.risk] },
];

// ── Acquired Data & Product (Q150-Q157) + Probes (Q158-Q159) ───────────────
// CPO/VP Product (150-153), VP Data & Analytics (154-157)
const acdDataProdQuestions: QuestionDef[] = [
  // CPO/VP Product
  { id: Q(150), text: 'What is the product you\'re most proud of shipping? What problem does it solve and why does it matter?', intent: "Let them lead with the product's thesis in their own words. Gives the integration team language to use when advocating for the product internally.", category: 'strategic-intent', tagIds: [TAG_IDS.strategic, TAG_IDS.safety] },
  { id: Q(151), text: 'What have you committed to customers on the roadmap that the integration must protect — and what is at risk of being deprioritized or dropped?', intent: "Customer-facing roadmap promises. Quietly dropping any of these costs customer trust at a particularly fragile moment.", category: 'risk-surface', tagIds: [TAG_IDS.risk, TAG_IDS.operational] },
  { id: Q(152), text: 'Where do you believe your product is genuinely ahead of the acquiring company\'s? Where do you think you\'d lose a head-to-head comparison?', intent: "Force honest competitive self-assessment. Generous self-ratings waste integration decisions; if hedging appears, fall back to the survivorship framing.", category: 'strategic-intent', tagIds: [TAG_IDS.strategic] },
  { id: Q(153), text: 'What would a product integration that goes well look like versus one that goes badly? What\'s the specific difference?', intent: "Specific markers, not feelings. Good answers describe users, workflows, and decisions — not 'alignment' or 'synergy.'", category: 'strategic-intent', tagIds: [TAG_IDS.strategic, TAG_IDS.risk] },
  // VP Data & Analytics
  { id: Q(154), text: 'What known data quality issues exist in production? Are there datasets that leadership relies on but that the data team knows are unreliable?', intent: "Surface the gap between what leadership reports and what data engineers know. Integration builds on whatever's underneath — not the deck version.", category: 'risk-surface', tagIds: [TAG_IDS.risk] },
  { id: Q(155), text: 'What customer, financial, or operational data needs to be migrated, merged, or reconciled with the acquiring company\'s systems?', intent: "Map concrete data movement scope. Each item implies a migration plan, a reconciliation rule, and a business owner.", category: 'operational-detail', tagIds: [TAG_IDS.operational, TAG_IDS.risk] },
  { id: Q(156), text: 'Are there active data sharing agreements, API integrations, or data feeds with customers or partners that must be maintained?', intent: "External integration contracts that can't be paused. Each one is both a migration constraint and a notification obligation.", category: 'risk-surface', tagIds: [TAG_IDS.risk, TAG_IDS.operational] },
  { id: Q(157), text: 'What AI or ML models are currently in production? Who owns them and how are they monitored?', intent: "Most ML in production is ambiguously owned; integration without clear ownership is how models silently go stale. Force the ownership answer.", category: 'operational-detail', tagIds: [TAG_IDS.operational, TAG_IDS.strategic] },
];

const acdDataProdProbes: QuestionDef[] = [
  { id: Q(158), text: 'I\'m asking because the integration team needs to make honest survivorship decisions. Your candid read is more useful than a polished one.', intent: "Reframe to make candor easier when the product leader is hedging on competitive honesty. The job is survivorship decisions — candid input serves that better than optimism.", category: 'strategic-intent', tagIds: [TAG_IDS.strategic] },
  { id: Q(159), text: 'What would the impact be of a 2–4 week disruption to the data and analytics environment during a migration?', intent: "Quantify disruption tolerance. Migration plans need a concrete disruption budget; 'as little as possible' isn't planning.", category: 'risk-surface', tagIds: [TAG_IDS.risk] },
];

// ── Acquired CHRO/VP People (Q170-Q174) + Probes (Q175-Q177) ───────────────
const acdPeopleQuestions: QuestionDef[] = [
  { id: Q(170), text: 'How is the team doing right now, honestly? What are you hearing from people about how they\'re feeling about this acquisition?', intent: "An invitation, not a survey question. The quality of the word 'honestly' matters — pause for space. If the answer stays rosy, use the probe on specific anxieties.", category: 'people-dynamics', tagIds: [TAG_IDS.people, TAG_IDS.safety] },
  { id: Q(171), text: 'Which employees are most at risk of leaving — not because of performance, but because of uncertainty or because they have options?', intent: "Names — or at least functions and levels. 'Uncertainty' and 'options' both matter — flight risk isn't only performance-correlated.", category: 'people-dynamics', tagIds: [TAG_IDS.people, TAG_IDS.risk] },
  { id: Q(172), text: 'Are there compensation, equity, or benefits gaps between the two companies that employees are already aware of or will discover soon?', intent: "Employees compare notes faster than integration teams plan disclosures. Anything the CHRO already knows is a landmine must be actively addressed, not hoped-away.", category: 'operational-detail', tagIds: [TAG_IDS.people, TAG_IDS.risk] },
  { id: Q(173), text: 'What about this company\'s culture is hardest to describe but most important to preserve?', intent: "Force articulation of the inarticulable. The quality of the answer is itself a culture-preservation diagnostic.", category: 'strategic-intent', tagIds: [TAG_IDS.strategic, TAG_IDS.people] },
  { id: Q(174), text: 'What do you need from the integration team to protect the people on your team through this transition?', intent: "A direct ask. Whatever the CHRO says here becomes a concrete commitment the integration leadership must decide to keep or renegotiate.", category: 'people-dynamics', tagIds: [TAG_IDS.people, TAG_IDS.safety] },
];

const acdPeopleProbes: QuestionDef[] = [
  { id: Q(175), text: 'Even when people are broadly supportive, they usually have specific anxieties. What are the most common ones?', intent: "Called when the team answer stays rosy. Broad support nearly always has specific anxieties underneath — naming them is the first step to addressing them.", category: 'people-dynamics', tagIds: [TAG_IDS.people, TAG_IDS.safety] },
  { id: Q(176), text: 'Even directionally — which functions or levels are most unsettled?', intent: "Safer framing when naming individuals feels unsafe. Functions and levels still inform where retention investment goes.", category: 'people-dynamics', tagIds: [TAG_IDS.people, TAG_IDS.risk] },
  { id: Q(177), text: 'Can you give me an example of a decision — a hiring decision, a management decision — that reflects that culture concretely?', intent: "A specific decision — hiring, firing, management — that reflects the culture claim. Moves the conversation from adjectives to behavior.", category: 'strategic-intent', tagIds: [TAG_IDS.people, TAG_IDS.strategic] },
];

// ── Acquired Tech & Infrastructure — Mirrored (Q190-Q204) ──────────────────
const acdTechInfQuestions: QuestionDef[] = [
  { id: Q(190), text: 'What end-of-life or unsupported infrastructure is currently in production at your company? What has been deferred for remediation?', intent: "Enumerate what's past support. What the team knows is past-due is information, not confession — acquired-side framing: capture, don't judge.", category: 'risk-surface', tagIds: [TAG_IDS.risk] },
  { id: Q(191), text: 'What are the most fragile or single-point-of-failure systems in your current environment?', intent: "The systems the team handles with care. Being honest here protects the team; hiding it delays the inevitable problem.", category: 'risk-surface', tagIds: [TAG_IDS.risk] },
  { id: Q(192), text: 'What managed service providers or outsourced infrastructure contracts exist at your company? What are the terms and notice periods?', intent: "Vendor map and notice windows. Every contract becomes a decision: renew, renegotiate, sunset — each with its own timing.", category: 'operational-detail', tagIds: [TAG_IDS.operational, TAG_IDS.risk] },
  { id: Q(193), text: 'What monitoring and observability tooling is in place at your company? How mature is alerting and incident response?', intent: "Whether the team sees problems in time. Weak observability compounds every integration risk; honest assessment here protects everyone.", category: 'operational-detail', tagIds: [TAG_IDS.operational, TAG_IDS.risk] },
  { id: Q(194), text: 'Walk me through your current infrastructure footprint — cloud providers, data centers, co-location, and on-premises.', intent: "Complete ledger — including the corners that weren't in the data room. On-prem pockets, sandbox accounts, and shadow-IT assets all count.", category: 'operational-detail', tagIds: [TAG_IDS.operational] },
  { id: Q(195), text: 'What security certifications or compliance frameworks is your company currently operating under?', intent: "Active compliance frameworks. These set the floor integration activity must not fall below.", category: 'operational-detail', tagIds: [TAG_IDS.risk, TAG_IDS.operational] },
  { id: Q(196), text: 'Are any of those certifications currently in scope, in audit, or pending renewal? What would integration activity put at risk?', intent: "Audit windows integration could disrupt. Prioritize integration activity around these timelines, not vice versa.", category: 'risk-surface', tagIds: [TAG_IDS.risk] },
  { id: Q(197), text: 'Have there been any security incidents, data breaches, or regulatory investigations at your company in the past 24 months?', intent: "Honest incident history. Post-close surprises here erode acquirer trust; upfront disclosure earns it.", category: 'risk-surface', tagIds: [TAG_IDS.risk] },
  { id: Q(198), text: 'What penetration testing or red team activity has been conducted recently at your company? What findings remain open?', intent: "Remediation backlog. Integration can inherit these; early visibility enables sequencing.", category: 'risk-surface', tagIds: [TAG_IDS.risk] },
  { id: Q(199), text: 'What security concerns do you have specifically about the integration process itself — not the steady state, but the transition period?', intent: "Transition-specific exposures: dual-admin, credential rotation, trust-boundary changes. Different from steady-state — treat separately.", category: 'risk-surface', tagIds: [TAG_IDS.risk] },
  { id: Q(200), text: 'What is the current state of your CI/CD pipeline and development tooling? How automated is the path from code to production?', intent: "Path-to-prod maturity. Affects integration-change risk directly; weak CI/CD means integration changes will break things quietly.", category: 'operational-detail', tagIds: [TAG_IDS.operational] },
  { id: Q(201), text: 'Where is the most significant technical debt in your product? What has been deliberately deferred and what is genuinely unknown?', intent: "Honest debt map. The 'unknown' category is where integration surprises come from — force it into the conversation.", category: 'risk-surface', tagIds: [TAG_IDS.risk, TAG_IDS.operational] },
  { id: Q(202), text: 'How does your engineering team feel about this acquisition? What are the most common concerns you\'re hearing?', intent: "What the team is actually saying. Acquired-side engineering morale is fragile — invest in hearing it accurately before filling in assumptions.", category: 'people-dynamics', tagIds: [TAG_IDS.people, TAG_IDS.risk] },
  { id: Q(203), text: 'Which engineers are most critical to retain? What retention risk exists and what has already been done?', intent: "Names plus what each knows that no one else does. Retention is both compensation and knowledge-transfer decisions.", category: 'people-dynamics', tagIds: [TAG_IDS.people, TAG_IDS.risk] },
  { id: Q(204), text: 'What AI coding tools or automation are currently in use by your engineering team? What has been tried and abandoned?', intent: "Tooling history. Integration often forces a tool convergence; knowing what was already tried saves re-litigation.", category: 'operational-detail', tagIds: [TAG_IDS.operational, TAG_IDS.strategic] },
];

// ── Acquired Commercial Operations — Mirrored (Q210-Q223) ──────────────────
const acdCommOpsQuestions: QuestionDef[] = [
  { id: Q(210), text: 'What customer-facing commitments — contractual, verbal, or implied — were made to your customers during or after the deal announcement?', intent: "Commitments the acquired team made or perceives were made. Verbal and implied dominate here; missing any creates the first wave of customer churn.", category: 'risk-surface', tagIds: [TAG_IDS.risk, TAG_IDS.operational] },
  { id: Q(211), text: 'Are there customers who are at meaningful churn risk? Who are they and what would stabilize them?', intent: "At-risk accounts the acquired-side team knows about. Often differs from the acquirer's list — both lists matter.", category: 'risk-surface', tagIds: [TAG_IDS.risk, TAG_IDS.strategic] },
  { id: Q(212), text: 'Are there contracts that contain change-of-control provisions that need to be actively managed?', intent: "Customer contracts needing active management. Each has a notification window and a decision — ignoring either costs the deal.", category: 'risk-surface', tagIds: [TAG_IDS.risk, TAG_IDS.operational] },
  { id: Q(213), text: 'What cross-sell or upsell opportunities does this acquisition unlock from your perspective? Which are time-sensitive?', intent: "Opportunities the acquired team sees. Their knowledge of the customer is superior to the acquirer's on these accounts.", category: 'strategic-intent', tagIds: [TAG_IDS.strategic] },
  { id: Q(214), text: 'Which of your customers are at meaningful churn risk right now — before any integration disruption — and what are the reasons?', intent: "Separate pre-deal churn from deal-induced churn. Integration gets blamed for the former without this distinction.", category: 'risk-surface', tagIds: [TAG_IDS.risk] },
  { id: Q(215), text: 'Are there customers who have a strong personal relationship with someone on your team who may be leaving?', intent: "Accounts held by individuals who may depart. These need planned relationship transitions in parallel with any system changes.", category: 'people-dynamics', tagIds: [TAG_IDS.risk, TAG_IDS.people] },
  { id: Q(216), text: 'What commitments — service levels, named contacts, response times — have been made to your customers in ways not captured in contracts?', intent: "Verbal SLAs, named contacts, response norms. They feel contractual to customers — and behave that way in churn analyses.", category: 'risk-surface', tagIds: [TAG_IDS.risk, TAG_IDS.operational] },
  { id: Q(217), text: 'What do your customers most value about working with your team that they\'re afraid they\'ll lose?', intent: "Intangibles customers associate with the team. Design constraint for any customer-facing integration change.", category: 'strategic-intent', tagIds: [TAG_IDS.strategic, TAG_IDS.risk] },
  { id: Q(218), text: 'Are there customer contracts that contain SLA penalties, service credits, or termination clauses that could be triggered during the transition?', intent: "Contract tripwires. Prioritize customer-facing integration plans around these.", category: 'risk-surface', tagIds: [TAG_IDS.risk] },
  { id: Q(219), text: 'Walk me through your full commercial technology stack — CRM, marketing automation, CPQ, billing, revenue recognition, BI.', intent: "Stack inventory. Without the full list, migration scope is guesswork.", category: 'operational-detail', tagIds: [TAG_IDS.operational] },
  { id: Q(220), text: 'What is the current state of your CRM data quality — contact completeness, account hierarchy, opportunity hygiene?', intent: "Honest CRM hygiene. The baseline for every commercial-integration decision.", category: 'operational-detail', tagIds: [TAG_IDS.operational, TAG_IDS.risk] },
  { id: Q(221), text: 'Are there customizations, automations, or integrations in your CRM not documented anywhere and live only in someone\'s head?', intent: "One-person-in-their-head automations. Single highest-risk category for post-migration regression.", category: 'risk-surface', tagIds: [TAG_IDS.risk, TAG_IDS.operational] },
  { id: Q(222), text: 'What is the most important data in your commercial systems that must not be lost or degraded in a migration?', intent: "Data that cannot degrade. Informs integrity-test and rollback strategy.", category: 'risk-surface', tagIds: [TAG_IDS.risk, TAG_IDS.operational] },
  { id: Q(223), text: 'What rev ops work is currently in flight that would be disrupted if it had to pause?', intent: "Current-state projects integration might disrupt. Protect or re-absorb, but don't surprise.", category: 'operational-detail', tagIds: [TAG_IDS.operational, TAG_IDS.risk] },
];

// ── Acquired Governance & Delivery — Mirrored (Q230-Q244) ──────────────────
const acdGovDelQuestions: QuestionDef[] = [
  { id: Q(230), text: 'Are there redundant roles that will need to be eliminated? Has leadership aligned on the timeline and communication approach?', intent: "Any role the CHRO already anticipates eliminating. The communication plan matters at least as much as the redundancy itself.", category: 'operational-detail', tagIds: [TAG_IDS.operational, TAG_IDS.risk] },
  { id: Q(231), text: 'How do total compensation, benefits, and equity structures compare to the acquiring company\'s? What harmonization is required and by when?', intent: "Harmonization gaps employees will discover. Honest mapping now prevents confidence collapse later.", category: 'operational-detail', tagIds: [TAG_IDS.operational, TAG_IDS.risk] },
  { id: Q(232), text: 'Who are the most critical people to retain from your company? What specific retention risk exists for each of them?', intent: "Named retention targets and specific risks. Retention spend without names is a campaign, not a plan.", category: 'people-dynamics', tagIds: [TAG_IDS.people, TAG_IDS.risk] },
  { id: Q(233), text: 'What is the communication plan for your employees? What has already been communicated, and what remains to be said?', intent: "What's been said, what's pending. Message consistency between companies is the variable employees use to judge trustworthiness.", category: 'people-dynamics', tagIds: [TAG_IDS.people, TAG_IDS.operational] },
  { id: Q(234), text: 'Are there employment law, works council, or union considerations that constrain how the integration can proceed?', intent: "Jurisdictional constraints. These can add months to integration sequencing — catch them now, not in discovery.", category: 'risk-surface', tagIds: [TAG_IDS.risk, TAG_IDS.operational] },
  { id: Q(235), text: 'What material contracts have change-of-control provisions triggered by this acquisition? What is the status of notification or consent for each?', intent: "Contract-notification tracker from the acquired side. Every row has a deadline and a status.", category: 'risk-surface', tagIds: [TAG_IDS.risk, TAG_IDS.operational] },
  { id: Q(236), text: 'Are there open or threatened litigation matters that the integration team should be aware of?', intent: "Litigation integration leadership must know about. Not to resolve — to avoid prejudicing with communications or people decisions.", category: 'risk-surface', tagIds: [TAG_IDS.risk] },
  { id: Q(237), text: 'What data processing agreements exist between your company and its customers? Are they compliant with GDPR, CCPA, or other applicable privacy regulations?', intent: "DPA / GDPR / CCPA exposure. Data movement during integration can trip obligations that didn't apply pre-deal.", category: 'risk-surface', tagIds: [TAG_IDS.risk, TAG_IDS.operational] },
  { id: Q(238), text: 'Are there open indemnification obligations or warranty claims from customer contracts that could become material?', intent: "Claims that could become material. Early visibility enables reserve planning.", category: 'risk-surface', tagIds: [TAG_IDS.risk] },
  { id: Q(239), text: 'What legal concerns specific to the integration process itself do you want to flag now, before work begins?', intent: "IP assignments, employee transfer, data novation. Different from steady-state legal posture — handle explicitly.", category: 'risk-surface', tagIds: [TAG_IDS.risk] },
  { id: Q(240), text: 'What projects are currently in flight at your company? Which ones are on the critical path and cannot be disrupted?', intent: "Critical-path projects the integration must not disrupt. Plan around them or absorb them deliberately.", category: 'operational-detail', tagIds: [TAG_IDS.operational, TAG_IDS.risk] },
  { id: Q(241), text: 'What project or program failures in the past 12–18 months should inform how we approach this integration?', intent: "Organizational failure patterns. Integration should counter known failure modes, not replicate them.", category: 'risk-surface', tagIds: [TAG_IDS.risk, TAG_IDS.operational] },
  { id: Q(242), text: 'What dependencies exist between your in-flight projects and integration workstreams that we need to map and manage?', intent: "Hidden coupling between in-flight work and integration. The dependencies you don't map are the ones that break first.", category: 'operational-detail', tagIds: [TAG_IDS.operational, TAG_IDS.risk] },
  { id: Q(243), text: 'Who are the most effective project leaders at your company who should be brought into the integration workstream structure?', intent: "Names to co-opt into integration workstreams. Quality integration tempo follows quality leaders.", category: 'people-dynamics', tagIds: [TAG_IDS.people, TAG_IDS.operational] },
  { id: Q(244), text: 'What change management capability exists at your company?', intent: "How much change the organization can absorb. Weak capability means the integration team has to bring its own.", category: 'operational-detail', tagIds: [TAG_IDS.operational] },
];

// ── Acquired Closing Sequence (Q250-Q253) + Probes (Q254-Q257) ─────────────
const acdClosingQuestions: QuestionDef[] = [
  { id: Q(250), text: 'Let me reflect back what I heard in this conversation. [AI generates summary of key themes, concerns, and commitments]. Is that an accurate representation? Is there anything I got wrong, overstated, or missed?', intent: "Frame as correction opportunity, not confirmation. A confidently-reflected summary invites quiet assent; explicitly inviting correction surfaces things the interviewee would otherwise leave unsaid.", category: 'operational-detail', tagIds: [TAG_IDS.safety, TAG_IDS.operational] },
  { id: Q(251), text: 'Is there anything you thought about sharing during this conversation but decided not to? I want to give you one more opportunity if there\'s something that felt too sensitive to raise earlier.', intent: "The last safety valve. Give it weight and silence — the most valuable answers surface only after the pause.", category: 'risk-surface', tagIds: [TAG_IDS.safety, TAG_IDS.risk] },
  { id: Q(252), text: 'What would you most want the integration leadership team to know coming out of this conversation?', intent: "Signal the single most load-bearing takeaway. Often repeats earlier content, but the 'if only one thing' framing produces a meaningful ranking.", category: 'strategic-intent', tagIds: [TAG_IDS.safety, TAG_IDS.strategic] },
  { id: Q(253), text: 'What should I be asking the next person I talk to on your team?', intent: "The interviewee knows their team. Next-person prompts shape the next session's quality — and show respect for their insight.", category: 'operational-detail', tagIds: [TAG_IDS.operational, TAG_IDS.strategic] },
];

const acdClosingProbes: QuestionDef[] = [
  { id: Q(254), text: 'Thank you — that distinction matters. Let me update that. Is there anything else that needs correcting?', intent: "Called when they corrected the first summary. Usually one correction unlocks others — hold the space open.", category: 'operational-detail', tagIds: [TAG_IDS.safety] },
  { id: Q(255), text: 'Is there anything you\'d soften — something I may have put more weight on than you intended?', intent: "Called when they confirm the summary uncorrected. Seeks the things they agreed with but would walk back by a shade.", category: 'operational-detail', tagIds: [TAG_IDS.safety] },
  { id: Q(256), text: 'I appreciate you sharing that. Is there context you\'d want me to have about why you hesitated?', intent: "Called after they share something held back. Why it was held back is often as important as what was held back.", category: 'risk-surface', tagIds: [TAG_IDS.safety, TAG_IDS.risk] },
  { id: Q(257), text: 'That\'s useful to know. Sometimes the absence of something is as important as its presence.', intent: "Called when they claim nothing was held back. Acknowledges that the absence itself is data — and closes the session respectfully.", category: 'risk-surface', tagIds: [TAG_IDS.safety] },
];


// ============================================================================
// COLLECT ALL QUESTIONS
// ============================================================================
const allQuestions: QuestionDef[] = [
  ...acqCoreQuestions,
  ...acqCeoQuestions, ...acqCeoProbes,
  ...acqCfoQuestions,
  ...acqCtoQuestions,
  ...acqTechInfQuestions,
  ...acqCommOpsQuestions,
  ...acqGovDelQuestions,
  ...acdCoreQuestions,
  ...acdCeoQuestions, ...acdCeoProbes,
  ...acdCtoQuestions, ...acdCtoProbes,
  ...acdDataProdQuestions, ...acdDataProdProbes,
  ...acdPeopleQuestions, ...acdPeopleProbes,
  ...acdTechInfQuestions,
  ...acdCommOpsQuestions,
  ...acdGovDelQuestions,
  ...acdClosingQuestions, ...acdClosingProbes,
];


// ============================================================================
// TEMPLATE DESCRIPTIONS (System Prompt Guidance)
// ============================================================================
const DESCRIPTIONS = {
  acqCore: `You are conducting the core intake interview for an acquiring-company stakeholder in a post-close M&A integration. These questions are asked of every C-suite and VP-level interviewee before any role-specific questions.

Your goal is to establish each individual's personal understanding of why the acquisition happened, what success looks like, what risks they see, and how they perceive the relationship between the two organizations.

Behavioral guidance:
- Ask each question as written. Do not paraphrase.
- Allow the interviewee to answer fully before moving on.
- If an answer is vague or overly brief, probe once for specificity: "Can you say more about what you mean by that?" or "Can you give me a concrete example?"
- Do not challenge or push back on answers. Your role is to capture their perspective accurately.
- Alternate between category buckets where possible to maintain conversational flow.`,

  acqCeo: `You are conducting the CEO/President-specific portion of an acquiring-company integration interview. The core questions have already been completed.

Interview goals:
- Understand the strategic thesis and what must be true for it to be validated
- Surface the speed-vs-preservation tradeoff as the CEO sees it
- Identify board-level commitments and constraints
- Learn who on the leadership team is most and least invested

Behavioral guidance:
- These are senior executives — be direct and efficient with their time.
- If they reference something from the core interview, acknowledge it and build on it rather than re-asking.
- Probe for specificity on timelines and commitments: "When you say 'early value capture,' what does that look like concretely?"
- Note any tension between stated strategic intent and operational reality — this feeds conflict detection.`,

  acqCfo: `You are conducting the CFO-specific portion of an acquiring-company integration interview. The core questions have already been completed.

Interview goals:
- Identify committed synergy targets and their timelines
- Understand which financial systems are in scope for consolidation
- Surface earn-out provisions or deal mechanics that create integration milestones
- Assess confidence in due diligence financial data
- Understand financial risk tolerance for integration disruption

Behavioral guidance:
- CFOs are precise — match their precision. If they give a number, confirm it.
- Probe for what's committed to the board vs. what's aspirational.
- Financial system consolidation timelines are a major source of cross-domain conflict — capture specifics.`,

  acqCto: `You are conducting the CTO/CIO-specific portion of an acquiring-company integration interview. The core questions have already been completed.

Interview goals:
- Determine the intended end state for the acquired company's product infrastructure
- Identify business-critical systems that cannot be disrupted
- Surface data sovereignty and contractual data constraints
- Understand AI/automation initiatives and intended direction
- Identify architectural incompatibilities

Behavioral guidance:
- Technical leaders often undersell risk — probe for what keeps them up at night.
- Ask for specifics on "parallel operation" timelines — these frequently conflict with CFO synergy targets.
- AI/automation questions should capture what exists at both companies, not just the acquired one.`,

  acqTechInf: `You are conducting a technology and infrastructure domain interview for the acquiring side. This template covers VP Infrastructure, VP Security, and VP Engineering roles.

Interview goals:
- Map the full infrastructure footprint, including end-of-life and fragile systems
- Identify security certifications at risk from integration activity
- Assess engineering team sentiment, retention risk, and technical debt
- Understand CI/CD maturity and development tooling
- Surface AI coding tools and automation in use

Behavioral guidance:
- Adapt your framing based on which VP role you are interviewing — infrastructure concerns differ from security concerns differ from engineering concerns.
- These roles carry operational detail that C-suite may not have. Capture specifics: system names, vendor names, contract terms, team sizes.
- For security roles, be specific about certification scope and audit timelines.
- For engineering roles, listen for morale signals — how the team "feels" is as important as what they build.`,

  acqCommOps: `You are conducting a commercial operations domain interview for the acquiring side. This template covers CRO/VP Sales, VP Customer Success, and VP Revenue Operations roles.

Interview goals:
- Surface customer-facing commitments made during or after the deal
- Identify customers at churn risk and what would stabilize them
- Map the full commercial technology stack (CRM, CPQ, billing, BI)
- Assess CRM data quality and undocumented customizations
- Identify cross-sell opportunities and their time sensitivity

Behavioral guidance:
- Customer-facing roles often know about commitments that aren't documented anywhere. Probe for verbal promises, implied expectations, and "handshake deals."
- CRM migration timing is a frequent conflict source — capture planned timelines carefully.
- For revenue operations, ask about what lives "only in someone's head" — tribal knowledge is integration risk.`,

  acqGovDel: `You are conducting a governance and delivery domain interview for the acquiring side. This template covers CHRO/VP People, VP Legal/General Counsel, and VP PMO roles.

Interview goals:
- Identify redundant roles and the communication plan for eliminations
- Surface compensation and benefits gaps between companies
- Map change-of-control provisions and open litigation
- Understand in-flight projects and cross-dependencies with integration
- Assess change management capability

Behavioral guidance:
- People topics require sensitivity — even on the acquiring side, individuals may feel uncertain about their own roles.
- Legal topics require precision — distinguish between "triggered" and "potentially triggered" provisions.
- PMO roles carry institutional memory about past failures — probe for lessons learned, not just current state.`,

  acdCore: `You are conducting the core intake interview for an acquired-company stakeholder in a post-close M&A integration.

IMPORTANT — Opening framing (deliver before any questions):
Before asking any questions, deliver the following statements in order. These are not optional courtesies — they establish the psychological safety required for candid responses.

1. "Before we start, I want to be clear about what this conversation is and isn't. This isn't an evaluation of you or your team. It isn't being used to make decisions about roles or structure. Its only purpose is to help the integration team understand your company well enough to plan carefully and protect what matters."

2. "You know things about this company that nobody on the integration team knows yet. That knowledge is genuinely valuable — and some of it will disappear if we don't capture it now. I'm here to learn from you."

3. "Is there anything about how this conversation will be used that you'd like to understand before we begin?"

4. "Is there anything you'd want me to know upfront — before I start asking questions — that would help me ask better ones?"

Wait for responses to statements 3 and 4 before proceeding to questions.

Mindset awareness: Interviewees on the acquired side may present as advocates (enthusiastic, may minimize problems), pragmatists (precise but volunteer nothing extra), or defensive/anxious (short answers, hedging). Adapt accordingly: with advocates, redirect toward gaps; with pragmatists, widen the aperture; with defensive interviewees, reinforce safety.

Behavioral guidance:
- The interviewee is the expert. You are here to learn, not to verify or audit.
- Ask each question as written. Do not paraphrase.
- If you sense hesitation, name it gently.
- Do not promise confidentiality you cannot guarantee.`,

  acdCeo: `You are conducting the CEO/Founder-specific portion of an acquired-company integration interview. The core questions and opening framing have already been completed.

Interview goals:
- Understand what was being built and what the founder was most proud of
- Surface the personal motivation behind agreeing to the acquisition
- Capture what the acquiring company might not understand about how this company operates
- Identify what the founder is most afraid of losing
- Surface commitments — explicit and implicit — to team, customers, and investors

Mindset awareness: Founders carry deep emotional investment. Some will be proud advocates, others may be grieving a loss of control. Lead with curiosity and respect.

Behavioral guidance:
- Start with what they built, not what's happening to it. The first question is deliberately backward-looking and pride-enabling.
- Probe for implicit commitments: "Sometimes commitments are implicit — things people understood to be true."
- The final question ("Is there anything you haven't been asked?") is a safety valve. Give it space.`,

  acdCto: `You are conducting the CTO/CIO-specific portion of an acquired-company integration interview. The core questions and opening framing have already been completed.

Interview goals:
- Get an insider's architecture walkthrough — strengths and warnings
- Surface technical decisions they'd make differently today
- Identify what the team does well that should be adopted, not replaced
- Map critical retention targets and what they'd walk out with
- Understand AI/automation work in progress

Mindset awareness: Technical leaders on the acquired side may be protective of their systems and team. Frame questions as learning, not assessment.

Behavioral guidance:
- If they skip warnings about their system, probe: "Every system has areas where the team moves carefully. What are yours?"
- For retention questions, go person-by-person.
- Capture what should be adopted by the acquirer, not just what will be migrated.`,

  acdDataProd: `You are conducting the Data & Product domain interview for the acquired side. This template covers CPO/VP Product and VP Data & Analytics roles.

Interview goals (Product):
- Understand the product they're most proud of shipping
- Surface roadmap commitments the integration must protect
- Get an honest competitive assessment vs. the acquiring company's product
- Understand what good vs. bad integration looks like from their perspective

Interview goals (Data & Analytics):
- Identify known data quality issues that leadership may be relying on
- Map data that must be migrated, merged, or reconciled
- Surface data sharing agreements and API integrations
- Understand AI/ML models in production and their ownership
- Assess impact tolerance for migration disruption

Mindset awareness: Product leaders may feel their product is under threat. Data leaders may feel their work will be dismissed. Both need reassurance you're here to understand, not to rank.

Behavioral guidance:
- For product: encourage candor about competitive positioning.
- For data: probe for what leadership relies on that the data team knows is unreliable.`,

  acdPeople: `You are conducting the CHRO/VP People-specific portion of an acquired-company integration interview. The core questions and opening framing have already been completed.

Interview goals:
- Get an honest read on how the team is doing right now
- Identify flight-risk employees — by name or by function/level
- Surface compensation and benefits gaps employees will discover
- Capture the hardest-to-describe cultural attributes worth preserving
- Understand what the People leader needs from the integration team

Mindset awareness: HR leaders on the acquired side carry the emotional weight of the entire organization. They know who's scared, who's job-hunting, and what the real culture is. They may also feel personally at risk.

Behavioral guidance:
- "How is the team doing right now, honestly?" must feel genuinely inviting, not performative.
- If they resist naming flight risks, go directional: "Even directionally — which functions or levels are most unsettled?"
- Culture questions benefit from concrete examples.`,

  acdTechInf: `You are conducting a technology and infrastructure domain interview for the acquired side. This template covers VP Infrastructure, VP Security, and VP Engineering roles at the acquired company.

This mirrors the acquiring-side Technology & Infrastructure interview but is adapted for the acquired company's context. These individuals may be uncertain about their roles and their systems' futures.

Interview goals: Same technical coverage as acquiring side — infrastructure footprint, security posture, engineering practices. Additionally: surface what the team does well that should be preserved, what they'd warn the acquirer about, and how the team is feeling.

Mindset awareness: Adapt to advocates (redirect to gaps), pragmatists (widen the aperture), and defensive interviewees (reinforce safety).

Behavioral guidance:
- Frame questions as learning: "Walk me through..." rather than "Report on..."
- Probe for what the acquiring company should adopt from this team.
- Engineering morale questions are critical.`,

  acdCommOps: `You are conducting a commercial operations domain interview for the acquired side. This template covers CRO/VP Sales, VP Customer Success, and VP Revenue Operations roles at the acquired company.

Interview goals: Same commercial coverage as acquiring side — customer risk, commercial stack, CRM state. Additionally: surface customer relationships that are personally held, commitments not in contracts, and what customers most value that they fear losing.

Mindset awareness: Adapt to advocates, pragmatists, and defensive interviewees.

Behavioral guidance:
- Customer success roles on the acquired side carry the most sensitive customer relationship intelligence.
- Probe for "what do customers most value about working with your team that they're afraid they'll lose?"
- Revenue operations tribal knowledge is a top integration risk.`,

  acdGovDel: `You are conducting a governance and delivery domain interview for the acquired side. This template covers VP Legal/General Counsel, VP PMO, and People roles at the acquired company.

Interview goals: Same governance coverage as acquiring side — legal provisions, project dependencies, change management. Additionally: surface what the acquired company's people need from the integration team, legal concerns specific to the transition, and which project leaders should join integration workstreams.

Mindset awareness: Adapt to advocates, pragmatists, and defensive interviewees.

Behavioral guidance:
- Legal roles may be guarded about open litigation — reinforce that this is integration planning, not due diligence.
- PMO roles often know about past failures that inform integration approach.`,

  acdClosing: `You are conducting the closing sequence for an acquired-company integration interview. This is run after all substantive questions have been completed.

Purpose: This is not a wrap-up. It serves two critical functions: (1) validation of what was captured — framed as a correction opportunity, not a confirmation, and (2) a final safety valve for anything the interviewee held back.

Behavioral guidance:
- Q1 (reflection): Summarize the key themes, concerns, and commitments from the interview. Ask explicitly: "Is that an accurate representation? Is there anything I got wrong, overstated, or missed?"
- If they correct something, thank them and ask if there's anything else to correct.
- If they confirm, probe gently: "Is there anything you'd soften?"
- Q2 (held back): "Is there anything you thought about sharing but decided not to?" — Give this question space. Do not rush past it.
- Q3 and Q4 are forward-looking: what should leadership know, and what should the next interviewer ask.

Post-interview flags (for system, not spoken to interviewee):
After this interview, flag: (1) any answer that changed materially after being reflected back, (2) any topic the interviewee explicitly declined to address, (3) any answer that conflicts with information already captured from the acquiring side.`,
};


// ============================================================================
// TEMPLATE QUESTION ASSIGNMENTS
// ============================================================================

// Trigger shape expected by TriggerEditor
interface FollowupTrigger {
  type: 'keyword' | 'sentiment' | 'length' | 'always';
  keywords?: string;
  sentiment?: string;
  lengthDescription?: string;
  targetTemplateQuestionIds: string[];
}

// Helper types
interface TQDef {
  id: string;
  templateId: string;
  questionId: string;
  sequenceOrder: number;
  categoryBucket: string;
  isRequired: boolean;
  adminNotes: string | null;
  followupTriggers: FollowupTrigger[];
}

function buildTQs(
  templateId: string,
  questions: QuestionDef[],
  opts: {
    requiredCount?: number;          // first N are required, rest optional
    allRequired?: boolean;           // override: all required
    triggers?: Record<string, { condition: string; followupQuestionId: string }[]>;
    adminNotes?: Record<string, string>;  // keyed by questionId — per-template behavioral guidance
    startSequence?: number;
  } = {}
): TQDef[] {
  const { requiredCount, allRequired = false, triggers = {}, adminNotes = {}, startSequence = 1 } = opts;
  return questions.map((q, i) => ({
    id: tqId(templateId, q.id),
    templateId,
    questionId: q.id,
    sequenceOrder: startSequence + i,
    categoryBucket: q.category,
    isRequired: allRequired ? true : requiredCount !== undefined ? i < requiredCount : true,
    adminNotes: adminNotes[q.id] ?? null,
    followupTriggers: (triggers[q.id] || []).map(t => ({
      type: 'always' as const,
      lengthDescription: t.condition,
      targetTemplateQuestionIds: [tqId(templateId, t.followupQuestionId)],
    })),
  }));
}

// ── Build all template-question associations ────────────────────────────────

const templateQuestions: TQDef[] = [
  // Acquiring Core — all required, no triggers
  ...buildTQs(TMPL.acqCore, acqCoreQuestions, {
    allRequired: true,
    adminNotes: {
      [Q(1)]: 'Cross-role question — every acquiring-side executive answers this. Compare the language they use to what the CEO said; wide divergence flags thesis misalignment for the integration team.',
      [Q(2)]: 'Personal success matters more than corporate metrics here. Note how the answer weights timeline, people, product, and financial — the lens reveals real priorities.',
      [Q(3)]: "If the executive offers a clean, board-ready worry, probe once: 'What's the one you wouldn't want to say on a slide?' The unrehearsed answer is the useful one.",
      [Q(4)]: "Often the most load-bearing answer in the core. If 'nothing comes to mind,' try 'Take a moment — it may feel obvious to you but new to the team.'",
      [Q(5)]: "'Preserve the culture' is a non-answer. Press until specific: a team, a product decision, a meeting cadence, a customer practice.",
      [Q(6)]: "If the answer blurs 'settled' and 'still-being-discussed,' the team itself hasn't aligned. Capture the blur without correcting it — the ambiguity is the finding.",
      [Q(7)]: "Names or functions, not adjectives. If 'it's going great,' probe for where trust hasn't been earned yet.",
      [Q(8)]: "Threshold in their own words. 'Churn hitting 15%' is useful; 'anything serious' isn't. Keep pressing until the number or named condition appears.",
    },
  }),

  // Acquiring CEO — first 3 required, rest optional, with a couple of triggers for testing
  ...buildTQs(TMPL.acqCeo, [...acqCeoQuestions, ...acqCeoProbes], {
    requiredCount: 3,
    triggers: {
      [Q(10)]: [{ condition: 'If the response lacks specific timelines or measurable milestones', followupQuestionId: Q(16) }],
      [Q(14)]: [{ condition: 'If the interviewee mentions specific individuals who have reservations', followupQuestionId: Q(17) }],
    },
    adminNotes: {
      [Q(10)]: "CEOs often state theses at the strategic-narrative level. If the answer doesn't include a measurable milestone at 90d / 6mo / 12mo, follow up explicitly via Q16 — vagueness here becomes misalignment later.",
      [Q(11)]: "Distinguish quick-win capture from compounding-value capture. If the CEO conflates them, the operational teams will disagree with this framing within 60 days.",
      [Q(12)]: "The CEO almost always claims 'both' on first pass. Press for the leaning — 'if you had to pick one to sacrifice at the margin.' The leaning decides workstream priority.",
      [Q(13)]: "Public statements, board decks, and handshakes with the acquired CEO all count. If any are downplayed, flag the under-disclosure — it will surface later from the acquired side.",
      [Q(14)]: "Push for names. 'We're aligned' is almost never true end-to-end; reservations are near-universal. When specific individuals surface, Q17 follows up on the root of their concern.",
      [Q(15)]: "Board interest shapes reporting cadence. 'We'll update them quarterly' is under-engaged — probe what would trigger an unplanned update.",
      [Q(16)]: "Use when Q10 stayed narrative. Gathering the thesis-validation checkpoints the board will use.",
      [Q(17)]: "Use when Q14 named individuals. Distinguish strategic disagreement from execution concern from personal friction — each requires a different intervention.",
    },
  }),

  // Acquiring CFO — first 3 required
  ...buildTQs(TMPL.acqCfo, acqCfoQuestions, {
    requiredCount: 3,
    adminNotes: {
      [Q(20)]: "CFOs are precise. If they round or hedge, press for the committed number. Synergy commits drive every downstream plan — ambiguity here is not safe.",
      [Q(21)]: "Each system in scope implies a migration plan, a finance-ops owner, and a cutover. If the CFO doesn't name systems, the consolidation plan doesn't exist yet.",
      [Q(22)]: "Earn-out dates are non-negotiable. If the CFO can't recite them, flag as a diligence gap — these dates often retroactively drive integration sequencing.",
      [Q(23)]: "Where the CFO 'expects surprises' is where first-week integration diligence should go. Don't settle for 'we're comfortable' — ask which specific line items they're watching.",
      [Q(24)]: "Translate the answer into a concrete disruption budget — dollars of revenue, number of customers, days of delay. 'Low tolerance' is not a budget.",
    },
  }),

  // Acquiring CTO — first 3 required
  ...buildTQs(TMPL.acqCto, acqCtoQuestions, {
    requiredCount: 3,
    adminNotes: {
      [Q(30)]: "The answer sets the end-state for every technical workstream. If it's ambiguous ('somewhere in between'), stop and press — it cannot stay ambiguous.",
      [Q(31)]: "You want a list with system names, not descriptions. If the CTO gives categories ('our customer-facing stuff'), probe for specifics.",
      [Q(32)]: "Data sovereignty answers are often incomplete because engineers own contract obligations ambiguously. If even one constraint surfaces, treat it as a signal there are probably more.",
      [Q(33)]: "Acquiring-side CTOs can be territorial about AI. Listen for kill vs. preserve decisions; kill decisions under-deliberated become integration incidents.",
      [Q(34)]: "Gut read, usually accurate but directional. Capture named systems; if the answer stays abstract, probe with 'what's the first collision you'd hit on day one?'",
    },
  }),

  // Acquiring Tech & Infra — VP Infra first 3 req, VP Security first 3 req, VP Eng first 3 req
  ...buildTQs(TMPL.acqTechInf, acqTechInfQuestions.slice(0, 5), {
    requiredCount: 3,
    adminNotes: {
      [Q(40)]: "VP Infra may soften 'unsupported' into 'on our roadmap.' Press for specific systems and the dates they went past support — the list becomes the remediation backlog.",
      [Q(41)]: "Expect a short list delivered with care — these are the systems the team babies. That care is the signal; capture the names and the workarounds.",
      [Q(42)]: "Notice periods (30/60/90/180d) drive migration sequencing more than most integration plans acknowledge. Missing any of these windows means you either renew or pay penalties.",
      [Q(43)]: "Ask for the last three incidents where monitoring surfaced the problem vs. where customers did. That ratio is the maturity signal.",
      [Q(44)]: "Push for the full list including dev/staging/sandbox and any forgotten corners. Shadow-IT accounts are nearly always under-reported; ask directly about them.",
    },
  }),
  ...buildTQs(TMPL.acqTechInf, acqTechInfQuestions.slice(5, 10), {
    requiredCount: 3,
    startSequence: 6,
    adminNotes: {
      [Q(45)]: "The answer sets the minimum compliance floor for all integration activity. Missing frameworks here (e.g., a HIPAA obligation overlooked) is a legal exposure, not a technical one.",
      [Q(46)]: "Audit windows and integration activity collide badly. If an audit is in scope within the next 6 months, integration sequencing must be adjusted — not the audit.",
      [Q(47)]: "If the answer is 'nothing,' follow up: 'Nothing reportable, or nothing at all?' Reportable-threshold incidents are the ones that matter for deal representations.",
      [Q(48)]: "Open findings inherit into the merged environment. Every open finding is either a remediation commitment or a documented accepted-risk — ambiguity here is risk.",
      [Q(49)]: "Credential sprawl, dual-admin windows, trust-boundary shifts. These are distinct from steady-state concerns — if the VP conflates them, re-frame until they separate cleanly.",
    },
  }),
  ...buildTQs(TMPL.acqTechInf, acqTechInfQuestions.slice(10, 15), {
    requiredCount: 3,
    startSequence: 11,
    adminNotes: {
      [Q(50)]: "Time from commit to production, manual steps, rollback capability. If deploys are ceremonial rather than routine, integration changes will compound the ceremony into downtime.",
      [Q(51)]: "The VP Eng will name what's known. 'Genuinely unknown' requires a different framing — 'where have you had surprises in the last 12 months?' Those are the debt-unknowns.",
      [Q(52)]: "Listen for 'my team is excited' without specifics — usually wishful. If specific anxieties don't surface, probe directly: 'what are the top two things people are asking you about?'",
      [Q(53)]: "Names first, then what each one uniquely knows. Retention spend is cheaper than re-hiring — if the VP can't list names, retention planning hasn't happened.",
      [Q(54)]: "Integration will force tool harmonization. Understanding what the team tried and rejected saves the integration leads from re-litigating decisions.",
    },
  }),

  // Acquiring Commercial Ops
  ...buildTQs(TMPL.acqCommOps, acqCommOpsQuestions.slice(0, 4), {
    requiredCount: 3,
    adminNotes: {
      [Q(60)]: "Verbal and implied dominate here. Ask the CRO to walk through the top 10 accounts — commitments surface that formal review would miss.",
      [Q(61)]: "Named accounts with specific stabilization actions. 'A couple are shaky' isn't planning; names plus the specific intervention are.",
      [Q(62)]: "Each change-of-control clause has a notice window. The CRO should know the status of each — if they don't, legal and commercial haven't been coordinating.",
      [Q(63)]: "Cross-sell windows close as customers re-evaluate. Time-sensitive opportunities need owners assigned in week one, not month three.",
    },
  }),
  ...buildTQs(TMPL.acqCommOps, acqCommOpsQuestions.slice(4, 9), {
    requiredCount: 3,
    startSequence: 5,
    adminNotes: {
      [Q(64)]: "Pre-existing churn, separate from deal-induced. Without this baseline, integration gets blamed for churn that was already in motion.",
      [Q(65)]: "Relationship-held accounts need planned transitions, not generic handoffs. Ask specifically: 'who stays because of who?'",
      [Q(66)]: "Habit-based SLAs. 'We always respond to X in an hour' becomes a contractual-feeling expectation — the CS lead usually knows the list.",
      [Q(67)]: "The intangibles shape design constraints for anything customer-facing. 'They trust us' without specifics isn't actionable; press for the behaviors that earn the trust.",
      [Q(68)]: "Contract tripwires that turn operational disruption into financial hits. Each one needs a risk-adjusted plan before migration begins.",
    },
  }),
  ...buildTQs(TMPL.acqCommOps, acqCommOpsQuestions.slice(9, 14), {
    requiredCount: 2,
    startSequence: 10,
    adminNotes: {
      [Q(69)]: "Full inventory — CRM through BI. Gaps in this list show up as surprises during migration. If the VP RevOps can't recite the stack, there is no coherent ops function.",
      [Q(70)]: "Honest CRM hygiene assessment. The VP RevOps usually knows where the rot is; asking directly respects that knowledge and gets faster answers than polite probes.",
      [Q(71)]: "One-person-in-their-head automations are the #1 cause of post-migration regression. If 'only Dave knows how the commission calc works,' that's a red-flag workstream.",
      [Q(72)]: "Data that cannot degrade under any migration scenario. Becomes migration non-negotiables and the test set for integrity checks.",
      [Q(73)]: "In-flight work that would be disrupted by pause. Each item needs a decision: protect, absorb into integration, or pause with owner sign-off.",
    },
  }),

  // Acquiring Governance & Delivery
  ...buildTQs(TMPL.acqGovDel, acqGovDelQuestions.slice(0, 5), {
    requiredCount: 3,
    adminNotes: {
      [Q(80)]: "Timeline + communication approach matter as much as the redundancy itself. Botched comms on reductions destroy trust with the retained population faster than anything else.",
      [Q(81)]: "Harmonization gaps employees will discover on Glassdoor within a week. Honest mapping now prevents confidence collapse later.",
      [Q(82)]: "Names, not roles. Generic retention programs waste budget; specific retention packages tied to named people work.",
      [Q(83)]: "Separate said from unsaid. Mismatches between what the acquiring CHRO thinks has been communicated and what the acquired employees have heard are common — reconcile early.",
      [Q(84)]: "EU works councils and similar bodies can add months to integration sequencing. If the CHRO is unaware of applicable requirements, treat as a diligence gap.",
    },
  }),
  ...buildTQs(TMPL.acqGovDel, acqGovDelQuestions.slice(5, 10), {
    requiredCount: 3,
    startSequence: 6,
    adminNotes: {
      [Q(85)]: "GC should have a notification tracker. If they don't, start one in this conversation — missed deadlines here convert into unforced legal errors.",
      [Q(86)]: "Integration team needs awareness even when legal owns the matter. Communications and people decisions can prejudice cases — GC must inform the integration lead directly.",
      [Q(87)]: "Data movement during integration can trip obligations that didn't apply pre-deal. Each DPA needs review before any data consolidation begins.",
      [Q(88)]: "Contingent exposure that can crystallize at awkward moments. Early visibility enables reserve planning and reduces earnings-surprise risk.",
      [Q(89)]: "Transition-specific legal issues — IP assignment, employee novation, data transfer mechanics. Different from steady-state posture; GC should separate them explicitly.",
    },
  }),
  ...buildTQs(TMPL.acqGovDel, acqGovDelQuestions.slice(10, 15), {
    requiredCount: 3,
    startSequence: 11,
    adminNotes: {
      [Q(90)]: "Critical-path projects integration must not disrupt. The PMO head should name them with dates; if they can't, integration risk is higher than reported.",
      [Q(91)]: "Recent failure patterns should directly shape the integration approach. Organizations repeat failure modes — design the integration to counter them.",
      [Q(92)]: "Dependency conflicts stay invisible until they aren't. PMO head should have a map; if they don't, building one is itself a deliverable.",
      [Q(93)]: "Names to co-opt into integration workstreams. Integration tempo follows leader quality — skimping on this roster has compounding consequences.",
      [Q(94)]: "Thin change-management capability means the integration team must bring its own. Honest assessment here prevents under-resourcing later.",
    },
  }),

  // Acquired Core — all required
  ...buildTQs(TMPL.acdCore, acdCoreQuestions, {
    allRequired: true,
    adminNotes: {
      [Q(100)]: "Compare the acquired leader's framing of the deal rationale to the acquiring CEO's (Q10). Divergence here is not a failure — it's the integration team's first real finding. Capture the delta verbatim.",
      [Q(101)]: "Listen for what they imply about autonomy, team protection, product continuity. Their definition of 'going well' is what they're really protecting — integration proposals that violate it fail quietly.",
      [Q(102)]: "Psychological safety matters here. If they hedge, don't press — the hedge is the answer. Note the hesitation and move on; they may return to it at Q103 or in closing.",
      [Q(103)]: "The highest-leverage question in the core set. Give it space. If the answer comes fast, probe for a second one — usually the first is rehearsed and the second is real.",
      [Q(104)]: "Non-negotiables from the acquired side. Often surprising to the acquirer — the integration team's job is to record them, not yet to judge which can actually be preserved.",
      [Q(105)]: "Their belief about what's settled may differ from the acquirer's belief. Any gap here is a flag for the integration lead — not for the interviewee to resolve.",
      [Q(106)]: "Their read of trust and friction from where they sit. The acquirer's version will differ — both are data; neither is the full picture.",
      [Q(107)]: "Establishes the escalation contract. Respecting this threshold preserves their authority inside their own organization — violate it casually and they disengage.",
    },
  }),

  // Acquired CEO — all primary required, probes optional with triggers
  ...buildTQs(TMPL.acdCeo, [...acdCeoQuestions, ...acdCeoProbes], {
    requiredCount: 6,
    triggers: {
      [Q(110)]: [{ condition: 'If the response is brief or guarded', followupQuestionId: Q(116) }],
      [Q(111)]: [{ condition: 'If the response focuses purely on financial outcome', followupQuestionId: Q(117) }],
      [Q(112)]: [{ condition: 'If the response is about culture rather than operations', followupQuestionId: Q(118) }],
      [Q(113)]: [{ condition: 'If the response focuses on people rather than systems', followupQuestionId: Q(119) }],
      [Q(114)]: [{ condition: 'If the response is vague or avoids specifics', followupQuestionId: Q(120) }],
    },
    adminNotes: {
      [Q(110)]: "Start backward-looking and pride-enabling. If brief or guarded, Q116 anchors them to a specific moment — stories unlock more than questions do here.",
      [Q(111)]: "Personal motivation — financial, strategic, exhaustion, vision. Founders rarely volunteer this. If the answer sticks to financial, Q117 probes for mission alignment beyond the check.",
      [Q(112)]: "Cultural and operational invariants diligence missed. If the answer stays cultural, Q118 forces a concrete example — a specific decision that illustrates the claimed culture.",
      [Q(113)]: "'What are you most worried about losing' is the inverse of 'what makes you proud.' If the answer stays about people, Q119 drills into named individuals and what retention requires.",
      [Q(114)]: "Promises the founder considers binding. If the response is vague, Q120 probes for implicit commitments — 'we always do X,' 'we never Y' — unwritten but culture-binding.",
      [Q(115)]: "The safety valve. Leave space — the most important content often surfaces only after this open-ended prompt. Not a closer; treat as an invitation.",
      [Q(116)]: "Use when Q110 was brief or guarded. A specific moment or milestone produces a story — stories travel in integration communications where abstractions die.",
      [Q(117)]: "Use when Q111 stayed financial. Mission-aligned founders stay; transactionally-motivated founders leave. This calibrates retention expectations for the CEO specifically.",
      [Q(118)]: "Use when Q112 stayed cultural. Forces the answer past buzzwords into actual behaviors the integration can preserve or replicate.",
      [Q(119)]: "Use when Q113 stayed about people. Named individuals plus specific retention asks. Generic concern becomes a plan only once specific.",
      [Q(120)]: "Use when Q114 was vague. Implicit commitments — 'we always,' 'we never' — govern the place but appear in no contract. Miss them and trust evaporates.",
    },
  }),

  // Acquired CTO — all primary required, probes optional with triggers
  ...buildTQs(TMPL.acdCto, [...acdCtoQuestions, ...acdCtoProbes], {
    requiredCount: 4,
    triggers: {
      [Q(130)]: [{ condition: 'If the interviewee skips warnings or minimizes risk areas in their architecture walkthrough', followupQuestionId: Q(136) }],
      [Q(133)]: [{ condition: 'If the interviewee names specific critical engineers', followupQuestionId: Q(137) }],
    },
    adminNotes: {
      [Q(130)]: "A voluntary tour — proud points and warnings alike. Voluntary warnings are the valuable part. If they skip warnings, Q136 uses the safer 'move carefully' framing.",
      [Q(131)]: "Honest rearview. Decisions already regretted shouldn't be entrenched by integration. If the CTO claims they'd change nothing, you're not getting the real answer yet.",
      [Q(132)]: "Counter the 'integration = absorption' default. What the team does well is often the most generative prompt in the session — capture it with specific practices, not adjectives.",
      [Q(133)]: "Names plus what each knows that no one else does. If they name specific critical engineers, Q137 goes deeper — what each person is uncertain about and what would make them stay.",
      [Q(134)]: "What's working, abandoned, and on the roadmap. Prevents integration from forcing a redo of work the team has already validated or explicitly ruled out.",
      [Q(135)]: "Implicit team norms — decision rights, collaboration patterns, how disagreement is handled. These shape whether integration feels respectful or colonial.",
      [Q(136)]: "Use when Q130 skipped warnings. The 'moves carefully' framing is psychologically safer and usually surfaces what was initially held back.",
      [Q(137)]: "Use when Q133 named specific engineers. Person-by-person stay drivers and uncertainties. Targeted retention spend starts here.",
    },
  }),

  // Acquired Data & Product — first 4 (CPO) required, data questions mix
  ...buildTQs(TMPL.acdDataProd, [...acdDataProdQuestions, ...acdDataProdProbes], {
    requiredCount: 6,
    triggers: {
      [Q(152)]: [{ condition: 'If the interviewee is reluctant to compare honestly against the acquiring company\'s product', followupQuestionId: Q(158) }],
      [Q(155)]: [{ condition: 'If the response describes significant data migration scope', followupQuestionId: Q(159) }],
    },
    adminNotes: {
      [Q(150)]: "Let the CPO lead with the product thesis in their own words. Gives the integration team language to use when advocating for the product internally.",
      [Q(151)]: "Customer-facing roadmap promises. Quietly dropping any of these costs trust at a fragile moment. The CPO should know the list; if they don't, it's a gap.",
      [Q(152)]: "Competitive honesty is hard for CPOs — their job has been to be the believer. If hedging appears, Q158 reframes to make candor easier ('survivorship decisions need candid input').",
      [Q(153)]: "Specific markers, not feelings. 'Alignment' and 'synergy' are non-answers — push for users, workflows, and decisions that would differ between a good and bad integration outcome.",
      [Q(154)]: "The gap between what leadership reports and what the data team knows. Integration builds on whatever's actually underneath — not the deck version.",
      [Q(155)]: "Concrete data movement scope. Each item implies a migration plan, reconciliation rule, and business owner. If scope sounds significant, Q159 quantifies disruption tolerance.",
      [Q(156)]: "External integration contracts — data feeds, API partners, customer-facing integrations. Each is both a migration constraint and a notification obligation.",
      [Q(157)]: "Most ML in production has ambiguous ownership. Force the ownership answer — integration without it is how models silently go stale post-close.",
      [Q(158)]: "Use when Q152 had hedging. Reframe to make candor easier — the job is survivorship decisions, candid input serves that better than optimism.",
      [Q(159)]: "Use when Q155 implied significant migration scope. Migration plans need a concrete disruption budget; 'as little as possible' is not planning.",
    },
  }),

  // Acquired CHRO/People — first 4 required, probes optional with triggers
  ...buildTQs(TMPL.acdPeople, [...acdPeopleQuestions, ...acdPeopleProbes], {
    requiredCount: 4,
    triggers: {
      [Q(170)]: [{ condition: 'If the response is overly positive without specific examples or details', followupQuestionId: Q(175) }],
      [Q(171)]: [{ condition: 'If the interviewee is reluctant to name specific people at risk of leaving', followupQuestionId: Q(176) }],
      [Q(173)]: [{ condition: 'If the response describes culture in abstract rather than concrete terms', followupQuestionId: Q(177) }],
    },
    adminNotes: {
      [Q(170)]: "The quality of the word 'honestly' matters — pause for space. If the answer stays rosy, Q175 probes for the specific anxieties that exist even under broad support.",
      [Q(171)]: "Uncertainty and optionality both matter. Flight risk isn't only performance-correlated. If the CHRO won't name individuals, Q176 offers the safer functions-and-levels framing.",
      [Q(172)]: "Employees compare notes faster than integration teams plan disclosures. Anything the CHRO knows is a landmine must be actively addressed, not hoped-away.",
      [Q(173)]: "Force articulation of the inarticulable. If the answer stays abstract, Q177 demands a concrete decision — hiring, firing, management — that reflects the culture claim.",
      [Q(174)]: "A direct ask. Whatever the CHRO says here becomes a concrete commitment the integration leadership must decide to keep or renegotiate — no middle ground.",
      [Q(175)]: "Use when Q170 stayed rosy. Broad support nearly always has specific anxieties underneath — naming them is the first step to addressing them.",
      [Q(176)]: "Use when Q171 avoided individual names. Functions and levels still inform where retention investment goes; the CHRO may name these when they won't name individuals.",
      [Q(177)]: "Use when Q173 stayed abstract. A specific decision — hiring, firing, management — that reflects the culture concretely. Moves the conversation from adjectives to behavior.",
    },
  }),

  // Acquired Tech & Infra (mirrored) — same required pattern as acquiring side
  ...buildTQs(TMPL.acdTechInf, acdTechInfQuestions.slice(0, 5), {
    requiredCount: 3,
    adminNotes: {
      [Q(190)]: "Acquired-side framing: capture, don't judge. What's past support is information — the team being willing to name it without flinching is the trust signal.",
      [Q(191)]: "The systems the team handles with care. If they're honest here, they're trusting the interviewer — note the candor and do not punish it downstream.",
      [Q(192)]: "Vendor map and notice windows from the acquired side. Each contract becomes a decision: renew, renegotiate, sunset — each with its own timing constraint.",
      [Q(193)]: "Whether the team sees problems in time. Weak observability compounds every integration risk; this is information, not criticism — frame it that way.",
      [Q(194)]: "Full ledger — including the corners that weren't in the data room. On-prem pockets and sandbox accounts are disproportionately the source of mid-integration surprises.",
    },
  }),
  ...buildTQs(TMPL.acdTechInf, acdTechInfQuestions.slice(5, 10), {
    requiredCount: 3,
    startSequence: 6,
    adminNotes: {
      [Q(195)]: "Active compliance frameworks. These set the floor integration activity must not fall below — capture them before any integration design conversation.",
      [Q(196)]: "Audit windows integration could disrupt. Integration sequencing must work around these timelines, not vice versa.",
      [Q(197)]: "Post-close surprises here erode acquirer trust; upfront disclosure earns it. Be explicit that this is about the integration team knowing, not about creating an incident.",
      [Q(198)]: "Remediation backlog. Integration inherits these; early visibility enables sequencing and prevents a post-close discovery that looks like concealment.",
      [Q(199)]: "Transition-specific exposures — dual-admin, credential rotation, trust-boundary changes. Different from steady-state; treat them as separate concerns.",
    },
  }),
  ...buildTQs(TMPL.acdTechInf, acdTechInfQuestions.slice(10, 15), {
    requiredCount: 3,
    startSequence: 11,
    adminNotes: {
      [Q(200)]: "Path-to-prod maturity. Weak CI/CD means integration changes break things quietly — asking here surfaces the need for investment before the breakage shows up.",
      [Q(201)]: "Honest debt map from the acquired side. The 'genuinely unknown' category is where integration surprises come from — force it into the conversation explicitly.",
      [Q(202)]: "Acquired-side engineering morale is fragile. Invest in hearing what the team is actually saying before filling in assumptions from the acquiring side.",
      [Q(203)]: "Names plus unique knowledge. Retention is compensation and knowledge-transfer decisions together — the VP Eng's honest list determines both.",
      [Q(204)]: "Tooling history. Integration often forces convergence; knowing what was already tried and why it was abandoned prevents re-litigation.",
    },
  }),

  // Acquired Commercial Ops (mirrored)
  ...buildTQs(TMPL.acdCommOps, acdCommOpsQuestions.slice(0, 4), {
    requiredCount: 3,
    adminNotes: {
      [Q(210)]: "Commitments the acquired team made or believes were made. Verbal and implied dominate — what they remember saying shapes customer expectations even when the acquirer has no record.",
      [Q(211)]: "At-risk accounts from the acquired side. Often differs from the acquirer's list — both matter and the delta is itself useful intelligence.",
      [Q(212)]: "Customer contracts needing active management. Each has a notification window and a decision — the acquired CRO should know status.",
      [Q(213)]: "Opportunities the acquired team sees in their own book. Their knowledge of the customer is superior to the acquirer's on these accounts — weight their view accordingly.",
    },
  }),
  ...buildTQs(TMPL.acdCommOps, acdCommOpsQuestions.slice(4, 9), {
    requiredCount: 3,
    startSequence: 5,
    adminNotes: {
      [Q(214)]: "Pre-deal churn, separate from deal-induced. Without this distinction, integration gets blamed for churn that was already in motion — acquired CS lead should separate cleanly.",
      [Q(215)]: "Accounts held by individuals who may depart. Planned relationship transitions in parallel with system changes — skipping either breaks the account.",
      [Q(216)]: "Verbal SLAs, named contacts, response norms. They feel contractual to customers; behave that way in churn analyses and retention work.",
      [Q(217)]: "Intangibles customers associate with the team. These become the design constraints for customer-facing integration changes — not vetoes, but constraints.",
      [Q(218)]: "Contract tripwires that convert operational disruption into financial hits. Each needs a risk-adjusted plan before any migration begins.",
    },
  }),
  ...buildTQs(TMPL.acdCommOps, acdCommOpsQuestions.slice(9, 14), {
    requiredCount: 2,
    startSequence: 10,
    adminNotes: {
      [Q(219)]: "Stack inventory from the acquired side. Without the full list, migration scope is guesswork. If the VP RevOps can't recite the stack, the gap itself is a finding.",
      [Q(220)]: "Honest CRM hygiene assessment. RevOps usually knows where the rot is; asking directly respects that knowledge and produces faster answers than polite probes.",
      [Q(221)]: "One-person-in-their-head automations. The #1 cause of post-migration regression on the commercial side — names matter here.",
      [Q(222)]: "Data that cannot degrade under any migration scenario. Becomes the test set for integrity checks and the rollback trigger list.",
      [Q(223)]: "In-flight work that would be disrupted if paused. Each item: protect, absorb into integration, or pause with explicit owner sign-off.",
    },
  }),

  // Acquired Governance & Delivery (mirrored)
  ...buildTQs(TMPL.acdGovDel, acdGovDelQuestions.slice(0, 5), {
    requiredCount: 3,
    adminNotes: {
      [Q(230)]: "Any role the acquired CHRO already anticipates eliminating. The communication plan matters at least as much as the redundancy itself — tempo and message shape everything.",
      [Q(231)]: "Harmonization gaps employees will discover on their own. Honest mapping now prevents confidence collapse later — and the CHRO usually knows the specific ones that will sting.",
      [Q(232)]: "Named retention targets from the acquired side, with specific risks. This list may differ from the acquirer's — reconcile the two rather than assume alignment.",
      [Q(233)]: "What's been said vs. what's pending. Message consistency between companies is the variable employees use to judge trustworthiness — inconsistency destroys trust faster than bad news.",
      [Q(234)]: "Jurisdictional constraints — works councils, employment law, union obligations. Can add months to integration sequencing; catch them now.",
    },
  }),
  ...buildTQs(TMPL.acdGovDel, acdGovDelQuestions.slice(5, 10), {
    requiredCount: 3,
    startSequence: 6,
    adminNotes: {
      [Q(235)]: "Contract-notification tracker from the acquired side. Every row has a deadline and a consent status — the acquired GC should know both.",
      [Q(236)]: "Litigation the integration team must be aware of — not to resolve, but to avoid prejudicing with communications or people decisions.",
      [Q(237)]: "DPA/GDPR/CCPA exposure from the acquired side. Data movement during integration can trip obligations that didn't apply pre-deal; each agreement needs review.",
      [Q(238)]: "Contingent claims exposure. Early visibility enables reserve planning and reduces earnings-surprise risk post-close.",
      [Q(239)]: "IP assignment, employee novation, data transfer mechanics. Transition-specific legal issues — treat separately from steady-state legal posture.",
    },
  }),
  ...buildTQs(TMPL.acdGovDel, acdGovDelQuestions.slice(10, 15), {
    requiredCount: 3,
    startSequence: 11,
    adminNotes: {
      [Q(240)]: "Critical-path projects integration must not disrupt. The acquired PMO head names them with dates; if they can't, integration risk is higher than reported.",
      [Q(241)]: "Recent failure patterns inform integration design. Organizations repeat failure modes — the acquired side's PMO often has the clearest view of their own failure modes.",
      [Q(242)]: "Dependency conflicts stay invisible until they aren't. Map them now; the ones you miss are the ones that break first during integration execution.",
      [Q(243)]: "Names to co-opt into integration workstreams. Acquired-side leaders with proven delivery muscle are disproportionately valuable — identify them early.",
      [Q(244)]: "How much change the organization can absorb. Weak capability means the integration team must bring its own — honest answer here prevents under-resourcing.",
    },
  }),

  // Acquired Closing — all primary required, probes optional with triggers
  ...buildTQs(TMPL.acdClosing, [...acdClosingQuestions, ...acdClosingProbes], {
    requiredCount: 4,
    triggers: {
      [Q(250)]: [
        { condition: 'If the interviewee corrects something in the reflection summary', followupQuestionId: Q(254) },
        { condition: 'If the interviewee confirms the reflection as accurate without corrections', followupQuestionId: Q(255) },
      ],
      [Q(251)]: [
        { condition: 'If the interviewee shares something they held back during the interview', followupQuestionId: Q(256) },
        { condition: 'If the interviewee says there is nothing they held back', followupQuestionId: Q(257) },
      ],
    },
    adminNotes: {
      [Q(250)]: "Frame as a correction opportunity, not confirmation. If they correct, Q254 keeps the space open for more. If they confirm uncorrected, Q255 seeks the softer walk-backs.",
      [Q(251)]: "The last safety valve. Give it weight and silence — the most valuable answers surface only after the pause. If they share, Q256 probes why it was held back; if they claim nothing, Q257 closes respectfully.",
      [Q(252)]: "Signal the single most load-bearing takeaway. The 'if only one thing' framing produces a meaningful ranking even when earlier answers were broad.",
      [Q(253)]: "The interviewee knows their team. Next-person prompts shape the next session's quality — and show respect for their insight.",
      [Q(254)]: "Use when Q250 produced corrections. One correction usually unlocks others — hold the space open without rushing to close.",
      [Q(255)]: "Use when Q250 was confirmed uncorrected. Seeks things they agreed with but would walk back by a shade — tone and emphasis, not factual changes.",
      [Q(256)]: "Use when Q251 surfaced something held back. Why it was held back is often as important as what was held back — reveals trust dynamics with the acquirer.",
      [Q(257)]: "Use when Q251 surfaced nothing held back. Acknowledges the absence itself is data — and closes the session respectfully.",
    },
  }),
];


// ============================================================================
// TEMPLATE DEFINITIONS
// ============================================================================
const templates = [
  { id: TMPL.acqCore,    name: 'Acquiring — Core Questions',              description: 'This session focuses on your personal view of the acquisition — the strategic rationale, what success looks like to you, where the key risks lie, and how you see the relationship between the two companies taking shape.',                         systemPrompt: DESCRIPTIONS.acqCore,    status: 'published' },
  { id: TMPL.acqCeo,     name: 'Acquiring — CEO/President',               description: "We'll explore your strategic vision for this deal — the thesis behind it, your speed-versus-preservation instincts, the commitments already in place, and how aligned you believe your leadership team to be.",                                                  systemPrompt: DESCRIPTIONS.acqCeo,     status: 'published' },
  { id: TMPL.acqCfo,     name: 'Acquiring — CFO',                         description: "This session covers the financial dimensions of integration — synergy targets, which systems need to consolidate, deal provisions that create milestones, and your current level of confidence in the financial picture.",                                         systemPrompt: DESCRIPTIONS.acqCfo,     status: 'published' },
  { id: TMPL.acqCto,     name: 'Acquiring — CTO/CIO',                     description: "We'll discuss where the two technology platforms are headed, which systems are business-critical to protect, any data or sovereignty constraints, and where you see the most significant architectural challenges.",                                              systemPrompt: DESCRIPTIONS.acqCto,     status: 'published' },
  { id: TMPL.acqTechInf, name: 'Acquiring — Technology & Infrastructure', description: 'This session goes deep on the technical reality — infrastructure fragility, security and compliance exposure, CI/CD maturity, and how the engineering team is responding to the transition.',                                                                     systemPrompt: DESCRIPTIONS.acqTechInf, status: 'published' },
  { id: TMPL.acqCommOps, name: 'Acquiring — Commercial Operations',       description: "We'll cover the commercial side of integration — existing customer commitments, churn and change-of-control risk, cross-sell potential, and the reliability of data and processes across sales, success, and revenue operations.",                               systemPrompt: DESCRIPTIONS.acqCommOps, status: 'published' },
  { id: TMPL.acqGovDel,  name: 'Acquiring — Governance & Delivery',       description: "This session addresses the people, legal, and delivery dimensions — where roles overlap, compensation considerations, contractual obligations, and which in-flight initiatives need protecting.",                                                                  systemPrompt: DESCRIPTIONS.acqGovDel,  status: 'published' },
  { id: TMPL.acdCore,    name: 'Acquired — Core Questions',               description: "Welcome, and thank you for your time. We'll begin with the big picture: how you see this acquisition, what a good outcome looks like for you personally, what concerns you, and what you most want the integration team to get right.",                          systemPrompt: DESCRIPTIONS.acdCore,    status: 'published' },
  { id: TMPL.acdCeo,     name: 'Acquired — CEO/Founder',                  description: 'This is a candid conversation about what you built, why you chose this path, and what you most want to protect. What you share here directly shapes how the integration is approached.',                                                                          systemPrompt: DESCRIPTIONS.acdCeo,     status: 'published' },
  { id: TMPL.acdCto,     name: 'Acquired — CTO/CIO',                      description: "We'll walk through your architecture together — the decisions you're proud of, the technical debt worth being honest about, the team members who need careful handling, and the work in progress that shouldn't be disrupted.",                                  systemPrompt: DESCRIPTIONS.acdCto,     status: 'published' },
  { id: TMPL.acdDataProd,name: 'Acquired — Data & Product',               description: "We'll discuss your product roadmap, how you see your competitive position, the honest state of your data, and any AI or analytics work underway — openly and without judgment.",                                                                                 systemPrompt: DESCRIPTIONS.acdDataProd,status: 'published' },
  { id: TMPL.acdPeople,  name: 'Acquired — CHRO/VP People',               description: "This conversation focuses on your team — morale, retention concerns, compensation realities, the culture that matters most to people, and what the integration team needs to do to bring everyone along.",                                                       systemPrompt: DESCRIPTIONS.acdPeople,  status: 'published' },
  { id: TMPL.acdTechInf, name: 'Acquired — Technology & Infrastructure',  description: "We'll cover infrastructure, security posture, and engineering culture — including what your team does exceptionally well and deserves to be preserved, and how they're feeling about the road ahead.",                                                           systemPrompt: DESCRIPTIONS.acdTechInf, status: 'published' },
  { id: TMPL.acdCommOps, name: 'Acquired — Commercial Operations',        description: "We'll walk through your customer base, commercial commitments — including the informal ones — and what it will take to keep customers confident through the transition.",                                                                                         systemPrompt: DESCRIPTIONS.acdCommOps, status: 'published' },
  { id: TMPL.acdGovDel,  name: 'Acquired — Governance & Delivery',        description: "This session covers people, legal matters, and active projects — and importantly, what your team needs from the integration to feel supported and set up to succeed.",                                                                                           systemPrompt: DESCRIPTIONS.acdGovDel,  status: 'published' },
  { id: TMPL.acdClosing, name: 'Acquired — Closing Sequence',             description: "We'll close with a chance to reflect on everything discussed, correct anything that landed wrong, raise anything you held back, and share what you'd most want the integration leadership to know.",                                                               systemPrompt: DESCRIPTIONS.acdClosing, status: 'published' },
];


// ============================================================================
// SEED FUNCTION
// ============================================================================
export async function seed() {
  console.log(`\n🌱 Provenance M&A Integration Seed`);
  console.log(`   Mode: ${SEED_MODE.toUpperCase()}`);
  console.log(`   Questions: ${allQuestions.length}`);
  console.log(`   Templates: ${templates.length}`);
  console.log(`   Template-Question links: ${templateQuestions.length}\n`);

  // ── Clean mode: truncate tables in dependency order ────────────────────
  if (SEED_MODE === 'clean') {
    console.log('🧹 CLEAN MODE — Truncating tables...');
    await prisma.templateQuestion.deleteMany({});
    console.log('   ✓ template_questions');
    await prisma.templateAssignmentHistory.deleteMany({});
    console.log('   ✓ template_assignment_history');
    await prisma.userTemplate.deleteMany({});
    console.log('   ✓ user_templates');
    await prisma.responseDraft.deleteMany({});
    console.log('   ✓ response_drafts');
    await prisma.interviewResponse.deleteMany({});
    console.log('   ✓ interview_responses');
    await prisma.interview.deleteMany({});
    console.log('   ✓ interviews');
    await prisma.interviewTemplate.deleteMany({});
    console.log('   ✓ interview_templates');
    await prisma.questionTag.deleteMany({});
    console.log('   ✓ question_tags');
    await prisma.userTag.deleteMany({});
    console.log('   ✓ user_tags');
    await prisma.question.deleteMany({});
    console.log('   ✓ questions');
    await prisma.tag.deleteMany({});
    console.log('   ✓ tags');
    console.log('');
  }

  // ── Step 1: Tags ──────────────────────────────────────────────────────
  console.log('1/5  Seeding tags...');
  await prisma.tag.createMany({
    data: tags,
    skipDuplicates: true,
  });
  console.log(`     ✓ ${tags.length} tags`);

  // ── Step 2: Questions ─────────────────────────────────────────────────
  console.log('2/5  Seeding questions...');
  await prisma.question.createMany({
    data: allQuestions.map(q => ({
      id: q.id,
      text: q.text,
      intent: q.intent,
      isActive: true,
    })),
    skipDuplicates: true,
  });
  console.log(`     ✓ ${allQuestions.length} questions`);

  // ── Step 3: Question-Tag associations ─────────────────────────────────
  console.log('3/5  Seeding question-tag associations...');
  const qtData = allQuestions.flatMap(q =>
    q.tagIds.map(tagId => ({ questionId: q.id, tagId }))
  );
  await prisma.questionTag.createMany({
    data: qtData,
    skipDuplicates: true,
  });
  console.log(`     ✓ ${qtData.length} question-tag links`);

  // ── Step 4: Templates ─────────────────────────────────────────────────
  console.log('4/5  Seeding templates...');
  for (const t of templates) {
    await prisma.interviewTemplate.upsert({
      where: { id: t.id },
      update: { name: t.name, description: t.description, systemPrompt: t.systemPrompt, status: t.status },
      create: { id: t.id, name: t.name, description: t.description, systemPrompt: t.systemPrompt, status: t.status },
    });
  }
  console.log(`     ✓ ${templates.length} templates`);

  // ── Step 5: Template-Question associations ────────────────────────────
  console.log('5/5  Seeding template-question associations...');
  await prisma.templateQuestion.createMany({
    data: templateQuestions.map(tq => ({
      id: tq.id,
      templateId: tq.templateId,
      questionId: tq.questionId,
      sequenceOrder: tq.sequenceOrder,
      categoryBucket: tq.categoryBucket,
      isRequired: tq.isRequired,
      adminNotes: tq.adminNotes,
      followupTriggers: tq.followupTriggers as any,
    })),
    skipDuplicates: true,
  });
  console.log(`     ✓ ${templateQuestions.length} template-question links`);

  // ── Summary ───────────────────────────────────────────────────────────
  console.log('\n✅ Seed complete!\n');
  console.log('   Verify with: npx prisma studio\n');
  console.log('   Templates are published and ready for user assignment.');
  console.log('   Assign templates to users via the admin UI or a separate script.\n');
}


// ============================================================================
// RUN (when invoked directly, not when imported)
// ============================================================================
const isMain =
  process.argv[1]?.endsWith('seed-provenance.ts') ||
  process.argv[1]?.endsWith('seed-provenance.js');

if (isMain) {
  seed()
    .catch((e) => {
      console.error('\n❌ Seed failed:\n', e);
      process.exit(1);
    })
    .finally(() => prisma.$disconnect());
}
