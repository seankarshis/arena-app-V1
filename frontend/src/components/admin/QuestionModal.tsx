'use client';

import React, { useState } from 'react';
import { gql, useMutation } from '@apollo/client';
import { cn } from '@/lib/utils';
import { TagChipInput } from '@/components/admin/TagChipInput';
import { QuestionRefBadge } from '@/components/ui/QuestionRefBadge';

// ---------------------------------------------------------------------------
// Types (exported so callers can type their state)
// ---------------------------------------------------------------------------

export type SensitivityLevel = 'STANDARD' | 'SENSITIVE' | 'HIGHLY_SENSITIVE';

export interface QuestionModalTag {
  id: string;
  label: string;
  isActive: boolean;
}

export interface QuestionModalQuestion {
  id: string;
  displayNumber: number;
  text: string;
  isActive: boolean;
  intent: string | null;
  sensitivityLevel: SensitivityLevel;
  tags: QuestionModalTag[];
}

// ---------------------------------------------------------------------------
// GQL
// ---------------------------------------------------------------------------

const CREATE_QUESTION = gql`
  mutation QuestionModalCreate($text: String!, $tagIds: [ID!]) {
    createQuestion(text: $text, tagIds: $tagIds) {
      id
      displayNumber
      text
      isActive
      intent
      sensitivityLevel
      tags {
        id
        label
        isActive
      }
    }
  }
`;

const UPDATE_QUESTION = gql`
  mutation QuestionModalUpdate(
    $id: ID!
    $text: String
    $tagIds: [ID!]
    $intent: String
    $sensitivityLevel: SensitivityLevel
  ) {
    updateQuestion(
      id: $id
      text: $text
      tagIds: $tagIds
      intent: $intent
      sensitivityLevel: $sensitivityLevel
    ) {
      id
      displayNumber
      text
      isActive
      intent
      sensitivityLevel
      tags {
        id
        label
        isActive
      }
    }
  }
`;

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface QuestionModalProps {
  mode: 'create' | 'edit';
  question: QuestionModalQuestion | null;
  allTags: QuestionModalTag[];
  onClose: () => void;
  onSaved?: (question: QuestionModalQuestion) => void;
}

// ---------------------------------------------------------------------------

const SENSITIVITY_OPTIONS: { value: SensitivityLevel; label: string }[] = [
  { value: 'STANDARD', label: 'Standard' },
  { value: 'SENSITIVE', label: 'Sensitive' },
  { value: 'HIGHLY_SENSITIVE', label: 'Highly Sensitive' },
];

const INTENT_MAX_LENGTH = 2000;

export function QuestionModal({
  mode,
  question,
  allTags,
  onClose,
  onSaved,
}: QuestionModalProps) {
  const [text, setText] = useState(question?.text ?? '');
  const [selectedTags, setSelectedTags] = useState<QuestionModalTag[]>(
    question?.tags ?? [],
  );
  const [intent, setIntent] = useState(question?.intent ?? '');
  const [sensitivityLevel, setSensitivityLevel] = useState<SensitivityLevel>(
    question?.sensitivityLevel ?? 'STANDARD',
  );
  const [error, setError] = useState<string | null>(null);

  const [createQuestion, { loading: creating }] = useMutation<{
    createQuestion: QuestionModalQuestion;
  }>(CREATE_QUESTION);
  const [updateQuestion, { loading: updating }] = useMutation<{
    updateQuestion: QuestionModalQuestion;
  }>(UPDATE_QUESTION);

  const isSaving = creating || updating;

  const canSubmit =
    text.trim().length > 0 && intent.length <= INTENT_MAX_LENGTH && !isSaving;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setError(null);

    const trimmedText = text.trim();
    const tagIds = selectedTags.map((t) => t.id);
    const trimmedIntent = intent.trim();

    try {
      if (mode === 'create') {
        const { data } = await createQuestion({
          variables: { text: trimmedText, tagIds },
        });
        if (data?.createQuestion) onSaved?.(data.createQuestion);
      } else if (question) {
        const { data } = await updateQuestion({
          variables: {
            id: question.id,
            text: trimmedText,
            tagIds,
            intent: trimmedIntent.length > 0 ? trimmedIntent : null,
            sensitivityLevel,
          },
        });
        if (data?.updateQuestion) onSaved?.(data.updateQuestion);
      }
      onClose();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="modal-backdrop">
      <div className="modal-panel max-w-[560px]">
        <div className="flex items-center gap-2.5 mb-6">
          <h2 className="font-semibold text-xl text-graphite">
            {mode === 'create' ? 'Create Question' : 'Edit Question'}
          </h2>
          {mode === 'edit' && question && (
            <QuestionRefBadge displayNumber={question.displayNumber} />
          )}
        </div>

        <form onSubmit={handleSubmit}>
          <div className="mb-5">
            <label className="block font-medium text-sm text-graphite mb-1.5">
              Question Text
            </label>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              required
              rows={4}
              className="input-field text-sm block w-full resize-y"
              placeholder="Enter question text…"
            />
          </div>

          <div className="mb-6">
            <label className="block font-medium text-sm text-graphite mb-1.5">
              Tags
            </label>
            <TagChipInput
              value={selectedTags}
              allTags={allTags}
              onChange={setSelectedTags}
              disabled={isSaving}
            />
          </div>

          <div className="mb-6 border-t border-ivory-tint pt-5">
            <h3 className="font-semibold text-[13px] uppercase tracking-wide text-grey mb-4">
              Interview Guidance
            </h3>

            <div className="mb-5">
              <label className="block font-medium text-sm text-graphite mb-1.5">
                Intent
              </label>
              <textarea
                value={intent}
                onChange={(e) => setIntent(e.target.value)}
                rows={3}
                maxLength={INTENT_MAX_LENGTH}
                className={cn(
                  'input-field text-sm block w-full resize-y',
                  intent.length > INTENT_MAX_LENGTH && 'border-horizon-red',
                )}
                placeholder="What this question is trying to uncover…"
              />
              <div className="flex items-start justify-between mt-1 gap-3">
                <p className="text-grey text-[12px] leading-snug">
                  What this question is trying to uncover. Used by the interviewer LLM as guidance — not shown to interviewees.
                </p>
                <span
                  className={cn(
                    'shrink-0 text-[12px] tabular-nums',
                    intent.length > INTENT_MAX_LENGTH
                      ? 'text-horizon-red font-medium'
                      : 'text-grey',
                  )}
                >
                  {intent.length}/{INTENT_MAX_LENGTH}
                </span>
              </div>
            </div>

            <div className="mb-1">
              <label className="block font-medium text-sm text-graphite mb-1.5">
                Sensitivity Level
              </label>
              <select
                value={sensitivityLevel}
                onChange={(e) =>
                  setSensitivityLevel(e.target.value as SensitivityLevel)
                }
                className="input-field text-sm block w-full cursor-pointer"
              >
                {SENSITIVITY_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
              <p className="text-grey text-[12px] leading-snug mt-1">
                How carefully the bot should handle responses to this question.
              </p>
            </div>
          </div>

          {error && <div className="alert-error mb-4">{error}</div>}

          <div className="flex justify-end gap-3">
            <button
              type="button"
              onClick={onClose}
              disabled={isSaving}
              className={cn('btn-secondary', isSaving && 'opacity-60')}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!canSubmit}
              className={cn(
                'btn-primary',
                !canSubmit && 'opacity-50 cursor-not-allowed',
              )}
            >
              {isSaving ? 'Saving…' : 'Save Question'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
