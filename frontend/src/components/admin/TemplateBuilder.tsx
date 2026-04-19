'use client';

import React, { useState, useEffect, useRef } from 'react';
import { useQuery, useMutation, gql } from '@apollo/client';
import { cn } from '@/lib/utils';
import { StatusBadge } from '@/components/ui/StatusBadge';
import {
  QuestionModal,
  type QuestionModalQuestion,
  type QuestionModalTag,
} from '@/components/admin/QuestionModal';
import { QuestionRefBadge } from '@/components/ui/QuestionRefBadge';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Tag {
  id: string;
  label: string;
  isActive: boolean;
}

type SensitivityLevel = 'STANDARD' | 'SENSITIVE' | 'HIGHLY_SENSITIVE';

interface Question {
  id: string;
  displayNumber: number;
  text: string;
  isActive: boolean;
  intent: string | null;
  sensitivityLevel: SensitivityLevel;
  tags: Tag[];
}

// Raw shape from GraphQL
interface RawTemplateQuestion {
  id: string;
  question: Question;
  sequenceOrder: number;
  categoryBucket: string;
  isRequired: boolean;
  adminNotes: string | null;
}

interface RawInterviewTemplate {
  id: string;
  name: string;
  description: string | null;
  systemPrompt: string | null;
  status: string;
  questions: RawTemplateQuestion[];
}

// Parsed local shape
interface TemplateQuestion {
  id: string;
  question: Question;
  sequenceOrder: number;
  categoryBucket: string;
  isRequired: boolean;
  adminNotes: string;
}

interface QuestionEdge {
  cursor: string;
  node: Question;
}

interface BankPageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

interface QuestionConnection {
  edges: QuestionEdge[];
  pageInfo: BankPageInfo;
  totalCount: number;
}

// ---------------------------------------------------------------------------
// GQL Documents
// ---------------------------------------------------------------------------

const GET_TEMPLATE = gql`
  query BuilderGetTemplate($id: ID!) {
    getTemplate(id: $id) {
      id
      name
      description
      systemPrompt
      status
      questions {
        id
        sequenceOrder
        categoryBucket
        isRequired
        adminNotes
        question {
          id
          displayNumber
          text
          isActive
          intent
          sensitivityLevel
          tags { id label isActive }
        }
      }
    }
  }
`;

const UPDATE_TEMPLATE = gql`
  mutation BuilderUpdateTemplate(
    $id: ID!
    $name: String
    $description: String
    $systemPrompt: String
    $status: String
  ) {
    updateTemplate(id: $id, name: $name, description: $description, systemPrompt: $systemPrompt, status: $status) {
      id
      name
      description
      systemPrompt
      status
    }
  }
`;

const GET_ACTIVE_QUESTIONS = gql`
  query BuilderGetActiveQuestions(
    $filters: QuestionFilters
    $first: Int
    $after: String
  ) {
    getQuestions(filters: $filters, includeInactive: false, first: $first, after: $after) {
      edges {
        cursor
        node {
          id
          displayNumber
          text
          isActive
          intent
          sensitivityLevel
          tags { id label isActive }
        }
      }
      pageInfo { hasNextPage endCursor }
      totalCount
    }
  }
`;

const ADD_QUESTION = gql`
  mutation BuilderAddQuestion(
    $templateId: ID!
    $questionId: ID!
    $sequenceOrder: Int!
    $categoryBucket: String!
    $isRequired: Boolean
  ) {
    addQuestionToTemplate(
      templateId: $templateId
      questionId: $questionId
      sequenceOrder: $sequenceOrder
      categoryBucket: $categoryBucket
      isRequired: $isRequired
    ) {
      id
      sequenceOrder
      categoryBucket
      isRequired
      adminNotes
      question { id displayNumber text isActive intent sensitivityLevel tags { id label isActive } }
    }
  }
`;

const UPDATE_TQ = gql`
  mutation BuilderUpdateTQ(
    $id: ID!
    $sequenceOrder: Int
    $categoryBucket: String
    $isRequired: Boolean
    $adminNotes: String
  ) {
    updateTemplateQuestion(
      id: $id
      sequenceOrder: $sequenceOrder
      categoryBucket: $categoryBucket
      isRequired: $isRequired
      adminNotes: $adminNotes
    ) {
      id
      sequenceOrder
      categoryBucket
      isRequired
      adminNotes
    }
  }
`;

const REORDER_TQS = gql`
  mutation BuilderReorderTQs($templateId: ID!, $orderedIds: [ID!]!) {
    reorderTemplateQuestions(templateId: $templateId, orderedIds: $orderedIds) {
      id
      sequenceOrder
    }
  }
`;

const REMOVE_QUESTION = gql`
  mutation BuilderRemoveQuestion($id: ID!) {
    removeQuestionFromTemplate(id: $id)
  }
`;

const GET_ALL_TAGS = gql`
  query BuilderGetAllTags {
    getTags { id label isActive }
  }
`;


// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sortedByOrder(qs: TemplateQuestion[]): TemplateQuestion[] {
  return [...qs].sort((a, b) => a.sequenceOrder - b.sequenceOrder);
}

// ---------------------------------------------------------------------------
// Step indicator
// ---------------------------------------------------------------------------

const STEPS = [
  'Template Info',
  'Select Questions',
  'Admin Notes',
  'Review & Order',
  'Publish',
];

function StepIndicator({
  current,
  onSelect,
}: {
  current: number;
  onSelect: (n: number) => void;
}) {
  return (
    <div className="flex border-b-2 border-ivory-tint bg-white overflow-x-auto">
      {STEPS.map((label, i) => {
        const step = i + 1;
        const active = step === current;
        const past = step < current;
        return (
          <button
            key={step}
            onClick={() => onSelect(step)}
            className={cn(
              'py-3.5 px-[18px] border-none bg-transparent font-primary text-[13px] cursor-pointer whitespace-nowrap -mb-[2px] flex items-center gap-[7px] border-b-2',
              active && 'border-b-horizon-red font-semibold text-horizon-red',
              !active && past && 'border-b-transparent font-normal text-graphite',
              !active && !past && 'border-b-transparent font-normal text-grey',
            )}
          >
            <span
              className={cn(
                'inline-flex items-center justify-center w-5 h-5 rounded-full text-2xs font-bold shrink-0',
                active && 'bg-horizon-red text-white',
                !active && past && 'bg-graphite text-white',
                !active && !past && 'bg-ivory-tint text-grey',
              )}
            >
              {past ? '\u2713' : step}
            </span>
            {label}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// TemplateBuilder
// ---------------------------------------------------------------------------

const BANK_PAGE_SIZE = 20;

export default function TemplateBuilder({ templateId }: { templateId: string }) {
  // Step navigation
  const [currentStep, setCurrentStep] = useState(1);

  // Step 1: template info
  const [localName, setLocalName] = useState('');
  const [localDescription, setLocalDescription] = useState('');
  const [localSystemPrompt, setLocalSystemPrompt] = useState('');
  const [infoSaveError, setInfoSaveError] = useState<string | null>(null);
  const [infoSaved, setInfoSaved] = useState(false);

  // Synced questions
  const [localQuestions, setLocalQuestions] = useState<TemplateQuestion[]>([]);
  const localQuestionsRef = useRef(localQuestions);
  localQuestionsRef.current = localQuestions;

  // Step 2: drag-and-drop
  const draggedIdxRef = useRef<number | null>(null);
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);
  const [isSavingOrder, setIsSavingOrder] = useState(false);

  // Step 2: question bank
  const [bankSearch, setBankSearch] = useState('');
  const [bankDebouncedSearch, setBankDebouncedSearch] = useState('');
  const [bankAfterCursor, setBankAfterCursor] = useState<string | null>(null);
  const bankSearchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Step 3: admin notes
  const [savingNotesFor, setSavingNotesFor] = useState<string | null>(null);
  const [localAdminNotes, setLocalAdminNotes] = useState<Record<string, string>>({});

  // Step 4: review & order (reorder reuses Step 2 DnD handlers; toggle required)
  const [togglingRequired, setTogglingRequired] = useState<string | null>(null);
  const [editingQuestion, setEditingQuestion] =
    useState<QuestionModalQuestion | null>(null);

  // General / publish
  const [pageError, setPageError] = useState<string | null>(null);
  const [publishError, setPublishError] = useState<string | null>(null);
  const [isPublishing, setIsPublishing] = useState(false);

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------

  const {
    data: templateData,
    loading: templateLoading,
    error: templateError,
    refetch: refetchTemplate,
  } = useQuery<{ getTemplate: RawInterviewTemplate | null }>(GET_TEMPLATE, {
    variables: { id: templateId },
    fetchPolicy: 'cache-and-network',
  });

  const { data: tagsData } = useQuery<{ getTags: Tag[] }>(GET_ALL_TAGS);

  const { data: bankData, loading: bankLoading } = useQuery<{
    getQuestions: QuestionConnection;
  }>(GET_ACTIVE_QUESTIONS, {
    skip: currentStep !== 2,
    variables: {
      first: BANK_PAGE_SIZE,
      after: bankAfterCursor,
      filters: bankDebouncedSearch ? { searchText: bankDebouncedSearch } : undefined,
    },
    fetchPolicy: 'cache-and-network',
  });

  // ---------------------------------------------------------------------------
  // Mutations
  // ---------------------------------------------------------------------------

  const [updateTemplate, { loading: updatingTemplate }] = useMutation(UPDATE_TEMPLATE);
  const [addQuestion, { loading: addingQuestion }] = useMutation(ADD_QUESTION);
  const [updateTQ] = useMutation(UPDATE_TQ);
  const [reorderTQs] = useMutation(REORDER_TQS);
  const [removeQuestion] = useMutation(REMOVE_QUESTION);

  // ---------------------------------------------------------------------------
  // Sync from API
  // ---------------------------------------------------------------------------

  useEffect(() => {
    const tpl = templateData?.getTemplate;
    if (!tpl) return;
    setLocalName(tpl.name);
    setLocalDescription(tpl.description ?? '');
    setLocalSystemPrompt(tpl.systemPrompt ?? '');
    const sorted = sortedByOrder(
      tpl.questions.map((q) => ({
        ...q,
        adminNotes: q.adminNotes ?? '',
      }))
    );
    setLocalQuestions(sorted);
    setLocalAdminNotes(
      Object.fromEntries(sorted.map((q) => [q.id, q.adminNotes]))
    );
  }, [templateData]);

  // ---------------------------------------------------------------------------
  // Derived
  // ---------------------------------------------------------------------------

  const template = templateData?.getTemplate ?? null;
  const allTags: QuestionModalTag[] = tagsData?.getTags ?? [];
  const bankQuestions = bankData?.getQuestions?.edges.map((e) => e.node) ?? [];
  const bankPageInfo = bankData?.getQuestions?.pageInfo;
  const bankTotalCount = bankData?.getQuestions?.totalCount ?? 0;
  const addedQuestionIds = new Set(localQuestions.map((tq) => tq.question.id));
  const requiredCount = localQuestions.filter((q) => q.isRequired).length;
  const optionalCount = localQuestions.length - requiredCount;

  // ---------------------------------------------------------------------------
  // Step 1 handlers
  // ---------------------------------------------------------------------------

  const handleSaveInfo = async () => {
    setInfoSaveError(null);
    setInfoSaved(false);
    try {
      await updateTemplate({
        variables: {
          id: templateId,
          name: localName.trim(),
          description: localDescription.trim() || null,
          systemPrompt: localSystemPrompt.trim() || null,
        },
      });
      setInfoSaved(true);
      setTimeout(() => setInfoSaved(false), 2500);
    } catch (err) {
      setInfoSaveError((err as Error).message);
    }
  };

  // ---------------------------------------------------------------------------
  // Step 2 handlers
  // ---------------------------------------------------------------------------

  const handleBankSearchChange = (val: string) => {
    setBankSearch(val);
    if (bankSearchTimer.current) clearTimeout(bankSearchTimer.current);
    bankSearchTimer.current = setTimeout(() => {
      setBankDebouncedSearch(val);
      setBankAfterCursor(null);
    }, 300);
  };

  const handleAddQuestion = async (q: Question) => {
    if (addedQuestionIds.has(q.id)) return;
    setPageError(null);
    try {
      await addQuestion({
        variables: {
          templateId,
          questionId: q.id,
          sequenceOrder: localQuestions.length + 1,
          categoryBucket: 'Uncategorized',
          isRequired: false,
        },
      });
      void refetchTemplate();
    } catch (err) {
      setPageError((err as Error).message);
    }
  };

  const handleRemoveQuestion = async (tqId: string) => {
    setPageError(null);
    try {
      await removeQuestion({ variables: { id: tqId } });
      void refetchTemplate();
    } catch (err) {
      setPageError((err as Error).message);
    }
  };

  const handleDragStart = (idx: number) => {
    draggedIdxRef.current = idx;
  };

  const handleDragOver = (e: React.DragEvent, idx: number) => {
    e.preventDefault();
    setDragOverIdx(idx);
  };

  const handleDrop = async (targetIdx: number) => {
    const fromIdx = draggedIdxRef.current;
    setDragOverIdx(null);
    draggedIdxRef.current = null;
    if (fromIdx === null || fromIdx === targetIdx) return;

    const reordered = [...localQuestions];
    const [item] = reordered.splice(fromIdx, 1);
    reordered.splice(targetIdx, 0, item);
    setLocalQuestions(reordered); // optimistic

    setIsSavingOrder(true);
    try {
      await reorderTQs({
        variables: {
          templateId,
          orderedIds: reordered.map((tq) => tq.id),
        },
      });
    } catch (err) {
      setPageError((err as Error).message);
      void refetchTemplate();
    } finally {
      setIsSavingOrder(false);
    }
  };

  const handleDragEnd = () => {
    draggedIdxRef.current = null;
    setDragOverIdx(null);
  };

  // ---------------------------------------------------------------------------
  // Step 3 handlers
  // ---------------------------------------------------------------------------

  const handleSaveAdminNotes = async (tqId: string, notes: string) => {
    setSavingNotesFor(tqId);
    try {
      await updateTQ({ variables: { id: tqId, adminNotes: notes } });
      setLocalQuestions((prev) =>
        prev.map((q) => (q.id === tqId ? { ...q, adminNotes: notes } : q))
      );
    } catch (err) {
      setPageError((err as Error).message);
    } finally {
      setSavingNotesFor(null);
    }
  };

  // ---------------------------------------------------------------------------
  // Step 4 handlers
  // ---------------------------------------------------------------------------

  const handleToggleRequired = async (tqId: string, current: boolean) => {
    setTogglingRequired(tqId);
    try {
      await updateTQ({ variables: { id: tqId, isRequired: !current } });
      setLocalQuestions((prev) =>
        prev.map((q) => (q.id === tqId ? { ...q, isRequired: !current } : q))
      );
    } catch (err) {
      setPageError((err as Error).message);
    } finally {
      setTogglingRequired(null);
    }
  };

  // ---------------------------------------------------------------------------
  // Step 6 handlers
  // ---------------------------------------------------------------------------

  const handlePublish = async () => {
    setPublishError(null);
    if (localQuestions.length === 0) {
      setPublishError(
        'Cannot publish: this template has no questions. Add at least one question in Step 2.'
      );
      return;
    }
    setIsPublishing(true);
    try {
      await updateTemplate({ variables: { id: templateId, status: 'published' } });
      void refetchTemplate();
    } catch (err) {
      setPublishError((err as Error).message);
    } finally {
      setIsPublishing(false);
    }
  };

  const handleArchive = async () => {
    setPublishError(null);
    setIsPublishing(true);
    try {
      await updateTemplate({ variables: { id: templateId, status: 'archived' } });
      void refetchTemplate();
    } catch (err) {
      setPublishError((err as Error).message);
    } finally {
      setIsPublishing(false);
    }
  };

  // ---------------------------------------------------------------------------
  // Step renderers
  // ---------------------------------------------------------------------------

  const renderStep1 = () => (
    <div className="max-w-[580px] py-8">
      <div className="mb-5">
        <label className="block font-medium text-sm text-graphite mb-1.5">
          Template Name *
        </label>
        <input
          type="text"
          value={localName}
          onChange={(e) => setLocalName(e.target.value)}
          className="input-field text-sm"
          placeholder="e.g. Senior Engineer Interview — Q2 2026"
        />
      </div>

      <div className="mb-6">
        <div className="flex items-center gap-2 mb-1.5">
          <label className="font-medium text-sm text-graphite">
            Description
          </label>
          <span className="relative inline-flex group">
            <span className="inline-flex items-center justify-center w-4 h-4 rounded-full border border-graphite text-[10px] font-semibold text-graphite cursor-default shrink-0 select-none">
              ?
            </span>
            <span className="hidden group-hover:block absolute left-[22px] top-1/2 -translate-y-1/2 bg-[#1f2937] text-[#f9fafb] text-xs leading-normal py-1.5 px-2.5 rounded-md w-[260px] whitespace-normal z-[100] pointer-events-none">
              Shown to interviewees before the interview starts. Briefly explain what to expect so they feel prepared and confident.
            </span>
          </span>
        </div>
        <textarea
          value={localDescription}
          onChange={(e) => setLocalDescription(e.target.value)}
          rows={4}
          className="input-field text-sm resize-y"
          placeholder="Describe the purpose and scope of this interview template..."
        />
      </div>

      <div className="mb-6">
        <div className="flex items-center gap-2 mb-1.5">
          <label className="font-medium text-sm text-graphite">
            System Prompt
          </label>
          <span className="relative inline-flex group">
            <span className="inline-flex items-center justify-center w-4 h-4 rounded-full border border-graphite text-[10px] font-semibold text-graphite cursor-default shrink-0 select-none">
              ?
            </span>
            <span className="hidden group-hover:block absolute left-[22px] top-1/2 -translate-y-1/2 bg-[#1f2937] text-[#f9fafb] text-xs leading-normal py-1.5 px-2.5 rounded-md w-[260px] whitespace-normal z-[100] pointer-events-none">
              This prompt defines the LLM&apos;s behavior for this template — setting its tone, rules, and interviewing style. It runs before every interview session.
            </span>
          </span>
        </div>
        <textarea
          value={localSystemPrompt}
          onChange={(e) => setLocalSystemPrompt(e.target.value)}
          rows={8}
          className="input-field text-sm resize-y"
          placeholder="Instructions passed to the AI interviewer to guide voice, tone, and structure..."
        />
      </div>

      {infoSaveError && (
        <p className="alert-error text-sm mb-3">
          {infoSaveError}
        </p>
      )}
      {infoSaved && (
        <p className="text-graphite text-sm mb-3 py-2 px-3 bg-ivory-tint rounded border border-ivory-tint">
          Template info saved.
        </p>
      )}

      <button
        onClick={() => void handleSaveInfo()}
        disabled={updatingTemplate || !localName.trim()}
        className={cn(
          'btn-primary',
          (updatingTemplate || !localName.trim()) && 'opacity-50 cursor-not-allowed',
        )}
      >
        {updatingTemplate ? 'Saving...' : 'Save Info'}
      </button>
    </div>
  );

  const renderStep2 = () => (
    <div className="grid grid-cols-2 gap-6 py-6">
      {/* Left: Question Bank */}
      <div>
        <h3 className="font-primary font-semibold text-base text-graphite mb-3">
          Question Bank
        </h3>

        <input
          type="search"
          value={bankSearch}
          onChange={(e) => handleBankSearchChange(e.target.value)}
          placeholder="Search questions..."
          className="input-field text-sm mb-3"
          aria-label="Search question bank"
        />

        {bankLoading && bankQuestions.length === 0 ? (
          <p className="text-grey text-sm">Loading...</p>
        ) : bankQuestions.length === 0 ? (
          <p className="text-grey text-sm">
            No active questions found.
          </p>
        ) : (
          <>
            <p className="text-grey text-xs mb-2">
              {bankTotalCount} question{bankTotalCount !== 1 ? 's' : ''}
              {bankDebouncedSearch ? ` matching "${bankDebouncedSearch}"` : ''}
              {addingQuestion && (
                <span className="ml-2 italic">Adding...</span>
              )}
            </p>

            <div className="border border-ivory-tint rounded bg-white max-h-[440px] overflow-y-auto">
              {bankQuestions.map((q, i) => {
                const isAdded = addedQuestionIds.has(q.id);
                return (
                  <div
                    key={q.id}
                    onClick={() => {
                      if (isAdded) {
                        const tq = localQuestions.find((t) => t.question.id === q.id);
                        if (tq) void handleRemoveQuestion(tq.id);
                      } else {
                        void handleAddQuestion(q);
                      }
                    }}
                    className={cn(
                      'py-3 px-3.5 flex items-start gap-2.5 transition-colors duration-100',
                      i < bankQuestions.length - 1 && 'border-b border-ivory-tint',
                      isAdded
                        ? 'cursor-pointer bg-ivory-tint/35 hover:bg-red-50/40'
                        : cn(i % 2 === 0 ? 'bg-white' : 'bg-ivory-tint', 'cursor-pointer hover:bg-horizon-red/[0.03]'),
                    )}
                  >
                    <div
                      className={cn(
                        'w-[18px] h-[18px] rounded-[4px] flex items-center justify-center text-2xs shrink-0 mt-0.5',
                        isAdded
                          ? 'bg-graphite text-white'
                          : 'border-[1.5px] border-ivory-tint bg-white',
                      )}
                    >
                      {isAdded ? '\u2713' : ''}
                    </div>
                    <div>
                      <p className="text-[13px] text-graphite leading-normal mb-1">
                        {q.text.length > 110 ? q.text.slice(0, 110) + '\u2026' : q.text}
                      </p>
                      <div className="flex gap-1.5 flex-wrap">
                        {q.tags.slice(0, 3).map((t) => (
                          <span
                            key={t.id}
                            className="badge bg-ivory-tint text-graphite"
                          >
                            {t.label}
                          </span>
                        ))}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            {bankPageInfo?.hasNextPage && (
              <button
                onClick={() => setBankAfterCursor(bankPageInfo.endCursor)}
                className="btn-amber mt-2.5 text-[13px] py-2 px-4"
              >
                Load more
              </button>
            )}
          </>
        )}
      </div>

      {/* Right: Selected Questions with DnD */}
      <div>
        <div className="flex justify-between items-center mb-3">
          <h3 className="font-primary font-semibold text-base text-graphite">
            Selected Questions
          </h3>
          <div className="flex items-center gap-3">
            {isSavingOrder && (
              <span className="text-grey text-xs">
                Saving order...
              </span>
            )}
            <span className="text-grey text-[13px]">
              {localQuestions.length} selected
            </span>
          </div>
        </div>

        {localQuestions.length === 0 ? (
          <div className="border-2 border-dashed border-ivory-tint rounded py-12 px-6 text-center text-grey text-sm">
            Click questions in the bank to add them here.
          </div>
        ) : (
          <div className="border border-ivory-tint rounded bg-white max-h-[500px] overflow-y-auto">
            {localQuestions.map((tq, idx) => (
              <div
                key={tq.id}
                draggable
                onDragStart={() => handleDragStart(idx)}
                onDragOver={(e) => handleDragOver(e, idx)}
                onDrop={() => void handleDrop(idx)}
                onDragEnd={handleDragEnd}
                className={cn(
                  'py-2.5 px-3 flex items-center gap-2.5 cursor-grab transition-colors duration-100 hover:bg-horizon-red/[0.03]',
                  idx < localQuestions.length - 1 && 'border-b border-ivory-tint',
                  dragOverIdx === idx
                    ? 'bg-horizon-red/[0.04] border-l-2 border-l-horizon-red'
                    : cn(idx % 2 === 0 ? 'bg-white' : 'bg-ivory-tint', 'border-l-2 border-l-transparent'),
                )}
              >
                <span className="text-grey text-sm shrink-0 select-none">
                  &#x2807;
                </span>
                <span className="text-grey text-2xs min-w-[20px] shrink-0 font-mono">
                  {idx + 1}
                </span>
                <span className="flex-1 text-[13px] text-graphite leading-[1.4]">
                  {tq.question.text.length > 80
                    ? tq.question.text.slice(0, 80) + '\u2026'
                    : tq.question.text}
                </span>
                <button
                  onClick={() => void handleRemoveQuestion(tq.id)}
                  aria-label="Remove question"
                  title="Remove from template"
                  className="bg-none border-none text-grey cursor-pointer text-base py-0 px-1 shrink-0 leading-none hover:text-horizon-red"
                >
                  {'\u00d7'}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );

  const renderStep3 = () => (
    <div className="py-6">
      <div className="flex justify-between items-center mb-4">
        <p className="text-grey text-sm">
          Add free-text guidance for the AI interviewer, per question. These notes
          are never shown to interviewees.
        </p>
        <div className="flex gap-2 shrink-0 ml-4">
          <button
            onClick={() => setCurrentStep((s) => Math.max(1, s - 1))}
            className="btn-primary py-1.5 px-3 text-xs"
          >
            {'\u2190'} Back
          </button>
          <button
            onClick={() => setCurrentStep((s) => Math.min(STEPS.length, s + 1))}
            className="btn-primary py-1.5 px-3 text-xs"
          >
            Next {'\u2192'}
          </button>
        </div>
      </div>

      {localQuestions.length === 0 ? (
        <p className="text-grey text-sm">
          No questions selected. Go to Step 2 to add questions.
        </p>
      ) : (
        <div className="flex flex-col gap-4">
          {localQuestions.map((tq, idx) => {
            const isSavingThis = savingNotesFor === tq.id;
            const notes = localAdminNotes[tq.id] ?? '';
            const isLegacyImport = notes.startsWith('Legacy triggers:');
            const MAX_NOTES = 4000;

            return (
              <div
                key={tq.id}
                className="bg-white rounded border border-ivory-tint overflow-hidden"
              >
                <div className="flex items-center gap-3 py-3 px-4 bg-ivory border-b border-ivory-tint">
                  <span className="text-grey text-2xs font-mono min-w-[20px] shrink-0">
                    {idx + 1}
                  </span>
                  <QuestionRefBadge displayNumber={tq.question.displayNumber} />
                  <span className="flex-1 text-[13px] text-graphite font-medium leading-snug">
                    {tq.question.text.length > 120
                      ? tq.question.text.slice(0, 120) + '\u2026'
                      : tq.question.text}
                  </span>
                </div>

                <div className="px-4 pb-4 pt-3">
                  {tq.question.intent && (
                    <div className="mb-4 rounded border border-ivory-tint bg-ivory/60 px-3 py-2.5">
                      <div className="text-grey text-[11px] uppercase tracking-wide font-medium mb-1">
                        This question&rsquo;s global briefing (edit in Question Bank)
                      </div>
                      <p className="text-[13px] text-graphite leading-relaxed whitespace-pre-wrap">
                        {tq.question.intent}
                      </p>
                    </div>
                  )}
                  <label className="block font-medium text-sm text-graphite mb-1">
                    Admin Notes
                  </label>
                  <p className="text-grey text-xs mb-2 leading-relaxed">
                    Free-text guidance for the interviewer LLM — e.g., &lsquo;Follow up if
                    response mentions legacy systems.&rsquo; Plain prose, not keyword
                    matching. Interviewees never see this.
                  </p>
                  <textarea
                    value={notes}
                    onChange={(e) => {
                      const val = e.target.value.slice(0, MAX_NOTES);
                      setLocalAdminNotes((prev) => ({ ...prev, [tq.id]: val }));
                    }}
                    onBlur={() => {
                      if (notes !== tq.adminNotes) {
                        void handleSaveAdminNotes(tq.id, notes);
                      }
                    }}
                    rows={5}
                    maxLength={MAX_NOTES}
                    className="input-field text-sm resize-y w-full mb-1"
                    placeholder="E.g. If the candidate mentions a legacy monolith, probe for migration experience before moving on."
                    disabled={isSavingThis}
                  />
                  <div className="flex items-center justify-between">
                    <span className="text-grey text-xs">
                      {notes.length} / {MAX_NOTES}
                    </span>
                    {isSavingThis && (
                      <span className="text-grey text-xs italic">Saving...</span>
                    )}
                  </div>
                  {isLegacyImport && (
                    <p className="mt-2 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-3 py-2">
                      Imported from legacy triggers — review and refine.
                    </p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );

  const renderReviewStep = () => (
    <div className="py-6">
      <div className="flex items-center gap-4 mb-5">
        <span className="text-graphite text-sm">
          <span className="font-bold">{localQuestions.length}</span>{' '}
          question{localQuestions.length !== 1 ? 's' : ''}
        </span>
        <span className="text-graphite text-sm">
          <span className="font-bold">{requiredCount}</span> required
        </span>
        <span className="text-grey text-sm">
          <span className="font-bold">{optionalCount}</span> optional
        </span>
        <span className="relative inline-flex group">
          <span className="inline-flex items-center justify-center w-4 h-4 rounded-full border border-graphite text-[10px] font-semibold text-graphite cursor-default shrink-0 select-none">
            ?
          </span>
          <span className="hidden group-hover:block absolute left-[22px] top-1/2 -translate-y-1/2 bg-[#1f2937] text-[#f9fafb] text-xs leading-snug py-1.5 px-2.5 rounded-md w-[230px] whitespace-normal z-[100] pointer-events-none">
            <span className="block"><span className="font-semibold">Required:</span> AI must cover to end interview.</span>
            <span className="block mt-0.5"><span className="font-semibold">Optional:</span> AI may skip.</span>
          </span>
        </span>
        {isSavingOrder && (
          <span className="text-grey text-xs italic ml-auto">Saving order...</span>
        )}
      </div>

      {localQuestions.length === 0 ? (
        <p className="text-grey text-sm">
          No questions selected. Go to Step 2 to add questions.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {localQuestions.map((tq, idx) => {
            const isToggling = togglingRequired === tq.id;
            return (
              <div
                key={tq.id}
                draggable
                onDragStart={() => handleDragStart(idx)}
                onDragOver={(e) => handleDragOver(e, idx)}
                onDrop={() => void handleDrop(idx)}
                onDragEnd={handleDragEnd}
                className={cn(
                  'bg-white rounded-md border shadow-sm overflow-hidden transition-colors duration-100',
                  dragOverIdx === idx
                    ? 'border-horizon-red border-l-2 border-l-horizon-red'
                    : 'border-ivory-tint',
                )}
              >
                <div className="flex items-center gap-3 py-3 px-4">
                  <span
                    className="text-grey text-base select-none cursor-grab shrink-0 leading-none"
                    title="Drag to reorder"
                    aria-label="Drag to reorder"
                  >
                    &#x2807;
                  </span>
                  <span className="text-grey text-2xs font-mono min-w-[24px] shrink-0">
                    #{idx + 1}
                  </span>
                  <QuestionRefBadge displayNumber={tq.question.displayNumber} />
                  <p className="flex-1 text-[13px] text-graphite font-medium leading-snug">
                    {tq.question.text}
                  </p>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      onClick={() => void handleToggleRequired(tq.id, tq.isRequired)}
                      disabled={isToggling}
                      className={cn(
                        'group relative py-[5px] px-3 rounded-md border-none text-xs font-semibold font-primary whitespace-nowrap min-w-[92px] transition-all duration-150',
                        tq.isRequired
                          ? 'bg-horizon-red/10 text-horizon-red hover:bg-horizon-red/15'
                          : 'bg-ivory-tint text-grey hover:bg-ivory-tint/80',
                        isToggling ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer',
                      )}
                    >
                      <span className="group-hover:invisible">
                        {tq.isRequired ? 'Required' : 'Optional'}
                      </span>
                      <span className="invisible group-hover:visible absolute inset-0 flex items-center justify-center whitespace-nowrap">
                        {tq.isRequired ? '\u2192 Optional' : '\u2192 Required'}
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditingQuestion(tq.question)}
                      className="text-xs text-horizon-red hover:underline inline-flex items-center gap-0.5 bg-transparent border-none cursor-pointer py-[5px]"
                      title="Edit this question"
                    >
                      Edit question
                    </button>
                  </div>
                </div>

                {(tq.question.intent || tq.adminNotes) && (
                  <div className="px-4 pb-3 pt-1 flex flex-col gap-2.5">
                    {tq.question.intent && (
                      <div className="rounded border border-ivory-tint bg-ivory/60 px-3 py-2">
                        <div className="text-grey text-[11px] uppercase tracking-wide font-medium mb-1">
                          Global briefing (edit in Question Bank)
                        </div>
                        <p className="text-[13px] text-graphite leading-relaxed whitespace-pre-wrap">
                          {tq.question.intent}
                        </p>
                      </div>
                    )}
                    {tq.adminNotes && (
                      <div className="rounded border border-ivory-tint bg-ivory/60 px-3 py-2">
                        <div className="text-grey text-[11px] uppercase tracking-wide font-medium mb-1">
                          This template&rsquo;s notes (edit in Step 3)
                        </div>
                        <p className="text-[13px] text-graphite leading-relaxed whitespace-pre-wrap">
                          {tq.adminNotes}
                        </p>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );

  const renderStep7 = () => {
    const status = template?.status ?? 'draft';
    const isDraft = status === 'draft';
    const isPublished = status === 'published';
    const isArchived = status === 'archived';

    return (
      <div className="max-w-[560px] py-8">
        {/* Status */}
        <div className="mb-6">
          <span className="text-xs font-semibold text-grey uppercase tracking-label mr-2.5">
            Current status:
          </span>
          <StatusBadge status={status} />
        </div>

        {/* Summary card */}
        <div className="bg-white rounded-[10px] border border-ivory-tint py-5 px-6 mb-6">
          <p
            className={cn(
              'font-semibold text-[15px] text-graphite',
              template?.description ? 'mb-1.5' : 'mb-3.5',
            )}
          >
            {template?.name}
          </p>
          {template?.description && (
            <p className="text-[13px] text-grey mb-3.5 leading-normal">
              {template.description}
            </p>
          )}
          <div className="flex gap-6">
            <div>
              <span className="text-[22px] font-bold text-graphite">
                {localQuestions.length}
              </span>
              <span className="text-[13px] text-grey ml-1.5">
                questions
              </span>
            </div>
            <div>
              <span className="text-[22px] font-bold text-graphite">
                {requiredCount}
              </span>
              <span className="text-[13px] text-grey ml-1.5">
                required
              </span>
            </div>
            <div>
              <span className="text-[22px] font-bold text-grey">
                {optionalCount}
              </span>
              <span className="text-[13px] text-grey ml-1.5">
                optional
              </span>
            </div>
          </div>
        </div>

        {publishError && (
          <div className="alert-error mb-4">
            {publishError}
          </div>
        )}

        {isDraft && (
          <div>
            {localQuestions.length === 0 && (
              <div className="alert-warning py-2.5 px-3.5 text-[13px] mb-4">
                <strong>Warning:</strong> This template has no questions. Add at
                least one question in Step 2 before publishing.
              </div>
            )}
            <button
              onClick={() => void handlePublish()}
              disabled={isPublishing || localQuestions.length === 0}
              className={cn(
                'btn-primary',
                (isPublishing || localQuestions.length === 0) && 'opacity-50 cursor-not-allowed',
              )}
            >
              {isPublishing ? 'Publishing...' : 'Publish Template'}
            </button>
          </div>
        )}

        {isPublished && (
          <div>
            <p className="text-grey text-[13px] mb-4 leading-relaxed">
              This template is live and can be assigned to users. You can
              continue editing at any time — changes take effect for new
              interviews.
            </p>
            <button
              onClick={() => void handleArchive()}
              disabled={isPublishing}
              className={cn(
                'btn-wine',
                isPublishing && 'opacity-50 cursor-not-allowed',
              )}
            >
              {isPublishing ? 'Archiving...' : 'Archive Template'}
            </button>
          </div>
        )}

        {isArchived && (
          <div>
            <p className="text-grey text-[13px] mb-4 leading-relaxed">
              This template is archived and cannot be assigned to new users.
              Re-publish to make it available again.
            </p>
            <button
              onClick={() => void handlePublish()}
              disabled={isPublishing}
              className={cn(
                'btn-primary',
                isPublishing && 'opacity-50 cursor-not-allowed',
              )}
            >
              {isPublishing ? 'Publishing...' : 'Re-publish Template'}
            </button>
          </div>
        )}
      </div>
    );
  };

  // ---------------------------------------------------------------------------
  // Loading / error states
  // ---------------------------------------------------------------------------

  if (templateLoading && !templateData) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-ivory font-primary">
        <p className="text-grey text-[15px]">Loading template...</p>
      </div>
    );
  }

  if (templateError || !template) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-ivory font-primary">
        <p className="text-horizon-red text-[15px]">
          {templateError
            ? `Error loading template: ${templateError.message}`
            : 'Template not found.'}
        </p>
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Step dispatch
  // ---------------------------------------------------------------------------

  const renderCurrentStep = (): React.ReactNode => {
    switch (currentStep) {
      case 1: return renderStep1();
      case 2: return renderStep2();
      case 3: return renderStep3();
      case 4: return renderReviewStep();
      case 5: return renderStep7();
      default: return null;
    }
  };

  // ---------------------------------------------------------------------------
  // Main render
  // ---------------------------------------------------------------------------

  return (
    <div className="min-h-screen bg-ivory font-primary">
      {/* Page header */}
      <header className="py-5 px-8 border-b border-ivory-tint bg-white flex items-center justify-between gap-4">
        <div>
          <h2 className="font-primary font-semibold text-[22px] text-graphite mb-0.5">
            {template.name}
          </h2>
          <p className="text-grey text-sm">
            Template Builder —{' '}
            {localQuestions.length} question
            {localQuestions.length !== 1 ? 's' : ''}
          </p>
        </div>
        <StatusBadge status={template.status} />
      </header>

      {/* Step indicator */}
      <StepIndicator current={currentStep} onSelect={setCurrentStep} />

      {/* Content */}
      <div className="px-8">
        {/* Page-level error */}
        {pageError && (
          <div
            role="alert"
            className="alert-error mt-5 flex justify-between items-center"
          >
            <span>{pageError}</span>
            <button
              onClick={() => setPageError(null)}
              aria-label="Dismiss error"
              className="bg-none border-none text-horizon-red cursor-pointer text-base leading-none py-0 px-1"
            >
              {'\u00d7'}
            </button>
          </div>
        )}

        {/* Step content */}
        {renderCurrentStep()}

        {/* Step navigation */}
        <div className="flex justify-between py-5 pb-8 border-t border-ivory-tint">
          <button
            onClick={() => setCurrentStep((s) => Math.max(1, s - 1))}
            disabled={currentStep === 1}
            className={cn(
              'btn-primary',
              currentStep === 1 && 'opacity-40 cursor-not-allowed',
            )}
          >
            {'\u2190'} Back
          </button>
          <button
            onClick={() => setCurrentStep((s) => Math.min(STEPS.length, s + 1))}
            disabled={currentStep === STEPS.length}
            className={cn(
              'btn-primary',
              currentStep === STEPS.length && 'opacity-40 cursor-not-allowed',
            )}
          >
            Next {'\u2192'}
          </button>
        </div>
      </div>

      {editingQuestion && (
        <QuestionModal
          mode="edit"
          question={editingQuestion}
          allTags={allTags}
          onClose={() => setEditingQuestion(null)}
          onSaved={() => {
            void refetchTemplate();
            setEditingQuestion(null);
          }}
        />
      )}
    </div>
  );
}
