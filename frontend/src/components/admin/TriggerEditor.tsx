'use client';

import React, { useState, useEffect, useRef } from 'react';

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

export interface BankQuestion {
  id: string; // Question.id (from question bank)
  text: string;
  category: string;
}

interface Props {
  currentTriggers: FollowupTrigger[];
  availableTargets: TriggerTarget[];
  onSave: (triggers: FollowupTrigger[]) => void;
  // Question bank search (optional — feature degrades gracefully)
  bankResults?: BankQuestion[];
  bankLoading?: boolean;
  onBankSearch?: (searchText: string) => void;
  onSelectBankQuestion?: (question: BankQuestion, triggerIndex: number) => Promise<string | null>;
  onCreateQuestion?: (data: { text: string; category: string }, triggerIndex: number) => Promise<string | null>;
  addingExternalQuestion?: boolean;
  creatingQuestion?: boolean;
  templateQuestionIds?: Set<string>;
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

const toggleBtnStyle: React.CSSProperties = {
  padding: '5px 12px',
  borderRadius: 6,
  border: '1px dashed var(--ivory-tint)',
  backgroundColor: 'transparent',
  color: 'var(--grey)',
  fontFamily: 'var(--font-primary)',
  fontSize: 12,
  fontWeight: 500,
  cursor: 'pointer',
};

// ---------------------------------------------------------------------------
// TriggerEditor
// ---------------------------------------------------------------------------

export default function TriggerEditor({
  currentTriggers,
  availableTargets,
  onSave,
  bankResults,
  bankLoading,
  onBankSearch,
  onSelectBankQuestion,
  onCreateQuestion,
  addingExternalQuestion,
  creatingQuestion,
  templateQuestionIds,
}: Props) {
  const [triggers, setTriggers] = useState<FollowupTrigger[]>(
    currentTriggers.length > 0 ? currentTriggers : []
  );

  // Auto-save on any trigger change (skip initial render, debounce for typing)
  const isInitialRender = useRef(true);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (isInitialRender.current) {
      isInitialRender.current = false;
      return;
    }
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      onSave(triggers);
    }, 400);
    return () => { if (saveTimer.current) clearTimeout(saveTimer.current); };
  }, [triggers]); // eslint-disable-line react-hooks/exhaustive-deps

  // Bank search panel state
  const [showBankPanel, setShowBankPanel] = useState<number | null>(null);
  const [bankSearchText, setBankSearchText] = useState('');

  // Create question form state
  const [showCreateForm, setShowCreateForm] = useState<number | null>(null);
  const [newQuestionText, setNewQuestionText] = useState('');
  const [newQuestionCategory, setNewQuestionCategory] = useState('');

  // Extra targets added from bank during this editing session
  const [extraTargets, setExtraTargets] = useState<TriggerTarget[]>([]);
  const targetListRef = useRef<HTMLDivElement>(null);

  // Scroll target list to bottom when a new target is added
  useEffect(() => {
    if (extraTargets.length > 0 && targetListRef.current) {
      targetListRef.current.scrollTop = targetListRef.current.scrollHeight;
    }
  }, [extraTargets.length]);

  const hasBankFeature = !!onBankSearch && !!onSelectBankQuestion;
  const hasCreateFeature = !!onCreateQuestion;

  const addTrigger = () => {
    setTriggers((prev) => [...prev, emptyTrigger()]);
  };

  const removeTrigger = (idx: number) => {
    setTriggers((prev) => prev.filter((_, i) => i !== idx));
    if (showBankPanel === idx) setShowBankPanel(null);
    if (showCreateForm === idx) setShowCreateForm(null);
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

  // Merge available targets with extras, dedup by id
  const getMergedTargets = () => {
    const seen = new Set<string>();
    const merged: TriggerTarget[] = [];
    for (const t of availableTargets) {
      if (!seen.has(t.id)) { seen.add(t.id); merged.push(t); }
    }
    for (const t of extraTargets) {
      if (!seen.has(t.id)) { seen.add(t.id); merged.push(t); }
    }
    return merged;
  };

  const handleBankSearchChange = (val: string) => {
    setBankSearchText(val);
    onBankSearch?.(val);
  };

  const handleSelectFromBank = async (question: BankQuestion, triggerIdx: number) => {
    if (!onSelectBankQuestion) return;
    const tqId = await onSelectBankQuestion(question, triggerIdx);
    if (!tqId) return;

    // Add to extra targets if not already present
    const allTargets = getMergedTargets();
    if (!allTargets.find((t) => t.id === tqId)) {
      setExtraTargets((prev) => [
        ...prev,
        { id: tqId, questionText: question.text, sequenceOrder: availableTargets.length + prev.length + 2 },
      ]);
    }

    // Toggle target on for this trigger
    setTriggers((prev) =>
      prev.map((t, i) => {
        if (i !== triggerIdx) return t;
        if (t.targetTemplateQuestionIds.includes(tqId)) return t;
        return { ...t, targetTemplateQuestionIds: [...t.targetTemplateQuestionIds, tqId] };
      })
    );
  };

  const handleCreateAndAdd = async (triggerIdx: number) => {
    if (!onCreateQuestion) return;
    const text = newQuestionText.trim();
    const category = newQuestionCategory.trim();
    if (!text || !category) return;

    const tqId = await onCreateQuestion({ text, category }, triggerIdx);
    if (!tqId) return;

    // Add to extra targets
    setExtraTargets((prev) => [
      ...prev,
      { id: tqId, questionText: text, sequenceOrder: availableTargets.length + prev.length + 2 },
    ]);

    // Toggle target on
    setTriggers((prev) =>
      prev.map((t, i) => {
        if (i !== triggerIdx) return t;
        if (t.targetTemplateQuestionIds.includes(tqId)) return t;
        return { ...t, targetTemplateQuestionIds: [...t.targetTemplateQuestionIds, tqId] };
      })
    );

    // Reset form
    setNewQuestionText('');
    setNewQuestionCategory('');
    setShowCreateForm(null);
  };

  const mergedTargets = getMergedTargets();

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
            {mergedTargets.length === 0 && !hasBankFeature ? (
              <p style={{ color: 'var(--grey)', fontSize: 13 }}>
                No other questions in this template.
              </p>
            ) : (
              <>
                {/* Existing template question checkboxes */}
                {mergedTargets.length > 0 && (
                  <div
                    ref={targetListRef}
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 4,
                      maxHeight: 180,
                      overflowY: 'auto',
                      marginBottom: 8,
                    }}
                  >
                    {mergedTargets.map((target) => {
                      const selected = (trigger.targetTemplateQuestionIds ?? []).includes(
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

                {/* Add from Question Bank */}
                {hasBankFeature && (
                  <div style={{ marginTop: 4 }}>
                    <button
                      onClick={() => {
                        setShowBankPanel(showBankPanel === idx ? null : idx);
                        setShowCreateForm(null);
                        setBankSearchText('');
                        onBankSearch?.('');
                      }}
                      style={{
                        ...toggleBtnStyle,
                        color: showBankPanel === idx ? 'var(--horizon-red)' : 'var(--grey)',
                        borderColor: showBankPanel === idx ? 'var(--horizon-red)' : 'var(--ivory-tint)',
                      }}
                    >
                      {showBankPanel === idx ? '− Close Search' : '+ Add from Question Bank'}
                    </button>

                    {showBankPanel === idx && (
                      <div
                        style={{
                          marginTop: 8,
                          padding: 10,
                          backgroundColor: 'var(--ivory)',
                          borderRadius: 6,
                          border: '1px solid var(--ivory-tint)',
                        }}
                      >
                        <input
                          type="text"
                          value={bankSearchText}
                          onChange={(e) => handleBankSearchChange(e.target.value)}
                          placeholder="Search all questions…"
                          autoFocus
                          style={{ ...textInput, marginBottom: 8 }}
                        />

                        {bankLoading && (
                          <p style={{ color: 'var(--grey)', fontSize: 12, padding: '8px 0' }}>
                            Searching…
                          </p>
                        )}

                        {!bankLoading && bankSearchText && bankResults && bankResults.length === 0 && (
                          <p style={{ color: 'var(--grey)', fontSize: 12, padding: '8px 0' }}>
                            No questions found.
                          </p>
                        )}

                        {!bankLoading && bankResults && bankResults.length > 0 && (
                          <div
                            style={{
                              display: 'flex',
                              flexDirection: 'column',
                              gap: 4,
                              maxHeight: 200,
                              overflowY: 'auto',
                            }}
                          >
                            {bankResults.map((q) => {
                              const inTemplate = templateQuestionIds?.has(q.id);
                              return (
                                <button
                                  key={q.id}
                                  onClick={() => void handleSelectFromBank(q, idx)}
                                  disabled={addingExternalQuestion}
                                  style={{
                                    display: 'flex',
                                    alignItems: 'flex-start',
                                    gap: 8,
                                    padding: '8px 10px',
                                    borderRadius: 6,
                                    border: '1px solid var(--ivory-tint)',
                                    backgroundColor: 'var(--white)',
                                    cursor: addingExternalQuestion ? 'wait' : 'pointer',
                                    textAlign: 'left',
                                    fontFamily: 'var(--font-primary)',
                                    fontSize: 13,
                                    color: 'var(--graphite)',
                                    width: '100%',
                                  }}
                                >
                                  <div style={{ flex: 1 }}>
                                    <span>
                                      {q.text.length > 100 ? q.text.slice(0, 100) + '…' : q.text}
                                    </span>
                                    <div style={{ display: 'flex', gap: 6, marginTop: 3 }}>
                                      <span
                                        style={{
                                          fontSize: 11,
                                          color: 'var(--grey)',
                                          fontStyle: 'italic',
                                        }}
                                      >
                                        {q.category}
                                      </span>
                                      {inTemplate && (
                                        <span
                                          style={{
                                            fontSize: 10,
                                            color: '#15803D',
                                            fontWeight: 600,
                                          }}
                                        >
                                          in template
                                        </span>
                                      )}
                                    </div>
                                  </div>
                                </button>
                              );
                            })}
                          </div>
                        )}

                        {addingExternalQuestion && (
                          <p style={{ color: 'var(--grey)', fontSize: 12, marginTop: 6 }}>
                            Adding to template…
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                )}

                {/* Create New Question */}
                {hasCreateFeature && (
                  <div style={{ marginTop: 6 }}>
                    <button
                      onClick={() => {
                        setShowCreateForm(showCreateForm === idx ? null : idx);
                        setShowBankPanel(null);
                        setNewQuestionText('');
                        setNewQuestionCategory('');
                      }}
                      style={{
                        ...toggleBtnStyle,
                        color: showCreateForm === idx ? 'var(--horizon-red)' : 'var(--grey)',
                        borderColor: showCreateForm === idx ? 'var(--horizon-red)' : 'var(--ivory-tint)',
                      }}
                    >
                      {showCreateForm === idx ? '− Cancel Create' : '+ Create New Question'}
                    </button>

                    {showCreateForm === idx && (
                      <div
                        style={{
                          marginTop: 8,
                          padding: 10,
                          backgroundColor: 'var(--ivory)',
                          borderRadius: 6,
                          border: '1px solid var(--ivory-tint)',
                        }}
                      >
                        <div style={{ marginBottom: 8 }}>
                          <label style={fieldLabel}>Question Text *</label>
                          <textarea
                            value={newQuestionText}
                            onChange={(e) => setNewQuestionText(e.target.value)}
                            placeholder="Enter the question text…"
                            rows={3}
                            style={{ ...textInput, resize: 'vertical' }}
                          />
                        </div>
                        <div style={{ marginBottom: 10 }}>
                          <label style={fieldLabel}>Category *</label>
                          <input
                            type="text"
                            value={newQuestionCategory}
                            onChange={(e) => setNewQuestionCategory(e.target.value)}
                            placeholder="e.g. experience, process, motivation…"
                            style={textInput}
                          />
                        </div>
                        <button
                          onClick={() => void handleCreateAndAdd(idx)}
                          disabled={
                            creatingQuestion ||
                            !newQuestionText.trim() ||
                            !newQuestionCategory.trim()
                          }
                          style={{
                            padding: '6px 16px',
                            borderRadius: 6,
                            border: 'none',
                            backgroundColor: 'var(--horizon-red)',
                            color: 'var(--white)',
                            fontFamily: 'var(--font-primary)',
                            fontWeight: 600,
                            fontSize: 12,
                            cursor:
                              creatingQuestion ||
                              !newQuestionText.trim() ||
                              !newQuestionCategory.trim()
                                ? 'not-allowed'
                                : 'pointer',
                            opacity:
                              creatingQuestion ||
                              !newQuestionText.trim() ||
                              !newQuestionCategory.trim()
                                ? 0.5
                                : 1,
                          }}
                        >
                          {creatingQuestion ? 'Creating…' : 'Create & Add'}
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      ))}

    </div>
  );
}
