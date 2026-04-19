'use client';

import { useState, useRef } from 'react';
import { useQuery, useMutation, gql } from '@apollo/client';
import { cn } from '@/lib/utils';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { TagChipInput } from '@/components/admin/TagChipInput';
import { QuestionModal } from '@/components/admin/QuestionModal';
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

const UPDATE_QUESTION = gql`
  mutation AdminUpdateQuestion(
    $id: ID!
    $text: String
    $tagIds: [ID!]
    $isActive: Boolean
    $intent: String
    $sensitivityLevel: SensitivityLevel
  ) {
    updateQuestion(
      id: $id
      text: $text
      tagIds: $tagIds
      isActive: $isActive
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
// Constants
// ---------------------------------------------------------------------------

const PAGE_SIZE = 25;


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
    <div className="modal-backdrop z-[60]">
      <div className="modal-panel max-w-[440px]">
        <h3 className="font-semibold text-lg text-graphite mb-3">
          Deactivate Question?
        </h3>
        <p className="text-grey text-sm leading-relaxed mb-1 overflow-hidden max-h-[3em]">
          <strong className="text-graphite">&ldquo;{question.text}&rdquo;</strong>
        </p>
        <p className="text-grey text-sm leading-relaxed mb-4">
          Deactivating this question will hide it from the question bank. It may currently
          be included in one or more published templates.
        </p>
        <div className="bg-ivory-tint border border-ivory-tint rounded p-[10px_14px] text-graphite text-[13px] leading-normal mb-6">
          <strong>Warning:</strong> This question will no longer appear for new interviews that
          use any template it belongs to. Existing in-progress interviews are unaffected.
        </div>
        <div className="flex justify-end gap-3">
          <button
            onClick={onCancel}
            disabled={isLoading}
            className={cn('btn-secondary', isLoading && 'opacity-60')}
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={isLoading}
            className={cn(
              'btn-wine bg-arena-wine text-white',
              isLoading && 'opacity-60 cursor-not-allowed'
            )}
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
  const [sortField, setSortField] = useState<'text' | null>(null);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

  // --- Pagination: stack of 'after' cursors (null = first page) ---
  const [cursorStack, setCursorStack] = useState<Array<string | null>>([null]);
  const currentPageIndex = cursorStack.length - 1;
  const afterCursor = cursorStack[currentPageIndex];

  // --- Modal state ---
  const [modalMode, setModalMode] = useState<'create' | 'edit' | null>(null);
  const [editingQuestion, setEditingQuestion] = useState<Question | null>(null);
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

  // ---------------------------------------------------------------------------
  // Mutations
  // ---------------------------------------------------------------------------

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

  const handleSort = (field: 'text') => {
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
    setPageError(null);
  };

  const openEdit = (q: Question) => {
    setEditingQuestion(q);
    setModalMode('edit');
    setPageError(null);
  };

  const closeModal = () => {
    setModalMode(null);
    setEditingQuestion(null);
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
      <header className="page-header flex items-center justify-between gap-4">
        <div>
          <h2 className="font-semibold text-[22px] text-graphite mb-0.5">
            Question Bank
          </h2>
          <p className="text-grey text-sm">
            Manage interview questions and tag associations.
          </p>
        </div>
        <button onClick={openCreate} className="btn-primary">
          + Create Question
        </button>
      </header>

      {/* ---- Filters bar ---- */}
      <div className="py-3.5 px-8 bg-white border-b border-ivory-tint flex items-center gap-3 flex-wrap">
        {/* Search input */}
        <input
          type="search"
          value={searchText}
          onChange={(e) => handleSearchChange(e.target.value)}
          placeholder="Search questions…"
          className="input-field text-sm w-[260px]"
          aria-label="Search questions"
        />

        {/* Tag filter dropdown */}
        <div className="relative">
          <button
            onClick={() => setShowTagDropdown((prev) => !prev)}
            aria-expanded={showTagDropdown}
            className={cn(
              'btn-secondary flex items-center gap-1.5',
              filterTagIds.length > 0
                ? 'border-horizon-red text-horizon-red'
                : 'text-graphite'
            )}
          >
            Filter by Tag
            {filterTagIds.length > 0 && (
              <span className="bg-horizon-red text-white rounded-pill text-2xs font-semibold px-[7px] py-px">
                {filterTagIds.length}
              </span>
            )}
            <span className="text-[9px] opacity-60">&#9660;</span>
          </button>

          {showTagDropdown && (
            <>
              {/* Click-outside overlay */}
              <div
                className="fixed inset-0 z-[19]"
                onClick={() => setShowTagDropdown(false)}
              />
              <div className="absolute top-[calc(100%+6px)] left-0 z-20 bg-white border border-ivory-tint rounded-[10px] min-w-[240px] max-w-[320px] max-h-[300px] overflow-y-auto py-2.5 px-1">
                {tagsLoading ? (
                  <p className="text-grey text-[13px] py-1.5 px-3">
                    Loading…
                  </p>
                ) : allTags.length === 0 ? (
                  <p className="text-grey text-[13px] py-1.5 px-3">
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
                        className="bg-transparent border-none text-horizon-red text-[13px] cursor-pointer py-1 px-3 mb-1 font-primary"
                      >
                        Clear all
                      </button>
                    )}
                    {allTags.map((tag) => (
                      <label
                        key={tag.id}
                        className="flex items-center gap-2 py-[7px] px-3 cursor-pointer text-sm text-graphite rounded"
                      >
                        <input
                          type="checkbox"
                          checked={filterTagIds.includes(tag.id)}
                          onChange={() => toggleTagFilter(tag.id)}
                          className="shrink-0 w-[15px] h-[15px]"
                          style={{ accentColor: 'var(--horizon-red)' }}
                        />
                        <span className="flex-1">{tag.label}</span>
                      </label>
                    ))}
                  </>
                )}
              </div>
            </>
          )}
        </div>

        {/* Show inactive toggle */}
        <label className="flex items-center gap-2 cursor-pointer text-sm text-graphite select-none">
          <input
            type="checkbox"
            checked={includeInactive}
            onChange={handleIncludeInactiveToggle}
            className="w-[15px] h-[15px]"
            style={{ accentColor: 'var(--horizon-red)' }}
          />
          Show inactive
        </label>

        {/* Total count */}
        <span className="ml-auto text-grey text-sm">
          {questionsLoading && questions.length === 0
            ? 'Loading…'
            : `${totalCount} question${totalCount !== 1 ? 's' : ''}`}
        </span>
      </div>

      {/* ---- Main content ---- */}
      <div className="page-content">
        {/* Page-level error */}
        {pageError && (
          <div role="alert" className="alert-error mb-4 flex justify-between items-center">
            <span>{pageError}</span>
            <button
              onClick={() => setPageError(null)}
              className="bg-transparent border-none text-inherit cursor-pointer text-base leading-none px-1"
              aria-label="Dismiss error"
            >
              &times;
            </button>
          </div>
        )}

        {/* Query error */}
        {questionsError && (
          <div role="alert" className="alert-error mb-4">
            Failed to load questions: {questionsError.message}
          </div>
        )}

        {/* Empty / loading state */}
        {questionsLoading && questions.length === 0 ? (
          <div className="text-center py-16 text-grey text-[15px]">
            Loading questions…
          </div>
        ) : questions.length === 0 ? (
          <div className="text-center py-16 text-grey text-[15px]">
            No questions found.
            {!includeInactive && (
              <span> Enable &ldquo;Show inactive&rdquo; to include deactivated questions.</span>
            )}
          </div>
        ) : (
          <>
            {/* Table */}
            <div className="bg-white rounded border border-ivory-tint overflow-hidden">
              {/* Table header */}
              <div className="grid grid-cols-[92px_2fr_200px_100px] py-2.5 px-[18px] border-b border-graphite/20 bg-graphite gap-3">
                {(['Ref', 'Question', 'Tags', 'Status'] as const).map((h) => {
                  const field = h === 'Question' ? 'text' : null;
                  const centered = h === 'Status';
                  const isSorted = field && sortField === field;
                  const arrow = isSorted ? (sortDir === 'asc' ? ' \u25B2' : ' \u25BC') : '';
                  return (
                    <span
                      key={h}
                      onClick={field ? () => handleSort(field) : undefined}
                      className={cn(
                        'col-header',
                        isSorted && 'text-arena-gold',
                        field && 'cursor-pointer',
                        centered && 'text-center'
                      )}
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
                  onClick={() => openEdit(q)}
                  className={cn(
                    'grid grid-cols-[92px_2fr_200px_100px] py-[15px] px-[18px] items-start gap-3 cursor-pointer transition-colors duration-100 hover:bg-horizon-red/[0.03]',
                    i < questions.length - 1 && 'border-b border-ivory-tint',
                    !q.isActive ? 'bg-ivory-tint/35 opacity-70' : i % 2 === 0 ? 'bg-white' : 'bg-ivory-tint'
                  )}
                >
                  {/* Reference ID */}
                  <div className="pt-[2px]">
                    <QuestionRefBadge displayNumber={q.displayNumber} />
                  </div>

                  {/* Question text */}
                  <div
                    className="text-sm text-graphite leading-[1.55] overflow-hidden max-h-[4.65em]"
                    title={q.text}
                  >
                    {q.text}
                  </div>

                  {/* Tags */}
                  <div className="flex flex-wrap gap-1 pt-px">
                    {q.tags.length === 0 ? (
                      <span className="text-grey text-[13px]">&mdash;</span>
                    ) : (
                      q.tags.map((tag) => (
                        <span
                          key={tag.id}
                          className="badge bg-ivory-tint text-graphite"
                        >
                          {tag.label}
                        </span>
                      ))
                    )}
                  </div>

                  {/* Active status toggle */}
                  <div className="flex justify-center">
                    <button
                      onClick={(e) => { e.stopPropagation(); handleActiveToggle(q); }}
                      disabled={updating}
                      title={q.isActive ? 'Click to deactivate' : 'Click to reactivate'}
                    >
                      <StatusBadge status={q.isActive ? 'active' : 'inactive'} />
                    </button>
                  </div>
                </div>
              ))}
            </div>

            {/* Pagination */}
            <div className="flex items-center justify-between mt-5 flex-wrap gap-3">
              <span className="text-grey text-sm">
                {questions.length > 0
                  ? `Showing ${pageStart}\u2013${pageEnd} of ${totalCount}`
                  : ''}
              </span>
              <div className="flex gap-2">
                <button
                  onClick={handlePrevPage}
                  disabled={currentPageIndex === 0}
                  className={cn(
                    'btn-amber',
                    currentPageIndex === 0 && 'opacity-40 cursor-not-allowed'
                  )}
                >
                  &larr; Previous
                </button>
                <button
                  onClick={handleNextPage}
                  disabled={!pageInfo?.hasNextPage}
                  className={cn(
                    'btn-amber',
                    !pageInfo?.hasNextPage && 'opacity-40 cursor-not-allowed'
                  )}
                >
                  Next &rarr;
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
          onClose={closeModal}
          onSaved={() => void refetch()}
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
