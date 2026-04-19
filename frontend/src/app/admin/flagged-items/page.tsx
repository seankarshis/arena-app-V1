'use client';

import React, { useState, useCallback } from 'react';
import { useQuery, useMutation, gql } from '@apollo/client';
import Link from 'next/link';
import { cn } from '@/lib/utils';
import {
  AlertTriangle,
  AlertCircle,
  Info,
  Minus,
  ExternalLink,
  X,
} from 'lucide-react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type FlaggedItemPriority = 'low' | 'medium' | 'high' | 'critical';
type FlaggedItemStatus = 'pending' | 'reviewed' | 'resolved' | 'dismissed';

interface FlaggedItem {
  id: string;
  interviewId: string;
  sourceTurn: number;
  priority: FlaggedItemPriority;
  description: string;
  suggestedTags: string[];
  status: FlaggedItemStatus;
  createdAt: string;
  reviewedAt: string | null;
  reviewedBy: string | null;
}

// ---------------------------------------------------------------------------
// GQL
// ---------------------------------------------------------------------------

const FLAGGED_ITEMS_QUERY = gql`
  query AdminFlaggedItems(
    $status: FlaggedItemStatus
    $priority: FlaggedItemPriority
    $limit: Int
    $offset: Int
  ) {
    flaggedItems(
      status: $status
      priority: $priority
      limit: $limit
      offset: $offset
    ) {
      id
      interviewId
      sourceTurn
      priority
      description
      suggestedTags
      status
      createdAt
      reviewedAt
      reviewedBy
    }
  }
`;

const PENDING_COUNT_QUERY = gql`
  query AdminFlaggedItemsPendingCount {
    flaggedItems(status: pending, limit: 50, offset: 0) {
      id
    }
  }
`;

const RESOLVE_FLAGGED_ITEM = gql`
  mutation AdminResolveFlaggedItem(
    $id: ID!
    $status: FlaggedItemStatus!
    $notes: String
  ) {
    resolveFlaggedItem(id: $id, status: $status, notes: $notes) {
      id
      status
      reviewedAt
      reviewedBy
    }
  }
`;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PAGE_LIMIT = 50;

const PRIORITY_CONFIG: Record<
  FlaggedItemPriority,
  { label: string; badgeClass: string; Icon: React.ElementType }
> = {
  critical: {
    label: 'Critical',
    badgeClass:
      'inline-flex items-center gap-1 px-2.5 py-0.5 rounded text-xs font-semibold border border-graphite/20 bg-horizon-red text-white',
    Icon: AlertCircle,
  },
  high: {
    label: 'High',
    badgeClass:
      'inline-flex items-center gap-1 px-2.5 py-0.5 rounded text-xs font-semibold border border-graphite/20 bg-arena-copper text-white',
    Icon: AlertTriangle,
  },
  medium: {
    label: 'Medium',
    badgeClass:
      'inline-flex items-center gap-1 px-2.5 py-0.5 rounded text-xs font-semibold border border-graphite/20 bg-arena-gold text-white',
    Icon: Info,
  },
  low: {
    label: 'Low',
    badgeClass:
      'inline-flex items-center gap-1 px-2.5 py-0.5 rounded text-xs font-semibold border border-graphite/20 bg-ivory-tint text-grey',
    Icon: Minus,
  },
};

const STATUS_BADGE: Record<FlaggedItemStatus, string> = {
  pending: 'badge bg-horizon-red text-white',
  reviewed: 'badge bg-arena-amber text-white',
  resolved: 'badge bg-graphite text-white',
  dismissed: 'badge bg-ivory-tint text-grey',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max).trimEnd() + '…';
}

// ---------------------------------------------------------------------------
// PriorityBadge
// ---------------------------------------------------------------------------

function PriorityBadge({ priority }: { priority: FlaggedItemPriority }) {
  const cfg = PRIORITY_CONFIG[priority];
  const Icon = cfg.Icon;
  return (
    <span className={cfg.badgeClass} aria-label={`Priority: ${cfg.label}`}>
      <Icon size={11} aria-hidden="true" />
      {cfg.label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Tooltip wrapper (pure CSS, no external dep)
// ---------------------------------------------------------------------------

function Tooltip({
  content,
  children,
}: {
  content: string;
  children: React.ReactNode;
}) {
  return (
    <span className="relative group cursor-default">
      {children}
      <span
        role="tooltip"
        className={cn(
          'absolute z-50 left-0 top-full mt-1.5 w-72 max-w-xs',
          'bg-graphite text-ivory text-xs leading-relaxed rounded p-2.5 shadow-lg',
          'invisible opacity-0 group-hover:visible group-hover:opacity-100',
          'transition-opacity duration-150 whitespace-pre-wrap pointer-events-none'
        )}
      >
        {content}
      </span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Detail Dialog
// ---------------------------------------------------------------------------

interface DetailDialogProps {
  item: FlaggedItem;
  onClose: () => void;
  onSuccess: () => void;
}

function DetailDialog({ item, onClose, onSuccess }: DetailDialogProps) {
  const [resolveItem, { loading: resolving }] = useMutation(RESOLVE_FLAGGED_ITEM);

  const [notesResolve, setNotesResolve] = useState('');
  const [notesDismiss, setNotesDismiss] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);

  const handleAction = useCallback(
    async (status: FlaggedItemStatus, notes?: string) => {
      setActionError(null);
      try {
        await resolveItem({
          variables: { id: item.id, status, notes: notes ?? null },
        });
        onSuccess();
        onClose();
      } catch (err) {
        setActionError((err as Error).message);
      }
    },
    [resolveItem, item.id, onSuccess, onClose]
  );

  const isSettled = item.status === 'resolved' || item.status === 'dismissed';

  return (
    <div
      className="modal-backdrop"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="flagged-dialog-title"
    >
      <div
        className="modal-panel max-w-[640px] w-full max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-4 mb-5">
          <div>
            <h2
              id="flagged-dialog-title"
              className="font-semibold text-xl text-graphite"
            >
              Flagged Item
            </h2>
            <p className="text-grey text-sm mt-0.5">
              Turn {item.sourceTurn} &middot; Created {formatDate(item.createdAt)}
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close dialog"
            className="p-1 text-grey hover:text-horizon-red transition-colors shrink-0"
          >
            <X size={18} />
          </button>
        </div>

        {/* Priority + Status row */}
        <div className="flex items-center gap-3 mb-5">
          <PriorityBadge priority={item.priority} />
          <span className={STATUS_BADGE[item.status]}>{item.status}</span>
        </div>

        {/* Description */}
        <div className="mb-5">
          <p className="text-xs font-semibold text-grey uppercase tracking-label mb-1.5">
            Description
          </p>
          <p className="text-sm text-graphite leading-relaxed bg-ivory-tint rounded p-3">
            {item.description}
          </p>
        </div>

        {/* Suggested tags */}
        {item.suggestedTags.length > 0 && (
          <div className="mb-5">
            <p className="text-xs font-semibold text-grey uppercase tracking-label mb-1.5">
              Suggested Tags
            </p>
            <div className="flex flex-wrap gap-2">
              {item.suggestedTags.map((tag) => (
                <span
                  key={tag}
                  className="badge bg-ivory-tint text-graphite border-graphite/20"
                >
                  {tag}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Interview context */}
        <div className="mb-6">
          <p className="text-xs font-semibold text-grey uppercase tracking-label mb-1.5">
            Interview
          </p>
          <Link
            href={`/admin/interviews/${item.interviewId}`}
            className="inline-flex items-center gap-1.5 text-sm text-horizon-red hover:underline"
          >
            View interview record
            <ExternalLink size={13} />
          </Link>
        </div>

        {/* Divider */}
        <hr className="border-ivory-tint mb-5" />

        {isSettled ? (
          <p className="text-sm text-grey italic">
            This item has already been {item.status}
            {item.reviewedAt ? ` on ${formatDate(item.reviewedAt)}` : ''}.
          </p>
        ) : (
          <div className="space-y-5">
            {/* Mark as Reviewed */}
            <div>
              <button
                className="btn-secondary w-full text-left"
                disabled={resolving || item.status === 'reviewed'}
                onClick={() => void handleAction('reviewed')}
              >
                {item.status === 'reviewed'
                  ? 'Already marked as reviewed'
                  : 'Mark as Reviewed'}
              </button>
            </div>

            {/* Resolve with optional notes */}
            <div>
              <label className="block text-sm font-medium text-graphite mb-1.5">
                Resolve (optional notes)
              </label>
              <textarea
                value={notesResolve}
                onChange={(e) => setNotesResolve(e.target.value)}
                rows={3}
                className="input-field text-sm mb-2 resize-none"
                placeholder="Optional resolution notes…"
                disabled={resolving}
              />
              <button
                className="btn-primary"
                disabled={resolving}
                onClick={() => void handleAction('resolved', notesResolve || undefined)}
              >
                {resolving ? 'Saving…' : 'Resolve'}
              </button>
            </div>

            {/* Dismiss with required reason */}
            <div>
              <label className="block text-sm font-medium text-graphite mb-1.5">
                Dismiss <span className="text-horizon-red">*</span>{' '}
                <span className="text-grey font-normal text-xs">(reason required)</span>
              </label>
              <textarea
                value={notesDismiss}
                onChange={(e) => setNotesDismiss(e.target.value)}
                rows={3}
                className="input-field text-sm mb-2 resize-none"
                placeholder="Reason for dismissal…"
                disabled={resolving}
              />
              <button
                className="btn-wine"
                disabled={resolving || notesDismiss.trim().length === 0}
                onClick={() => void handleAction('dismissed', notesDismiss)}
              >
                {resolving ? 'Saving…' : 'Dismiss'}
              </button>
            </div>
          </div>
        )}

        {actionError && (
          <div role="alert" className="alert-error mt-4">
            {actionError}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// FlaggedItemsPage
// ---------------------------------------------------------------------------

export default function FlaggedItemsPage() {
  const [filterPriority, setFilterPriority] = useState<FlaggedItemPriority | ''>('');
  const [filterStatus, setFilterStatus] = useState<FlaggedItemStatus | ''>('');
  const [offset, setOffset] = useState(0);
  const [selectedItem, setSelectedItem] = useState<FlaggedItem | null>(null);

  const queryVars = {
    status: filterStatus || undefined,
    priority: filterPriority || undefined,
    limit: PAGE_LIMIT,
    offset,
  };

  const { data, loading, error, refetch } = useQuery<{
    flaggedItems: FlaggedItem[];
  }>(FLAGGED_ITEMS_QUERY, {
    variables: queryVars,
    fetchPolicy: 'cache-and-network',
  });

  const items = data?.flaggedItems ?? [];
  const hasMore = items.length === PAGE_LIMIT;

  const handleFilterChange = useCallback(() => {
    setOffset(0);
  }, []);

  const handleMutationSuccess = useCallback(() => {
    void refetch();
  }, [refetch]);

  return (
    <>
      {/* Header */}
      <header className="page-header">
        <h2 className="font-semibold text-[22px] text-graphite">Flagged Items</h2>
        <p className="text-grey text-sm">
          Review items flagged during interviews by the enrichment pipeline or
          interviewer LLM.
        </p>
      </header>

      {/* Content */}
      <div className="page-content">
        {/* Filters */}
        <div className="flex flex-wrap items-center gap-3 mb-5">
          <select
            className="select-field"
            value={filterPriority}
            onChange={(e) => {
              setFilterPriority(e.target.value as FlaggedItemPriority | '');
              handleFilterChange();
            }}
            aria-label="Filter by priority"
          >
            <option value="">All priorities</option>
            <option value="critical">Critical</option>
            <option value="high">High</option>
            <option value="medium">Medium</option>
            <option value="low">Low</option>
          </select>

          <select
            className="select-field"
            value={filterStatus}
            onChange={(e) => {
              setFilterStatus(e.target.value as FlaggedItemStatus | '');
              handleFilterChange();
            }}
            aria-label="Filter by status"
          >
            <option value="">All statuses</option>
            <option value="pending">Pending</option>
            <option value="reviewed">Reviewed</option>
            <option value="resolved">Resolved</option>
            <option value="dismissed">Dismissed</option>
          </select>

          {(filterPriority || filterStatus) && (
            <button
              className="btn-ghost text-xs"
              onClick={() => {
                setFilterPriority('');
                setFilterStatus('');
                setOffset(0);
              }}
            >
              Clear filters
            </button>
          )}
        </div>

        {error && (
          <div role="alert" className="alert-error mb-4">
            Failed to load flagged items: {error.message}
          </div>
        )}

        {loading && items.length === 0 ? (
          <div className="text-center py-16 text-grey text-[15px]">
            Loading flagged items…
          </div>
        ) : items.length === 0 ? (
          <div className="text-center py-16 text-grey text-[15px]">
            No flagged items match these filters.
          </div>
        ) : (
          <>
            <div className="bg-white rounded border border-ivory-tint overflow-hidden">
              {/* Table header */}
              <div
                className="grid py-2.5 px-[18px] border-b border-graphite/20 bg-graphite gap-3"
                style={{
                  gridTemplateColumns: '130px 1fr 80px 1fr 80px 100px 110px',
                }}
              >
                {[
                  'Priority',
                  'Interview',
                  'Turn',
                  'Description',
                  'Tags',
                  'Status',
                  'Created',
                ].map((h) => (
                  <span key={h} className="col-header">
                    {h}
                  </span>
                ))}
              </div>

              {/* Rows */}
              {items.map((item, i) => (
                <div
                  key={item.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => setSelectedItem(item)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      setSelectedItem(item);
                    }
                  }}
                  className={cn(
                    'grid py-3 px-[18px] items-center gap-3 cursor-pointer',
                    'transition-colors duration-100 hover:bg-horizon-red/[0.03]',
                    'border-b border-ivory-tint last:border-b-0',
                    i % 2 === 0 ? 'bg-white' : 'bg-ivory-tint'
                  )}
                  style={{
                    gridTemplateColumns: '130px 1fr 80px 1fr 80px 100px 110px',
                  }}
                >
                  {/* Priority */}
                  <div>
                    <PriorityBadge priority={item.priority} />
                  </div>

                  {/* Interview link */}
                  <div
                    onClick={(e) => e.stopPropagation()}
                    className="min-w-0"
                  >
                    <Link
                      href={`/admin/interviews/${item.interviewId}`}
                      className="text-sm text-horizon-red hover:underline font-mono truncate block"
                      title={item.interviewId}
                    >
                      {item.interviewId.slice(0, 8)}…
                    </Link>
                  </div>

                  {/* Source turn */}
                  <span className="text-sm text-graphite text-center">
                    {item.sourceTurn}
                  </span>

                  {/* Description (truncated with tooltip) */}
                  <div className="min-w-0">
                    {item.description.length > 120 ? (
                      <Tooltip content={item.description}>
                        <span className="text-sm text-graphite">
                          {truncate(item.description, 120)}
                        </span>
                      </Tooltip>
                    ) : (
                      <span className="text-sm text-graphite">
                        {item.description}
                      </span>
                    )}
                  </div>

                  {/* Suggested tag count */}
                  <span className="text-sm text-graphite text-center">
                    {item.suggestedTags.length}
                  </span>

                  {/* Status */}
                  <div>
                    <span className={STATUS_BADGE[item.status]}>{item.status}</span>
                  </div>

                  {/* Created */}
                  <span className="text-[13px] text-grey">
                    {formatDate(item.createdAt)}
                  </span>
                </div>
              ))}
            </div>

            {/* Load more */}
            {hasMore && (
              <div className="mt-4 flex justify-center">
                <button
                  className="btn-secondary"
                  disabled={loading}
                  onClick={() => setOffset((prev) => prev + PAGE_LIMIT)}
                >
                  {loading ? 'Loading…' : 'Load more'}
                </button>
              </div>
            )}
          </>
        )}
      </div>

      {/* Detail dialog */}
      {selectedItem && (
        <DetailDialog
          item={selectedItem}
          onClose={() => setSelectedItem(null)}
          onSuccess={handleMutationSuccess}
        />
      )}
    </>
  );
}
