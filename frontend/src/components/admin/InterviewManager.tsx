'use client';

import React, { useState } from 'react';
import { useQuery, gql } from '@apollo/client';

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
// Styles
// ---------------------------------------------------------------------------

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

const colHeader: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  color: 'var(--grey)',
  textTransform: 'uppercase',
  letterSpacing: '0.07em',
};

// ---------------------------------------------------------------------------
// Status badge
// ---------------------------------------------------------------------------

const STATUS_STYLES: Record<string, { bg: string; color: string }> = {
  scheduled: { bg: '#DBEAFE', color: '#1D4ED8' },
  in_progress: { bg: '#FEF3C7', color: '#92400E' },
  paused: { bg: '#F3E8FF', color: '#7C3AED' },
  completed: { bg: '#DCFCE7', color: '#15803D' },
  abandoned: { bg: '#F3F4F6', color: '#6B7280' },
};

function StatusBadge({ status }: { status: string }) {
  const s = STATUS_STYLES[status] ?? STATUS_STYLES.scheduled;
  const label = status.replace(/_/g, ' ');
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '3px 10px',
        borderRadius: 999,
        fontSize: 12,
        fontWeight: 600,
        backgroundColor: s.bg,
        color: s.color,
        textTransform: 'capitalize',
        width: 'fit-content',
      }}
    >
      {label}
    </span>
  );
}

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
          <h2 style={{ fontWeight: 600, fontSize: 22, color: 'var(--graphite)' }}>Interviews</h2>
          <p style={{ color: 'var(--grey)', fontSize: 14 }}>
            View all interviews across users. {totalCount > 0 && `${totalCount} total.`}
          </p>
        </div>
      </header>

      {/* Content */}
      <div style={{ padding: '24px 32px' }}>
        {/* Filter */}
        <div style={{ marginBottom: 20 }}>
          <select
            value={filterStatus}
            onChange={(e) => setFilterStatus(e.target.value)}
            style={{ ...inputStyle, width: 200, cursor: 'pointer' }}
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
            Failed to load interviews: {error.message}
          </div>
        )}

        {loading && edges.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '64px 0', color: 'var(--grey)', fontSize: 15 }}>
            Loading interviews…
          </div>
        ) : edges.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '64px 0', color: 'var(--grey)', fontSize: 15 }}>
            No interviews found.
          </div>
        ) : (
          <>
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
                  gridTemplateColumns: '1fr 1fr 110px 140px 140px',
                  padding: '11px 18px',
                  borderBottom: '1px solid var(--ivory-tint)',
                  backgroundColor: 'var(--ivory)',
                  gap: 12,
                }}
              >
                {['Candidate', 'Template', 'Status', 'Started', 'Completed'].map((h) => (
                  <span key={h} style={colHeader}>
                    {h}
                  </span>
                ))}
              </div>

              {/* Rows */}
              {edges.map(({ node: interview }, i) => {
                const expanded = expandedId === interview.id;
                return (
                  <div key={interview.id}>
                    <div
                      onClick={() => setExpandedId(expanded ? null : interview.id)}
                      style={{
                        display: 'grid',
                        gridTemplateColumns: '1fr 1fr 110px 140px 140px',
                        padding: '14px 18px',
                        borderBottom: expanded ? 'none' : i < edges.length - 1 ? '1px solid var(--ivory-tint)' : 'none',
                        alignItems: 'center',
                        gap: 12,
                        cursor: 'pointer',
                        backgroundColor: i % 2 === 0 ? 'var(--white)' : 'var(--ivory)',
                        transition: 'background-color 0.1s',
                      }}
                      onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = 'rgba(122,14,19,0.03)'; }}
                      onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = i % 2 === 0 ? 'var(--white)' : 'var(--ivory)'; }}
                    >
                      <div>
                        <span style={{ fontSize: 14, fontWeight: 500, color: 'var(--graphite)' }}>
                          {interview.user.name}
                        </span>
                        <br />
                        <span style={{ fontSize: 12, color: 'var(--grey)' }}>{interview.user.email}</span>
                      </div>

                      <span style={{ fontSize: 14, color: 'var(--graphite)' }}>
                        {interview.template.name}
                      </span>

                      <StatusBadge status={interview.status} />

                      <span style={{ fontSize: 13, color: 'var(--grey)' }}>
                        {formatDate(interview.startedAt)}
                      </span>

                      <span style={{ fontSize: 13, color: 'var(--grey)' }}>
                        {formatDate(interview.completedAt)}
                      </span>
                    </div>

                    {/* Expanded detail */}
                    {expanded && (
                      <div
                        style={{
                          padding: '16px 18px 20px',
                          borderBottom: i < edges.length - 1 ? '1px solid var(--ivory-tint)' : 'none',
                          backgroundColor: 'rgba(122,14,19,0.02)',
                        }}
                      >
                        <div style={{ display: 'flex', gap: 32, flexWrap: 'wrap' }}>
                          <div>
                            <span style={{ ...colHeader, display: 'block', marginBottom: 4 }}>Responses</span>
                            <span style={{ fontSize: 20, fontWeight: 600, color: 'var(--graphite)', fontFamily: 'var(--font-mono)' }}>
                              {interview.responses.length}
                            </span>
                          </div>
                          <div>
                            <span style={{ ...colHeader, display: 'block', marginBottom: 4 }}>LLM Tokens</span>
                            <span style={{ fontSize: 14, color: 'var(--graphite)', fontFamily: 'var(--font-mono)' }}>
                              {(interview.costSummary.totalLlmPromptTokens + interview.costSummary.totalLlmCompletionTokens).toLocaleString()}
                            </span>
                            <span style={{ fontSize: 12, color: 'var(--grey)', marginLeft: 6 }}>
                              ({interview.costSummary.totalLlmPromptTokens.toLocaleString()} prompt + {interview.costSummary.totalLlmCompletionTokens.toLocaleString()} completion)
                            </span>
                          </div>
                          <div>
                            <span style={{ ...colHeader, display: 'block', marginBottom: 4 }}>STT Duration</span>
                            <span style={{ fontSize: 14, color: 'var(--graphite)', fontFamily: 'var(--font-mono)' }}>
                              {interview.costSummary.totalSttDurationSeconds.toFixed(1)}s
                            </span>
                          </div>
                          <div>
                            <span style={{ ...colHeader, display: 'block', marginBottom: 4 }}>TTS Characters</span>
                            <span style={{ fontSize: 14, color: 'var(--graphite)', fontFamily: 'var(--font-mono)' }}>
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
              <div style={{ textAlign: 'center', marginTop: 20 }}>
                <button
                  onClick={handleLoadMore}
                  style={{
                    padding: '10px 24px',
                    borderRadius: 999,
                    border: '1px solid var(--ivory-tint)',
                    backgroundColor: 'var(--white)',
                    color: 'var(--graphite)',
                    fontFamily: 'var(--font-primary)',
                    fontWeight: 500,
                    fontSize: 14,
                    cursor: 'pointer',
                  }}
                >
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
