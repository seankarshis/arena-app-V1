// ---------------------------------------------------------------------------
// Unit Tests — LLM System Prompt Constructor
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';
import {
  buildSystemPrompt,
  type PromptQuestion,
  type PromptTemplateData,
} from '../services/promptConstructor';

// --- Helpers ---

function makeQuestion(
  overrides: Partial<PromptQuestion> & { questionId: string; text: string },
): PromptQuestion {
  return {
    categoryBucket: 'general',
    isRequired: true,
    sequenceOrder: 1,
    followupTriggers: [],
    ...overrides,
  };
}

function makeTemplate(
  overrides?: Partial<PromptTemplateData>,
): PromptTemplateData {
  return {
    name: 'Test Template',
    description: null,
    questions: [],
    ...overrides,
  };
}

// --- Tests ---

describe('buildSystemPrompt', () => {
  it('includes the interviewer role instruction', () => {
    const prompt = buildSystemPrompt(
      makeTemplate({
        questions: [makeQuestion({ questionId: 'q1', text: 'Test?' })],
      }),
    );
    expect(prompt).toContain(
      'You are conducting a structured research interview.',
    );
  });

  it('includes template name and description', () => {
    const prompt = buildSystemPrompt(
      makeTemplate({
        name: 'CRM Research Interview',
        description: 'Understanding CRM usage patterns',
        questions: [
          makeQuestion({ questionId: 'q1', text: 'What CRM do you use?' }),
        ],
      }),
    );
    expect(prompt).toContain('Template: CRM Research Interview');
    expect(prompt).toContain('Description: Understanding CRM usage patterns');
  });

  it('omits description line when null', () => {
    const prompt = buildSystemPrompt(
      makeTemplate({
        name: 'No Description Template',
        description: null,
        questions: [makeQuestion({ questionId: 'q1', text: 'Test?' })],
      }),
    );
    expect(prompt).toContain('Template: No Description Template');
    expect(prompt).not.toContain('Description:');
  });

  it('organizes required questions by category bucket', () => {
    const prompt = buildSystemPrompt(
      makeTemplate({
        questions: [
          makeQuestion({
            questionId: 'q1',
            text: 'Process Q1?',
            categoryBucket: 'process',
            sequenceOrder: 1,
          }),
          makeQuestion({
            questionId: 'q2',
            text: 'Tech Q?',
            categoryBucket: 'technology',
            sequenceOrder: 2,
          }),
          makeQuestion({
            questionId: 'q3',
            text: 'Process Q2?',
            categoryBucket: 'process',
            sequenceOrder: 3,
          }),
        ],
      }),
    );
    expect(prompt).toContain('### Category: process');
    expect(prompt).toContain('### Category: technology');
    // Both process questions under the process heading
    const processStart = prompt.indexOf('### Category: process');
    const techStart = prompt.indexOf('### Category: technology');
    const q1Pos = prompt.indexOf('q1');
    const q3Pos = prompt.indexOf('q3');
    expect(q1Pos).toBeGreaterThan(processStart);
    expect(q3Pos).toBeGreaterThan(processStart);
    expect(q3Pos).toBeLessThan(techStart);
  });

  it('separates required and optional questions into sections', () => {
    const prompt = buildSystemPrompt(
      makeTemplate({
        questions: [
          makeQuestion({
            questionId: 'q1',
            text: 'Required Q?',
            isRequired: true,
            sequenceOrder: 1,
          }),
          makeQuestion({
            questionId: 'q2',
            text: 'Optional Q?',
            isRequired: false,
            sequenceOrder: 2,
          }),
        ],
      }),
    );
    expect(prompt).toContain('## Required Questions');
    expect(prompt).toContain('q1 (required): "Required Q?"');
    expect(prompt).toContain('## Optional Questions');
    expect(prompt).toContain('q2 (optional): "Optional Q?"');
  });

  it('omits optional section when no optional questions exist', () => {
    const prompt = buildSystemPrompt(
      makeTemplate({
        questions: [
          makeQuestion({ questionId: 'q1', text: 'Required?', isRequired: true }),
        ],
      }),
    );
    expect(prompt).toContain('## Required Questions');
    expect(prompt).not.toContain('## Optional Questions');
  });

  it('includes follow-up trigger definitions for questions', () => {
    const prompt = buildSystemPrompt(
      makeTemplate({
        questions: [
          makeQuestion({
            questionId: 'q1',
            text: 'Main question?',
            sequenceOrder: 1,
            followupTriggers: [
              {
                condition: 'If response mentions data quality issues',
                followupQuestionId: 'q2',
              },
            ],
          }),
          makeQuestion({
            questionId: 'q2',
            text: 'Follow-up on data quality?',
            sequenceOrder: 2,
          }),
        ],
      }),
    );
    expect(prompt).toContain('Follow-up triggers:');
    expect(prompt).toContain('If response mentions data quality issues');
    expect(prompt).toContain('suggest follow-up q2');
  });

  it('filters out triggers referencing questions not in the set', () => {
    const prompt = buildSystemPrompt(
      makeTemplate({
        questions: [
          makeQuestion({
            questionId: 'q1',
            text: 'Main?',
            sequenceOrder: 1,
            followupTriggers: [
              {
                condition: 'Valid trigger',
                followupQuestionId: 'q2',
              },
              {
                condition: 'Invalid trigger pointing outside',
                followupQuestionId: 'nonexistent-id',
              },
            ],
          }),
          makeQuestion({ questionId: 'q2', text: 'Follow-up?', sequenceOrder: 2 }),
        ],
      }),
    );
    expect(prompt).toContain('Valid trigger');
    expect(prompt).not.toContain('Invalid trigger pointing outside');
    expect(prompt).not.toContain('nonexistent-id');
  });

  it('omits trigger block when all triggers reference missing questions', () => {
    const prompt = buildSystemPrompt(
      makeTemplate({
        questions: [
          makeQuestion({
            questionId: 'q1',
            text: 'Main?',
            sequenceOrder: 1,
            followupTriggers: [
              {
                condition: 'points to missing',
                followupQuestionId: 'missing-id',
              },
            ],
          }),
        ],
      }),
    );
    expect(prompt).not.toContain('Follow-up triggers:');
  });

  it('sorts questions by sequence order within buckets', () => {
    const prompt = buildSystemPrompt(
      makeTemplate({
        questions: [
          makeQuestion({
            questionId: 'q3',
            text: 'Third?',
            categoryBucket: 'process',
            sequenceOrder: 3,
          }),
          makeQuestion({
            questionId: 'q1',
            text: 'First?',
            categoryBucket: 'process',
            sequenceOrder: 1,
          }),
          makeQuestion({
            questionId: 'q2',
            text: 'Second?',
            categoryBucket: 'process',
            sequenceOrder: 2,
          }),
        ],
      }),
    );
    const q1Pos = prompt.indexOf('q1');
    const q2Pos = prompt.indexOf('q2');
    const q3Pos = prompt.indexOf('q3');
    expect(q1Pos).toBeLessThan(q2Pos);
    expect(q2Pos).toBeLessThan(q3Pos);
  });

  it('includes all four instruction sections', () => {
    const prompt = buildSystemPrompt(
      makeTemplate({
        questions: [makeQuestion({ questionId: 'q1', text: 'Test?' })],
      }),
    );
    expect(prompt).toContain('### Follow-Up Behavior');
    expect(prompt).toContain(
      'evaluate the follow-up triggers for that question based on your judgment',
    );
    expect(prompt).toContain('### Progression');
    expect(prompt).toContain(
      'Move between different category buckets to maintain conversational variety',
    );
    expect(prompt).toContain('### Deduplication');
    expect(prompt).toContain(
      'Do not ask questions that substantially overlap',
    );
    expect(prompt).toContain('### Missing Trigger Targets');
    expect(prompt).toContain(
      'If a trigger references a follow-up question that is not in your current question set',
    );
  });

  it('includes sequence order for each question', () => {
    const prompt = buildSystemPrompt(
      makeTemplate({
        questions: [
          makeQuestion({ questionId: 'q1', text: 'Test?', sequenceOrder: 5 }),
        ],
      }),
    );
    expect(prompt).toContain('Suggested sequence: 5');
  });

  it('handles multiple triggers on the same question', () => {
    const prompt = buildSystemPrompt(
      makeTemplate({
        questions: [
          makeQuestion({
            questionId: 'q1',
            text: 'Challenges?',
            sequenceOrder: 1,
            followupTriggers: [
              { condition: 'If mentions data quality', followupQuestionId: 'q2' },
              { condition: 'If response is brief', followupQuestionId: 'q3' },
              { condition: 'If strong negative sentiment', followupQuestionId: 'q4' },
            ],
          }),
          makeQuestion({ questionId: 'q2', text: 'Data quality?', sequenceOrder: 2 }),
          makeQuestion({ questionId: 'q3', text: 'Probe deeper?', sequenceOrder: 3 }),
          makeQuestion({ questionId: 'q4', text: 'Elaborate?', sequenceOrder: 4 }),
        ],
      }),
    );
    expect(prompt).toContain('If mentions data quality');
    expect(prompt).toContain('If response is brief');
    expect(prompt).toContain('If strong negative sentiment');
  });

  it('handles questions with empty followupTriggers array', () => {
    const prompt = buildSystemPrompt(
      makeTemplate({
        questions: [
          makeQuestion({
            questionId: 'q1',
            text: 'No triggers?',
            sequenceOrder: 1,
            followupTriggers: [],
          }),
        ],
      }),
    );
    expect(prompt).toContain('q1 (required): "No triggers?"');
    expect(prompt).not.toContain('Follow-up triggers:');
  });

  it('handles template with only optional questions', () => {
    const prompt = buildSystemPrompt(
      makeTemplate({
        questions: [
          makeQuestion({
            questionId: 'q1',
            text: 'Optional?',
            isRequired: false,
            sequenceOrder: 1,
          }),
        ],
      }),
    );
    // Required section header still present (but no questions under it)
    expect(prompt).toContain('## Required Questions');
    expect(prompt).toContain('## Optional Questions');
    expect(prompt).toContain('q1 (optional)');
  });
});
