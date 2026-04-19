// Deprecated: replaced by adminNotes textarea in TemplateBuilder.tsx as of ADR 007. Safe to delete after one release cycle.
'use client';

import React, { useState, useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';

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
    <div className="p-4 bg-[#F9F7F3] rounded border border-ivory-tint">
      {/* Header */}
      <div className="flex justify-between items-center mb-3.5">
        <h4 className="font-primary font-semibold text-sm text-graphite">
          Follow-up Triggers
        </h4>
        <button
          onClick={addTrigger}
          className="px-3 py-1 rounded border border-dashed border-horizon-red bg-transparent text-horizon-red font-primary text-xs font-medium cursor-pointer hover:bg-horizon-red/5"
        >
          + Add Trigger
        </button>
      </div>

      {triggers.length === 0 && (
        <p className="text-grey text-[13px] mb-3.5">
          No triggers configured. The LLM will not be prompted to ask follow-ups
          unless you add trigger conditions here.
        </p>
      )}

      {triggers.map((trigger, idx) => (
        <div
          key={idx}
          className="bg-white rounded border border-ivory-tint p-3.5 mb-2.5"
        >
          {/* Trigger header row */}
          <div className="flex justify-between items-center mb-3">
            <span className="font-primary font-medium text-[13px] text-graphite">
              Trigger {idx + 1}
            </span>
            <button
              onClick={() => removeTrigger(idx)}
              aria-label="Remove trigger"
              className="bg-transparent border-none text-grey cursor-pointer text-base px-1 py-0 leading-none hover:text-horizon-red"
            >
              ×
            </button>
          </div>

          {/* Trigger type selector */}
          <div className="mb-3">
            <label className="block text-2xs font-semibold text-grey uppercase tracking-wide mb-1.5">
              Trigger Type
            </label>
            <div className="flex gap-2 flex-wrap">
              {TRIGGER_TYPES.map((type) => (
                <button
                  key={type}
                  onClick={() => updateTrigger(idx, { type })}
                  className={cn(
                    'px-3.5 py-1 rounded-md font-primary text-[13px] font-medium cursor-pointer capitalize',
                    trigger.type === type
                      ? 'border-[1.5px] border-horizon-red bg-horizon-red/[0.07] text-horizon-red'
                      : 'border-[1.5px] border-ivory-tint bg-white text-graphite hover:border-grey/30'
                  )}
                >
                  {type}
                </button>
              ))}
            </div>
          </div>

          {/* Keyword input */}
          {trigger.type === 'keyword' && (
            <div className="mb-3">
              <label className="block text-2xs font-semibold text-grey uppercase tracking-wide mb-1.5">
                Keywords / Phrases (LLM guidance)
              </label>
              <input
                type="text"
                value={trigger.keywords ?? ''}
                onChange={(e) => updateTrigger(idx, { keywords: e.target.value })}
                placeholder="e.g. conflict, leadership challenge, under pressure..."
                className="input-field text-sm"
              />
            </div>
          )}

          {/* Sentiment dropdown */}
          {trigger.type === 'sentiment' && (
            <div className="mb-3">
              <label className="block text-2xs font-semibold text-grey uppercase tracking-wide mb-1.5">
                Sentiment Direction
              </label>
              <select
                value={trigger.sentiment ?? 'positive'}
                onChange={(e) =>
                  updateTrigger(idx, { sentiment: e.target.value as SentimentValue })
                }
                className="input-field text-sm w-auto cursor-pointer"
              >
                <option value="positive">Positive</option>
                <option value="negative">Negative</option>
                <option value="neutral">Neutral</option>
              </select>
            </div>
          )}

          {/* Length description */}
          {trigger.type === 'length' && (
            <div className="mb-3">
              <label className="block text-2xs font-semibold text-grey uppercase tracking-wide mb-1.5">
                Length Threshold (LLM guidance)
              </label>
              <input
                type="text"
                value={trigger.lengthDescription ?? ''}
                onChange={(e) =>
                  updateTrigger(idx, { lengthDescription: e.target.value })
                }
                placeholder="e.g. response is very brief, answer is unusually long..."
                className="input-field text-sm"
              />
            </div>
          )}

          {/* Target questions */}
          <div>
            <label className="block text-2xs font-semibold text-grey uppercase tracking-wide mb-1.5">
              Suggested Follow-up Questions
            </label>
            {mergedTargets.length === 0 && !hasBankFeature ? (
              <p className="text-grey text-[13px]">
                No other questions in this template.
              </p>
            ) : (
              <>
                {/* Existing template question checkboxes */}
                {mergedTargets.length > 0 && (
                  <div
                    ref={targetListRef}
                    className="flex flex-col gap-1 max-h-[180px] overflow-y-auto mb-2"
                  >
                    {mergedTargets.map((target) => {
                      const selected = (trigger.targetTemplateQuestionIds ?? []).includes(
                        target.id
                      );
                      return (
                        <label
                          key={target.id}
                          className={cn(
                            'flex items-start gap-2 py-1.5 px-2 rounded cursor-pointer text-[13px] text-graphite select-none',
                            selected
                              ? 'bg-horizon-red/5 border border-horizon-red/20'
                              : 'bg-transparent border border-transparent hover:bg-ivory-tint/50'
                          )}
                        >
                          <input
                            type="checkbox"
                            checked={selected}
                            onChange={() => toggleTarget(idx, target.id)}
                            className="accent-horizon-red mt-0.5 shrink-0"
                          />
                          <span>
                            <span className="text-grey text-2xs mr-1.5 font-mono">
                              #{target.sequenceOrder}
                            </span>
                            {target.questionText.length > 90
                              ? target.questionText.slice(0, 90) + '\u2026'
                              : target.questionText}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                )}

                {/* Add from Question Bank */}
                {hasBankFeature && (
                  <div className="mt-1">
                    <button
                      onClick={() => {
                        setShowBankPanel(showBankPanel === idx ? null : idx);
                        setShowCreateForm(null);
                        setBankSearchText('');
                        onBankSearch?.('');
                      }}
                      className={cn(
                        'px-3 py-1 rounded border border-dashed font-primary text-xs font-medium cursor-pointer',
                        showBankPanel === idx
                          ? 'text-horizon-red border-horizon-red'
                          : 'text-grey border-ivory-tint hover:border-grey/30'
                      )}
                    >
                      {showBankPanel === idx ? '− Close Search' : '+ Add from Question Bank'}
                    </button>

                    {showBankPanel === idx && (
                      <div className="mt-2 p-2.5 bg-ivory rounded border border-ivory-tint">
                        <input
                          type="text"
                          value={bankSearchText}
                          onChange={(e) => handleBankSearchChange(e.target.value)}
                          placeholder="Search all questions..."
                          autoFocus
                          className="input-field text-sm mb-2"
                        />

                        {bankLoading && (
                          <p className="text-grey text-xs py-2">
                            Searching...
                          </p>
                        )}

                        {!bankLoading && bankSearchText && bankResults && bankResults.length === 0 && (
                          <p className="text-grey text-xs py-2">
                            No questions found.
                          </p>
                        )}

                        {!bankLoading && bankResults && bankResults.length > 0 && (
                          <div className="flex flex-col gap-1 max-h-[200px] overflow-y-auto">
                            {bankResults.map((q) => {
                              const inTemplate = templateQuestionIds?.has(q.id);
                              return (
                                <button
                                  key={q.id}
                                  onClick={() => void handleSelectFromBank(q, idx)}
                                  disabled={addingExternalQuestion}
                                  className={cn(
                                    'flex items-start gap-2 py-2 px-2.5 rounded border border-ivory-tint bg-white text-left font-primary text-[13px] text-graphite w-full',
                                    addingExternalQuestion
                                      ? 'cursor-wait'
                                      : 'cursor-pointer hover:border-grey/30 hover:bg-ivory-tint/30'
                                  )}
                                >
                                  <div className="flex-1">
                                    <span>
                                      {q.text.length > 100 ? q.text.slice(0, 100) + '\u2026' : q.text}
                                    </span>
                                    <div className="flex gap-1.5 mt-0.5">
                                      <span className="text-2xs text-grey italic">
                                        {q.category}
                                      </span>
                                      {inTemplate && (
                                        <span className="text-[10px] text-green-700 font-semibold">
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
                          <p className="text-grey text-xs mt-1.5">
                            Adding to template...
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                )}

                {/* Create New Question */}
                {hasCreateFeature && (
                  <div className="mt-1.5">
                    <button
                      onClick={() => {
                        setShowCreateForm(showCreateForm === idx ? null : idx);
                        setShowBankPanel(null);
                        setNewQuestionText('');
                        setNewQuestionCategory('');
                      }}
                      className={cn(
                        'px-3 py-1 rounded border border-dashed font-primary text-xs font-medium cursor-pointer',
                        showCreateForm === idx
                          ? 'text-horizon-red border-horizon-red'
                          : 'text-grey border-ivory-tint hover:border-grey/30'
                      )}
                    >
                      {showCreateForm === idx ? '− Cancel Create' : '+ Create New Question'}
                    </button>

                    {showCreateForm === idx && (
                      <div className="mt-2 p-2.5 bg-ivory rounded border border-ivory-tint">
                        <div className="mb-2">
                          <label className="block text-2xs font-semibold text-grey uppercase tracking-wide mb-1.5">
                            Question Text *
                          </label>
                          <textarea
                            value={newQuestionText}
                            onChange={(e) => setNewQuestionText(e.target.value)}
                            placeholder="Enter the question text..."
                            rows={3}
                            className="input-field text-sm resize-y"
                          />
                        </div>
                        <div className="mb-2.5">
                          <label className="block text-2xs font-semibold text-grey uppercase tracking-wide mb-1.5">
                            Category *
                          </label>
                          <input
                            type="text"
                            value={newQuestionCategory}
                            onChange={(e) => setNewQuestionCategory(e.target.value)}
                            placeholder="e.g. experience, process, motivation..."
                            className="input-field text-sm"
                          />
                        </div>
                        <button
                          onClick={() => void handleCreateAndAdd(idx)}
                          disabled={
                            creatingQuestion ||
                            !newQuestionText.trim() ||
                            !newQuestionCategory.trim()
                          }
                          className={cn(
                            'btn-primary text-xs py-1.5 px-4',
                            (creatingQuestion || !newQuestionText.trim() || !newQuestionCategory.trim())
                              && 'opacity-50 cursor-not-allowed'
                          )}
                        >
                          {creatingQuestion ? 'Creating...' : 'Create & Add'}
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
