'use client';

import React, { useState, useEffect, useRef } from 'react';
import { useQuery, useMutation, gql } from '@apollo/client';
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
// Shared button / input styles
// ---------------------------------------------------------------------------

const primaryBtn: React.CSSProperties = {
  padding: '10px 20px',
  borderRadius: 8,
  border: 'none',
  backgroundColor: 'var(--horizon-red)',
  color: 'var(--white)',
  fontFamily: 'var(--font-primary)',
  fontWeight: 600,
  fontSize: 14,
  cursor: 'pointer',
};

const secondaryBtn: React.CSSProperties = {
  padding: '10px 20px',
  borderRadius: 8,
  border: '1px solid var(--ivory-tint)',
  backgroundColor: 'var(--white)',
  color: 'var(--graphite)',
  fontFamily: 'var(--font-primary)',
  fontWeight: 500,
  fontSize: 14,
  cursor: 'pointer',
};

const inputStyle: React.CSSProperties = {
  padding: '10px 14px',
  borderRadius: 8,
  border: '1px solid var(--ivory-tint)',
  backgroundColor: 'var(--ivory-tint)',
  fontFamily: 'var(--font-primary)',
  fontSize: 14,
  color: 'var(--graphite)',
  outline: 'none',
  width: '100%',
};

const colHeader: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  color: 'var(--grey)',
  textTransform: 'uppercase',
  letterSpacing: '0.07em',
};

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
    <div
      style={{
        display: 'flex',
        borderBottom: '2px solid var(--ivory-tint)',
        backgroundColor: 'var(--white)',
        overflowX: 'auto',
      }}
    >
      {STEPS.map((label, i) => {
        const step = i + 1;
        const active = step === current;
        const past = step < current;
        return (
          <button
            key={step}
            onClick={() => onSelect(step)}
            style={{
              padding: '14px 18px',
              border: 'none',
              borderBottom: active
                ? '2px solid var(--horizon-red)'
                : '2px solid transparent',
              backgroundColor: 'transparent',
              fontFamily: 'var(--font-primary)',
              fontSize: 13,
              fontWeight: active ? 600 : 400,
              color: active
                ? 'var(--horizon-red)'
                : past
                ? 'var(--graphite)'
                : 'var(--grey)',
              cursor: 'pointer',
              whiteSpace: 'nowrap',
              marginBottom: -2,
              display: 'flex',
              alignItems: 'center',
              gap: 7,
            }}
          >
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 20,
                height: 20,
                borderRadius: '50%',
                fontSize: 11,
                fontWeight: 700,
                backgroundColor: active
                  ? 'var(--horizon-red)'
                  : past
                  ? '#DCFCE7'
                  : 'var(--ivory-tint)',
                color: active ? 'var(--white)' : past ? '#15803D' : 'var(--grey)',
                flexShrink: 0,
              }}
            >
              {past ? '✓' : step}
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

  const handleBucketChange = (tqId: string, val: string) => {
    setBucketEdits((prev) => ({ ...prev, [tqId]: val }));
  };

  const handleBucketBlur = async (tqId: string) => {
    const newBucket = (bucketEdits[tqId] ?? '').trim();
    if (!newBucket) return;
    const tq = localQuestions.find((q) => q.id === tqId);
    if (!tq || tq.categoryBucket === newBucket) return;
    try {
      await updateTQ({ variables: { id: tqId, categoryBucket: newBucket } });
      setLocalQuestions((prev) =>
        prev.map((q) => (q.id === tqId ? { ...q, categoryBucket: newBucket } : q))
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
    <div style={{ maxWidth: 580, padding: '32px 0' }}>
      <div style={{ marginBottom: 20 }}>
        <label
          style={{
            display: 'block',
            fontWeight: 500,
            fontSize: 14,
            color: 'var(--graphite)',
            marginBottom: 6,
          }}
        >
          Template Name *
        </label>
        <input
          type="text"
          value={localName}
          onChange={(e) => setLocalName(e.target.value)}
          style={inputStyle}
          placeholder="e.g. Senior Engineer Interview — Q2 2026"
        />
      </div>

      <div style={{ marginBottom: 24 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
          <label
            style={{
              fontWeight: 500,
              fontSize: 14,
              color: 'var(--graphite)',
            }}
          >
            Description
          </label>
          <span style={{ position: 'relative', display: 'inline-flex' }}>
            <span
              onMouseEnter={(e) => {
                const tip = (e.currentTarget.nextSibling as HTMLElement);
                if (tip) tip.style.display = 'block';
              }}
              onMouseLeave={(e) => {
                const tip = (e.currentTarget.nextSibling as HTMLElement);
                if (tip) tip.style.display = 'none';
              }}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 16,
                height: 16,
                borderRadius: '50%',
                border: '1px solid var(--graphite)',
                fontSize: 10,
                fontWeight: 600,
                color: 'var(--graphite)',
                cursor: 'default',
                flexShrink: 0,
                userSelect: 'none',
              }}
            >
              ?
            </span>
            <span
              style={{
                display: 'none',
                position: 'absolute',
                left: 22,
                top: '50%',
                transform: 'translateY(-50%)',
                backgroundColor: '#1f2937',
                color: '#f9fafb',
                fontSize: 12,
                lineHeight: 1.5,
                padding: '6px 10px',
                borderRadius: 6,
                width: 260,
                whiteSpace: 'normal',
                zIndex: 100,
                pointerEvents: 'none',
                boxShadow: '0 2px 8px rgba(0,0,0,0.25)',
              }}
            >
              Shown to interviewees before the interview starts. Briefly explain what to expect so they feel prepared and confident.
            </span>
          </span>
        </div>
        <textarea
          value={localDescription}
          onChange={(e) => setLocalDescription(e.target.value)}
          rows={4}
          style={{ ...inputStyle, resize: 'vertical' }}
          placeholder="Describe the purpose and scope of this interview template…"
        />
      </div>

      <div style={{ marginBottom: 24 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
          <label
            style={{
              fontWeight: 500,
              fontSize: 14,
              color: 'var(--graphite)',
            }}
          >
            System Prompt
          </label>
          <span style={{ position: 'relative', display: 'inline-flex' }}>
            <span
              onMouseEnter={(e) => {
                const tip = (e.currentTarget.nextSibling as HTMLElement);
                if (tip) tip.style.display = 'block';
              }}
              onMouseLeave={(e) => {
                const tip = (e.currentTarget.nextSibling as HTMLElement);
                if (tip) tip.style.display = 'none';
              }}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 16,
                height: 16,
                borderRadius: '50%',
                border: '1px solid var(--graphite)',
                fontSize: 10,
                fontWeight: 600,
                color: 'var(--graphite)',
                cursor: 'default',
                flexShrink: 0,
                userSelect: 'none',
              }}
            >
              ?
            </span>
            <span
              style={{
                display: 'none',
                position: 'absolute',
                left: 22,
                top: '50%',
                transform: 'translateY(-50%)',
                backgroundColor: '#1f2937',
                color: '#f9fafb',
                fontSize: 12,
                lineHeight: 1.5,
                padding: '6px 10px',
                borderRadius: 6,
                width: 260,
                whiteSpace: 'normal',
                zIndex: 100,
                pointerEvents: 'none',
                boxShadow: '0 2px 8px rgba(0,0,0,0.25)',
              }}
            >
              This prompt defines the LLM&apos;s behavior for this template — setting its tone, rules, and interviewing style. It runs before every interview session.
            </span>
          </span>
        </div>
        <textarea
          value={localSystemPrompt}
          onChange={(e) => setLocalSystemPrompt(e.target.value)}
          rows={8}
          style={{ ...inputStyle, resize: 'vertical' }}
          placeholder="Instructions passed to the AI interviewer to guide voice, tone, and structure…"
        />
      </div>

      {infoSaveError && (
        <p
          style={{
            color: 'var(--horizon-red)',
            fontSize: 14,
            marginBottom: 12,
            padding: '8px 12px',
            backgroundColor: '#FEE2E2',
            borderRadius: 6,
          }}
        >
          {infoSaveError}
        </p>
      )}
      {infoSaved && (
        <p
          style={{
            color: '#15803D',
            fontSize: 14,
            marginBottom: 12,
            padding: '8px 12px',
            backgroundColor: '#DCFCE7',
            borderRadius: 6,
          }}
        >
          Template info saved.
        </p>
      )}

      <button
        onClick={() => void handleSaveInfo()}
        disabled={updatingTemplate || !localName.trim()}
        style={{
          ...primaryBtn,
          opacity: updatingTemplate || !localName.trim() ? 0.5 : 1,
          cursor: updatingTemplate || !localName.trim() ? 'not-allowed' : 'pointer',
        }}
      >
        {updatingTemplate ? 'Saving…' : 'Save Info'}
      </button>
    </div>
  );

  const renderStep2 = () => (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '1fr 1fr',
        gap: 24,
        padding: '24px 0',
      }}
    >
      {/* Left: Question Bank */}
      <div>
        <h3
          style={{
            fontFamily: 'var(--font-primary)',
            fontWeight: 600,
            fontSize: 16,
            color: 'var(--graphite)',
            marginBottom: 12,
          }}
        >
          Question Bank
        </h3>

        <input
          type="search"
          value={bankSearch}
          onChange={(e) => handleBankSearchChange(e.target.value)}
          placeholder="Search questions…"
          style={{ ...inputStyle, marginBottom: 12 }}
          aria-label="Search question bank"
        />

        {bankLoading && bankQuestions.length === 0 ? (
          <p style={{ color: 'var(--grey)', fontSize: 14 }}>Loading…</p>
        ) : bankQuestions.length === 0 ? (
          <p style={{ color: 'var(--grey)', fontSize: 14 }}>
            No active questions found.
          </p>
        ) : (
          <>
            <p style={{ color: 'var(--grey)', fontSize: 12, marginBottom: 8 }}>
              {bankTotalCount} question{bankTotalCount !== 1 ? 's' : ''}
              {bankDebouncedSearch ? ` matching "${bankDebouncedSearch}"` : ''}
              {addingQuestion && (
                <span style={{ marginLeft: 8, fontStyle: 'italic' }}>Adding…</span>
              )}
            </p>

            <div
              style={{
                border: '1px solid var(--ivory-tint)',
                borderRadius: 8,
                maxHeight: 440,
                overflowY: 'auto',
                backgroundColor: 'var(--white)',
              }}
            >
              {bankQuestions.map((q, i) => {
                const isAdded = addedQuestionIds.has(q.id);
                return (
                  <div
                    key={q.id}
                    onClick={() => !isAdded && void handleAddQuestion(q)}
                    style={{
                      padding: '12px 14px',
                      borderBottom:
                        i < bankQuestions.length - 1
                          ? '1px solid var(--ivory-tint)'
                          : 'none',
                      display: 'flex',
                      alignItems: 'flex-start',
                      gap: 10,
                      cursor: isAdded ? 'default' : 'pointer',
                      backgroundColor: isAdded
                        ? 'rgba(236,234,222,0.35)'
                        : 'var(--white)',
                    }}
                  >
                    <div
                      style={{
                        width: 18,
                        height: 18,
                        borderRadius: 4,
                        border: isAdded ? 'none' : '1.5px solid var(--ivory-tint)',
                        backgroundColor: isAdded ? '#DCFCE7' : 'var(--white)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontSize: 11,
                        color: '#15803D',
                        flexShrink: 0,
                        marginTop: 2,
                      }}
                    >
                      {isAdded ? '✓' : ''}
                    </div>
                    <div>
                      <p
                        style={{
                          fontSize: 13,
                          color: 'var(--graphite)',
                          lineHeight: 1.5,
                          marginBottom: 4,
                        }}
                      >
                        {q.text.length > 110 ? q.text.slice(0, 110) + '…' : q.text}
                      </p>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        <span
                          style={{
                            fontSize: 11,
                            color: 'var(--grey)',
                            fontStyle: 'italic',
                          }}
                        >
                          {q.category}
                        </span>
                        {q.tags.slice(0, 3).map((t) => (
                          <span
                            key={t.id}
                            style={{
                              fontSize: 10,
                              padding: '1px 7px',
                              borderRadius: 999,
                              backgroundColor: 'var(--ivory-tint)',
                              color: 'var(--grey)',
                            }}
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
                style={{
                  ...secondaryBtn,
                  marginTop: 10,
                  fontSize: 13,
                  padding: '8px 16px',
                }}
              >
                Load more
              </button>
            )}
          </>
        )}
      </div>

      {/* Right: Selected Questions with DnD */}
      <div>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 12,
          }}
        >
          <h3
            style={{
              fontFamily: 'var(--font-primary)',
              fontWeight: 600,
              fontSize: 16,
              color: 'var(--graphite)',
            }}
          >
            Selected Questions
          </h3>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            {isSavingOrder && (
              <span style={{ color: 'var(--grey)', fontSize: 12 }}>
                Saving order…
              </span>
            )}
            <span style={{ color: 'var(--grey)', fontSize: 13 }}>
              {localQuestions.length} selected
            </span>
          </div>
        </div>

        {localQuestions.length === 0 ? (
          <div
            style={{
              border: '2px dashed var(--ivory-tint)',
              borderRadius: 8,
              padding: '48px 24px',
              textAlign: 'center',
              color: 'var(--grey)',
              fontSize: 14,
            }}
          >
            Click questions in the bank to add them here.
          </div>
        ) : (
          <div
            style={{
              border: '1px solid var(--ivory-tint)',
              borderRadius: 8,
              backgroundColor: 'var(--white)',
              maxHeight: 500,
              overflowY: 'auto',
            }}
          >
            {localQuestions.map((tq, idx) => (
              <div
                key={tq.id}
                draggable
                onDragStart={() => handleDragStart(idx)}
                onDragOver={(e) => handleDragOver(e, idx)}
                onDrop={() => void handleDrop(idx)}
                onDragEnd={handleDragEnd}
                style={{
                  padding: '10px 12px',
                  borderBottom:
                    idx < localQuestions.length - 1
                      ? '1px solid var(--ivory-tint)'
                      : 'none',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  cursor: 'grab',
                  backgroundColor:
                    dragOverIdx === idx
                      ? 'rgba(122,14,19,0.04)'
                      : 'var(--white)',
                  borderLeft:
                    dragOverIdx === idx
                      ? '2px solid var(--horizon-red)'
                      : '2px solid transparent',
                }}
              >
                <span
                  style={{
                    color: 'var(--grey)',
                    fontSize: 14,
                    flexShrink: 0,
                    userSelect: 'none',
                  }}
                >
                  ⠿
                </span>
                <span
                  style={{
                    color: 'var(--grey)',
                    fontSize: 11,
                    minWidth: 20,
                    flexShrink: 0,
                    fontFamily: 'var(--font-mono)',
                  }}
                >
                  {idx + 1}
                </span>
                <span
                  style={{
                    flex: 1,
                    fontSize: 13,
                    color: 'var(--graphite)',
                    lineHeight: 1.4,
                  }}
                >
                  {tq.question.text.length > 80
                    ? tq.question.text.slice(0, 80) + '…'
                    : tq.question.text}
                </span>
                <button
                  onClick={() => void handleRemoveQuestion(tq.id)}
                  aria-label="Remove question"
                  title="Remove from template"
                  style={{
                    background: 'none',
                    border: 'none',
                    color: 'var(--grey)',
                    cursor: 'pointer',
                    fontSize: 16,
                    padding: '0 4px',
                    flexShrink: 0,
                    lineHeight: 1,
                  }}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );

  const renderStep3 = () => (
    <div style={{ padding: '24px 0' }}>
      <p style={{ color: 'var(--grey)', fontSize: 14, marginBottom: 20 }}>
        Assign each question to a category bucket within this template. Buckets may
        differ from a question&apos;s master category. Changes save on field blur.
      </p>

      {localQuestions.length === 0 ? (
        <p style={{ color: 'var(--grey)', fontSize: 14 }}>
          No questions selected. Go to Step 2 to add questions.
        </p>
      ) : (
        <div
          style={{
            backgroundColor: 'var(--white)',
            borderRadius: 12,
            border: '1px solid var(--ivory-tint)',
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '36px 1fr 210px',
              padding: '10px 16px',
              backgroundColor: 'var(--ivory)',
              borderBottom: '1px solid var(--ivory-tint)',
              gap: 12,
            }}
          >
            {['#', 'Question', 'Category Bucket'].map((h) => (
              <span key={h} style={colHeader}>
                {h}
              </span>
            ))}
          </div>

          {localQuestions.map((tq, i) => (
            <div
              key={tq.id}
              style={{
                display: 'grid',
                gridTemplateColumns: '36px 1fr 210px',
                padding: '14px 16px',
                borderBottom:
                  i < localQuestions.length - 1
                    ? '1px solid var(--ivory-tint)'
                    : 'none',
                alignItems: 'center',
                gap: 12,
              }}
            >
              <span
                style={{
                  fontSize: 12,
                  color: 'var(--grey)',
                  fontFamily: 'var(--font-mono)',
                }}
              >
                {i + 1}
              </span>
              <p
                style={{ fontSize: 13, color: 'var(--graphite)', lineHeight: 1.4 }}
              >
                {tq.question.text.length > 120
                  ? tq.question.text.slice(0, 120) + '…'
                  : tq.question.text}
              </p>
              <input
                type="text"
                value={bucketEdits[tq.id] ?? tq.categoryBucket}
                onChange={(e) => handleBucketChange(tq.id, e.target.value)}
                onBlur={() => void handleBucketBlur(tq.id)}
                placeholder="e.g. Behavioral"
                style={{
                  padding: '7px 10px',
                  borderRadius: 6,
                  border: '1px solid var(--ivory-tint)',
                  backgroundColor: 'var(--ivory-tint)',
                  fontFamily: 'var(--font-primary)',
                  fontSize: 13,
                  color: 'var(--graphite)',
                  outline: 'none',
                  width: '100%',
                }}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );

  const renderStep4 = () => (
    <div style={{ padding: '24px 0' }}>
      <p style={{ color: 'var(--grey)', fontSize: 14, marginBottom: 20 }}>
        Configure follow-up trigger conditions for each question. Click a question row
        to open the trigger editor.
      </p>

      {localQuestions.length === 0 ? (
        <p style={{ color: 'var(--grey)', fontSize: 14 }}>
          No questions selected. Go to Step 2 to add questions.
        </p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
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
                style={{
                  backgroundColor: 'var(--white)',
                  borderRadius: 8,
                  border: isOpen
                    ? '1px solid var(--horizon-red)'
                    : '1px solid var(--ivory-tint)',
                  overflow: 'hidden',
                }}
              >
                <div
                  onClick={() => setOpenTriggerFor(isOpen ? null : tq.id)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                    padding: '12px 16px',
                    cursor: 'pointer',
                    backgroundColor: isOpen
                      ? 'rgba(122,14,19,0.03)'
                      : 'var(--white)',
                  }}
                >
                  <span
                    style={{
                      color: 'var(--grey)',
                      fontSize: 11,
                      fontFamily: 'var(--font-mono)',
                      minWidth: 20,
                      flexShrink: 0,
                    }}
                  >
                    {idx + 1}
                  </span>
                  <span
                    style={{ flex: 1, fontSize: 13, color: 'var(--graphite)' }}
                  >
                    {tq.question.text.length > 120
                      ? tq.question.text.slice(0, 120) + '…'
                      : tq.question.text}
                  </span>
                  <span
                    style={{
                      fontSize: 12,
                      color:
                        tq.followupTriggers.length > 0
                          ? 'var(--horizon-red)'
                          : 'var(--grey)',
                      flexShrink: 0,
                    }}
                  >
                    {tq.followupTriggers.length} trigger
                    {tq.followupTriggers.length !== 1 ? 's' : ''}
                  </span>
                  <span
                    style={{
                      color: isOpen ? 'var(--horizon-red)' : 'var(--grey)',
                      fontSize: 11,
                    }}
                  >
                    {isOpen ? '▲' : '▼'}
                  </span>
                </div>

                {isOpen && (
                  <div style={{ padding: '0 16px 16px' }}>
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
    <div style={{ padding: '24px 0' }}>
      {/* Summary badges */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 20 }}>
        <div
          style={{
            padding: '10px 16px',
            borderRadius: 8,
            backgroundColor: '#DCFCE7',
            border: '1px solid #BBF7D0',
          }}
        >
          <span style={{ fontWeight: 700, color: '#15803D', fontSize: 15 }}>
            {requiredCount}
          </span>
          <span style={{ color: '#15803D', fontSize: 13, marginLeft: 6 }}>
            Required
          </span>
        </div>
        <div
          style={{
            padding: '10px 16px',
            borderRadius: 8,
            backgroundColor: 'var(--ivory)',
            border: '1px solid var(--ivory-tint)',
          }}
        >
          <span
            style={{ fontWeight: 700, color: 'var(--graphite)', fontSize: 15 }}
          >
            {optionalCount}
          </span>
          <span style={{ color: 'var(--grey)', fontSize: 13, marginLeft: 6 }}>
            Optional
          </span>
        </div>
      </div>

      {localQuestions.length === 0 ? (
        <p style={{ color: 'var(--grey)', fontSize: 14 }}>
          No questions selected. Go to Step 2 to add questions.
        </p>
      ) : (
        <div
          style={{
            backgroundColor: 'var(--white)',
            borderRadius: 12,
            border: '1px solid var(--ivory-tint)',
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '36px 1fr 150px',
              padding: '10px 16px',
              backgroundColor: 'var(--ivory)',
              borderBottom: '1px solid var(--ivory-tint)',
              gap: 12,
            }}
          >
            {['#', 'Question', 'Required?'].map((h) => (
              <span key={h} style={colHeader}>
                {h}
              </span>
            ))}
          </div>

          {localQuestions.map((tq, i) => {
            const isToggling = togglingRequired === tq.id;
            return (
              <div
                key={tq.id}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '36px 1fr 150px',
                  padding: '14px 16px',
                  borderBottom:
                    i < localQuestions.length - 1
                      ? '1px solid var(--ivory-tint)'
                      : 'none',
                  alignItems: 'center',
                  gap: 12,
                }}
              >
                <span
                  style={{
                    fontSize: 12,
                    color: 'var(--grey)',
                    fontFamily: 'var(--font-mono)',
                  }}
                >
                  {i + 1}
                </span>
                <p
                  style={{ fontSize: 13, color: 'var(--graphite)', lineHeight: 1.4 }}
                >
                  {tq.question.text.length > 140
                    ? tq.question.text.slice(0, 140) + '…'
                    : tq.question.text}
                </p>
                <button
                  onClick={() => void handleToggleRequired(tq.id, tq.isRequired)}
                  disabled={isToggling}
                  style={{
                    padding: '5px 14px',
                    borderRadius: 999,
                    border: 'none',
                    fontSize: 12,
                    fontWeight: 600,
                    cursor: isToggling ? 'not-allowed' : 'pointer',
                    backgroundColor: tq.isRequired ? '#DCFCE7' : 'var(--ivory-tint)',
                    color: tq.isRequired ? '#15803D' : 'var(--grey)',
                    fontFamily: 'var(--font-primary)',
                    opacity: isToggling ? 0.6 : 1,
                    transition: 'all 0.15s',
                  }}
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
      <div style={{ padding: '24px 0' }}>
        <p style={{ color: 'var(--grey)', fontSize: 14, marginBottom: 20 }}>
          Review the full interview flow before publishing. Click a bucket header to
          collapse or expand it.
        </p>

        {localQuestions.length === 0 ? (
          <p style={{ color: 'var(--grey)', fontSize: 14 }}>
            No questions in this template yet.
          </p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {bucketOrder.map((bucket) => {
              const qs = buckets[bucket];
              const isCollapsed = collapsedBuckets.has(bucket);

              return (
                <div
                  key={bucket}
                  style={{
                    backgroundColor: 'var(--white)',
                    borderRadius: 10,
                    border: '1px solid var(--ivory-tint)',
                    overflow: 'hidden',
                  }}
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
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      width: '100%',
                      padding: '14px 18px',
                      border: 'none',
                      backgroundColor: 'var(--ivory)',
                      cursor: 'pointer',
                      fontFamily: 'var(--font-primary)',
                    }}
                  >
                    <span
                      style={{
                        fontWeight: 600,
                        fontSize: 15,
                        color: 'var(--graphite)',
                      }}
                    >
                      {bucket}
                    </span>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                      <span style={{ fontSize: 12, color: 'var(--grey)' }}>
                        {qs.length} question{qs.length !== 1 ? 's' : ''}
                      </span>
                      <span style={{ color: 'var(--grey)', fontSize: 11 }}>
                        {isCollapsed ? '▶' : '▼'}
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
                          style={{ padding: '14px 18px', borderTop: '1px solid var(--ivory-tint)' }}
                        >
                          <div
                            style={{
                              display: 'flex',
                              alignItems: 'flex-start',
                              gap: 10,
                              marginBottom:
                                tq.followupTriggers.length > 0 ? 10 : 0,
                            }}
                          >
                            <span
                              style={{
                                fontSize: 11,
                                color: 'var(--grey)',
                                fontFamily: 'var(--font-mono)',
                                minWidth: 24,
                                marginTop: 3,
                                flexShrink: 0,
                              }}
                            >
                              #{seqNum}
                            </span>
                            <div style={{ flex: 1 }}>
                              <p
                                style={{
                                  fontSize: 14,
                                  color: 'var(--graphite)',
                                  lineHeight: 1.5,
                                  marginBottom: 6,
                                }}
                              >
                                {tq.question.text}
                              </p>
                              <span
                                style={{
                                  fontSize: 11,
                                  padding: '2px 9px',
                                  borderRadius: 999,
                                  backgroundColor: tq.isRequired
                                    ? '#DCFCE7'
                                    : 'var(--ivory-tint)',
                                  color: tq.isRequired ? '#15803D' : 'var(--grey)',
                                  fontWeight: 600,
                                }}
                              >
                                {tq.isRequired ? 'Required' : 'Optional'}
                              </span>
                            </div>
                          </div>

                          {tq.followupTriggers.length > 0 && (
                            <div
                              style={{
                                marginLeft: 34,
                                display: 'flex',
                                flexDirection: 'column',
                                gap: 5,
                              }}
                            >
                              {tq.followupTriggers.map((trigger, ti) => {
                                const targetTexts = trigger.targetTemplateQuestionIds
                                  .map((id) => {
                                    const found = localQuestions.find(
                                      (q) => q.id === id
                                    );
                                    if (!found) return null;
                                    const txt = found.question.text;
                                    return txt.length > 50
                                      ? txt.slice(0, 50) + '…'
                                      : txt;
                                  })
                                  .filter((s): s is string => s !== null);

                                return (
                                  <div
                                    key={ti}
                                    style={{
                                      fontSize: 12,
                                      color: 'var(--grey)',
                                      padding: '6px 10px',
                                      borderRadius: 6,
                                      backgroundColor: 'var(--ivory)',
                                      border: '1px solid var(--ivory-tint)',
                                    }}
                                  >
                                    <strong
                                      style={{
                                        textTransform: 'capitalize',
                                        color: 'var(--graphite)',
                                      }}
                                    >
                                      {trigger.type}
                                    </strong>
                                    {trigger.type === 'keyword' &&
                                      trigger.keywords &&
                                      ` — "${trigger.keywords}"`}
                                    {trigger.type === 'sentiment' &&
                                      trigger.sentiment &&
                                      ` — ${trigger.sentiment}`}
                                    {trigger.type === 'length' &&
                                      trigger.lengthDescription &&
                                      ` — ${trigger.lengthDescription}`}
                                    {targetTexts.length > 0 && (
                                      <span
                                        style={{
                                          display: 'block',
                                          marginTop: 3,
                                          color: 'var(--grey)',
                                          fontSize: 11,
                                        }}
                                      >
                                        → {targetTexts.join(', ')}
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
      <div style={{ maxWidth: 560, padding: '32px 0' }}>
        {/* Status */}
        <div style={{ marginBottom: 24 }}>
          <span
            style={{
              fontSize: 12,
              fontWeight: 600,
              color: 'var(--grey)',
              textTransform: 'uppercase',
              letterSpacing: '0.07em',
              marginRight: 10,
            }}
          >
            Current status:
          </span>
          <span
            style={{
              padding: '4px 12px',
              borderRadius: 999,
              fontSize: 13,
              fontWeight: 600,
              backgroundColor: isPublished
                ? '#DCFCE7'
                : isArchived
                ? '#F3F4F6'
                : '#FEF3C7',
              color: isPublished
                ? '#15803D'
                : isArchived
                ? '#6B7280'
                : '#92400E',
            }}
          >
            {status.charAt(0).toUpperCase() + status.slice(1)}
          </span>
        </div>

        {/* Summary card */}
        <div
          style={{
            backgroundColor: 'var(--white)',
            borderRadius: 10,
            border: '1px solid var(--ivory-tint)',
            padding: '20px 24px',
            marginBottom: 24,
          }}
        >
          <p
            style={{
              fontWeight: 600,
              fontSize: 15,
              color: 'var(--graphite)',
              marginBottom: template?.description ? 6 : 14,
            }}
          >
            {template?.name}
          </p>
          {template?.description && (
            <p
              style={{
                fontSize: 13,
                color: 'var(--grey)',
                marginBottom: 14,
                lineHeight: 1.5,
              }}
            >
              {template.description}
            </p>
          )}
          <div style={{ display: 'flex', gap: 24 }}>
            <div>
              <span
                style={{
                  fontSize: 22,
                  fontWeight: 700,
                  color: 'var(--graphite)',
                }}
              >
                {localQuestions.length}
              </span>
              <span style={{ fontSize: 13, color: 'var(--grey)', marginLeft: 6 }}>
                questions
              </span>
            </div>
            <div>
              <span style={{ fontSize: 22, fontWeight: 700, color: '#15803D' }}>
                {requiredCount}
              </span>
              <span style={{ fontSize: 13, color: 'var(--grey)', marginLeft: 6 }}>
                required
              </span>
            </div>
            <div>
              <span
                style={{ fontSize: 22, fontWeight: 700, color: 'var(--grey)' }}
              >
                {optionalCount}
              </span>
              <span style={{ fontSize: 13, color: 'var(--grey)', marginLeft: 6 }}>
                optional
              </span>
            </div>
          </div>
        </div>

        {publishError && (
          <div
            style={{
              backgroundColor: '#FEE2E2',
              border: '1px solid #FCA5A5',
              borderRadius: 8,
              padding: '12px 16px',
              marginBottom: 16,
              color: '#B91C1C',
              fontSize: 14,
            }}
          >
            {publishError}
          </div>
        )}

        {isDraft && (
          <div>
            {localQuestions.length === 0 && (
              <div
                style={{
                  backgroundColor: '#FEF3C7',
                  border: '1px solid #FDE68A',
                  borderRadius: 8,
                  padding: '10px 14px',
                  color: '#92400E',
                  fontSize: 13,
                  marginBottom: 16,
                }}
              >
                <strong>Warning:</strong> This template has no questions. Add at
                least one question in Step 2 before publishing.
              </div>
            )}
            <button
              onClick={() => void handlePublish()}
              disabled={isPublishing || localQuestions.length === 0}
              style={{
                ...primaryBtn,
                opacity:
                  isPublishing || localQuestions.length === 0 ? 0.5 : 1,
                cursor:
                  isPublishing || localQuestions.length === 0
                    ? 'not-allowed'
                    : 'pointer',
              }}
            >
              {isPublishing ? 'Publishing…' : 'Publish Template'}
            </button>
          </div>
        )}

        {isPublished && (
          <div>
            <p
              style={{
                color: 'var(--grey)',
                fontSize: 13,
                marginBottom: 16,
                lineHeight: 1.6,
              }}
            >
              This template is live and can be assigned to users. You can
              continue editing at any time — changes take effect for new
              interviews.
            </p>
            <button
              onClick={() => void handleArchive()}
              disabled={isPublishing}
              style={{
                ...secondaryBtn,
                border: '1px solid #FCA5A5',
                color: '#B91C1C',
                opacity: isPublishing ? 0.5 : 1,
                cursor: isPublishing ? 'not-allowed' : 'pointer',
              }}
            >
              {isPublishing ? 'Archiving…' : 'Archive Template'}
            </button>
          </div>
        )}

        {isArchived && (
          <div>
            <p
              style={{
                color: 'var(--grey)',
                fontSize: 13,
                marginBottom: 16,
                lineHeight: 1.6,
              }}
            >
              This template is archived and cannot be assigned to new users.
              Re-publish to make it available again.
            </p>
            <button
              onClick={() => void handlePublish()}
              disabled={isPublishing}
              style={{
                ...primaryBtn,
                opacity: isPublishing ? 0.5 : 1,
                cursor: isPublishing ? 'not-allowed' : 'pointer',
              }}
            >
              {isPublishing ? 'Publishing…' : 'Re-publish Template'}
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
      <div
        style={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: 'var(--ivory)',
          fontFamily: 'var(--font-primary)',
        }}
      >
        <p style={{ color: 'var(--grey)', fontSize: 15 }}>Loading template…</p>
      </div>
    );
  }

  if (templateError || !template) {
    return (
      <div
        style={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: 'var(--ivory)',
          fontFamily: 'var(--font-primary)',
        }}
      >
        <p style={{ color: 'var(--horizon-red)', fontSize: 15 }}>
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
    <div
      style={{
        minHeight: '100vh',
        backgroundColor: 'var(--ivory)',
        fontFamily: 'var(--font-primary)',
      }}
    >
      {/* Page header */}
      <header
        style={{
          padding: '20px 32px',
          borderBottom: '1px solid var(--ivory-tint)',
          backgroundColor: 'var(--white)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 16,
        }}
      >
        <div>
          <h2
            style={{
              fontFamily: 'var(--font-primary)',
              fontWeight: 600,
              fontSize: 22,
              color: 'var(--graphite)',
              marginBottom: 2,
            }}
          >
            {template.name}
          </h2>
          <p style={{ color: 'var(--grey)', fontSize: 14 }}>
            Template Builder —{' '}
            {localQuestions.length} question
            {localQuestions.length !== 1 ? 's' : ''}
          </p>
        </div>
        <span
          style={{
            padding: '5px 14px',
            borderRadius: 999,
            fontSize: 13,
            fontWeight: 600,
            backgroundColor:
              template.status === 'published'
                ? '#DCFCE7'
                : template.status === 'archived'
                ? '#F3F4F6'
                : '#FEF3C7',
            color:
              template.status === 'published'
                ? '#15803D'
                : template.status === 'archived'
                ? '#6B7280'
                : '#92400E',
          }}
        >
          {template.status.charAt(0).toUpperCase() + template.status.slice(1)}
        </span>
      </header>

      {/* Step indicator */}
      <StepIndicator current={currentStep} onSelect={setCurrentStep} />

      {/* Content */}
      <div style={{ padding: '0 32px' }}>
        {/* Page-level error */}
        {pageError && (
          <div
            role="alert"
            style={{
              backgroundColor: '#FEE2E2',
              border: '1px solid #FCA5A5',
              borderRadius: 8,
              padding: '12px 16px',
              marginTop: 20,
              color: '#B91C1C',
              fontSize: 14,
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
            }}
          >
            <span>{pageError}</span>
            <button
              onClick={() => setPageError(null)}
              aria-label="Dismiss error"
              style={{
                background: 'none',
                border: 'none',
                color: '#B91C1C',
                cursor: 'pointer',
                fontSize: 16,
                lineHeight: 1,
                padding: '0 4px',
              }}
            >
              ×
            </button>
          </div>
        )}

        {/* Step content */}
        {renderCurrentStep()}

        {/* Step navigation */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            padding: '20px 0 32px',
            borderTop: '1px solid var(--ivory-tint)',
          }}
        >
          <button
            onClick={() => setCurrentStep((s) => Math.max(1, s - 1))}
            disabled={currentStep === 1}
            style={{
              ...secondaryBtn,
              opacity: currentStep === 1 ? 0.4 : 1,
              cursor: currentStep === 1 ? 'not-allowed' : 'pointer',
            }}
          >
            ← Back
          </button>
          <button
            onClick={() => setCurrentStep((s) => Math.min(7, s + 1))}
            disabled={currentStep === 7}
            style={{
              ...primaryBtn,
              opacity: currentStep === 7 ? 0.4 : 1,
              cursor: currentStep === 7 ? 'not-allowed' : 'pointer',
            }}
          >
            Next →
          </button>
        </div>
      </div>
    </div>
  );
}
