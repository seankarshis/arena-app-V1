'use client';

import React, { useState } from 'react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TriggerType = 'keyword' | 'sentiment' | 'length' | 'always';
export type SentimentValue = 'positive' | 'negative' | 'neutral';

export interface FollowupTrigger {
  type: TriggerType;
  keywords?: string;
  sentiment?: SentimentValue;
  lengthDescription?: string;
  targetTemplateQuestionIds: string[];
}

export interface TriggerTarget {
  id: string; // TemplateQuestion.id
  questionText: string;
  sequenceOrder: number;
}

interface Props {
  currentTriggers: FollowupTrigger[];
  availableTargets: TriggerTarget[];
  onSave: (triggers: FollowupTrigger[]) => void;
  onClose: () => void;
  isSaving: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emptyTrigger(): FollowupTrigger {
  return { type: 'always', targetTemplateQuestionIds: [] };
}

const TRIGGER_TYPES: TriggerType[] = ['keyword', 'sentiment', 'length', 'always'];

// ---------------------------------------------------------------------------
// Shared micro-styles
// ---------------------------------------------------------------------------

const fieldLabel: React.CSSProperties = {
  display: 'block',
  fontSize: 11,
  fontWeight: 600,
  color: 'var(--grey)',
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
  marginBottom: 6,
};

const textInput: React.CSSProperties = {
  width: '100%',
  padding: '8px 12px',
  borderRadius: 6,
  border: '1px solid var(--ivory-tint)',
  backgroundColor: 'var(--ivory-tint)',
  fontFamily: 'var(--font-primary)',
  fontSize: 13,
  color: 'var(--graphite)',
  outline: 'none',
};

// ---------------------------------------------------------------------------
// TriggerEditor
// ---------------------------------------------------------------------------

export default function TriggerEditor({
  currentTriggers,
  availableTargets,
  onSave,
  onClose,
  isSaving,
}: Props) {
  const [triggers, setTriggers] = useState<FollowupTrigger[]>(
    currentTriggers.length > 0 ? currentTriggers : []
  );

  const addTrigger = () => {
    setTriggers((prev) => [...prev, emptyTrigger()]);
  };

  const removeTrigger = (idx: number) => {
    setTriggers((prev) => prev.filter((_, i) => i !== idx));
  };

  const updateTrigger = (idx: number, patch: Partial<FollowupTrigger>) => {
    setTriggers((prev) =>
      prev.map((t, i) => (i === idx ? { ...t, ...patch } : t))
    );
  };

  const toggleTarget = (idx: number, targetId: string) => {
    setTriggers((prev) =>
      prev.map((t, i) => {
        if (i !== idx) return t;
        const ids = t.targetTemplateQuestionIds;
        return {
          ...t,
          targetTemplateQuestionIds: ids.includes(targetId)
            ? ids.filter((id) => id !== targetId)
            : [...ids, targetId],
        };
      })
    );
  };

  return (
    <div
      style={{
        padding: 16,
        backgroundColor: '#F9F7F3',
        borderRadius: 8,
        border: '1px solid var(--ivory-tint)',
      }}
    >
      {/* Header */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 14,
        }}
      >
        <h4
          style={{
            fontFamily: 'var(--font-primary)',
            fontWeight: 600,
            fontSize: 14,
            color: 'var(--graphite)',
          }}
        >
          Follow-up Triggers
        </h4>
        <button
          onClick={addTrigger}
          style={{
            padding: '5px 13px',
            borderRadius: 6,
            border: '1px dashed var(--horizon-red)',
            backgroundColor: 'transparent',
            color: 'var(--horizon-red)',
            fontFamily: 'var(--font-primary)',
            fontSize: 12,
            fontWeight: 500,
            cursor: 'pointer',
          }}
        >
          + Add Trigger
        </button>
      </div>

      {triggers.length === 0 && (
        <p style={{ color: 'var(--grey)', fontSize: 13, marginBottom: 14 }}>
          No triggers configured. The LLM will not be prompted to ask follow-ups
          unless you add trigger conditions here.
        </p>
      )}

      {triggers.map((trigger, idx) => (
        <div
          key={idx}
          style={{
            backgroundColor: 'var(--white)',
            borderRadius: 8,
            border: '1px solid var(--ivory-tint)',
            padding: 14,
            marginBottom: 10,
          }}
        >
          {/* Trigger header row */}
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: 12,
            }}
          >
            <span
              style={{
                fontFamily: 'var(--font-primary)',
                fontWeight: 500,
                fontSize: 13,
                color: 'var(--graphite)',
              }}
            >
              Trigger {idx + 1}
            </span>
            <button
              onClick={() => removeTrigger(idx)}
              aria-label="Remove trigger"
              style={{
                background: 'none',
                border: 'none',
                color: 'var(--grey)',
                cursor: 'pointer',
                fontSize: 16,
                padding: '0 4px',
                lineHeight: 1,
              }}
            >
              ×
            </button>
          </div>

          {/* Trigger type selector */}
          <div style={{ marginBottom: 12 }}>
            <label style={fieldLabel}>Trigger Type</label>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {TRIGGER_TYPES.map((type) => (
                <button
                  key={type}
                  onClick={() => updateTrigger(idx, { type })}
                  style={{
                    padding: '5px 14px',
                    borderRadius: 999,
                    border:
                      trigger.type === type
                        ? '1.5px solid var(--horizon-red)'
                        : '1.5px solid var(--ivory-tint)',
                    backgroundColor:
                      trigger.type === type
                        ? 'rgba(122,14,19,0.07)'
                        : 'var(--white)',
                    color:
                      trigger.type === type
                        ? 'var(--horizon-red)'
                        : 'var(--graphite)',
                    fontFamily: 'var(--font-primary)',
                    fontSize: 13,
                    fontWeight: 500,
                    cursor: 'pointer',
                    textTransform: 'capitalize',
                  }}
                >
                  {type}
                </button>
              ))}
            </div>
          </div>

          {/* Keyword input */}
          {trigger.type === 'keyword' && (
            <div style={{ marginBottom: 12 }}>
              <label style={fieldLabel}>Keywords / Phrases (LLM guidance)</label>
              <input
                type="text"
                value={trigger.keywords ?? ''}
                onChange={(e) => updateTrigger(idx, { keywords: e.target.value })}
                placeholder="e.g. conflict, leadership challenge, under pressure…"
                style={textInput}
              />
            </div>
          )}

          {/* Sentiment dropdown */}
          {trigger.type === 'sentiment' && (
            <div style={{ marginBottom: 12 }}>
              <label style={fieldLabel}>Sentiment Direction</label>
              <select
                value={trigger.sentiment ?? 'positive'}
                onChange={(e) =>
                  updateTrigger(idx, { sentiment: e.target.value as SentimentValue })
                }
                style={{
                  ...textInput,
                  width: 'auto',
                  cursor: 'pointer',
                }}
              >
                <option value="positive">Positive</option>
                <option value="negative">Negative</option>
                <option value="neutral">Neutral</option>
              </select>
            </div>
          )}

          {/* Length description */}
          {trigger.type === 'length' && (
            <div style={{ marginBottom: 12 }}>
              <label style={fieldLabel}>Length Threshold (LLM guidance)</label>
              <input
                type="text"
                value={trigger.lengthDescription ?? ''}
                onChange={(e) =>
                  updateTrigger(idx, { lengthDescription: e.target.value })
                }
                placeholder="e.g. response is very brief, answer is unusually long…"
                style={textInput}
              />
            </div>
          )}

          {/* Target questions */}
          <div>
            <label style={fieldLabel}>Suggested Follow-up Questions</label>
            {availableTargets.length === 0 ? (
              <p style={{ color: 'var(--grey)', fontSize: 13 }}>
                No other questions in this template.
              </p>
            ) : (
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 4,
                  maxHeight: 180,
                  overflowY: 'auto',
                }}
              >
                {availableTargets.map((target) => {
                  const selected = trigger.targetTemplateQuestionIds.includes(
                    target.id
                  );
                  return (
                    <label
                      key={target.id}
                      style={{
                        display: 'flex',
                        alignItems: 'flex-start',
                        gap: 8,
                        padding: '6px 8px',
                        borderRadius: 6,
                        cursor: 'pointer',
                        backgroundColor: selected
                          ? 'rgba(122,14,19,0.05)'
                          : 'transparent',
                        border: selected
                          ? '1px solid rgba(122,14,19,0.2)'
                          : '1px solid transparent',
                        fontSize: 13,
                        color: 'var(--graphite)',
                        userSelect: 'none',
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={selected}
                        onChange={() => toggleTarget(idx, target.id)}
                        style={{
                          accentColor: 'var(--horizon-red)',
                          marginTop: 2,
                          flexShrink: 0,
                        }}
                      />
                      <span>
                        <span
                          style={{
                            color: 'var(--grey)',
                            fontSize: 11,
                            marginRight: 6,
                            fontFamily: 'var(--font-mono)',
                          }}
                        >
                          #{target.sequenceOrder}
                        </span>
                        {target.questionText.length > 90
                          ? target.questionText.slice(0, 90) + '…'
                          : target.questionText}
                      </span>
                    </label>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      ))}

      {/* Actions */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'flex-end',
          gap: 10,
          marginTop: 8,
        }}
      >
        <button
          onClick={onClose}
          disabled={isSaving}
          style={{
            padding: '8px 18px',
            borderRadius: 6,
            border: '1px solid var(--ivory-tint)',
            backgroundColor: 'var(--white)',
            color: 'var(--graphite)',
            fontFamily: 'var(--font-primary)',
            fontSize: 13,
            cursor: 'pointer',
            opacity: isSaving ? 0.6 : 1,
          }}
        >
          Cancel
        </button>
        <button
          onClick={() => onSave(triggers)}
          disabled={isSaving}
          style={{
            padding: '8px 18px',
            borderRadius: 6,
            border: 'none',
            backgroundColor: 'var(--horizon-red)',
            color: 'var(--white)',
            fontFamily: 'var(--font-primary)',
            fontWeight: 600,
            fontSize: 13,
            cursor: isSaving ? 'not-allowed' : 'pointer',
            opacity: isSaving ? 0.6 : 1,
          }}
        >
          {isSaving ? 'Saving…' : 'Save Triggers'}
        </button>
      </div>
    </div>
  );
}
