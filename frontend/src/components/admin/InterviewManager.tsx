'use client';

import React, { useState } from 'react';
import { useQuery, gql } from '@apollo/client';
import { cn } from '@/lib/utils';
import { StatusBadge } from '@/components/ui/StatusBadge';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface InterviewUser {
  id: string;
  name: string;
  email: string;
}

interface InterviewTemplate {
  id: string;
  name: string;
}

interface InterviewResponse {
  id: string;
}

interface CostSummary {
  totalLlmPromptTokens: number;
  totalLlmCompletionTokens: number;
  totalSttDurationSeconds: number;
  totalTtsCharacters: number;
}

interface Interview {
  id: string;
  user: InterviewUser;
  template: InterviewTemplate;
  status: string;
  startedAt: string | null;
  completedAt: string | null;
  responses: InterviewResponse[];
  costSummary: CostSummary;
}

interface InterviewEdge {
  cursor: string;
  node: Interview;
}

interface PageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

// ---------------------------------------------------------------------------
// GQL
// ---------------------------------------------------------------------------

const LIST_ALL_INTERVIEWS = gql`
  query AdminListInterviews($status: String, $first: Int, $after: String) {
    listAllInterviews(status: $status, first: $first, after: $after) {
      edges {
        cursor
        node {
          id
          user { id name email }
          template { id name }
          status
          startedAt
          completedAt
          responses { id }
          costSummary {
            totalLlmPromptTokens
            totalLlmCompletionTokens
            totalSttDurationSeconds
            totalTtsCharacters
          }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
      totalCount
    }
  }
`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// ---------------------------------------------------------------------------
// InterviewManager
// ---------------------------------------------------------------------------

const STATUSES = ['', 'scheduled', 'in_progress', 'paused', 'completed', 'abandoned'];

export default function InterviewManager() {
  const [filterStatus, setFilterStatus] = useState<string>('');
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const { data, loading, error, fetchMore } = useQuery<{
    listAllInterviews: {
      edges: InterviewEdge[];
      pageInfo: PageInfo;
      totalCount: number;
    };
  }>(LIST_ALL_INTERVIEWS, {
    variables: { status: filterStatus || undefined, first: 25 },
    fetchPolicy: 'cache-and-network',
  });

  const edges = data?.listAllInterviews.edges ?? [];
  const pageInfo = data?.listAllInterviews.pageInfo;
  const totalCount = data?.listAllInterviews.totalCount ?? 0;

  const handleLoadMore = () => {
    if (!pageInfo?.hasNextPage || !pageInfo.endCursor) return;
    void fetchMore({
      variables: { after: pageInfo.endCursor },
      updateQuery: (prev, { fetchMoreResult }) => {
        if (!fetchMoreResult) return prev;
        return {
          listAllInterviews: {
            ...fetchMoreResult.listAllInterviews,
            edges: [
              ...prev.listAllInterviews.edges,
              ...fetchMoreResult.listAllInterviews.edges,
            ],
          },
        };
      },
    });
  };

  return (
    <>
      {/* Header */}
      <header className="page-header flex items-center justify-between gap-4">
        <div>
          <h2 className="font-semibold text-[22px] text-graphite">Interviews</h2>
          <p className="text-grey text-sm">
            View all interviews across users. {totalCount > 0 && `${totalCount} total.`}
          </p>
        </div>
      </header>

      {/* Content */}
      <div className="page-content">
        {/* Filter */}
        <div className="mb-5">
          <select
            value={filterStatus}
            onChange={(e) => setFilterStatus(e.target.value)}
            className="select-field w-[200px]"
          >
            <option value="">All Statuses</option>
            {STATUSES.filter(Boolean).map((s) => (
              <option key={s} value={s}>
                {s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())}
              </option>
            ))}
          </select>
        </div>

        {error && (
          <div role="alert" className="alert-error mb-4">
            Failed to load interviews: {error.message}
          </div>
        )}

        {loading && edges.length === 0 ? (
          <div className="text-center py-16 text-grey text-[15px]">
            Loading interviews…
          </div>
        ) : edges.length === 0 ? (
          <div className="text-center py-16 text-grey text-[15px]">
            No interviews found.
          </div>
        ) : (
          <>
            <div className="bg-white rounded border border-ivory-tint overflow-hidden">
              {/* Table header */}
              <div className="grid grid-cols-[1fr_1fr_110px_140px_140px] py-2.5 px-[18px] border-b border-graphite/20 bg-graphite gap-3">
                {['Candidate', 'Template', 'Status', 'Started', 'Completed'].map((h) => (
                  <span key={h} className={cn('col-header', h === 'Status' && 'text-center')}>{h}</span>
                ))}
              </div>

              {/* Rows */}
              {edges.map(({ node: interview }, i) => {
                const expanded = expandedId === interview.id;
                return (
                  <div key={interview.id}>
                    <div
                      onClick={() => setExpandedId(expanded ? null : interview.id)}
                      className={cn(
                        'grid grid-cols-[1fr_1fr_110px_140px_140px] py-3.5 px-[18px] items-center gap-3 cursor-pointer',
                        'transition-colors duration-100 hover:bg-horizon-red/[0.03]',
                        !expanded && i < edges.length - 1 && 'border-b border-ivory-tint',
                        i % 2 === 0 ? 'bg-white' : 'bg-ivory-tint'
                      )}
                    >
                      <div>
                        <span className="text-sm font-medium text-graphite">{interview.user.name}</span>
                        <br />
                        <span className="text-xs text-grey">{interview.user.email}</span>
                      </div>

                      <span className="text-sm text-graphite">{interview.template.name}</span>

                      <div className="flex justify-center">
                        <StatusBadge status={interview.status} />
                      </div>

                      <span className="text-[13px] text-grey">{formatDate(interview.startedAt)}</span>

                      <span className="text-[13px] text-grey">{formatDate(interview.completedAt)}</span>
                    </div>

                    {/* Expanded detail */}
                    {expanded && (
                      <div
                        className={cn(
                          'py-4 px-[18px] pb-5 bg-horizon-red/[0.02]',
                          i < edges.length - 1 && 'border-b border-ivory-tint'
                        )}
                      >
                        <div className="flex gap-8 flex-wrap">
                          <div>
                            <span className="col-header block mb-1">Responses</span>
                            <span className="text-xl font-semibold text-graphite font-mono">
                              {interview.responses.length}
                            </span>
                          </div>
                          <div>
                            <span className="col-header block mb-1">LLM Tokens</span>
                            <span className="text-sm text-graphite font-mono">
                              {(interview.costSummary.totalLlmPromptTokens + interview.costSummary.totalLlmCompletionTokens).toLocaleString()}
                            </span>
                            <span className="text-xs text-grey ml-1.5">
                              ({interview.costSummary.totalLlmPromptTokens.toLocaleString()} prompt + {interview.costSummary.totalLlmCompletionTokens.toLocaleString()} completion)
                            </span>
                          </div>
                          <div>
                            <span className="col-header block mb-1">STT Duration</span>
                            <span className="text-sm text-graphite font-mono">
                              {interview.costSummary.totalSttDurationSeconds.toFixed(1)}s
                            </span>
                          </div>
                          <div>
                            <span className="col-header block mb-1">TTS Characters</span>
                            <span className="text-sm text-graphite font-mono">
                              {interview.costSummary.totalTtsCharacters.toLocaleString()}
                            </span>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Load more */}
            {pageInfo?.hasNextPage && (
              <div className="text-center mt-5">
                <button onClick={handleLoadMore} className="btn-amber">
                  Load More
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}
