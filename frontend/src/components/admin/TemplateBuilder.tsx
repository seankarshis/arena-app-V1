'use client';

import React, { useState, useEffect, useRef } from 'react';
import { useQuery, useMutation, gql } from '@apollo/client';
import { cn } from '@/lib/utils';
import { StatusBadge } from '@/components/ui/StatusBadge';
import TriggerEditor, { type FollowupTrigger } from './TriggerEditor';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Tag {
  id: string;
  label: string;
}

interface Question {
  id: string;
  text: string;
  category: string;
  tags: Tag[];
}

// Raw shape from GraphQL (followupTriggers is JSON scalar → unknown)
interface RawTemplateQuestion {
  id: string;
  question: Question;
  sequenceOrder: number;
  categoryBucket: string;
  isRequired: boolean;
  followupTriggers: unknown;
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
  followupTriggers: FollowupTrigger[];
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
        followupTriggers
        question {
          id
          text
          category
          tags { id label }
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
          text
          category
          tags { id label }
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
    $followupTriggers: JSON
  ) {
    addQuestionToTemplate(
      templateId: $templateId
      questionId: $questionId
      sequenceOrder: $sequenceOrder
      categoryBucket: $categoryBucket
      isRequired: $isRequired
      followupTriggers: $followupTriggers
    ) {
      id
      sequenceOrder
      categoryBucket
      isRequired
      followupTriggers
      question { id text category tags { id label } }
    }
  }
`;

const UPDATE_TQ = gql`
  mutation BuilderUpdateTQ(
    $id: ID!
    $sequenceOrder: Int
    $categoryBucket: String
    $isRequired: Boolean
    $followupTriggers: JSON
  ) {
    updateTemplateQuestion(
      id: $id
      sequenceOrder: $sequenceOrder
      categoryBucket: $categoryBucket
      isRequired: $isRequired
      followupTriggers: $followupTriggers
    ) {
      id
      sequenceOrder
      categoryBucket
      isRequired
      followupTriggers
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

const CREATE_QUESTION = gql`
  mutation BuilderCreateQuestion($text: String!, $category: String!) {
    createQuestion(text: $text, category: $category) {
      id
      text
      category
      isActive
      tags { id label }
    }
  }
`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseTriggers(raw: unknown): FollowupTrigger[] {
  if (!Array.isArray(raw)) return [];
  return raw as FollowupTrigger[];
}

function sortedByOrder(qs: TemplateQuestion[]): TemplateQuestion[] {
  return [...qs].sort((a, b) => a.sequenceOrder - b.sequenceOrder);
}

// ---------------------------------------------------------------------------
// Step indicator
// ---------------------------------------------------------------------------

const STEPS = [
  'Template Info',
  'Select Questions',
  'Category Buckets',
  'Follow-up Triggers',
  'Required / Optional',
  'Preview',
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

  // Step 3: bucket edits
  const [bucketEdits, setBucketEdits] = useState<Record<string, string>>({});
  const [creatingBucketFor, setCreatingBucketFor] = useState<string | null>(null);
  const [newBucketValue, setNewBucketValue] = useState('');

  // Step 4: trigger editor
  const [openTriggerFor, setOpenTriggerFor] = useState<string | null>(null);
  const [savingTriggersFor, setSavingTriggersFor] = useState<string | null>(null);
  const [triggerBankDebouncedSearch, setTriggerBankDebouncedSearch] = useState('');
  const triggerBankSearchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [addingExternalQuestion, setAddingExternalQuestion] = useState(false);

  // Step 5: toggling required
  const [togglingRequired, setTogglingRequired] = useState<string | null>(null);

  // Step 6: collapsed buckets
  const [collapsedBuckets, setCollapsedBuckets] = useState<Set<string>>(new Set());

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

  // Step 4: question bank search for trigger targets
  const { data: triggerBankData, loading: triggerBankLoading } = useQuery<{
    getQuestions: QuestionConnection;
  }>(GET_ACTIVE_QUESTIONS, {
    skip: currentStep !== 4 || !triggerBankDebouncedSearch,
    variables: {
      first: 10,
      filters: { searchText: triggerBankDebouncedSearch },
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
  const [createQuestion, { loading: creatingQuestion }] = useMutation(CREATE_QUESTION);

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
        followupTriggers: parseTriggers(q.followupTriggers),
      }))
    );
    setLocalQuestions(sorted);
    const edits: Record<string, string> = {};
    for (const q of sorted) edits[q.id] = q.categoryBucket;
    setBucketEdits(edits);
  }, [templateData]);

  // ---------------------------------------------------------------------------
  // Derived
  // ---------------------------------------------------------------------------

  const template = templateData?.getTemplate ?? null;
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
          categoryBucket: q.category,
          isRequired: false,
          followupTriggers: [],
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

  const handleBucketSelect = async (tqId: string, val: string) => {
    if (val === '__new__') {
      setCreatingBucketFor(tqId);
      setNewBucketValue('');
      return;
    }
    setBucketEdits((prev) => ({ ...prev, [tqId]: val }));
    const tq = localQuestions.find((q) => q.id === tqId);
    if (!tq || tq.categoryBucket === val) return;
    try {
      await updateTQ({ variables: { id: tqId, categoryBucket: val } });
      setLocalQuestions((prev) =>
        prev.map((q) => (q.id === tqId ? { ...q, categoryBucket: val } : q))
      );
    } catch (err) {
      setPageError((err as Error).message);
      setBucketEdits((prev) => ({ ...prev, [tqId]: tq.categoryBucket }));
    }
  };

  const handleNewBucketSave = async (tqId: string) => {
    const val = newBucketValue.trim();
    if (!val) {
      setCreatingBucketFor(null);
      return;
    }
    setCreatingBucketFor(null);
    setBucketEdits((prev) => ({ ...prev, [tqId]: val }));
    const tq = localQuestions.find((q) => q.id === tqId);
    if (!tq || tq.categoryBucket === val) return;
    try {
      await updateTQ({ variables: { id: tqId, categoryBucket: val } });
      setLocalQuestions((prev) =>
        prev.map((q) => (q.id === tqId ? { ...q, categoryBucket: val } : q))
      );
    } catch (err) {
      setPageError((err as Error).message);
      setBucketEdits((prev) => ({ ...prev, [tqId]: tq.categoryBucket }));
    }
  };

  // ---------------------------------------------------------------------------
  // Step 4 handlers
  // ---------------------------------------------------------------------------

  const handleSaveTriggers = async (tqId: string, triggers: FollowupTrigger[]) => {
    setSavingTriggersFor(tqId);
    try {
      await updateTQ({ variables: { id: tqId, followupTriggers: triggers } });
      setLocalQuestions((prev) =>
        prev.map((q) => (q.id === tqId ? { ...q, followupTriggers: triggers } : q))
      );
    } catch (err) {
      setPageError((err as Error).message);
    } finally {
      setSavingTriggersFor(null);
    }
  };

  const handleTriggerBankSearch = (searchText: string) => {
    if (triggerBankSearchTimer.current) clearTimeout(triggerBankSearchTimer.current);
    triggerBankSearchTimer.current = setTimeout(() => {
      setTriggerBankDebouncedSearch(searchText);
    }, 300);
  };

  const handleSelectBankQuestion = async (
    question: { id: string; text: string; category: string },
  ): Promise<string | null> => {
    // Use ref to read latest state (avoids stale closure after create)
    const current = localQuestionsRef.current;

    // Already in template? Return existing TQ id
    const existingTQ = current.find((tq) => tq.question.id === question.id);
    if (existingTQ) return existingTQ.id;

    // Add to template as optional
    setAddingExternalQuestion(true);
    try {
      const result = await addQuestion({
        variables: {
          templateId,
          questionId: question.id,
          sequenceOrder: current.length + 1,
          categoryBucket: question.category,
          isRequired: false,
          followupTriggers: [],
        },
      });
      const newTQ = result.data.addQuestionToTemplate;
      setLocalQuestions((prev) => [
        ...prev,
        {
          id: newTQ.id,
          question: { id: question.id, text: question.text, category: question.category, tags: [] },
          sequenceOrder: prev.length + 1,
          categoryBucket: question.category,
          isRequired: false,
          followupTriggers: parseTriggers(newTQ.followupTriggers),
        },
      ]);
      return newTQ.id;
    } catch (err) {
      setPageError((err as Error).message);
      return null;
    } finally {
      setAddingExternalQuestion(false);
    }
  };

  const handleCreateQuestionForTrigger = async (
    data: { text: string; category: string },
  ): Promise<string | null> => {
    try {
      const createResult = await createQuestion({
        variables: { text: data.text, category: data.category },
      });
      const newQ = createResult.data.createQuestion;
      const current = localQuestionsRef.current;

      const addResult = await addQuestion({
        variables: {
          templateId,
          questionId: newQ.id,
          sequenceOrder: current.length + 1,
          categoryBucket: data.category,
          isRequired: false,
          followupTriggers: [],
        },
      });
      const newTQ = addResult.data.addQuestionToTemplate;
      setLocalQuestions((prev) => [
        ...prev,
        {
          id: newTQ.id,
          question: { id: newQ.id, text: newQ.text, category: newQ.category, tags: newQ.tags ?? [] },
          sequenceOrder: prev.length + 1,
          categoryBucket: data.category,
          isRequired: false,
          followupTriggers: [],
        },
      ]);
      return newTQ.id;
    } catch (err) {
      setPageError((err as Error).message);
      return null;
    }
  };

  // ---------------------------------------------------------------------------
  // Step 5 handlers
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
  // Step 7 handlers
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
                    onClick={() => !isAdded && void handleAddQuestion(q)}
                    className={cn(
                      'py-3 px-3.5 flex items-start gap-2.5 transition-colors duration-100',
                      i < bankQuestions.length - 1 && 'border-b border-ivory-tint',
                      isAdded
                        ? 'cursor-default bg-ivory-tint/35'
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
                        <span className="text-2xs text-grey italic">
                          {q.category}
                        </span>
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

  const renderStep3 = () => {
    // Collect unique bucket names from all questions + edits
    const uniqueBuckets = Array.from(
      new Set(
        localQuestions.map((tq) => bucketEdits[tq.id] ?? tq.categoryBucket).filter(Boolean)
      )
    ).sort();

    return (
      <div className="py-6">
        <p className="text-grey text-sm mb-5">
          Assign each question to a category bucket within this template. Select
          an existing bucket or create a new one. Changes save immediately.
        </p>

        {localQuestions.length === 0 ? (
          <p className="text-grey text-sm">
            No questions selected. Go to Step 2 to add questions.
          </p>
        ) : (
          <div className="bg-white rounded border border-ivory-tint overflow-hidden">
            <div className="grid grid-cols-[36px_1fr_210px] py-2.5 px-4 bg-graphite border-b border-graphite/20 gap-3">
              {['#', 'Question', 'Category Bucket'].map((h) => (
                <span key={h} className="col-header">
                  {h}
                </span>
              ))}
            </div>

            {localQuestions.map((tq, i) => {
              const currentBucket = bucketEdits[tq.id] ?? tq.categoryBucket;
              const isCreating = creatingBucketFor === tq.id;

              return (
                <div
                  key={tq.id}
                  className={cn(
                    'grid grid-cols-[36px_1fr_210px] py-3.5 px-4 items-center gap-3 transition-colors duration-100 hover:bg-horizon-red/[0.03]',
                    i < localQuestions.length - 1 && 'border-b border-ivory-tint',
                    i % 2 === 0 ? 'bg-white' : 'bg-ivory-tint',
                  )}
                >
                  <span className="text-xs text-grey font-mono">
                    {i + 1}
                  </span>
                  <p className="text-[13px] text-graphite leading-[1.4]">
                    {tq.question.text.length > 120
                      ? tq.question.text.slice(0, 120) + '\u2026'
                      : tq.question.text}
                  </p>

                  {isCreating ? (
                    <div className="flex gap-1.5">
                      <input
                        type="text"
                        value={newBucketValue}
                        onChange={(e) => setNewBucketValue(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') void handleNewBucketSave(tq.id);
                          if (e.key === 'Escape') setCreatingBucketFor(null);
                        }}
                        autoFocus
                        placeholder="New bucket name"
                        className="input-field text-[13px] py-1.5 flex-1 min-w-0"
                      />
                      <button
                        onClick={() => void handleNewBucketSave(tq.id)}
                        disabled={!newBucketValue.trim()}
                        className={cn(
                          'btn-primary py-1.5 px-2.5 text-2xs shrink-0',
                          !newBucketValue.trim() && 'opacity-50 cursor-not-allowed',
                        )}
                      >
                        Save
                      </button>
                      <button
                        onClick={() => setCreatingBucketFor(null)}
                        className="btn-ghost text-[13px] shrink-0"
                      >
                        {'\u00d7'}
                      </button>
                    </div>
                  ) : (
                    <select
                      value={currentBucket}
                      onChange={(e) => void handleBucketSelect(tq.id, e.target.value)}
                      className="select-field text-[13px]"
                    >
                      {uniqueBuckets.map((b) => (
                        <option key={b} value={b}>
                          {b}
                        </option>
                      ))}
                      {!uniqueBuckets.includes(currentBucket) && (
                        <option value={currentBucket}>{currentBucket}</option>
                      )}
                      <option value="__new__">+ Create new...</option>
                    </select>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  };

  const renderStep4 = () => (
    <div className="py-6">
      <p className="text-grey text-sm mb-5">
        Configure follow-up trigger conditions for each question. Click a question row
        to open the trigger editor.
      </p>

      {localQuestions.length === 0 ? (
        <p className="text-grey text-sm">
          No questions selected. Go to Step 2 to add questions.
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {localQuestions.map((tq, idx) => {
            const isOpen = openTriggerFor === tq.id;
            const isSavingThis = savingTriggersFor === tq.id;
            const targets = localQuestions
              .filter((q) => q.id !== tq.id)
              .map((q) => ({
                id: q.id,
                questionText: q.question.text,
                sequenceOrder:
                  localQuestions.findIndex((lq) => lq.id === q.id) + 1,
              }));

            return (
              <div
                key={tq.id}
                className={cn(
                  'bg-white rounded border overflow-hidden',
                  isOpen ? 'border-horizon-red' : 'border-ivory-tint',
                )}
              >
                <div
                  onClick={() => setOpenTriggerFor(isOpen ? null : tq.id)}
                  className={cn(
                    'flex items-center gap-3 py-3 px-4 cursor-pointer',
                    isOpen ? 'bg-horizon-red/[0.03]' : 'bg-white hover:bg-ivory',
                  )}
                >
                  <span className="text-grey text-2xs font-mono min-w-[20px] shrink-0">
                    {idx + 1}
                  </span>
                  <span className="flex-1 text-[13px] text-graphite">
                    {tq.question.text.length > 120
                      ? tq.question.text.slice(0, 120) + '\u2026'
                      : tq.question.text}
                  </span>
                  <span
                    className={cn(
                      'text-xs shrink-0',
                      tq.followupTriggers.length > 0 ? 'text-horizon-red' : 'text-grey',
                    )}
                  >
                    {tq.followupTriggers.length} trigger
                    {tq.followupTriggers.length !== 1 ? 's' : ''}
                  </span>
                  <span
                    className={cn(
                      'text-2xs',
                      isOpen ? 'text-horizon-red' : 'text-grey',
                    )}
                  >
                    {isOpen ? '\u25b2' : '\u25bc'}
                  </span>
                </div>

                {isOpen && (
                  <div className="px-4 pb-4">
                    <TriggerEditor
                      currentTriggers={tq.followupTriggers}
                      availableTargets={targets}
                      onSave={(triggers) =>
                        void handleSaveTriggers(tq.id, triggers)
                      }
                      bankResults={
                        triggerBankData?.getQuestions?.edges.map((e) => ({
                          id: e.node.id,
                          text: e.node.text,
                          category: e.node.category,
                        })) ?? []
                      }
                      bankLoading={triggerBankLoading}
                      onBankSearch={handleTriggerBankSearch}
                      onSelectBankQuestion={handleSelectBankQuestion}
                      onCreateQuestion={handleCreateQuestionForTrigger}
                      addingExternalQuestion={addingExternalQuestion}
                      creatingQuestion={creatingQuestion}
                      templateQuestionIds={addedQuestionIds}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );

  const renderStep5 = () => (
    <div className="py-6">
      {/* Summary badges */}
      <div className="flex gap-3 mb-5">
        <div className="py-2.5 px-4 rounded bg-ivory-tint border border-ivory-tint">
          <span className="font-bold text-graphite text-[15px]">
            {requiredCount}
          </span>
          <span className="text-graphite text-[13px] ml-1.5">
            Required
          </span>
        </div>
        <div className="py-2.5 px-4 rounded bg-ivory border border-ivory-tint">
          <span className="font-bold text-graphite text-[15px]">
            {optionalCount}
          </span>
          <span className="text-grey text-[13px] ml-1.5">
            Optional
          </span>
        </div>
      </div>

      {localQuestions.length === 0 ? (
        <p className="text-grey text-sm">
          No questions selected. Go to Step 2 to add questions.
        </p>
      ) : (
        <div className="bg-white rounded border border-ivory-tint overflow-hidden">
          <div className="grid grid-cols-[36px_1fr_150px] py-2.5 px-4 bg-graphite border-b border-graphite/20 gap-3">
            {['#', 'Question', 'Required?'].map((h) => (
              <span key={h} className="col-header">
                {h}
              </span>
            ))}
          </div>

          {localQuestions.map((tq, i) => {
            const isToggling = togglingRequired === tq.id;
            return (
              <div
                key={tq.id}
                className={cn(
                  'grid grid-cols-[36px_1fr_150px] py-3.5 px-4 items-center gap-3 transition-colors duration-100 hover:bg-horizon-red/[0.03]',
                  i < localQuestions.length - 1 && 'border-b border-ivory-tint',
                  i % 2 === 0 ? 'bg-white' : 'bg-ivory-tint',
                )}
              >
                <span className="text-xs text-grey font-mono">
                  {i + 1}
                </span>
                <p className="text-[13px] text-graphite leading-[1.4]">
                  {tq.question.text.length > 140
                    ? tq.question.text.slice(0, 140) + '\u2026'
                    : tq.question.text}
                </p>
                <button
                  onClick={() => void handleToggleRequired(tq.id, tq.isRequired)}
                  disabled={isToggling}
                  className={cn(
                    'py-[5px] px-3.5 rounded-md border-none text-xs font-semibold font-primary transition-all duration-150',
                    tq.isRequired
                      ? 'bg-horizon-red/10 text-horizon-red'
                      : 'bg-ivory-tint text-grey',
                    isToggling ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer',
                  )}
                >
                  {tq.isRequired ? 'Required' : 'Optional'}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );

  const renderStep6 = () => {
    // Group questions by bucket (preserve order)
    const bucketOrder: string[] = [];
    const buckets: Record<string, TemplateQuestion[]> = {};
    for (const tq of localQuestions) {
      if (!buckets[tq.categoryBucket]) {
        bucketOrder.push(tq.categoryBucket);
        buckets[tq.categoryBucket] = [];
      }
      buckets[tq.categoryBucket].push(tq);
    }

    return (
      <div className="py-6">
        <p className="text-grey text-sm mb-5">
          Review the full interview flow before publishing. Click a bucket header to
          collapse or expand it.
        </p>

        {localQuestions.length === 0 ? (
          <p className="text-grey text-sm">
            No questions in this template yet.
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            {bucketOrder.map((bucket) => {
              const qs = buckets[bucket];
              const isCollapsed = collapsedBuckets.has(bucket);

              return (
                <div
                  key={bucket}
                  className="bg-white rounded-[10px] border border-ivory-tint overflow-hidden"
                >
                  {/* Bucket header */}
                  <button
                    onClick={() => {
                      setCollapsedBuckets((prev) => {
                        const next = new Set(prev);
                        isCollapsed ? next.delete(bucket) : next.add(bucket);
                        return next;
                      });
                    }}
                    className="flex items-center justify-between w-full py-3.5 px-[18px] border-none bg-ivory cursor-pointer font-primary"
                  >
                    <span className="font-semibold text-[15px] text-graphite">
                      {bucket}
                    </span>
                    <span className="flex items-center gap-3">
                      <span className="text-xs text-grey">
                        {qs.length} question{qs.length !== 1 ? 's' : ''}
                      </span>
                      <span className="text-grey text-2xs">
                        {isCollapsed ? '\u25b6' : '\u25bc'}
                      </span>
                    </span>
                  </button>

                  {/* Bucket questions */}
                  {!isCollapsed &&
                    qs.map((tq) => {
                      const seqNum = localQuestions.findIndex((q) => q.id === tq.id) + 1;
                      return (
                        <div
                          key={tq.id}
                          className="py-3.5 px-[18px] border-t border-ivory-tint"
                        >
                          <div
                            className={cn(
                              'flex items-start gap-2.5',
                              tq.followupTriggers.length > 0 && 'mb-2.5',
                            )}
                          >
                            <span className="text-2xs text-grey font-mono min-w-[24px] mt-[3px] shrink-0">
                              #{seqNum}
                            </span>
                            <div className="flex-1">
                              <p className="text-sm text-graphite leading-normal mb-1.5">
                                {tq.question.text}
                              </p>
                              <span
                                className={cn(
                                  'text-2xs py-0.5 px-2 rounded-pill font-semibold',
                                  tq.isRequired
                                    ? 'bg-horizon-red/10 text-horizon-red'
                                    : 'bg-ivory-tint text-grey',
                                )}
                              >
                                {tq.isRequired ? 'Required' : 'Optional'}
                              </span>
                            </div>
                          </div>

                          {tq.followupTriggers.length > 0 && (
                            <div className="ml-[34px] flex flex-col gap-[5px]">
                              {tq.followupTriggers.map((trigger, ti) => {
                                const targetTexts = trigger.targetTemplateQuestionIds
                                  .map((id) => {
                                    const found = localQuestions.find(
                                      (q) => q.id === id
                                    );
                                    if (!found) return null;
                                    const txt = found.question.text;
                                    return txt.length > 50
                                      ? txt.slice(0, 50) + '\u2026'
                                      : txt;
                                  })
                                  .filter((s): s is string => s !== null);

                                return (
                                  <div
                                    key={ti}
                                    className="text-xs text-grey py-1.5 px-2.5 rounded-md bg-ivory border border-ivory-tint"
                                  >
                                    <strong className="capitalize text-graphite">
                                      {trigger.type}
                                    </strong>
                                    {trigger.type === 'keyword' &&
                                      trigger.keywords &&
                                      ` \u2014 "${trigger.keywords}"`}
                                    {trigger.type === 'sentiment' &&
                                      trigger.sentiment &&
                                      ` \u2014 ${trigger.sentiment}`}
                                    {trigger.type === 'length' &&
                                      trigger.lengthDescription &&
                                      ` \u2014 ${trigger.lengthDescription}`}
                                    {targetTexts.length > 0 && (
                                      <span className="block mt-[3px] text-grey text-2xs">
                                        {'\u2192'} {targetTexts.join(', ')}
                                      </span>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      );
                    })}
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  };

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
      case 4: return renderStep4();
      case 5: return renderStep5();
      case 6: return renderStep6();
      case 7: return renderStep7();
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
            onClick={() => setCurrentStep((s) => Math.min(7, s + 1))}
            disabled={currentStep === 7}
            className={cn(
              'btn-primary',
              currentStep === 7 && 'opacity-40 cursor-not-allowed',
            )}
          >
            Next {'\u2192'}
          </button>
        </div>
      </div>
    </div>
  );
}
