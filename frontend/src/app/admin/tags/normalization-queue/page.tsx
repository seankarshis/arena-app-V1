'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { useQuery, useMutation, gql } from '@apollo/client';
import { cn } from '@/lib/utils';
import { StatusBadge } from '@/components/ui/StatusBadge';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ProposalStatus = 'pending' | 'approved' | 'rejected';

interface Tag {
  id: string;
  label: string;
  isActive: boolean;
}

interface TagMergeProposal {
  id: string;
  canonicalTagId: string;
  candidateTagIds: string[];
  rationale: string | null;
  status: ProposalStatus;
  proposedAt: string;
  createdAt: string;
  reviewedAt: string | null;
  reviewedBy: string | null;
  rejectedReason: string | null;
}

// ---------------------------------------------------------------------------
// GQL
// ---------------------------------------------------------------------------

const GET_PROPOSALS = gql`
  query AdminTagMergeProposals($status: TagMergeProposalStatus, $limit: Int) {
    tagMergeProposals(status: $status, limit: $limit) {
      id
      canonicalTagId
      candidateTagIds
      rationale
      status
      proposedAt
      createdAt
      reviewedAt
      reviewedBy
      rejectedReason
    }
  }
`;

const GET_TAGS = gql`
  query AdminGetTagsForQueue {
    getTags(includeInactive: false) {
      id
      label
      isActive
    }
  }
`;

const APPROVE_PROPOSAL = gql`
  mutation AdminApproveTagMergeProposal($id: ID!, $canonicalTagId: ID) {
    approveTagMergeProposal(id: $id, canonicalTagId: $canonicalTagId) {
      id
      status
      reviewedAt
      reviewedBy
    }
  }
`;

const REJECT_PROPOSAL = gql`
  mutation AdminRejectTagMergeProposal($id: ID!, $reason: String!) {
    rejectTagMergeProposal(id: $id, reason: $reason) {
      id
      status
      reviewedAt
      reviewedBy
      rejectedReason
    }
  }
`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return iso;
  }
}

// ---------------------------------------------------------------------------
// ApproveDialog
// ---------------------------------------------------------------------------

interface ApproveDialogProps {
  proposal: TagMergeProposal;
  tags: Tag[];
  onConfirm: (canonicalTagId: string | null) => void;
  onClose: () => void;
  isSaving: boolean;
  error: string | null;
}

function ApproveDialog({ proposal, tags, onConfirm, onClose, isSaving, error }: ApproveDialogProps) {
  const [selectedTagId, setSelectedTagId] = useState<string>('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onConfirm(selectedTagId.trim() || null);
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-panel max-w-[540px]" onClick={(e) => e.stopPropagation()}>
        <h2 className="font-semibold text-xl text-graphite mb-2">Approve Merge Proposal</h2>
        <p className="text-sm text-grey mb-6">
          Optionally override the canonical tag. If left blank, the proposal&apos;s
          existing canonical tag is used as the merge target.
        </p>

        <form onSubmit={handleSubmit}>
          <div className="mb-5">
            <label className="block font-medium text-sm text-graphite mb-1.5">
              Merge into tag (optional override)
            </label>
            <select
              value={selectedTagId}
              onChange={(e) => setSelectedTagId(e.target.value)}
              className="select-field w-full"
            >
              <option value="">— Use proposal&apos;s canonical tag ({proposal.canonicalTagId}) —</option>
              {tags.map((tag) => (
                <option key={tag.id} value={tag.id}>
                  {tag.label} ({tag.id})
                </option>
              ))}
            </select>
          </div>

          {error && <div className="alert-error mb-4">{error}</div>}

          <div className="flex justify-end gap-3">
            <button type="button" onClick={onClose} disabled={isSaving} className={cn('btn-secondary', isSaving && 'opacity-60')}>
              Cancel
            </button>
            <button type="submit" disabled={isSaving} className="btn-primary">
              {isSaving ? 'Approving…' : 'Approve'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// RejectDialog
// ---------------------------------------------------------------------------

interface RejectDialogProps {
  onConfirm: (reason: string) => void;
  onClose: () => void;
  isSaving: boolean;
  error: string | null;
}

function RejectDialog({ onConfirm, onClose, isSaving, error }: RejectDialogProps) {
  const [reason, setReason] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (reason.trim()) {
      onConfirm(reason.trim());
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-panel max-w-[480px]" onClick={(e) => e.stopPropagation()}>
        <h2 className="font-semibold text-xl text-graphite mb-2">Reject Merge Proposal</h2>
        <p className="text-sm text-grey mb-6">
          Provide a reason for rejection. This is stored for audit purposes.
        </p>

        <form onSubmit={handleSubmit}>
          <div className="mb-5">
            <label className="block font-medium text-sm text-graphite mb-1.5">
              Reason *
            </label>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              required
              autoFocus
              rows={3}
              className="input-field text-sm resize-none"
              placeholder="e.g. Tags are semantically distinct and should remain separate."
            />
          </div>

          {error && <div className="alert-error mb-4">{error}</div>}

          <div className="flex justify-end gap-3">
            <button type="button" onClick={onClose} disabled={isSaving} className={cn('btn-secondary', isSaving && 'opacity-60')}>
              Cancel
            </button>
            <button type="submit" disabled={isSaving || !reason.trim()} className="btn-wine">
              {isSaving ? 'Rejecting…' : 'Reject'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ProposalCard
// ---------------------------------------------------------------------------

interface ProposalCardProps {
  proposal: TagMergeProposal;
  tags: Tag[];
  onApprove: (proposal: TagMergeProposal) => void;
  onReject: (proposal: TagMergeProposal) => void;
}

function tagLabel(id: string, tags: Tag[]): string {
  const found = tags.find((t) => t.id === id);
  return found ? `${found.label} (${id})` : id;
}

function ProposalCard({ proposal, tags, onApprove, onReject }: ProposalCardProps) {
  return (
    <div className="card mb-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          {/* Canonical target */}
          <div className="mb-3">
            <span className="text-xs font-semibold uppercase tracking-wide text-grey block mb-1">
              Canonical Target
            </span>
            <span className="text-sm font-medium text-graphite">
              {tagLabel(proposal.canonicalTagId, tags)}
            </span>
          </div>

          {/* Candidates */}
          <div className="mb-3">
            <span className="text-xs font-semibold uppercase tracking-wide text-grey block mb-1">
              Candidate Tags ({proposal.candidateTagIds.length})
            </span>
            <div className="flex flex-wrap gap-1.5">
              {proposal.candidateTagIds.map((cid) => (
                <span
                  key={cid}
                  className="inline-block px-2 py-0.5 rounded text-xs bg-ivory-tint text-graphite border border-graphite/15"
                >
                  {tagLabel(cid, tags)}
                </span>
              ))}
            </div>
          </div>

          {/* Rationale */}
          {proposal.rationale && (
            <div className="mb-3">
              <span className="text-xs font-semibold uppercase tracking-wide text-grey block mb-1">
                Rationale
              </span>
              <p className="text-sm text-graphite">{proposal.rationale}</p>
            </div>
          )}

          {/* Metadata row */}
          <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-grey mt-3">
            <span>Proposed: {formatDate(proposal.proposedAt)}</span>
            <span>Created: {formatDate(proposal.createdAt)}</span>
            {proposal.reviewedAt && <span>Reviewed: {formatDate(proposal.reviewedAt)}</span>}
            {proposal.reviewedBy && <span>Reviewed by: {proposal.reviewedBy}</span>}
            {proposal.rejectedReason && (
              <span className="text-horizon-red">Reason: {proposal.rejectedReason}</span>
            )}
          </div>
        </div>

        {/* Status + Actions */}
        <div className="flex flex-col items-end gap-3 shrink-0">
          <StatusBadge status={proposal.status} />
          {proposal.status === 'pending' && (
            <div className="flex gap-2">
              <button
                onClick={() => onReject(proposal)}
                className="btn-wine py-1 px-3 text-[13px]"
              >
                Reject
              </button>
              <button
                onClick={() => onApprove(proposal)}
                className="btn-primary py-1 px-3 text-[13px]"
              >
                Approve
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// NormalizationQueuePage
// ---------------------------------------------------------------------------

const STATUS_TABS: { label: string; value: ProposalStatus }[] = [
  { label: 'Pending', value: 'pending' },
  { label: 'Approved', value: 'approved' },
  { label: 'Rejected', value: 'rejected' },
];

export default function NormalizationQueuePage() {
  const [activeTab, setActiveTab] = useState<ProposalStatus>('pending');
  const [approveTarget, setApproveTarget] = useState<TagMergeProposal | null>(null);
  const [rejectTarget, setRejectTarget] = useState<TagMergeProposal | null>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);

  const {
    data: proposalsData,
    loading: proposalsLoading,
    error: proposalsError,
    refetch: refetchProposals,
  } = useQuery<{ tagMergeProposals: TagMergeProposal[] }>(GET_PROPOSALS, {
    variables: { status: activeTab, limit: 100 },
    fetchPolicy: 'cache-and-network',
  });

  const { data: tagsData } = useQuery<{ getTags: Tag[] }>(GET_TAGS, {
    fetchPolicy: 'cache-and-network',
  });

  const [approveProposal, { loading: approving }] = useMutation(APPROVE_PROPOSAL);
  const [rejectProposal, { loading: rejecting }] = useMutation(REJECT_PROPOSAL);

  const proposals = proposalsData?.tagMergeProposals ?? [];
  const tags = tagsData?.getTags ?? [];

  const handleTabChange = (tab: ProposalStatus) => {
    setActiveTab(tab);
    void refetchProposals({ status: tab, limit: 100 });
  };

  const openApprove = (proposal: TagMergeProposal) => {
    setDialogError(null);
    setApproveTarget(proposal);
  };

  const openReject = (proposal: TagMergeProposal) => {
    setDialogError(null);
    setRejectTarget(proposal);
  };

  const closeDialogs = () => {
    setApproveTarget(null);
    setRejectTarget(null);
    setDialogError(null);
  };

  const handleApproveConfirm = async (canonicalTagId: string | null) => {
    if (!approveTarget) return;
    setDialogError(null);
    try {
      await approveProposal({
        variables: { id: approveTarget.id, canonicalTagId: canonicalTagId ?? undefined },
      });
      closeDialogs();
      void refetchProposals();
    } catch (err) {
      setDialogError((err as Error).message);
    }
  };

  const handleRejectConfirm = async (reason: string) => {
    if (!rejectTarget) return;
    setDialogError(null);
    try {
      await rejectProposal({
        variables: { id: rejectTarget.id, reason },
      });
      closeDialogs();
      void refetchProposals();
    } catch (err) {
      setDialogError((err as Error).message);
    }
  };

  return (
    <>
      {/* Header */}
      <header className="page-header flex items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Link href="/admin/tags" className="text-sm text-grey hover:text-horizon-red transition-colors">
              Tags
            </Link>
            <span className="text-grey text-sm">/</span>
            <span className="text-sm text-graphite font-medium">Normalization Queue</span>
          </div>
          <h2 className="font-semibold text-[22px] text-graphite">Tag Normalization Queue</h2>
          <p className="text-grey text-sm">
            Review merge proposals generated by the enrichment pipeline. Approve to consolidate synonymous tags; reject to keep them separate.
          </p>
        </div>
      </header>

      {/* Content */}
      <div className="page-content">
        {/* Tabs */}
        <div className="flex gap-0 mb-6 border-b border-ivory-tint">
          {STATUS_TABS.map((tab) => (
            <button
              key={tab.value}
              onClick={() => handleTabChange(tab.value)}
              className={cn(
                'px-5 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors duration-150',
                activeTab === tab.value
                  ? 'border-horizon-red text-horizon-red'
                  : 'border-transparent text-grey hover:text-graphite'
              )}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Error */}
        {proposalsError && (
          <div role="alert" className="alert-error mb-4">
            Failed to load proposals: {proposalsError.message}
          </div>
        )}

        {/* Loading */}
        {proposalsLoading && proposals.length === 0 ? (
          <div className="text-center py-16 text-grey text-[15px]">Loading proposals…</div>
        ) : proposals.length === 0 ? (
          <div className="text-center py-16 text-grey text-[15px] max-w-[480px] mx-auto">
            {activeTab === 'pending'
              ? 'No pending proposals. The enrichment pipeline creates these when it encounters tags not in the canonical vocabulary.'
              : `No ${activeTab} proposals.`}
          </div>
        ) : (
          <div>
            {proposals.map((proposal) => (
              <ProposalCard
                key={proposal.id}
                proposal={proposal}
                tags={tags}
                onApprove={openApprove}
                onReject={openReject}
              />
            ))}
          </div>
        )}
      </div>

      {/* Approve dialog */}
      {approveTarget && (
        <ApproveDialog
          proposal={approveTarget}
          tags={tags}
          onConfirm={(id) => void handleApproveConfirm(id)}
          onClose={closeDialogs}
          isSaving={approving}
          error={dialogError}
        />
      )}

      {/* Reject dialog */}
      {rejectTarget && (
        <RejectDialog
          onConfirm={(reason) => void handleRejectConfirm(reason)}
          onClose={closeDialogs}
          isSaving={rejecting}
          error={dialogError}
        />
      )}
    </>
  );
}
