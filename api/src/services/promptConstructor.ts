// ---------------------------------------------------------------------------
// Arena LLM System Prompt Constructor — Pure Functions
// Builds the full system prompt from template data with follow-up triggers.
// No infrastructure dependencies (no Redis, no Prisma, no network calls).
// ---------------------------------------------------------------------------

// --- Types ---

export interface FollowupTrigger {
  condition: string;
  followupQuestionId: string;
}

export interface PromptQuestion {
  questionId: string;
  text: string;
  categoryBucket: string;
  isRequired: boolean;
  sequenceOrder: number;
  followupTriggers: FollowupTrigger[];
}

export interface PromptTemplateData {
  name: string;
  description: string | null;
  systemPrompt: string | null;
  questions: PromptQuestion[];
}

// --- Helpers ---

function groupByBucket(
  questions: PromptQuestion[],
): Map<string, PromptQuestion[]> {
  const groups = new Map<string, PromptQuestion[]>();
  for (const q of questions) {
    const bucket = groups.get(q.categoryBucket);
    if (bucket) {
      bucket.push(q);
    } else {
      groups.set(q.categoryBucket, [q]);
    }
  }
  return groups;
}

function formatQuestion(
  q: PromptQuestion,
  questionIdSet: Set<string>,
): string {
  const label = q.isRequired ? 'required' : 'optional';
  const lines: string[] = [];
  lines.push(`${q.questionId} (${label}): "${q.text}"`);
  lines.push(`  Suggested sequence: ${q.sequenceOrder}`);

  const validTriggers = q.followupTriggers.filter((t) =>
    questionIdSet.has(t.followupQuestionId),
  );
  if (validTriggers.length > 0) {
    lines.push('  Follow-up triggers:');
    for (const trigger of validTriggers) {
      lines.push(
        `    - ${trigger.condition} → suggest follow-up ${trigger.followupQuestionId}`,
      );
    }
  }

  return lines.join('\n');
}

// --- Main ---

/**
 * Builds the LLM system prompt from template data.
 *
 * The prompt includes:
 * - Template name and description (research context)
 * - Required questions organized by category bucket, with follow-up triggers
 * - Optional questions organized by category bucket, with follow-up triggers
 * - Instructions on follow-up behavior, progression, deduplication, and missing triggers
 *
 * Triggers referencing questions not in the current set are filtered out at
 * construction time (the "Missing Trigger Targets" instruction is included as
 * a safety net).
 */
export function buildSystemPrompt(template: PromptTemplateData): string {
  const required = template.questions
    .filter((q) => q.isRequired)
    .sort((a, b) => a.sequenceOrder - b.sequenceOrder);
  const optional = template.questions
    .filter((q) => !q.isRequired)
    .sort((a, b) => a.sequenceOrder - b.sequenceOrder);

  const questionIdSet = new Set(template.questions.map((q) => q.questionId));

  const sections: string[] = [];

  // Header / system prompt
  if (template.systemPrompt) {
    sections.push(template.systemPrompt);
    sections.push('');
  } else {
    sections.push('You are conducting a structured research interview.');
    sections.push('');
    sections.push('## Interview Context');
    sections.push(`Template: ${template.name}`);
    if (template.description) {
      sections.push(`Description: ${template.description}`);
    }
    sections.push('');
  }

  // Required questions by bucket
  sections.push('## Required Questions');
  sections.push(
    'You MUST ask all of the following questions during this interview.',
  );
  sections.push('');
  for (const [bucket, questions] of groupByBucket(required)) {
    sections.push(`### Category: ${bucket}`);
    for (const q of questions) {
      sections.push(formatQuestion(q, questionIdSet));
    }
    sections.push('');
  }

  // Optional questions by bucket
  if (optional.length > 0) {
    sections.push('## Optional Questions');
    sections.push(
      'Ask these if time permits or if the conversation naturally leads to them.',
    );
    sections.push('');
    for (const [bucket, questions] of groupByBucket(optional)) {
      sections.push(`### Category: ${bucket}`);
      for (const q of questions) {
        sections.push(formatQuestion(q, questionIdSet));
      }
      sections.push('');
    }
  }

  // Instructions
  sections.push('## Instructions');
  sections.push('');
  sections.push('### Follow-Up Behavior');
  sections.push(
    'After each answer, evaluate the follow-up triggers for that question based on your judgment. If trigger conditions are met, ask one of the suggested follow-ups before moving to the next core question.',
  );
  sections.push('');
  sections.push('### Progression');
  sections.push(
    'Move between different category buckets to maintain conversational variety. Do not cluster all questions from one category together.',
  );
  sections.push('');
  sections.push('### Deduplication');
  sections.push(
    'Do not ask questions that substantially overlap with questions already asked. If a follow-up covers ground similar to an upcoming required question, you may skip the required question and note it as covered.',
  );
  sections.push('');
  sections.push('### Missing Trigger Targets');
  sections.push(
    'If a trigger references a follow-up question that is not in your current question set, skip that trigger.',
  );

  return sections.join('\n');
}
