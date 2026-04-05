# CI/CD Pipeline

This directory contains an AI-powered CI/CD pipeline that automatically reviews, fixes, and deploys code.

## How It Works

When you open a pull request, the pipeline runs in three phases:

**Phase 1 — Pre-checks** run in parallel and catch deterministic issues: dependency vulnerabilities (`npm audit`), bundle size regressions, security vulnerabilities (Bearer CLI), and a blast radius analysis that maps which files are affected by your changes using the TypeScript import graph.

**Phase 2 — AI agents** run sequentially, each powered by Claude via AWS Lambda. Every agent analyzes the files in the blast radius, auto-fixes what it can, and commits its changes directly to your PR branch. The agents run in this order because each one benefits from the previous agent's output:

1. **Linting / Code Style** — enforces consistent TypeScript patterns, removes dead code, organizes imports
2. **Security** — interprets Bearer scan results, fixes confirmed vulnerabilities, flags complex issues for human review
3. **Speed Optimization** — catches N+1 queries, unnecessary re-renders, inefficient algorithms, missing caching
4. **Unit Tests** — generates or updates test files for changed code
5. **Documentation** — adds JSDoc comments and inline documentation optimized for both humans and AI agents
6. **API Contract Validation** — verifies frontend/backend type contracts are consistent

**Phase 3 — Synthesis** always runs, even if earlier steps fail. It aggregates all agent reports, posts a summary comment on your PR, and creates Linear tickets for any findings that couldn't be auto-fixed.

On **push to main**, only the pre-checks run, followed by deployment to dev and then prod.

## Directory Map

```
.github/
├── README.md                        ← You are here
├── workflows/
│   ├── pr-pipeline.yml              ← Full PR pipeline (pre-checks → agents → synthesis)
│   └── deploy.yml                   ← Push-to-main deploy (pre-checks → dev → prod)
├── actions/
│   └── run-agent/
│       └── action.yml               ← Reusable composite action for invoking any agent Lambda
└── scripts/
    └── blast-radius.ts              ← Madge-based dependency graph analyzer

infrastructure/lambdas/
├── shared/
│   ├── types.ts                     ← Shared interfaces (AgentReport, Finding, etc.)
│   ├── claude-client.ts             ← Anthropic API wrapper with retry logic
│   └── git-operations.ts            ← Diff parsing and code formatting utilities
├── agent-linting/
├── agent-security/
├── agent-speed/
├── agent-unit-tests/
├── agent-documentation/
├── agent-api-contracts/
└── agent-synthesis/
    ├── handler.ts
    ├── prompt.ts
    └── linear-client.ts             ← Linear API integration for ticket creation
```

## Key Behaviors

**Loop prevention.** Agent commits use the `github-actions[bot]` identity. GitHub Actions does not trigger workflows on commits from this identity, so agent fixes never cause the pipeline to re-run itself.

**Scope control.** Agents don't scan the entire repo. The blast radius analyzer uses `madge` to trace the import graph of changed files (3 levels deep, capped at 100 files) so agents only review code that could actually be affected.

**Cost control.** The pipeline uses concurrency groups to cancel in-progress runs when you push new commits to the same branch. Each agent tracks Claude token usage in its report, and the synthesis comment includes total token cost for the run.

**Failure handling.** If any agent fails or flags critical issues it can't fix, the pipeline blocks the PR and the synthesis agent creates Linear tickets with enough context for a developer or coding agent to resolve the issue.

## How to Modify an Agent

Each agent lives in `infrastructure/lambdas/agent-{name}/` and has two key files:

**`prompt.ts`** contains the system prompt that defines what the agent looks for and how it behaves. This is the main thing you'll tune over time. If the agent is producing false positives, being too aggressive with fixes, or missing a category of issues, adjust the prompt.

**`handler.ts`** contains the Lambda handler logic: parsing the input payload, calling Claude, parsing the response, and formatting the output. You'll rarely need to change this unless you're changing the agent's I/O contract.

To add a new agent: copy any existing agent directory, update the prompt and handler, add a new job to `pr-pipeline.yml` that slots it into the sequence, and update the synthesis agent to expect the new report.

## Secrets

The pipeline requires these GitHub repository secrets:

| Secret | Purpose |
|--------|---------|
| `ANTHROPIC_API_KEY` | Claude API access for all Lambda agents |
| `AWS_ACCESS_KEY_ID` | Lambda invocation and deployment |
| `AWS_SECRET_ACCESS_KEY` | Lambda invocation and deployment |
| `AWS_REGION` | AWS region (e.g., `us-east-1`) |
| `LINEAR_API_KEY` | Ticket creation by the synthesis agent |
| `LINEAR_TEAM_ID` | Target team for Linear tickets |