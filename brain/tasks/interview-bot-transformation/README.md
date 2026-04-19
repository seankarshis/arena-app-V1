# How to Kick Off This Work

## Where to Put the Files

Save the three brief files somewhere accessible to Claude Code. Recommended location in the project:

```
brain/tasks/interview-bot-transformation/
├── 00-KICKOFF.md
├── 01-DESIGN-PRINCIPLES.md
└── 02-OPERATIONAL-GUARDRAILS.md
```

This fits the existing Arena documentation convention (task-scoped specs live in `brain/tasks/`) and means Claude Code can reference them naturally through the normal file paths. You can use any location, but placing them inside the project's existing docs structure helps Claude Code treat them as first-class project artifacts rather than outside instructions.

## Model Choice

**Use Claude Opus for this work.**

Reasoning: This is a multi-phase architectural transformation with significant judgment calls about data model design, prompt engineering, and documentation discipline. The bulk of the cost is thinking and deciding, not code volume. Opus's stronger reasoning earns its keep on the design phases and on the judgment calls embedded throughout.

If you want to economize, Sonnet is capable of executing Phase 3 (Implementation) layer-by-layer once the Phase 2 designs are approved. Consider Opus for Phases 1 and 2, Sonnet for straightforward implementation work, and Opus again for Phase 4 review of whether the bot actually behaves like a world-class consultant. But the simpler path is Opus throughout.

## The Kickoff Prompt

Paste this into Claude Code when you start the session:

---

I'm kicking off a significant architectural transformation of the interview bot. The work is scoped, documented, and ready to begin. Three briefing files describe the effort:

- `brain/tasks/interview-bot-transformation/00-KICKOFF.md` — master brief, phases, working mode
- `brain/tasks/interview-bot-transformation/01-DESIGN-PRINCIPLES.md` — orchestration model, data model, system prompt architecture, token strategy
- `brain/tasks/interview-bot-transformation/02-OPERATIONAL-GUARDRAILS.md` — ClickHouse observability, PII rules, documentation discipline

Read all three files carefully before beginning work. The kickoff file tells you how to structure the work and which companion to reference at each phase.

Before touching anything, follow the Arena startup protocol described in the kickoff: read `CLAUDE.md`, `brain/architecture/current-state.md`, `brain/architecture/changelog.md`, relevant ADRs, and the current interview and conversation-protocol specs.

Then begin **Phase 1: Discovery.** Produce the `INTERVIEW_BOT_ANALYSIS.md` deliverable described in the kickoff. This is an explicit approval gate — do not proceed to Phase 2 until the analysis is reviewed and approved.

Within Phase 1, pay special attention to the ClickHouse event schema proposal. Those new event types are blocked on explicit approval before any emitting code is written, per `02-OPERATIONAL-GUARDRAILS.md`.

Work as autonomously as you can within Phase 1. Ask clarifying questions only if you encounter genuine ambiguity that blocks meaningful progress. Otherwise, document your assumptions in the analysis and proceed. I'll review the analysis holistically when it's done.

A few reminders for how I want this work to feel:

- Creative freedom is real. If you see a better approach than what's described in the briefings, propose it. Document deviations via ADR.
- Spec conflicts flag explicitly, never resolve silently.
- Inline documentation explains *why*, not *what*.
- The system prompt is a versioned artifact — treat it with the same discipline as code.
- The goal is a world-class interview system for the post-close M&A market. Quality of the resulting conversations and data matters more than speed of delivery.

Begin.

---

## What to Expect

Phase 1 will likely take a substantial session. Claude Code will read extensively across the codebase, map the current architecture, and produce a detailed analysis. The deliverable is the analysis document — not code changes.

You'll review the analysis, respond with feedback and approval (or redirection), and then Claude Code can proceed to Phase 2 design work. Same pattern: design deliverables (ADRs, updated specs), review, approve, proceed.

Phase 3 implementation is where code changes happen, in layers. Each layer should be independently shippable, and you can review between layers rather than all at once.

## Tips for the Session

**Don't interrupt during Phase 1 discovery unless necessary.** The value of the analysis depends on Claude Code building a complete mental model. Let it work.

**Review the analysis carefully.** This is the foundation for everything that follows. If something looks wrong, say so before Phase 2 begins — course correction is cheap at this point and expensive later.

**When approving, be explicit about the approval and about any modifications.** "Approved as written, proceed to Phase 2" vs "Approved with these changes: [list]" — unambiguous signals make Claude Code's next move clear.

**If Claude Code proposes a deviation from the briefings, engage with the reasoning.** The briefings are guidance, not law. Deviations that have good reasoning behind them are often improvements. The ADR pattern captures this.

**Keep an eye on the ClickHouse event type proposal.** That's the one place in Phase 1 where you're explicitly gating implementation. Make sure the schemas make sense for the kinds of questions you'll want to ask the data later.

## If Things Go Sideways

If Claude Code's Phase 1 analysis misses something important or reaches wrong conclusions, the cost of correction is a round-trip conversation — not a code rollback. That's the value of the gate-based structure.

If Claude Code starts drifting during implementation, point it back to the briefings. The kickoff file, design principles, and guardrails together constitute the project's north star. When in doubt, re-read.

Good luck. This should produce something genuinely useful.
