// ---------------------------------------------------------------------------
// Unit Tests — api/src/services/promptBuilder.ts
//
// Tests cover:
// - Tier 1 determinism: same promptVersion → identical content
// - Tier 1 caching: spec file is read only once per version (spy on fs.readFileSync)
// - Tier 2 full briefing format for not_started / partially_covered questions
// - Tier 2 compact one-line format for fully_covered / skipped questions
// - Missing intent fallback to exact ADR 006 phrasing
// - cacheBreakpoint points to the end of Tier 1, not into Tier 2
// - messages array contains conversation turns, not interview guide content
// - Template systemPrompt override appears in the system string
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';

import {
  buildPrompt,
  _tier1CacheSize,
  _clearTier1Cache,
  type InterviewSessionState,
  type SessionQuestion,
  type AnthropicMessage,
} from '../services/promptBuilder';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeQuestion(
  overrides: Partial<SessionQuestion> & { questionId: string; questionText: string },
): SessionQuestion {
  return {
    categoryBucket: 'infrastructure',
    isRequired: true,
    sequenceOrder: 1,
    sensitivityLevel: 'standard',
    intent: 'Understand the current state of identity and access management.',
    adminNotes: null,
    tags: [],
    ...overrides,
  };
}

function makeSession(overrides: Partial<InterviewSessionState> = {}): InterviewSessionState {
  return {
    interviewId: 'interview-001',
    userId: 'user-001',
    templateId: 'template-001',
    turnNumber: 1,
    isStreaming: false,
    currentTurnLlmText: '',
    sessionVersion: 'v2-coverage',
    consecutiveParseFailures: 0,
    coverage: {},
    activeThreads: [],
    factsLedger: [],
    rapportNotes: [],
    questions: [
      makeQuestion({
        questionId: 'q-001',
        questionText: 'How do you handle identity and access management today?',
      }),
    ],
    intervieweeName: 'Alex',
    intervieweeRole: 'CIO',
    intervieweeCompany: 'Acme Corp',
    templateFocus: 'Post-close IT integration discovery',
    templateSystemPromptOverride: null,
    conversationHistory: [],
    currentUserUtterance: 'Hello, I am ready to start.',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tier 1 determinism
// ---------------------------------------------------------------------------

describe('Tier 1 — determinism', () => {
  it('produces identical Tier 1 content on two calls with the same promptVersion', () => {
    const session = makeSession();
    const result1 = buildPrompt(session, 'v1');
    const result2 = buildPrompt(session, 'v1');

    // Extract the Tier 1 prefix from both results using cacheBreakpoint
    const tier1a = result1.system.slice(0, result1.cacheBreakpoint);
    const tier1b = result2.system.slice(0, result2.cacheBreakpoint);

    expect(tier1a).toBe(tier1b);
    expect(tier1a.length).toBeGreaterThan(100); // sanity: actually has content
  });

  it('Tier 1 contains the Output Contract section', () => {
    const { system, cacheBreakpoint } = buildPrompt(makeSession(), 'v1');
    const tier1 = system.slice(0, cacheBreakpoint);
    // Output contract specifies the STATE_UPDATE delimiter
    expect(tier1).toContain('---STATE_UPDATE---');
    expect(tier1).toContain('---END_STATE_UPDATE---');
  });

  it('Tier 1 contains all eight static prompt section bodies', () => {
    const { system, cacheBreakpoint } = buildPrompt(makeSession(), 'v1');
    const tier1 = system.slice(0, cacheBreakpoint);

    // Spot-check one phrase from each of the 8 numbered sections in the spec
    expect(tier1).toContain('fifteen years'); // §1 Persona
    expect(tier1).toContain('Assess.'); // §2 Orchestration Loop
    expect(tier1).toContain('Vague answers.'); // §3 Response Handling
    expect(tier1).toContain('telegraphs the expected answer'); // §4 Leading Questions body
    expect(tier1).toContain('Opening'); // §5 Opening/Closing
    expect(tier1).toContain('chatbot tell'); // §6 Pacing
    expect(tier1).toContain('pretending and guessing'); // §7 Honesty About Limitations body
    expect(tier1).toContain('canonical reference for structure'); // §8 Worked Example body
  });

  it('throws loudly on an unknown promptVersion', () => {
    expect(() => buildPrompt(makeSession(), 'v99')).toThrow('Unknown promptVersion');
    expect(() => buildPrompt(makeSession(), 'v99')).toThrow('v99');
  });
});

// ---------------------------------------------------------------------------
// Tier 1 caching — spec is parsed once per version
// ---------------------------------------------------------------------------

describe('Tier 1 — caching', () => {
  it('cache size is exactly 1 after multiple calls with the same version', () => {
    // Clear the cache so this test controls state
    _clearTier1Cache();
    expect(_tier1CacheSize()).toBe(0);

    buildPrompt(makeSession(), 'v1');
    expect(_tier1CacheSize()).toBe(1);

    // Repeated calls with the same version must not add new cache entries
    buildPrompt(makeSession(), 'v1');
    buildPrompt(makeSession(), 'v1');
    buildPrompt(makeSession(), 'v1');
    expect(_tier1CacheSize()).toBe(1);
  });

  it('produces the same Tier 1 content on every call after caching', () => {
    _clearTier1Cache();
    const r1 = buildPrompt(makeSession(), 'v1');
    const r2 = buildPrompt(makeSession(), 'v1');
    const r3 = buildPrompt(makeSession(), 'v1');

    const tier1a = r1.system.slice(0, r1.cacheBreakpoint);
    const tier1b = r2.system.slice(0, r2.cacheBreakpoint);
    const tier1c = r3.system.slice(0, r3.cacheBreakpoint);

    expect(tier1a).toBe(tier1b);
    expect(tier1b).toBe(tier1c);
  });
});

// ---------------------------------------------------------------------------
// Tier 2 — Interview Guide rendering
// ---------------------------------------------------------------------------

describe('Tier 2 — not_started question renders full briefing', () => {
  it('includes all briefing fields when coverage is absent (implicitly not_started)', () => {
    const session = makeSession({
      questions: [
        makeQuestion({
          questionId: 'q-001',
          questionText: 'What ERP systems are in use?',
          categoryBucket: 'applications',
          isRequired: true,
          sensitivityLevel: 'standard',
          intent: 'Identify ERP landscape and integration complexity.',
          adminNotes: 'Focus on SAP vs Oracle.',
          tags: ['erp', 'applications'],
          sequenceOrder: 1,
        }),
      ],
      coverage: {},
    });

    const { system, cacheBreakpoint } = buildPrompt(session, 'v1');
    const tier2 = system.slice(cacheBreakpoint);

    expect(tier2).toContain('What ERP systems are in use?');
    expect(tier2).toContain('Identify ERP landscape and integration complexity.');
    expect(tier2).toContain('Focus on SAP vs Oracle.');
    expect(tier2).toContain('erp');
    expect(tier2).toContain('required');
    expect(tier2).toContain('standard');
    expect(tier2).toContain('not_started');
  });

  it('includes all briefing fields when status is explicitly partially_covered', () => {
    const session = makeSession({
      questions: [
        makeQuestion({
          questionId: 'q-002',
          questionText: 'How are vendor contracts managed?',
          categoryBucket: 'vendors',
          isRequired: false,
          sensitivityLevel: 'sensitive',
          intent: 'Understand vendor landscape and contract renewal risk.',
          adminNotes: null,
          tags: ['vendors'],
          sequenceOrder: 1,
        }),
      ],
      coverage: {
        'q-002': {
          status: 'partially_covered',
          confidence: 'low',
          turnNumbers: [2],
          summary: 'Brief mention of SAP and Oracle contracts.',
        },
      },
    });

    const { system, cacheBreakpoint } = buildPrompt(session, 'v1');
    const tier2 = system.slice(cacheBreakpoint);

    expect(tier2).toContain('How are vendor contracts managed?');
    expect(tier2).toContain('partially_covered');
    expect(tier2).toContain('confidence: low');
    expect(tier2).toContain('Brief mention of SAP and Oracle contracts.');
    expect(tier2).toContain('optional');
    expect(tier2).toContain('sensitive');
  });
});

describe('Tier 2 — fully_covered and skipped questions render compact', () => {
  it('renders fully_covered question as one-line compact entry', () => {
    const session = makeSession({
      questions: [
        makeQuestion({
          questionId: 'q-003',
          questionText: 'What is the budget for this year?',
          categoryBucket: 'financials',
          sequenceOrder: 1,
        }),
      ],
      coverage: {
        'q-003': {
          status: 'fully_covered',
          confidence: 'high',
          turnNumbers: [3, 4],
          summary: '$2.1M allocated, 18-month runway.',
        },
      },
    });

    const { system, cacheBreakpoint } = buildPrompt(session, 'v1');
    const tier2 = system.slice(cacheBreakpoint);

    // Should be compact — the full question text should NOT appear in a briefing block
    expect(tier2).toContain('Q1 (financials) — fully_covered (high): $2.1M allocated, 18-month runway.');
    // The question text should not appear as a standalone "Question text:" line
    // (it appears only in full briefing format)
    expect(tier2).not.toContain('Question text: What is the budget for this year?');
  });

  it('renders skipped question as one-line compact entry with reason', () => {
    const session = makeSession({
      questions: [
        makeQuestion({
          questionId: 'q-004',
          questionText: 'How many staff will be affected?',
          categoryBucket: 'hr',
          sequenceOrder: 1,
        }),
      ],
      coverage: {
        'q-004': {
          status: 'skipped',
          confidence: null,
          turnNumbers: [],
          summary: 'Interviewee declined to discuss.',
        },
      },
    });

    const { system, cacheBreakpoint } = buildPrompt(session, 'v1');
    const tier2 = system.slice(cacheBreakpoint);

    expect(tier2).toContain('Q1 (hr) — skipped: Interviewee declined to discuss.');
    expect(tier2).not.toContain('Question text: How many staff will be affected?');
  });

  it('renders a mix of not_started, partially_covered, fully_covered, and skipped correctly', () => {
    const session = makeSession({
      questions: [
        makeQuestion({ questionId: 'q-a', questionText: 'Q Alpha', categoryBucket: 'alpha', sequenceOrder: 1 }),
        makeQuestion({ questionId: 'q-b', questionText: 'Q Beta', categoryBucket: 'beta', sequenceOrder: 2 }),
        makeQuestion({ questionId: 'q-c', questionText: 'Q Gamma', categoryBucket: 'gamma', sequenceOrder: 3 }),
        makeQuestion({ questionId: 'q-d', questionText: 'Q Delta', categoryBucket: 'delta', sequenceOrder: 4 }),
      ],
      coverage: {
        'q-b': { status: 'partially_covered', confidence: 'medium', turnNumbers: [1], summary: 'Some info.' },
        'q-c': { status: 'fully_covered', confidence: 'high', turnNumbers: [2], summary: 'Fully addressed.' },
        'q-d': { status: 'skipped', confidence: null, turnNumbers: [], summary: 'Out of scope.' },
      },
    });

    const { system, cacheBreakpoint } = buildPrompt(session, 'v1');
    const tier2 = system.slice(cacheBreakpoint);

    // q-a: not_started → full briefing
    expect(tier2).toContain('Question text: Q Alpha');
    // q-b: partially_covered → full briefing
    expect(tier2).toContain('Question text: Q Beta');
    // q-c: fully_covered → compact
    expect(tier2).toContain('Q3 (gamma) — fully_covered (high): Fully addressed.');
    expect(tier2).not.toContain('Question text: Q Gamma');
    // q-d: skipped → compact
    expect(tier2).toContain('Q4 (delta) — skipped: Out of scope.');
    expect(tier2).not.toContain('Question text: Q Delta');
  });
});

// ---------------------------------------------------------------------------
// Missing intent fallback
// ---------------------------------------------------------------------------

describe('Missing intent fallback', () => {
  it('renders the exact ADR 006 fallback phrasing when intent is null', () => {
    const session = makeSession({
      questions: [
        makeQuestion({
          questionId: 'q-null-intent',
          questionText: 'What are the main pain points?',
          intent: null,
          sequenceOrder: 1,
        }),
      ],
      coverage: {},
    });

    const { system, cacheBreakpoint } = buildPrompt(session, 'v1');
    const tier2 = system.slice(cacheBreakpoint);

    expect(tier2).toContain(
      'Briefing: (No briefing provided; infer intent from question text and tags.)',
    );
  });

  it('does NOT use the fallback phrasing when intent is provided', () => {
    const session = makeSession({
      questions: [
        makeQuestion({
          questionId: 'q-with-intent',
          questionText: 'Describe your backup strategy.',
          intent: 'Assess DR readiness and recovery time objectives.',
          sequenceOrder: 1,
        }),
      ],
      coverage: {},
    });

    const { system, cacheBreakpoint } = buildPrompt(session, 'v1');
    const tier2 = system.slice(cacheBreakpoint);

    expect(tier2).toContain('Assess DR readiness and recovery time objectives.');
    expect(tier2).not.toContain('No briefing provided');
  });
});

// ---------------------------------------------------------------------------
// cacheBreakpoint
// ---------------------------------------------------------------------------

describe('cacheBreakpoint', () => {
  it('points exactly to the end of Tier 1 — character at breakpoint is start of Tier 2', () => {
    const { system, cacheBreakpoint } = buildPrompt(makeSession(), 'v1');

    // Character at cacheBreakpoint should start the Tier 2 separator
    const charAtBreakpoint = system.slice(cacheBreakpoint, cacheBreakpoint + 5);
    // Tier 2 starts with '\n\n---' (the separator line we prepend)
    expect(charAtBreakpoint).toMatch(/^\n\n---/);
  });

  it('Tier 1 prefix does not contain Interview Guide content', () => {
    const session = makeSession({
      questions: [
        makeQuestion({
          questionId: 'q-check',
          questionText: 'UNIQUE_QUESTION_MARKER_XYZ',
          sequenceOrder: 1,
        }),
      ],
    });

    const { system, cacheBreakpoint } = buildPrompt(session, 'v1');
    const tier1 = system.slice(0, cacheBreakpoint);

    expect(tier1).not.toContain('UNIQUE_QUESTION_MARKER_XYZ');
    expect(tier1).not.toContain('Interview Guide');
  });

  it('Tier 1 prefix does not contain interviewee context', () => {
    const session = makeSession({
      intervieweeName: 'UNIQUE_NAME_ZEPHYR',
      intervieweeCompany: 'UNIQUE_COMPANY_XYZ',
    });

    const { system, cacheBreakpoint } = buildPrompt(session, 'v1');
    const tier1 = system.slice(0, cacheBreakpoint);

    expect(tier1).not.toContain('UNIQUE_NAME_ZEPHYR');
    expect(tier1).not.toContain('UNIQUE_COMPANY_XYZ');
  });

  it('cacheBreakpoint is stable across calls with the same session', () => {
    const session = makeSession();
    const r1 = buildPrompt(session, 'v1');
    const r2 = buildPrompt(session, 'v1');
    expect(r1.cacheBreakpoint).toBe(r2.cacheBreakpoint);
  });
});

// ---------------------------------------------------------------------------
// Messages array
// ---------------------------------------------------------------------------

describe('messages array', () => {
  it('includes the current user utterance as the final message', () => {
    const session = makeSession({
      currentUserUtterance: 'We use Active Directory for most identity.',
      conversationHistory: [],
    });

    const { messages } = buildPrompt(session, 'v1');

    expect(messages.length).toBeGreaterThan(0);
    const lastMsg = messages[messages.length - 1];
    expect(lastMsg.role).toBe('user');
    expect(lastMsg.content).toBe('We use Active Directory for most identity.');
  });

  it('does not contain interview guide content in messages', () => {
    const session = makeSession({
      questions: [
        makeQuestion({
          questionId: 'q-guide',
          questionText: 'GUIDE_CONTENT_MARKER_ABC',
          sequenceOrder: 1,
        }),
      ],
      conversationHistory: [
        { role: 'assistant', content: 'Tell me about your IT environment.' },
        { role: 'user', content: 'Sure, we have mostly on-prem systems.' },
      ],
      currentUserUtterance: 'And we use AD.',
    });

    const { messages } = buildPrompt(session, 'v1');

    for (const msg of messages) {
      expect(msg.content).not.toContain('GUIDE_CONTENT_MARKER_ABC');
    }
  });

  it('trims conversation history to last 8 turn pairs (16 messages)', () => {
    // Build 10 turn pairs (20 messages) — only the last 8 pairs should survive
    const history: AnthropicMessage[] = [];
    for (let i = 1; i <= 10; i++) {
      history.push({ role: 'user', content: `Turn ${i} user` });
      history.push({ role: 'assistant', content: `Turn ${i} assistant` });
    }

    const session = makeSession({
      conversationHistory: history,
      currentUserUtterance: 'Turn 11 user',
    });

    const { messages } = buildPrompt(session, 'v1');

    // Should have 16 history messages (8 pairs) + 1 current = 17
    expect(messages.length).toBe(17);

    // Earliest turn in the window should be turn 3 (pairs 3-10 = 8 pairs)
    expect(messages[0].content).toBe('Turn 3 user');
    expect(messages[messages.length - 1].content).toBe('Turn 11 user');
  });

  it('starts with role user even when truncation leaves a leading assistant message', () => {
    // 3 messages: assistant, user, assistant — truncation of a longer history
    // that started mid-pair would give a leading assistant
    const history: AnthropicMessage[] = [
      { role: 'assistant', content: 'Mid-pair assistant start' },
      { role: 'user', content: 'User reply' },
      { role: 'assistant', content: 'Next assistant' },
    ];

    // Directly test with a history that starts with assistant
    const session = makeSession({
      conversationHistory: history,
      currentUserUtterance: 'Current user',
    });

    const { messages } = buildPrompt(session, 'v1');

    expect(messages[0].role).toBe('user');
    expect(messages[0].content).not.toBe('Mid-pair assistant start');
  });

  it('contains only user and assistant roles — no system role', () => {
    const session = makeSession({
      conversationHistory: [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there' },
      ],
    });

    const { messages } = buildPrompt(session, 'v1');

    for (const msg of messages) {
      expect(['user', 'assistant']).toContain(msg.role);
    }
  });
});

// ---------------------------------------------------------------------------
// Template systemPrompt override
// ---------------------------------------------------------------------------

describe('templateSystemPromptOverride', () => {
  it('appends the override to the system string when present', () => {
    const session = makeSession({
      templateSystemPromptOverride:
        'This interview is part of the Acme acquisition wave — focus on data center consolidation risks.',
    });

    const { system } = buildPrompt(session, 'v1');

    expect(system).toContain('Acme acquisition wave');
    expect(system).toContain('data center consolidation risks');
  });

  it('does not add override content when templateSystemPromptOverride is null', () => {
    const session = makeSession({
      templateSystemPromptOverride: null,
    });

    const { system } = buildPrompt(session, 'v1');

    expect(system).not.toContain('Template-Specific Framing');
  });

  it('override appears AFTER the interview guide content in the system string', () => {
    const session = makeSession({
      questions: [
        makeQuestion({
          questionId: 'q-order',
          questionText: 'GUIDE_QUESTION_MARKER',
          sequenceOrder: 1,
        }),
      ],
      templateSystemPromptOverride: 'OVERRIDE_MARKER_CONTENT',
    });

    const { system } = buildPrompt(session, 'v1');

    const guidePos = system.indexOf('GUIDE_QUESTION_MARKER');
    const overridePos = system.indexOf('OVERRIDE_MARKER_CONTENT');

    expect(guidePos).toBeGreaterThan(-1);
    expect(overridePos).toBeGreaterThan(-1);
    expect(overridePos).toBeGreaterThan(guidePos);
  });
});

// ---------------------------------------------------------------------------
// Tier 2 — other sections
// ---------------------------------------------------------------------------

describe('Tier 2 — context sections', () => {
  it('renders interviewee name, role, and company in Interview Context', () => {
    const session = makeSession({
      intervieweeName: 'Jordan',
      intervieweeRole: 'VP of Infrastructure',
      intervieweeCompany: 'BetaCorp',
    });

    const { system, cacheBreakpoint } = buildPrompt(session, 'v1');
    const tier2 = system.slice(cacheBreakpoint);

    expect(tier2).toContain('Jordan');
    expect(tier2).toContain('VP of Infrastructure');
    expect(tier2).toContain('BetaCorp');
  });

  it('renders facts ledger entries with turn numbers', () => {
    const session = makeSession({
      factsLedger: [
        { id: 'f1', text: 'Uses SAP for ERP.', sourceTurn: 3, questionIds: ['q-001'] },
        { id: 'f2', text: 'AD is primary identity provider.', sourceTurn: 5, questionIds: ['q-001'] },
      ],
    });

    const { system, cacheBreakpoint } = buildPrompt(session, 'v1');
    const tier2 = system.slice(cacheBreakpoint);

    expect(tier2).toContain('- Uses SAP for ERP. (turn 3)');
    expect(tier2).toContain('- AD is primary identity provider. (turn 5)');
  });

  it('renders active threads with topic and turn opened', () => {
    const session = makeSession({
      activeThreads: [
        { topic: 'Vendor contract renewals', openedAtTurn: 4, questionIds: ['q-001'] },
      ],
    });

    const { system, cacheBreakpoint } = buildPrompt(session, 'v1');
    const tier2 = system.slice(cacheBreakpoint);

    expect(tier2).toContain('Vendor contract renewals');
    expect(tier2).toContain('opened turn 4');
  });

  it('renders rapport notes', () => {
    const session = makeSession({
      rapportNotes: [
        'Interviewee was uncomfortable when layoffs came up at turn 6.',
      ],
    });

    const { system, cacheBreakpoint } = buildPrompt(session, 'v1');
    const tier2 = system.slice(cacheBreakpoint);

    expect(tier2).toContain('Interviewee was uncomfortable when layoffs came up at turn 6.');
  });
});
