'use client';

import { useState, useRef } from 'react';
import { useQuery, useMutation, gql } from '@apollo/client';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Tag {
  id: string;
  label: string;
  isActive: boolean;
}

interface Question {
  id: string;
  text: string;
  category: string;
  isActive: boolean;
  tags: Tag[];
}

interface QuestionEdge {
  cursor: string;
  node: Question;
}

interface PageInfo {
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  startCursor: string | null;
  endCursor: string | null;
}

interface QuestionConnection {
  edges: QuestionEdge[];
  pageInfo: PageInfo;
  totalCount: number;
}

// ---------------------------------------------------------------------------
// GQL documents
// ---------------------------------------------------------------------------

const GET_QUESTIONS = gql`
  query AdminGetQuestions(
    $filters: QuestionFilters
    $includeInactive: Boolean
    $first: Int
    $after: String
  ) {
    getQuestions(
      filters: $filters
      includeInactive: $includeInactive
      first: $first
      after: $after
    ) {
      edges {
        cursor
        node {
          id
          text
          category
          isActive
          tags {
            id
            label
            isActive
          }
        }
      }
      pageInfo {
        hasNextPage
        hasPreviousPage
        startCursor
        endCursor
      }
      totalCount
    }
  }
`;

const GET_TAGS = gql`
  query AdminGetTags {
    getTags(includeInactive: false) {
      id
      label
      isActive
    }
  }
`;

const GET_ALL_CATEGORIES = gql`
  query AdminGetAllCategories {
    getQuestions(first: 500, includeInactive: true) {
      edges {
        node {
          category
        }
      }
    }
  }
`;

const CREATE_QUESTION = gql`
  mutation AdminCreateQuestion(
    $text: String!
    $category: String!
    $tagIds: [ID!]
  ) {
    createQuestion(text: $text, category: $category, tagIds: $tagIds) {
      id
      text
      category
      isActive
      tags {
        id
        label
        isActive
      }
    }
  }
`;

const UPDATE_QUESTION = gql`
  mutation AdminUpdateQuestion(
    $id: ID!
    $text: String
    $category: String
    $tagIds: [ID!]
    $isActive: Boolean
  ) {
    updateQuestion(
      id: $id
      text: $text
      category: $category
      tagIds: $tagIds
      isActive: $isActive
    ) {
      id
      text
      category
      isActive
      tags {
        id
        label
        isActive
      }
    }
  }
`;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PAGE_SIZE = 25;

// ---------------------------------------------------------------------------
// Shared styles
// ---------------------------------------------------------------------------

const labelStyle: React.CSSProperties = {
  display: 'block',
  fontFamily: 'var(--font-primary)',
  fontWeight: 500,
  fontSize: 14,
  color: 'var(--graphite)',
  marginBottom: 6,
};

const inputStyle: React.CSSProperties = {
  padding: '10px 14px',
  borderRadius: 6,
  border: '1px solid var(--grey)',
  backgroundColor: 'var(--ivory-tint)',
  fontFamily: 'var(--font-primary)',
  fontSize: 14,
  color: 'var(--graphite)',
  outline: 'none',
};

const primaryBtnStyle: React.CSSProperties = {
  padding: '10px 20px',
  borderRadius: 999,
  border: 'none',
  backgroundColor: 'var(--horizon-red)',
  color: 'var(--white)',
  fontFamily: 'var(--font-primary)',
  fontWeight: 600,
  fontSize: 14,
  cursor: 'pointer',
};

const secondaryBtnStyle: React.CSSProperties = {
  padding: '10px 20px',
  borderRadius: 999,
  border: '1px solid var(--ivory-tint)',
  backgroundColor: 'var(--white)',
  color: 'var(--graphite)',
  fontFamily: 'var(--font-primary)',
  fontWeight: 500,
  fontSize: 14,
  cursor: 'pointer',
};

// ---------------------------------------------------------------------------
// QuestionModal — create / edit
// ---------------------------------------------------------------------------

interface ModalProps {
  mode: 'create' | 'edit';
  question: Question | null;
  allTags: Tag[];
  allCategories: string[];
  onSave: (data: { text: string; category: string; tagIds: string[] }) => void;
  onClose: () => void;
  isSaving: boolean;
  error: string | null;
}

function QuestionModal({ mode, question, allTags, allCategories, onSave, onClose, isSaving, error }: ModalProps) {
  const [text, setText] = useState(question?.text ?? '');
  const existingCategory = question?.category ?? '';
  const isExisting = allCategories.includes(existingCategory);
  const [categorySelect, setCategorySelect] = useState(
    existingCategory && !isExisting ? '__new__' : existingCategory
  );
  const [newCategory, setNewCategory] = useState(existingCategory && !isExisting ? existingCategory : '');
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>(
    question?.tags.map((t) => t.id) ?? []
  );

  const category = categorySelect === '__new__' ? newCategory.trim() : categorySelect;

  const toggleTag = (id: string) => {
    setSelectedTagIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSave({ text: text.trim(), category: category.trim(), tagIds: selectedTagIds });
  };

  const canSubmit = text.trim().length > 0 && category.trim().length > 0;

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 50,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'rgba(26,26,26,0.5)',
      }}
    >
      <div
        style={{
          backgroundColor: 'var(--white)',
          borderRadius: 12,
          padding: 32,
          width: '100%',
          maxWidth: 560,
          maxHeight: '90vh',
          overflowY: 'auto',
          boxShadow: '0 8px 32px rgba(0,0,0,0.18)',
        }}
      >
        <h2
          style={{
            fontFamily: 'var(--font-primary)',
            fontWeight: 600,
            fontSize: 20,
            color: 'var(--graphite)',
            marginBottom: 24,
          }}
        >
          {mode === 'create' ? 'Create Question' : 'Edit Question'}
        </h2>

        <form onSubmit={handleSubmit}>
          {/* Text */}
          <div style={{ marginBottom: 20 }}>
            <label style={labelStyle}>Question Text</label>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              required
              rows={4}
              style={{
                ...inputStyle,
                resize: 'vertical',
                display: 'block',
                width: '100%',
              }}
              placeholder="Enter question text…"
            />
          </div>

          {/* Category */}
          <div style={{ marginBottom: 20 }}>
            <label style={labelStyle}>Category</label>
            <select
              value={categorySelect}
              onChange={(e) => setCategorySelect(e.target.value)}
              required
              style={{ ...inputStyle, display: 'block', width: '100%', cursor: 'pointer' }}
            >
              <option value="" disabled>Select a category…</option>
              {allCategories.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
              <option value="__new__">+ Add new category…</option>
            </select>
            {categorySelect === '__new__' && (
              <input
                type="text"
                value={newCategory}
                onChange={(e) => setNewCategory(e.target.value)}
                autoFocus
                style={{ ...inputStyle, display: 'block', width: '100%', marginTop: 8 }}
                placeholder="Enter new category name…"
              />
            )}
          </div>

          {/* Tags */}
          <div style={{ marginBottom: 24 }}>
            <label style={labelStyle}>Tags</label>
            {allTags.length === 0 ? (
              <p style={{ color: 'var(--grey)', fontSize: 14 }}>No active tags available.</p>
            ) : (
              <div
                style={{
                  border: '1px solid var(--ivory-tint)',
                  borderRadius: 8,
                  padding: 12,
                  maxHeight: 220,
                  overflowY: 'auto',
                  backgroundColor: 'var(--ivory)',
                }}
              >
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  {allTags.map((tag) => {
                    const selected = selectedTagIds.includes(tag.id);
                    return (
                      <label
                        key={tag.id}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 6,
                          cursor: 'pointer',
                          padding: '5px 12px',
                          borderRadius: 999,
                          fontSize: 13,
                          border: selected
                            ? '1.5px solid var(--horizon-red)'
                            : '1.5px solid var(--ivory-tint)',
                          backgroundColor: selected
                            ? 'rgba(122,14,19,0.07)'
                            : 'var(--white)',
                          color: selected ? 'var(--horizon-red)' : 'var(--graphite)',
                          transition: 'all 0.12s',
                          userSelect: 'none',
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={selected}
                          onChange={() => toggleTag(tag.id)}
                          style={{ display: 'none' }}
                        />
                        {tag.label}
                      </label>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          {error && (
            <p
              style={{
                color: 'var(--horizon-red)',
                fontSize: 14,
                marginBottom: 16,
                padding: '8px 12px',
                backgroundColor: '#FEE2E2',
                borderRadius: 6,
              }}
            >
              {error}
            </p>
          )}

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 12 }}>
            <button
              type="button"
              onClick={onClose}
              disabled={isSaving}
              style={{ ...secondaryBtnStyle, opacity: isSaving ? 0.6 : 1 }}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSaving || !canSubmit}
              style={{
                ...primaryBtnStyle,
                opacity: isSaving || !canSubmit ? 0.5 : 1,
                cursor: isSaving || !canSubmit ? 'not-allowed' : 'pointer',
              }}
            >
              {isSaving ? 'Saving…' : 'Save Question'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// DeactivateWarningDialog
// ---------------------------------------------------------------------------

interface WarningDialogProps {
  question: Question;
  onConfirm: () => void;
  onCancel: () => void;
  isLoading: boolean;
}

function DeactivateWarningDialog({
  question,
  onConfirm,
  onCancel,
  isLoading,
}: WarningDialogProps) {
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 60,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'rgba(26,26,26,0.55)',
      }}
    >
      <div
        style={{
          backgroundColor: 'var(--white)',
          borderRadius: 12,
          padding: 32,
          width: '100%',
          maxWidth: 440,
          boxShadow: '0 8px 32px rgba(0,0,0,0.2)',
        }}
      >
        <h3
          style={{
            fontFamily: 'var(--font-primary)',
            fontWeight: 600,
            fontSize: 18,
            color: 'var(--graphite)',
            marginBottom: 12,
          }}
        >
          Deactivate Question?
        </h3>
        <p
          style={{
            color: 'var(--grey)',
            fontSize: 14,
            lineHeight: 1.6,
            marginBottom: 4,
            overflow: 'hidden',
            maxHeight: '3em',
          }}
        >
          <strong style={{ color: 'var(--graphite)' }}>&ldquo;{question.text}&rdquo;</strong>
        </p>
        <p
          style={{
            color: 'var(--grey)',
            fontSize: 14,
            lineHeight: 1.6,
            marginBottom: 16,
          }}
        >
          Deactivating this question will hide it from the question bank. It may currently
          be included in one or more published templates.
        </p>
        <div
          style={{
            backgroundColor: '#FEF3C7',
            border: '1px solid #FDE68A',
            borderRadius: 8,
            padding: '10px 14px',
            color: '#92400E',
            fontSize: 13,
            lineHeight: 1.5,
            marginBottom: 24,
          }}
        >
          <strong>Warning:</strong> This question will no longer appear for new interviews that
          use any template it belongs to. Existing in-progress interviews are unaffected.
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 12 }}>
          <button
            onClick={onCancel}
            disabled={isLoading}
            style={{ ...secondaryBtnStyle, opacity: isLoading ? 0.6 : 1 }}
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={isLoading}
            style={{
              ...primaryBtnStyle,
              backgroundColor: '#B91C1C',
              opacity: isLoading ? 0.6 : 1,
              cursor: isLoading ? 'not-allowed' : 'pointer',
            }}
          >
            {isLoading ? 'Deactivating…' : 'Deactivate'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// QuestionBank — main component
// ---------------------------------------------------------------------------

export default function QuestionBank() {
  // --- Filter state ---
  const [searchText, setSearchText] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [filterTagIds, setFilterTagIds] = useState<string[]>([]);
  const [includeInactive, setIncludeInactive] = useState(false);
  const [showTagDropdown, setShowTagDropdown] = useState(false);

  // --- Sort state (client-side) ---
  const [sortField, setSortField] = useState<'text' | 'category' | null>(null);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

  // --- Pagination: stack of 'after' cursors (null = first page) ---
  const [cursorStack, setCursorStack] = useState<Array<string | null>>([null]);
  const currentPageIndex = cursorStack.length - 1;
  const afterCursor = cursorStack[currentPageIndex];

  // --- Modal state ---
  const [modalMode, setModalMode] = useState<'create' | 'edit' | null>(null);
  const [editingQuestion, setEditingQuestion] = useState<Question | null>(null);
  const [modalError, setModalError] = useState<string | null>(null);

  // --- Deactivate warning state ---
  const [deactivateTarget, setDeactivateTarget] = useState<Question | null>(null);

  // --- Page-level error (e.g. toggle failure when modal is closed) ---
  const [pageError, setPageError] = useState<string | null>(null);

  // --- Debounce timer ---
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------

  const filters = {
    ...(debouncedSearch ? { searchText: debouncedSearch } : {}),
    ...(filterTagIds.length > 0 ? { tagIds: filterTagIds } : {}),
  };

  const { data: questionsData, loading: questionsLoading, error: questionsError, refetch } =
    useQuery<{ getQuestions: QuestionConnection }>(GET_QUESTIONS, {
      variables: {
        filters: Object.keys(filters).length > 0 ? filters : undefined,
        includeInactive: includeInactive || undefined,
        first: PAGE_SIZE,
        after: afterCursor,
      },
      fetchPolicy: 'cache-and-network',
    });

  const { data: tagsData, loading: tagsLoading } = useQuery<{ getTags: Tag[] }>(GET_TAGS);

  const { data: categoriesData } = useQuery<{ getQuestions: { edges: { node: { category: string } }[] } }>(
    GET_ALL_CATEGORIES
  );
  const allCategories = Array.from(
    new Set((categoriesData?.getQuestions.edges ?? []).map((e) => e.node.category).filter(Boolean))
  ).sort();

  // ---------------------------------------------------------------------------
  // Mutations
  // ---------------------------------------------------------------------------

  const [createQuestion, { loading: creating }] = useMutation(CREATE_QUESTION);
  const [updateQuestion, { loading: updating }] = useMutation(UPDATE_QUESTION);

  // ---------------------------------------------------------------------------
  // Derived data
  // ---------------------------------------------------------------------------

  const allTags = tagsData?.getTags ?? [];
  const connection = questionsData?.getQuestions;
  const rawQuestions = connection?.edges.map((e) => e.node) ?? [];
  const questions = sortField
    ? [...rawQuestions].sort((a, b) => {
        const aVal = a[sortField].toLowerCase();
        const bVal = b[sortField].toLowerCase();
        if (aVal < bVal) return sortDir === 'asc' ? -1 : 1;
        if (aVal > bVal) return sortDir === 'asc' ? 1 : -1;
        return 0;
      })
    : rawQuestions;
  const pageInfo = connection?.pageInfo;
  const totalCount = connection?.totalCount ?? 0;
  const pageStart = currentPageIndex * PAGE_SIZE + 1;
  const pageEnd = pageStart + questions.length - 1;

  // ---------------------------------------------------------------------------
  // Handlers — search / filter
  // ---------------------------------------------------------------------------

  const handleSearchChange = (value: string) => {
    setSearchText(value);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => {
      setDebouncedSearch(value);
      setCursorStack([null]);
    }, 300);
  };

  const toggleTagFilter = (tagId: string) => {
    setFilterTagIds((prev) =>
      prev.includes(tagId) ? prev.filter((x) => x !== tagId) : [...prev, tagId]
    );
    setCursorStack([null]);
  };

  const clearTagFilters = () => {
    setFilterTagIds([]);
    setCursorStack([null]);
  };

  const handleSort = (field: 'text' | 'category') => {
    if (sortField === field) {
      setSortDir((prev) => (prev === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(field);
      setSortDir('asc');
    }
  };

  const handleIncludeInactiveToggle = () => {
    setIncludeInactive((prev) => !prev);
    setCursorStack([null]);
  };

  // ---------------------------------------------------------------------------
  // Handlers — pagination
  // ---------------------------------------------------------------------------

  const handleNextPage = () => {
    const cursor = pageInfo?.endCursor;
    if (cursor) setCursorStack((prev) => [...prev, cursor]);
  };

  const handlePrevPage = () => {
    if (cursorStack.length > 1) setCursorStack((prev) => prev.slice(0, -1));
  };

  // ---------------------------------------------------------------------------
  // Handlers — modal
  // ---------------------------------------------------------------------------

  const openCreate = () => {
    setEditingQuestion(null);
    setModalMode('create');
    setModalError(null);
    setPageError(null);
  };

  const openEdit = (q: Question) => {
    setEditingQuestion(q);
    setModalMode('edit');
    setModalError(null);
    setPageError(null);
  };

  const closeModal = () => {
    setModalMode(null);
    setEditingQuestion(null);
    setModalError(null);
  };

  const handleModalSave = async ({
    text,
    category,
    tagIds,
  }: {
    text: string;
    category: string;
    tagIds: string[];
  }) => {
    try {
      if (modalMode === 'create') {
        await createQuestion({ variables: { text, category, tagIds } });
      } else if (editingQuestion) {
        await updateQuestion({ variables: { id: editingQuestion.id, text, category, tagIds } });
      }
      closeModal();
      void refetch();
    } catch (err) {
      setModalError((err as Error).message);
    }
  };

  // ---------------------------------------------------------------------------
  // Handlers — active toggle
  // ---------------------------------------------------------------------------

  const handleActiveToggle = (q: Question) => {
    if (q.isActive) {
      // Deactivating: show warning dialog first
      setDeactivateTarget(q);
      setPageError(null);
    } else {
      // Reactivating: no warning needed
      void (async () => {
        try {
          await updateQuestion({ variables: { id: q.id, isActive: true } });
          void refetch();
        } catch (err) {
          setPageError((err as Error).message);
        }
      })();
    }
  };

  const confirmDeactivate = async () => {
    if (!deactivateTarget) return;
    try {
      await updateQuestion({ variables: { id: deactivateTarget.id, isActive: false } });
      setDeactivateTarget(null);
      void refetch();
    } catch (err) {
      setDeactivateTarget(null);
      setPageError((err as Error).message);
    }
  };

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <>
      {/* ---- Page header ---- */}
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
            Question Bank
          </h2>
          <p style={{ color: 'var(--grey)', fontSize: 14 }}>
            Manage interview questions, categories, and tag associations.
          </p>
        </div>
        <button onClick={openCreate} style={primaryBtnStyle}>
          + Create Question
        </button>
      </header>

      {/* ---- Filters bar ---- */}
      <div
        style={{
          padding: '14px 32px',
          backgroundColor: 'var(--white)',
          borderBottom: '1px solid var(--ivory-tint)',
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          flexWrap: 'wrap',
        }}
      >
        {/* Search input */}
        <input
          type="search"
          value={searchText}
          onChange={(e) => handleSearchChange(e.target.value)}
          placeholder="Search questions…"
          style={{ ...inputStyle, width: 260 }}
          aria-label="Search questions"
        />

        {/* Tag filter dropdown */}
        <div style={{ position: 'relative' }}>
          <button
            onClick={() => setShowTagDropdown((prev) => !prev)}
            aria-expanded={showTagDropdown}
            style={{
              ...secondaryBtnStyle,
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              borderColor:
                filterTagIds.length > 0 ? 'var(--horizon-red)' : 'var(--ivory-tint)',
              color: filterTagIds.length > 0 ? 'var(--horizon-red)' : 'var(--graphite)',
            }}
          >
            Filter by Tag
            {filterTagIds.length > 0 && (
              <span
                style={{
                  backgroundColor: 'var(--horizon-red)',
                  color: 'var(--white)',
                  borderRadius: 999,
                  fontSize: 11,
                  fontWeight: 600,
                  padding: '1px 7px',
                }}
              >
                {filterTagIds.length}
              </span>
            )}
            <span style={{ fontSize: 9, opacity: 0.6 }}>▼</span>
          </button>

          {showTagDropdown && (
            <>
              {/* Click-outside overlay */}
              <div
                style={{ position: 'fixed', inset: 0, zIndex: 19 }}
                onClick={() => setShowTagDropdown(false)}
              />
              <div
                style={{
                  position: 'absolute',
                  top: 'calc(100% + 6px)',
                  left: 0,
                  zIndex: 20,
                  backgroundColor: 'var(--white)',
                  border: '1px solid var(--ivory-tint)',
                  borderRadius: 10,
                  boxShadow: '0 4px 20px rgba(0,0,0,0.1)',
                  minWidth: 240,
                  maxWidth: 320,
                  maxHeight: 300,
                  overflowY: 'auto',
                  padding: '10px 4px',
                }}
              >
                {tagsLoading ? (
                  <p style={{ color: 'var(--grey)', fontSize: 13, padding: '6px 12px' }}>
                    Loading…
                  </p>
                ) : allTags.length === 0 ? (
                  <p style={{ color: 'var(--grey)', fontSize: 13, padding: '6px 12px' }}>
                    No tags available.
                  </p>
                ) : (
                  <>
                    {filterTagIds.length > 0 && (
                      <button
                        onClick={() => {
                          clearTagFilters();
                          setShowTagDropdown(false);
                        }}
                        style={{
                          background: 'none',
                          border: 'none',
                          color: 'var(--horizon-red)',
                          fontSize: 13,
                          cursor: 'pointer',
                          padding: '4px 12px',
                          marginBottom: 4,
                          fontFamily: 'var(--font-primary)',
                        }}
                      >
                        Clear all
                      </button>
                    )}
                    {allTags.map((tag) => (
                      <label
                        key={tag.id}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 8,
                          padding: '7px 12px',
                          cursor: 'pointer',
                          fontSize: 14,
                          color: 'var(--graphite)',
                          borderRadius: 6,
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={filterTagIds.includes(tag.id)}
                          onChange={() => toggleTagFilter(tag.id)}
                          style={{
                            accentColor: 'var(--horizon-red)',
                            width: 15,
                            height: 15,
                            flexShrink: 0,
                          }}
                        />
                        <span style={{ flex: 1 }}>{tag.label}</span>
                      </label>
                    ))}
                  </>
                )}
              </div>
            </>
          )}
        </div>

        {/* Show inactive toggle */}
        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            cursor: 'pointer',
            fontSize: 14,
            color: 'var(--graphite)',
            userSelect: 'none',
          }}
        >
          <input
            type="checkbox"
            checked={includeInactive}
            onChange={handleIncludeInactiveToggle}
            style={{ accentColor: 'var(--horizon-red)', width: 15, height: 15 }}
          />
          Show inactive
        </label>

        {/* Total count */}
        <span style={{ marginLeft: 'auto', color: 'var(--grey)', fontSize: 14 }}>
          {questionsLoading && questions.length === 0
            ? 'Loading…'
            : `${totalCount} question${totalCount !== 1 ? 's' : ''}`}
        </span>
      </div>

      {/* ---- Main content ---- */}
      <div style={{ padding: '24px 32px' }}>
        {/* Page-level error */}
        {pageError && (
          <div
            role="alert"
            style={{
              backgroundColor: '#FEE2E2',
              border: '1px solid #FCA5A5',
              borderRadius: 8,
              padding: '12px 16px',
              marginBottom: 16,
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
              style={{
                background: 'none',
                border: 'none',
                color: '#B91C1C',
                cursor: 'pointer',
                fontSize: 16,
                lineHeight: 1,
                padding: '0 4px',
              }}
              aria-label="Dismiss error"
            >
              ×
            </button>
          </div>
        )}

        {/* Query error */}
        {questionsError && (
          <div
            role="alert"
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
            Failed to load questions: {questionsError.message}
          </div>
        )}

        {/* Empty / loading state */}
        {questionsLoading && questions.length === 0 ? (
          <div
            style={{
              textAlign: 'center',
              padding: '64px 0',
              color: 'var(--grey)',
              fontSize: 15,
            }}
          >
            Loading questions…
          </div>
        ) : questions.length === 0 ? (
          <div
            style={{
              textAlign: 'center',
              padding: '64px 0',
              color: 'var(--grey)',
              fontSize: 15,
            }}
          >
            No questions found.
            {!includeInactive && (
              <span> Enable &ldquo;Show inactive&rdquo; to include deactivated questions.</span>
            )}
          </div>
        ) : (
          <>
            {/* Table */}
            <div
              style={{
                backgroundColor: 'var(--white)',
                borderRadius: 12,
                border: '1px solid var(--ivory-tint)',
                overflow: 'hidden',
              }}
            >
              {/* Table header */}
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: '2fr 130px 160px 100px 72px',
                  padding: '11px 18px',
                  borderBottom: '1px solid var(--ivory-tint)',
                  backgroundColor: 'var(--ivory)',
                  gap: 12,
                }}
              >
                {(['Question', 'Category', 'Tags', 'Status', 'Action'] as const).map((h) => {
                  const field = h === 'Question' ? 'text' : h === 'Category' ? 'category' : null;
                  const isSorted = field && sortField === field;
                  const arrow = isSorted ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '';
                  return (
                    <span
                      key={h}
                      onClick={field ? () => handleSort(field) : undefined}
                      style={{
                        fontSize: 11,
                        fontWeight: 600,
                        color: isSorted ? 'var(--graphite)' : 'var(--grey)',
                        textTransform: 'uppercase',
                        letterSpacing: '0.07em',
                        cursor: field ? 'pointer' : 'default',
                        userSelect: 'none',
                      }}
                    >
                      {h}{arrow}
                    </span>
                  );
                })}
              </div>

              {/* Rows */}
              {questions.map((q, i) => (
                <div
                  key={q.id}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '2fr 130px 160px 100px 72px',
                    padding: '15px 18px',
                    borderBottom:
                      i < questions.length - 1 ? '1px solid var(--ivory-tint)' : 'none',
                    alignItems: 'start',
                    gap: 12,
                    backgroundColor: q.isActive ? 'var(--white)' : 'rgba(236,234,222,0.35)',
                    opacity: q.isActive ? 1 : 0.7,
                    transition: 'background-color 0.15s',
                  }}
                >
                  {/* Question text */}
                  <div
                    style={{
                      fontSize: 14,
                      color: 'var(--graphite)',
                      lineHeight: 1.55,
                      overflow: 'hidden',
                      maxHeight: '4.65em',
                    }}
                    title={q.text}
                  >
                    {q.text}
                  </div>

                  {/* Category */}
                  <div
                    style={{
                      fontSize: 13,
                      color: 'var(--grey)',
                      paddingTop: 1,
                    }}
                  >
                    {q.category}
                  </div>

                  {/* Tags */}
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, paddingTop: 1 }}>
                    {q.tags.length === 0 ? (
                      <span style={{ color: 'var(--grey)', fontSize: 13 }}>—</span>
                    ) : (
                      q.tags.map((tag) => (
                        <span
                          key={tag.id}
                          style={{
                            fontSize: 11,
                            fontWeight: 500,
                            padding: '3px 9px',
                            borderRadius: 999,
                            border: '1px solid var(--ivory-tint)',
                            backgroundColor: 'var(--ivory)',
                            color: 'var(--grey)',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {tag.label}
                        </span>
                      ))
                    )}
                  </div>

                  {/* Active status toggle */}
                  <div>
                    <button
                      onClick={() => handleActiveToggle(q)}
                      disabled={updating}
                      title={q.isActive ? 'Click to deactivate' : 'Click to reactivate'}
                      style={{
                        padding: '4px 12px',
                        borderRadius: 999,
                        border: 'none',
                        fontSize: 12,
                        fontWeight: 600,
                        cursor: updating ? 'not-allowed' : 'pointer',
                        backgroundColor: q.isActive ? '#DCFCE7' : '#F3F4F6',
                        color: q.isActive ? '#15803D' : '#6B7280',
                        transition: 'all 0.15s',
                        fontFamily: 'var(--font-primary)',
                      }}
                    >
                      {q.isActive ? 'Active' : 'Inactive'}
                    </button>
                  </div>

                  {/* Edit button */}
                  <div>
                    <button
                      onClick={() => openEdit(q)}
                      style={{
                        background: 'none',
                        border: '1px solid var(--ivory-tint)',
                        borderRadius: 6,
                        padding: '5px 12px',
                        fontSize: 13,
                        color: 'var(--graphite)',
                        cursor: 'pointer',
                        fontFamily: 'var(--font-primary)',
                        transition: 'border-color 0.12s',
                      }}
                    >
                      Edit
                    </button>
                  </div>
                </div>
              ))}
            </div>

            {/* Pagination */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                marginTop: 20,
                flexWrap: 'wrap',
                gap: 12,
              }}
            >
              <span style={{ color: 'var(--grey)', fontSize: 14 }}>
                {questions.length > 0
                  ? `Showing ${pageStart}–${pageEnd} of ${totalCount}`
                  : ''}
              </span>
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  onClick={handlePrevPage}
                  disabled={currentPageIndex === 0}
                  style={{
                    ...secondaryBtnStyle,
                    opacity: currentPageIndex === 0 ? 0.4 : 1,
                    cursor: currentPageIndex === 0 ? 'not-allowed' : 'pointer',
                  }}
                >
                  ← Previous
                </button>
                <button
                  onClick={handleNextPage}
                  disabled={!pageInfo?.hasNextPage}
                  style={{
                    ...secondaryBtnStyle,
                    opacity: !pageInfo?.hasNextPage ? 0.4 : 1,
                    cursor: !pageInfo?.hasNextPage ? 'not-allowed' : 'pointer',
                  }}
                >
                  Next →
                </button>
              </div>
            </div>
          </>
        )}
      </div>

      {/* ---- Modals ---- */}
      {modalMode && (
        <QuestionModal
          mode={modalMode}
          question={editingQuestion}
          allTags={allTags}
          allCategories={allCategories}
          onSave={(data) => void handleModalSave(data)}
          onClose={closeModal}
          isSaving={creating || updating}
          error={modalError}
        />
      )}

      {deactivateTarget && (
        <DeactivateWarningDialog
          question={deactivateTarget}
          onConfirm={() => void confirmDeactivate()}
          onCancel={() => setDeactivateTarget(null)}
          isLoading={updating}
        />
      )}
    </>
  );
}
