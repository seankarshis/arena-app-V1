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
  category: string;
  tagIds: string[];
}

// ── Acquiring Core (Q1-Q8) ─────────────────────────────────────────────────
const acqCoreQuestions: QuestionDef[] = [
  { id: Q(1), text: 'In your own words, why did we make this acquisition? What problem does it solve or what opportunity does it unlock?', category: 'strategic-intent', tagIds: [TAG_IDS.strategic] },
  { id: Q(2), text: 'What does success look like for you personally, 12 months from now? What would make you say this integration went well?', category: 'strategic-intent', tagIds: [TAG_IDS.strategic] },
  { id: Q(3), text: 'What is the single thing you are most worried about in this integration?', category: 'risk-surface', tagIds: [TAG_IDS.risk] },
  { id: Q(4), text: 'Is there anything important about the acquired company that you believe the integration team may underestimate or overlook?', category: 'risk-surface', tagIds: [TAG_IDS.strategic, TAG_IDS.risk] },
  { id: Q(5), text: 'What, if anything, about the acquired company should be preserved exactly as-is?', category: 'strategic-intent', tagIds: [TAG_IDS.strategic] },
  { id: Q(6), text: 'What decisions are already made and should not be re-opened? What is still genuinely up for discussion?', category: 'operational-detail', tagIds: [TAG_IDS.strategic] },
  { id: Q(7), text: 'What is your read on the relationship between the two leadership teams right now? Where is there trust, and where is there friction?', category: 'people-dynamics', tagIds: [TAG_IDS.people] },
  { id: Q(8), text: 'What would cause you to intervene directly in the integration? What threshold signals a problem serious enough to need your personal attention?', category: 'risk-surface', tagIds: [TAG_IDS.risk, TAG_IDS.operational] },
];

// ── Acquiring CEO (Q10-Q15) ────────────────────────────────────────────────
const acqCeoQuestions: QuestionDef[] = [
  { id: Q(10), text: 'What was the strategic thesis that made this deal worth doing? What has to be true for that thesis to be validated?', category: 'strategic-intent', tagIds: [TAG_IDS.strategic] },
  { id: Q(11), text: 'What value do you expect to be able to capture in the first 90 days? What value is locked behind longer integration work?', category: 'strategic-intent', tagIds: [TAG_IDS.strategic] },
  { id: Q(12), text: 'How would you describe the relative priority between speed of integration and preservation of the acquired company\'s culture and operating model?', category: 'strategic-intent', tagIds: [TAG_IDS.strategic, TAG_IDS.people] },
  { id: Q(13), text: 'What commitments — public, board-level, or to the acquired company\'s leadership — have already been made about how this integration will be handled?', category: 'risk-surface', tagIds: [TAG_IDS.risk, TAG_IDS.operational] },
  { id: Q(14), text: 'Who on your leadership team is most invested in making this work? Who has reservations?', category: 'people-dynamics', tagIds: [TAG_IDS.people] },
  { id: Q(15), text: 'What is the board\'s level of visibility into this integration, and what will they be watching most closely?', category: 'operational-detail', tagIds: [TAG_IDS.operational, TAG_IDS.risk] },
];

// Acquiring CEO follow-up probes (for testing triggers on acquiring side)
const acqCeoProbes: QuestionDef[] = [
  { id: Q(16), text: 'Can you be more specific about the timeline for that thesis validation? What milestones would you expect to see at 90 days, 6 months, and 12 months?', category: 'strategic-intent', tagIds: [TAG_IDS.strategic] },
  { id: Q(17), text: 'You mentioned reservations on the leadership team. Can you help me understand what those reservations are rooted in — strategic disagreement, execution concern, or something else?', category: 'people-dynamics', tagIds: [TAG_IDS.people, TAG_IDS.risk] },
];

// ── Acquiring CFO (Q20-Q24) ────────────────────────────────────────────────
const acqCfoQuestions: QuestionDef[] = [
  { id: Q(20), text: 'What synergy targets — cost, revenue, or both — are committed to the board or investors, and on what timeline?', category: 'strategic-intent', tagIds: [TAG_IDS.strategic, TAG_IDS.risk] },
  { id: Q(21), text: 'Which financial systems (ERP, billing, revenue recognition, general ledger) are in scope for consolidation, and what is the target state?', category: 'operational-detail', tagIds: [TAG_IDS.operational] },
  { id: Q(22), text: 'Are there earn-out provisions, deferred consideration, or financial performance clauses in the deal that create specific integration milestones?', category: 'risk-surface', tagIds: [TAG_IDS.risk, TAG_IDS.strategic] },
  { id: Q(23), text: 'What is your current level of confidence in the financial data provided during due diligence? Are there areas where you expect surprises?', category: 'risk-surface', tagIds: [TAG_IDS.risk] },
  { id: Q(24), text: 'What is the financial risk tolerance for integration-related disruption to customers or operations?', category: 'risk-surface', tagIds: [TAG_IDS.risk, TAG_IDS.strategic] },
];

// ── Acquiring CTO (Q30-Q34) ────────────────────────────────────────────────
const acqCtoQuestions: QuestionDef[] = [
  { id: Q(30), text: 'What is the intended long-term outcome for the acquired company\'s product infrastructure — full migration to your platform, parallel operation, or maintained separately?', category: 'strategic-intent', tagIds: [TAG_IDS.strategic, TAG_IDS.operational] },
  { id: Q(31), text: 'Which systems at the acquired company are business-critical and cannot be disrupted during integration?', category: 'risk-surface', tagIds: [TAG_IDS.risk, TAG_IDS.operational] },
  { id: Q(32), text: 'Are there data sovereignty, residency, or contractual data obligations that will constrain how we migrate or consolidate infrastructure?', category: 'operational-detail', tagIds: [TAG_IDS.risk, TAG_IDS.operational] },
  { id: Q(33), text: 'What AI or automation initiatives are currently underway at either company? Which ones should be accelerated, merged, or stopped?', category: 'strategic-intent', tagIds: [TAG_IDS.strategic, TAG_IDS.operational] },
  { id: Q(34), text: 'Where do you see the most significant architectural incompatibility between the two companies\' systems?', category: 'risk-surface', tagIds: [TAG_IDS.risk, TAG_IDS.strategic] },
];

// ── Acquiring Tech & Infrastructure (Q40-Q54) ──────────────────────────────
// VP Infrastructure (40-44), VP Security (45-49), VP Engineering (50-54)
const acqTechInfQuestions: QuestionDef[] = [
  // VP Infrastructure
  { id: Q(40), text: 'What end-of-life or unsupported infrastructure is currently in production? What has been deferred for remediation?', category: 'risk-surface', tagIds: [TAG_IDS.risk] },
  { id: Q(41), text: 'What are the most fragile or single-point-of-failure systems in the current environment?', category: 'risk-surface', tagIds: [TAG_IDS.risk] },
  { id: Q(42), text: 'What managed service providers or outsourced infrastructure contracts exist? What are the terms and notice periods?', category: 'operational-detail', tagIds: [TAG_IDS.operational, TAG_IDS.risk] },
  { id: Q(43), text: 'What monitoring and observability tooling is in place? How mature is alerting and incident response?', category: 'operational-detail', tagIds: [TAG_IDS.operational, TAG_IDS.risk] },
  { id: Q(44), text: 'Walk me through the current infrastructure footprint — cloud providers, data centers, co-location, and on-premises.', category: 'operational-detail', tagIds: [TAG_IDS.operational] },
  // VP Security
  { id: Q(45), text: 'What security certifications or compliance frameworks is the acquired company currently operating under?', category: 'operational-detail', tagIds: [TAG_IDS.risk, TAG_IDS.operational] },
  { id: Q(46), text: 'Are any of those certifications currently in scope, in audit, or pending renewal? What would integration activity put at risk?', category: 'risk-surface', tagIds: [TAG_IDS.risk] },
  { id: Q(47), text: 'Have there been any security incidents, data breaches, or regulatory investigations in the past 24 months?', category: 'risk-surface', tagIds: [TAG_IDS.risk] },
  { id: Q(48), text: 'What penetration testing or red team activity has been conducted recently? What findings remain open?', category: 'risk-surface', tagIds: [TAG_IDS.risk] },
  { id: Q(49), text: 'What security concerns do you have specifically about the integration process itself — not the steady state, but the transition period?', category: 'risk-surface', tagIds: [TAG_IDS.risk] },
  // VP Engineering
  { id: Q(50), text: 'What is the current state of the CI/CD pipeline and development tooling? How automated is the path from code to production?', category: 'operational-detail', tagIds: [TAG_IDS.operational] },
  { id: Q(51), text: 'Where is the most significant technical debt in the product? What has been deliberately deferred and what is genuinely unknown?', category: 'risk-surface', tagIds: [TAG_IDS.risk, TAG_IDS.operational] },
  { id: Q(52), text: 'How does the engineering team feel about this acquisition? What are the most common concerns you\'re hearing?', category: 'people-dynamics', tagIds: [TAG_IDS.people, TAG_IDS.risk] },
  { id: Q(53), text: 'Which engineers are most critical to retain? What retention risk exists and what has already been done?', category: 'people-dynamics', tagIds: [TAG_IDS.people, TAG_IDS.risk] },
  { id: Q(54), text: 'What AI coding tools or automation are currently in use by the engineering team? What has been tried and abandoned?', category: 'operational-detail', tagIds: [TAG_IDS.operational, TAG_IDS.strategic] },
];

// ── Acquiring Commercial Operations (Q60-Q73) ─────────────────────────────
// CRO/VP Sales (60-63), VP Customer Success (64-68), VP RevOps (69-73)
const acqCommOpsQuestions: QuestionDef[] = [
  // CRO / VP Sales
  { id: Q(60), text: 'What customer-facing commitments — contractual, verbal, or implied — were made to the acquired company\'s customers during or after the deal announcement?', category: 'risk-surface', tagIds: [TAG_IDS.risk, TAG_IDS.operational] },
  { id: Q(61), text: 'Are there customers at the acquired company who are at meaningful churn risk? Who are they and what would stabilize them?', category: 'risk-surface', tagIds: [TAG_IDS.risk, TAG_IDS.strategic] },
  { id: Q(62), text: 'Are there contracts at the acquired company that contain change-of-control provisions that need to be actively managed?', category: 'risk-surface', tagIds: [TAG_IDS.risk, TAG_IDS.operational] },
  { id: Q(63), text: 'What cross-sell or upsell opportunities does this acquisition unlock? Which are time-sensitive?', category: 'strategic-intent', tagIds: [TAG_IDS.strategic] },
  // VP Customer Success
  { id: Q(64), text: 'Which customers are at meaningful churn risk right now — before any integration disruption — and what are the reasons?', category: 'risk-surface', tagIds: [TAG_IDS.risk] },
  { id: Q(65), text: 'Are there customers who have a strong personal relationship with someone at your company who may be leaving?', category: 'people-dynamics', tagIds: [TAG_IDS.risk, TAG_IDS.people] },
  { id: Q(66), text: 'What commitments — service levels, named contacts, response times — have been made to customers in ways not captured in contracts?', category: 'risk-surface', tagIds: [TAG_IDS.risk, TAG_IDS.operational] },
  { id: Q(67), text: 'What do customers most value about working with your team that they\'re afraid they\'ll lose?', category: 'strategic-intent', tagIds: [TAG_IDS.strategic, TAG_IDS.risk] },
  { id: Q(68), text: 'Are there customer contracts that contain SLA penalties, service credits, or termination clauses that could be triggered during the transition?', category: 'risk-surface', tagIds: [TAG_IDS.risk] },
  // VP Revenue Operations
  { id: Q(69), text: 'Walk me through the full commercial technology stack — CRM, marketing automation, CPQ, billing, revenue recognition, BI.', category: 'operational-detail', tagIds: [TAG_IDS.operational] },
  { id: Q(70), text: 'What is the current state of CRM data quality — contact completeness, account hierarchy, opportunity hygiene?', category: 'operational-detail', tagIds: [TAG_IDS.operational, TAG_IDS.risk] },
  { id: Q(71), text: 'Are there customizations, automations, or integrations in the CRM not documented anywhere and live only in someone\'s head?', category: 'risk-surface', tagIds: [TAG_IDS.risk, TAG_IDS.operational] },
  { id: Q(72), text: 'What is the most important data in your commercial systems that must not be lost or degraded in a migration?', category: 'risk-surface', tagIds: [TAG_IDS.risk, TAG_IDS.operational] },
  { id: Q(73), text: 'What rev ops work is currently in flight that would be disrupted if it had to pause?', category: 'operational-detail', tagIds: [TAG_IDS.operational, TAG_IDS.risk] },
];

// ── Acquiring Governance & Delivery (Q80-Q94) ──────────────────────────────
// CHRO/VP People (80-84), VP Legal (85-89), VP PMO (90-94)
const acqGovDelQuestions: QuestionDef[] = [
  // CHRO / VP People
  { id: Q(80), text: 'Are there redundant roles that will need to be eliminated? Has leadership aligned on the timeline and communication approach?', category: 'operational-detail', tagIds: [TAG_IDS.operational, TAG_IDS.risk] },
  { id: Q(81), text: 'How do total compensation, benefits, and equity structures at the acquired company compare to your own? What harmonization is required and by when?', category: 'operational-detail', tagIds: [TAG_IDS.operational, TAG_IDS.risk] },
  { id: Q(82), text: 'Who are the most critical people to retain from the acquired company? What specific retention risk exists for each of them?', category: 'people-dynamics', tagIds: [TAG_IDS.people, TAG_IDS.risk] },
  { id: Q(83), text: 'What is the communication plan for the acquired company\'s employees? What has already been communicated, and what remains to be said?', category: 'people-dynamics', tagIds: [TAG_IDS.people, TAG_IDS.operational] },
  { id: Q(84), text: 'Are there employment law, works council, or union considerations that constrain how we can proceed?', category: 'risk-surface', tagIds: [TAG_IDS.risk, TAG_IDS.operational] },
  // VP Legal / General Counsel
  { id: Q(85), text: 'What material contracts have change-of-control provisions triggered by this acquisition? What is the status of notification or consent for each?', category: 'risk-surface', tagIds: [TAG_IDS.risk, TAG_IDS.operational] },
  { id: Q(86), text: 'Are there open or threatened litigation matters at the acquired company that the integration team should be aware of?', category: 'risk-surface', tagIds: [TAG_IDS.risk] },
  { id: Q(87), text: 'What data processing agreements exist between the acquired company and its customers? Are they compliant with GDPR, CCPA, or other applicable privacy regulations?', category: 'risk-surface', tagIds: [TAG_IDS.risk, TAG_IDS.operational] },
  { id: Q(88), text: 'Are there open indemnification obligations or warranty claims from customer contracts that could become material?', category: 'risk-surface', tagIds: [TAG_IDS.risk] },
  { id: Q(89), text: 'What legal concerns specific to the integration process itself do you want to flag now, before work begins?', category: 'risk-surface', tagIds: [TAG_IDS.risk] },
  // VP PMO
  { id: Q(90), text: 'What projects are currently in flight across the acquired company? Which ones are on the critical path and cannot be disrupted?', category: 'operational-detail', tagIds: [TAG_IDS.operational, TAG_IDS.risk] },
  { id: Q(91), text: 'What project or program failures in the past 12–18 months should inform how we approach this integration?', category: 'risk-surface', tagIds: [TAG_IDS.risk, TAG_IDS.operational] },
  { id: Q(92), text: 'What dependencies exist between in-flight projects and integration workstreams that we need to map and manage?', category: 'operational-detail', tagIds: [TAG_IDS.operational, TAG_IDS.risk] },
  { id: Q(93), text: 'Who are the most effective project leaders at the acquired company who should be brought into the integration workstream structure?', category: 'people-dynamics', tagIds: [TAG_IDS.people, TAG_IDS.operational] },
  { id: Q(94), text: 'What change management capability exists at the acquired company?', category: 'operational-detail', tagIds: [TAG_IDS.operational] },
];

// ── Acquired Core (Q100-Q107) ──────────────────────────────────────────────
const acdCoreQuestions: QuestionDef[] = [
  { id: Q(100), text: 'In your own words, why did we make this acquisition? What problem does it solve or what opportunity does it unlock?', category: 'strategic-intent', tagIds: [TAG_IDS.strategic] },
  { id: Q(101), text: 'What does success look like for you personally, 12 months from now? What would make you say this integration went well?', category: 'strategic-intent', tagIds: [TAG_IDS.strategic] },
  { id: Q(102), text: 'What is the single thing you are most worried about in this integration?', category: 'risk-surface', tagIds: [TAG_IDS.risk] },
  { id: Q(103), text: 'Is there anything important about your company that you believe the integration team may underestimate or overlook?', category: 'risk-surface', tagIds: [TAG_IDS.strategic, TAG_IDS.risk] },
  { id: Q(104), text: 'What, if anything, about your company should be preserved exactly as-is?', category: 'strategic-intent', tagIds: [TAG_IDS.strategic] },
  { id: Q(105), text: 'What decisions are already made and should not be re-opened? What is still genuinely up for discussion?', category: 'operational-detail', tagIds: [TAG_IDS.strategic] },
  { id: Q(106), text: 'What is your read on the relationship between the two leadership teams right now? Where is there trust, and where is there friction?', category: 'people-dynamics', tagIds: [TAG_IDS.people] },
  { id: Q(107), text: 'What would cause you to intervene directly in the integration? What threshold signals a problem serious enough to need your personal attention?', category: 'risk-surface', tagIds: [TAG_IDS.risk, TAG_IDS.operational] },
];

// ── Acquired CEO/Founder (Q110-Q115) + Probes (Q116-Q120) ─────────────────
const acdCeoQuestions: QuestionDef[] = [
  { id: Q(110), text: 'Before we get into specifics — what were you building, and what were you most proud of?', category: 'strategic-intent', tagIds: [TAG_IDS.strategic, TAG_IDS.safety] },
  { id: Q(111), text: 'What was your personal motivation for agreeing to this acquisition? What outcome for your company — and for yourself — were you hoping for?', category: 'strategic-intent', tagIds: [TAG_IDS.strategic, TAG_IDS.people, TAG_IDS.safety] },
  { id: Q(112), text: 'What do you most want the acquiring company to understand about how your company operates that might not be obvious from the outside?', category: 'strategic-intent', tagIds: [TAG_IDS.strategic, TAG_IDS.safety] },
  { id: Q(113), text: 'What are you most worried about losing in this integration?', category: 'risk-surface', tagIds: [TAG_IDS.risk, TAG_IDS.safety, TAG_IDS.strategic] },
  { id: Q(114), text: 'Are there commitments you made to your team, your customers, or your investors that the integration team should know about?', category: 'risk-surface', tagIds: [TAG_IDS.risk, TAG_IDS.operational] },
  { id: Q(115), text: 'Is there anything you haven\'t been asked yet that you think the integration team needs to know?', category: 'strategic-intent', tagIds: [TAG_IDS.safety, TAG_IDS.strategic] },
];

const acdCeoProbes: QuestionDef[] = [
  { id: Q(116), text: 'Was there a specific moment or milestone that stands out as defining what made this company different?', category: 'strategic-intent', tagIds: [TAG_IDS.strategic, TAG_IDS.safety] },
  { id: Q(117), text: 'Beyond the financial outcome — were there mission or product goals that this acquisition advances?', category: 'strategic-intent', tagIds: [TAG_IDS.strategic, TAG_IDS.safety] },
  { id: Q(118), text: 'Can you give me a concrete example — a decision you made that illustrates that culture in action?', category: 'strategic-intent', tagIds: [TAG_IDS.strategic, TAG_IDS.safety] },
  { id: Q(119), text: 'Which specific people are you most concerned about? What would it take to retain them?', category: 'people-dynamics', tagIds: [TAG_IDS.people, TAG_IDS.risk] },
  { id: Q(120), text: 'Sometimes commitments are implicit — things people understood to be true. Are there any of the implicit kind we should know about?', category: 'risk-surface', tagIds: [TAG_IDS.risk, TAG_IDS.operational] },
];

// ── Acquired CTO/CIO (Q130-Q135) + Probes (Q136-Q137) ─────────────────────
const acdCtoQuestions: QuestionDef[] = [
  { id: Q(130), text: 'Walk me through the system the way you\'d explain it to a new senior engineer joining your team. What\'s the architecture, what are you proud of, and what would you warn them about?', category: 'operational-detail', tagIds: [TAG_IDS.operational, TAG_IDS.safety] },
  { id: Q(131), text: 'What technical decisions have you made that you\'d make differently if you were starting over today?', category: 'risk-surface', tagIds: [TAG_IDS.risk, TAG_IDS.operational] },
  { id: Q(132), text: 'What does your team do exceptionally well that you\'d want the acquiring company to adopt or learn from — rather than replace?', category: 'strategic-intent', tagIds: [TAG_IDS.strategic, TAG_IDS.safety] },
  { id: Q(133), text: 'Which engineers on your team are most critical to retain? What would each of them walk out the door with if they left?', category: 'people-dynamics', tagIds: [TAG_IDS.people, TAG_IDS.risk] },
  { id: Q(134), text: 'What AI or automation work is currently underway on your team? What\'s working, what\'s been abandoned, and what\'s on the roadmap?', category: 'strategic-intent', tagIds: [TAG_IDS.strategic, TAG_IDS.operational] },
  { id: Q(135), text: 'What should the acquiring company\'s technical leadership understand about your team that won\'t be obvious from an org chart or a codebase review?', category: 'people-dynamics', tagIds: [TAG_IDS.safety, TAG_IDS.people] },
];

const acdCtoProbes: QuestionDef[] = [
  { id: Q(136), text: 'Every system has areas where the team moves carefully. What are yours?', category: 'risk-surface', tagIds: [TAG_IDS.risk, TAG_IDS.operational] },
  { id: Q(137), text: 'For each of those people — what would make them want to stay? What are they most uncertain about right now?', category: 'people-dynamics', tagIds: [TAG_IDS.people, TAG_IDS.risk] },
];

// ── Acquired Data & Product (Q150-Q157) + Probes (Q158-Q159) ───────────────
// CPO/VP Product (150-153), VP Data & Analytics (154-157)
const acdDataProdQuestions: QuestionDef[] = [
  // CPO/VP Product
  { id: Q(150), text: 'What is the product you\'re most proud of shipping? What problem does it solve and why does it matter?', category: 'strategic-intent', tagIds: [TAG_IDS.strategic, TAG_IDS.safety] },
  { id: Q(151), text: 'What have you committed to customers on the roadmap that the integration must protect — and what is at risk of being deprioritized or dropped?', category: 'risk-surface', tagIds: [TAG_IDS.risk, TAG_IDS.operational] },
  { id: Q(152), text: 'Where do you believe your product is genuinely ahead of the acquiring company\'s? Where do you think you\'d lose a head-to-head comparison?', category: 'strategic-intent', tagIds: [TAG_IDS.strategic] },
  { id: Q(153), text: 'What would a product integration that goes well look like versus one that goes badly? What\'s the specific difference?', category: 'strategic-intent', tagIds: [TAG_IDS.strategic, TAG_IDS.risk] },
  // VP Data & Analytics
  { id: Q(154), text: 'What known data quality issues exist in production? Are there datasets that leadership relies on but that the data team knows are unreliable?', category: 'risk-surface', tagIds: [TAG_IDS.risk] },
  { id: Q(155), text: 'What customer, financial, or operational data needs to be migrated, merged, or reconciled with the acquiring company\'s systems?', category: 'operational-detail', tagIds: [TAG_IDS.operational, TAG_IDS.risk] },
  { id: Q(156), text: 'Are there active data sharing agreements, API integrations, or data feeds with customers or partners that must be maintained?', category: 'risk-surface', tagIds: [TAG_IDS.risk, TAG_IDS.operational] },
  { id: Q(157), text: 'What AI or ML models are currently in production? Who owns them and how are they monitored?', category: 'operational-detail', tagIds: [TAG_IDS.operational, TAG_IDS.strategic] },
];

const acdDataProdProbes: QuestionDef[] = [
  { id: Q(158), text: 'I\'m asking because the integration team needs to make honest survivorship decisions. Your candid read is more useful than a polished one.', category: 'strategic-intent', tagIds: [TAG_IDS.strategic] },
  { id: Q(159), text: 'What would the impact be of a 2–4 week disruption to the data and analytics environment during a migration?', category: 'risk-surface', tagIds: [TAG_IDS.risk] },
];

// ── Acquired CHRO/VP People (Q170-Q174) + Probes (Q175-Q177) ───────────────
const acdPeopleQuestions: QuestionDef[] = [
  { id: Q(170), text: 'How is the team doing right now, honestly? What are you hearing from people about how they\'re feeling about this acquisition?', category: 'people-dynamics', tagIds: [TAG_IDS.people, TAG_IDS.safety] },
  { id: Q(171), text: 'Which employees are most at risk of leaving — not because of performance, but because of uncertainty or because they have options?', category: 'people-dynamics', tagIds: [TAG_IDS.people, TAG_IDS.risk] },
  { id: Q(172), text: 'Are there compensation, equity, or benefits gaps between the two companies that employees are already aware of or will discover soon?', category: 'operational-detail', tagIds: [TAG_IDS.people, TAG_IDS.risk, TAG_IDS.operational] },
  { id: Q(173), text: 'What about this company\'s culture is hardest to describe but most important to preserve?', category: 'strategic-intent', tagIds: [TAG_IDS.people, TAG_IDS.strategic, TAG_IDS.safety] },
  { id: Q(174), text: 'What do you need from the integration team to protect the people on your team through this transition?', category: 'people-dynamics', tagIds: [TAG_IDS.people, TAG_IDS.safety] },
];

const acdPeopleProbes: QuestionDef[] = [
  { id: Q(175), text: 'Even when people are broadly supportive, they usually have specific anxieties. What are the most common ones?', category: 'people-dynamics', tagIds: [TAG_IDS.people, TAG_IDS.safety] },
  { id: Q(176), text: 'Even directionally — which functions or levels are most unsettled?', category: 'people-dynamics', tagIds: [TAG_IDS.people, TAG_IDS.risk] },
  { id: Q(177), text: 'Can you give me an example of a decision — a hiring decision, a management decision — that reflects that culture concretely?', category: 'strategic-intent', tagIds: [TAG_IDS.people, TAG_IDS.strategic] },
];

// ── Acquired Tech & Infrastructure — Mirrored (Q190-Q204) ──────────────────
const acdTechInfQuestions: QuestionDef[] = [
  { id: Q(190), text: 'What end-of-life or unsupported infrastructure is currently in production at your company? What has been deferred for remediation?', category: 'risk-surface', tagIds: [TAG_IDS.risk] },
  { id: Q(191), text: 'What are the most fragile or single-point-of-failure systems in your current environment?', category: 'risk-surface', tagIds: [TAG_IDS.risk] },
  { id: Q(192), text: 'What managed service providers or outsourced infrastructure contracts exist at your company? What are the terms and notice periods?', category: 'operational-detail', tagIds: [TAG_IDS.operational, TAG_IDS.risk] },
  { id: Q(193), text: 'What monitoring and observability tooling is in place at your company? How mature is alerting and incident response?', category: 'operational-detail', tagIds: [TAG_IDS.operational, TAG_IDS.risk] },
  { id: Q(194), text: 'Walk me through your current infrastructure footprint — cloud providers, data centers, co-location, and on-premises.', category: 'operational-detail', tagIds: [TAG_IDS.operational] },
  { id: Q(195), text: 'What security certifications or compliance frameworks is your company currently operating under?', category: 'operational-detail', tagIds: [TAG_IDS.risk, TAG_IDS.operational] },
  { id: Q(196), text: 'Are any of those certifications currently in scope, in audit, or pending renewal? What would integration activity put at risk?', category: 'risk-surface', tagIds: [TAG_IDS.risk] },
  { id: Q(197), text: 'Have there been any security incidents, data breaches, or regulatory investigations at your company in the past 24 months?', category: 'risk-surface', tagIds: [TAG_IDS.risk] },
  { id: Q(198), text: 'What penetration testing or red team activity has been conducted recently at your company? What findings remain open?', category: 'risk-surface', tagIds: [TAG_IDS.risk] },
  { id: Q(199), text: 'What security concerns do you have specifically about the integration process itself — not the steady state, but the transition period?', category: 'risk-surface', tagIds: [TAG_IDS.risk] },
  { id: Q(200), text: 'What is the current state of your CI/CD pipeline and development tooling? How automated is the path from code to production?', category: 'operational-detail', tagIds: [TAG_IDS.operational] },
  { id: Q(201), text: 'Where is the most significant technical debt in your product? What has been deliberately deferred and what is genuinely unknown?', category: 'risk-surface', tagIds: [TAG_IDS.risk, TAG_IDS.operational] },
  { id: Q(202), text: 'How does your engineering team feel about this acquisition? What are the most common concerns you\'re hearing?', category: 'people-dynamics', tagIds: [TAG_IDS.people, TAG_IDS.risk] },
  { id: Q(203), text: 'Which engineers are most critical to retain? What retention risk exists and what has already been done?', category: 'people-dynamics', tagIds: [TAG_IDS.people, TAG_IDS.risk] },
  { id: Q(204), text: 'What AI coding tools or automation are currently in use by your engineering team? What has been tried and abandoned?', category: 'operational-detail', tagIds: [TAG_IDS.operational, TAG_IDS.strategic] },
];

// ── Acquired Commercial Operations — Mirrored (Q210-Q223) ──────────────────
const acdCommOpsQuestions: QuestionDef[] = [
  { id: Q(210), text: 'What customer-facing commitments — contractual, verbal, or implied — were made to your customers during or after the deal announcement?', category: 'risk-surface', tagIds: [TAG_IDS.risk, TAG_IDS.operational] },
  { id: Q(211), text: 'Are there customers who are at meaningful churn risk? Who are they and what would stabilize them?', category: 'risk-surface', tagIds: [TAG_IDS.risk, TAG_IDS.strategic] },
  { id: Q(212), text: 'Are there contracts that contain change-of-control provisions that need to be actively managed?', category: 'risk-surface', tagIds: [TAG_IDS.risk, TAG_IDS.operational] },
  { id: Q(213), text: 'What cross-sell or upsell opportunities does this acquisition unlock from your perspective? Which are time-sensitive?', category: 'strategic-intent', tagIds: [TAG_IDS.strategic] },
  { id: Q(214), text: 'Which of your customers are at meaningful churn risk right now — before any integration disruption — and what are the reasons?', category: 'risk-surface', tagIds: [TAG_IDS.risk] },
  { id: Q(215), text: 'Are there customers who have a strong personal relationship with someone on your team who may be leaving?', category: 'people-dynamics', tagIds: [TAG_IDS.risk, TAG_IDS.people] },
  { id: Q(216), text: 'What commitments — service levels, named contacts, response times — have been made to your customers in ways not captured in contracts?', category: 'risk-surface', tagIds: [TAG_IDS.risk, TAG_IDS.operational] },
  { id: Q(217), text: 'What do your customers most value about working with your team that they\'re afraid they\'ll lose?', category: 'strategic-intent', tagIds: [TAG_IDS.strategic, TAG_IDS.risk] },
  { id: Q(218), text: 'Are there customer contracts that contain SLA penalties, service credits, or termination clauses that could be triggered during the transition?', category: 'risk-surface', tagIds: [TAG_IDS.risk] },
  { id: Q(219), text: 'Walk me through your full commercial technology stack — CRM, marketing automation, CPQ, billing, revenue recognition, BI.', category: 'operational-detail', tagIds: [TAG_IDS.operational] },
  { id: Q(220), text: 'What is the current state of your CRM data quality — contact completeness, account hierarchy, opportunity hygiene?', category: 'operational-detail', tagIds: [TAG_IDS.operational, TAG_IDS.risk] },
  { id: Q(221), text: 'Are there customizations, automations, or integrations in your CRM not documented anywhere and live only in someone\'s head?', category: 'risk-surface', tagIds: [TAG_IDS.risk, TAG_IDS.operational] },
  { id: Q(222), text: 'What is the most important data in your commercial systems that must not be lost or degraded in a migration?', category: 'risk-surface', tagIds: [TAG_IDS.risk, TAG_IDS.operational] },
  { id: Q(223), text: 'What rev ops work is currently in flight that would be disrupted if it had to pause?', category: 'operational-detail', tagIds: [TAG_IDS.operational, TAG_IDS.risk] },
];

// ── Acquired Governance & Delivery — Mirrored (Q230-Q244) ──────────────────
const acdGovDelQuestions: QuestionDef[] = [
  { id: Q(230), text: 'Are there redundant roles that will need to be eliminated? Has leadership aligned on the timeline and communication approach?', category: 'operational-detail', tagIds: [TAG_IDS.operational, TAG_IDS.risk] },
  { id: Q(231), text: 'How do total compensation, benefits, and equity structures compare to the acquiring company\'s? What harmonization is required and by when?', category: 'operational-detail', tagIds: [TAG_IDS.operational, TAG_IDS.risk] },
  { id: Q(232), text: 'Who are the most critical people to retain from your company? What specific retention risk exists for each of them?', category: 'people-dynamics', tagIds: [TAG_IDS.people, TAG_IDS.risk] },
  { id: Q(233), text: 'What is the communication plan for your employees? What has already been communicated, and what remains to be said?', category: 'people-dynamics', tagIds: [TAG_IDS.people, TAG_IDS.operational] },
  { id: Q(234), text: 'Are there employment law, works council, or union considerations that constrain how the integration can proceed?', category: 'risk-surface', tagIds: [TAG_IDS.risk, TAG_IDS.operational] },
  { id: Q(235), text: 'What material contracts have change-of-control provisions triggered by this acquisition? What is the status of notification or consent for each?', category: 'risk-surface', tagIds: [TAG_IDS.risk, TAG_IDS.operational] },
  { id: Q(236), text: 'Are there open or threatened litigation matters that the integration team should be aware of?', category: 'risk-surface', tagIds: [TAG_IDS.risk] },
  { id: Q(237), text: 'What data processing agreements exist between your company and its customers? Are they compliant with GDPR, CCPA, or other applicable privacy regulations?', category: 'risk-surface', tagIds: [TAG_IDS.risk, TAG_IDS.operational] },
  { id: Q(238), text: 'Are there open indemnification obligations or warranty claims from customer contracts that could become material?', category: 'risk-surface', tagIds: [TAG_IDS.risk] },
  { id: Q(239), text: 'What legal concerns specific to the integration process itself do you want to flag now, before work begins?', category: 'risk-surface', tagIds: [TAG_IDS.risk] },
  { id: Q(240), text: 'What projects are currently in flight at your company? Which ones are on the critical path and cannot be disrupted?', category: 'operational-detail', tagIds: [TAG_IDS.operational, TAG_IDS.risk] },
  { id: Q(241), text: 'What project or program failures in the past 12–18 months should inform how we approach this integration?', category: 'risk-surface', tagIds: [TAG_IDS.risk, TAG_IDS.operational] },
  { id: Q(242), text: 'What dependencies exist between your in-flight projects and integration workstreams that we need to map and manage?', category: 'operational-detail', tagIds: [TAG_IDS.operational, TAG_IDS.risk] },
  { id: Q(243), text: 'Who are the most effective project leaders at your company who should be brought into the integration workstream structure?', category: 'people-dynamics', tagIds: [TAG_IDS.people, TAG_IDS.operational] },
  { id: Q(244), text: 'What change management capability exists at your company?', category: 'operational-detail', tagIds: [TAG_IDS.operational] },
];

// ── Acquired Closing Sequence (Q250-Q253) + Probes (Q254-Q257) ─────────────
const acdClosingQuestions: QuestionDef[] = [
  { id: Q(250), text: 'Let me reflect back what I heard in this conversation. [AI generates summary of key themes, concerns, and commitments]. Is that an accurate representation? Is there anything I got wrong, overstated, or missed?', category: 'operational-detail', tagIds: [TAG_IDS.safety, TAG_IDS.operational] },
  { id: Q(251), text: 'Is there anything you thought about sharing during this conversation but decided not to? I want to give you one more opportunity if there\'s something that felt too sensitive to raise earlier.', category: 'risk-surface', tagIds: [TAG_IDS.safety, TAG_IDS.risk] },
  { id: Q(252), text: 'What would you most want the integration leadership team to know coming out of this conversation?', category: 'strategic-intent', tagIds: [TAG_IDS.safety, TAG_IDS.strategic] },
  { id: Q(253), text: 'What should I be asking the next person I talk to on your team?', category: 'operational-detail', tagIds: [TAG_IDS.operational, TAG_IDS.strategic] },
];

const acdClosingProbes: QuestionDef[] = [
  { id: Q(254), text: 'Thank you — that distinction matters. Let me update that. Is there anything else that needs correcting?', category: 'operational-detail', tagIds: [TAG_IDS.safety] },
  { id: Q(255), text: 'Is there anything you\'d soften — something I may have put more weight on than you intended?', category: 'operational-detail', tagIds: [TAG_IDS.safety] },
  { id: Q(256), text: 'I appreciate you sharing that. Is there context you\'d want me to have about why you hesitated?', category: 'risk-surface', tagIds: [TAG_IDS.safety, TAG_IDS.risk] },
  { id: Q(257), text: 'That\'s useful to know. Sometimes the absence of something is as important as its presence.', category: 'risk-surface', tagIds: [TAG_IDS.safety] },
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
  followupTriggers: FollowupTrigger[];
}

function buildTQs(
  templateId: string,
  questions: QuestionDef[],
  opts: {
    requiredCount?: number;          // first N are required, rest optional
    allRequired?: boolean;           // override: all required
    triggers?: Record<string, { condition: string; followupQuestionId: string }[]>;
    startSequence?: number;
  } = {}
): TQDef[] {
  const { requiredCount, allRequired = false, triggers = {}, startSequence = 1 } = opts;
  return questions.map((q, i) => ({
    id: tqId(templateId, q.id),
    templateId,
    questionId: q.id,
    sequenceOrder: startSequence + i,
    categoryBucket: q.category,
    isRequired: allRequired ? true : requiredCount !== undefined ? i < requiredCount : true,
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
  ...buildTQs(TMPL.acqCore, acqCoreQuestions, { allRequired: true }),

  // Acquiring CEO — first 3 required, rest optional, with a couple of triggers for testing
  ...buildTQs(TMPL.acqCeo, [...acqCeoQuestions, ...acqCeoProbes], {
    requiredCount: 3,
    triggers: {
      [Q(10)]: [{ condition: 'If the response lacks specific timelines or measurable milestones', followupQuestionId: Q(16) }],
      [Q(14)]: [{ condition: 'If the interviewee mentions specific individuals who have reservations', followupQuestionId: Q(17) }],
    },
  }),

  // Acquiring CFO — first 3 required
  ...buildTQs(TMPL.acqCfo, acqCfoQuestions, { requiredCount: 3 }),

  // Acquiring CTO — first 3 required
  ...buildTQs(TMPL.acqCto, acqCtoQuestions, { requiredCount: 3 }),

  // Acquiring Tech & Infra — VP Infra first 3 req, VP Security first 3 req, VP Eng first 3 req
  ...buildTQs(TMPL.acqTechInf, acqTechInfQuestions.slice(0, 5), { requiredCount: 3 }),
  ...buildTQs(TMPL.acqTechInf, acqTechInfQuestions.slice(5, 10), { requiredCount: 3, startSequence: 6 }),
  ...buildTQs(TMPL.acqTechInf, acqTechInfQuestions.slice(10, 15), { requiredCount: 3, startSequence: 11 }),

  // Acquiring Commercial Ops
  ...buildTQs(TMPL.acqCommOps, acqCommOpsQuestions.slice(0, 4), { requiredCount: 3 }),
  ...buildTQs(TMPL.acqCommOps, acqCommOpsQuestions.slice(4, 9), { requiredCount: 3, startSequence: 5 }),
  ...buildTQs(TMPL.acqCommOps, acqCommOpsQuestions.slice(9, 14), { requiredCount: 2, startSequence: 10 }),

  // Acquiring Governance & Delivery
  ...buildTQs(TMPL.acqGovDel, acqGovDelQuestions.slice(0, 5), { requiredCount: 3 }),
  ...buildTQs(TMPL.acqGovDel, acqGovDelQuestions.slice(5, 10), { requiredCount: 3, startSequence: 6 }),
  ...buildTQs(TMPL.acqGovDel, acqGovDelQuestions.slice(10, 15), { requiredCount: 3, startSequence: 11 }),

  // Acquired Core — all required
  ...buildTQs(TMPL.acdCore, acdCoreQuestions, { allRequired: true }),

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
  }),

  // Acquired CTO — all primary required, probes optional with triggers
  ...buildTQs(TMPL.acdCto, [...acdCtoQuestions, ...acdCtoProbes], {
    requiredCount: 4,
    triggers: {
      [Q(130)]: [{ condition: 'If the interviewee skips warnings or minimizes risk areas in their architecture walkthrough', followupQuestionId: Q(136) }],
      [Q(133)]: [{ condition: 'If the interviewee names specific critical engineers', followupQuestionId: Q(137) }],
    },
  }),

  // Acquired Data & Product — first 4 (CPO) required, data questions mix
  ...buildTQs(TMPL.acdDataProd, [...acdDataProdQuestions, ...acdDataProdProbes], {
    requiredCount: 6,
    triggers: {
      [Q(152)]: [{ condition: 'If the interviewee is reluctant to compare honestly against the acquiring company\'s product', followupQuestionId: Q(158) }],
      [Q(155)]: [{ condition: 'If the response describes significant data migration scope', followupQuestionId: Q(159) }],
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
  }),

  // Acquired Tech & Infra (mirrored) — same required pattern as acquiring side
  ...buildTQs(TMPL.acdTechInf, acdTechInfQuestions.slice(0, 5), { requiredCount: 3 }),
  ...buildTQs(TMPL.acdTechInf, acdTechInfQuestions.slice(5, 10), { requiredCount: 3, startSequence: 6 }),
  ...buildTQs(TMPL.acdTechInf, acdTechInfQuestions.slice(10, 15), { requiredCount: 3, startSequence: 11 }),

  // Acquired Commercial Ops (mirrored)
  ...buildTQs(TMPL.acdCommOps, acdCommOpsQuestions.slice(0, 4), { requiredCount: 3 }),
  ...buildTQs(TMPL.acdCommOps, acdCommOpsQuestions.slice(4, 9), { requiredCount: 3, startSequence: 5 }),
  ...buildTQs(TMPL.acdCommOps, acdCommOpsQuestions.slice(9, 14), { requiredCount: 2, startSequence: 10 }),

  // Acquired Governance & Delivery (mirrored)
  ...buildTQs(TMPL.acdGovDel, acdGovDelQuestions.slice(0, 5), { requiredCount: 3 }),
  ...buildTQs(TMPL.acdGovDel, acdGovDelQuestions.slice(5, 10), { requiredCount: 3, startSequence: 6 }),
  ...buildTQs(TMPL.acdGovDel, acdGovDelQuestions.slice(10, 15), { requiredCount: 3, startSequence: 11 }),

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
  }),
];


// ============================================================================
// TEMPLATE DEFINITIONS
// ============================================================================
const templates = [
  { id: TMPL.acqCore,    name: 'Acquiring — Core Questions',              description: "Establishes each acquiring-side stakeholder's personal understanding of the acquisition rationale, success criteria, key risks, and inter-company relationship dynamics.",                                                                                    systemPrompt: DESCRIPTIONS.acqCore,    status: 'published' },
  { id: TMPL.acqCeo,     name: 'Acquiring — CEO/President',               description: "Captures the acquiring CEO's strategic thesis, speed-vs-preservation priorities, board-level commitments, and leadership team alignment.",                                                                                                                     systemPrompt: DESCRIPTIONS.acqCeo,     status: 'published' },
  { id: TMPL.acqCfo,     name: 'Acquiring — CFO',                         description: 'Surfaces committed synergy targets, financial system consolidation scope, earn-out provisions, due-diligence confidence, and risk tolerance for disruption.',                                                                                                    systemPrompt: DESCRIPTIONS.acqCfo,     status: 'published' },
  { id: TMPL.acqCto,     name: 'Acquiring — CTO/CIO',                     description: 'Determines the intended infrastructure end-state, business-critical systems, data sovereignty constraints, AI/automation direction, and key architectural incompatibilities.',                                                                                   systemPrompt: DESCRIPTIONS.acqCto,     status: 'published' },
  { id: TMPL.acqTechInf, name: 'Acquiring — Technology & Infrastructure', description: 'Maps infrastructure fragility, security certification exposure, engineering morale and retention risk, CI/CD maturity, and AI tooling across VP Infrastructure, Security, and Engineering roles.',                                                               systemPrompt: DESCRIPTIONS.acqTechInf, status: 'published' },
  { id: TMPL.acqCommOps, name: 'Acquiring — Commercial Operations',       description: 'Uncovers customer-facing commitments, churn risk, change-of-control provisions, cross-sell opportunities, and CRM data quality across Sales, Customer Success, and Revenue Operations roles.',                                                                   systemPrompt: DESCRIPTIONS.acqCommOps, status: 'published' },
  { id: TMPL.acqGovDel,  name: 'Acquiring — Governance & Delivery',       description: 'Identifies redundant roles, compensation gaps, legal provisions, in-flight project dependencies, and change management capability across People, Legal, and PMO roles.',                                                                                         systemPrompt: DESCRIPTIONS.acqGovDel,  status: 'published' },
  { id: TMPL.acdCore,    name: 'Acquired — Core Questions',               description: "Opens acquired-side interviews with required psychological safety framing, then surfaces each stakeholder's view of the acquisition rationale, personal success criteria, risks, and what must be preserved.",                                                   systemPrompt: DESCRIPTIONS.acdCore,    status: 'published' },
  { id: TMPL.acdCeo,     name: 'Acquired — CEO/Founder',                  description: "Draws out what the founder built and was proud of, their personal motivation for the deal, implicit commitments made, and what they most fear losing.",                                                                                                          systemPrompt: DESCRIPTIONS.acdCeo,     status: 'published' },
  { id: TMPL.acdCto,     name: 'Acquired — CTO/CIO',                      description: 'Captures an insider architecture walkthrough with candid warnings, technical regrets, team strengths worth adopting, critical retention targets, and AI work in progress.',                                                                                      systemPrompt: DESCRIPTIONS.acdCto,     status: 'published' },
  { id: TMPL.acdDataProd,name: 'Acquired — Data & Product',               description: 'Surfaces roadmap commitments at risk, honest competitive positioning, known data quality issues, migration scope, and AI/ML models in production.',                                                                                                              systemPrompt: DESCRIPTIONS.acdDataProd,status: 'published' },
  { id: TMPL.acdPeople,  name: 'Acquired — CHRO/VP People',               description: "Gathers an honest read on team morale, flight-risk employees, compensation gaps employees will discover, hardest-to-preserve cultural attributes, and what the People leader needs from the integration team.",                                                  systemPrompt: DESCRIPTIONS.acdPeople,  status: 'published' },
  { id: TMPL.acdTechInf, name: 'Acquired — Technology & Infrastructure',  description: 'Mirrors the acquiring-side tech interview while additionally surfacing what the acquired team does well that should be preserved and how the team is feeling about the transition.',                                                                              systemPrompt: DESCRIPTIONS.acdTechInf, status: 'published' },
  { id: TMPL.acdCommOps, name: 'Acquired — Commercial Operations',        description: "Mirrors the acquiring-side commercial interview while additionally uncovering personally-held customer relationships, unwritten commitments, and what customers most fear losing.",                                                                                systemPrompt: DESCRIPTIONS.acdCommOps, status: 'published' },
  { id: TMPL.acdGovDel,  name: 'Acquired — Governance & Delivery',        description: "Mirrors the acquiring-side governance interview while additionally capturing what the acquired company's people need from the integration team and which project leaders should join workstreams.",                                                               systemPrompt: DESCRIPTIONS.acdGovDel,  status: 'published' },
  { id: TMPL.acdClosing, name: 'Acquired — Closing Sequence',             description: 'Validates a reflection summary for corrections, creates a final safety valve for anything the interviewee held back, and gathers forward-looking guidance for integration leadership.',                                                                           systemPrompt: DESCRIPTIONS.acdClosing, status: 'published' },
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
      category: q.category,
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
