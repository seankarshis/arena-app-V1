'use client';

import React from 'react';
import { useQuery, gql } from '@apollo/client';
import Link from 'next/link';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Template {
  id: string;
  name: string;
  status: string;
}

interface Tag {
  id: string;
}

interface UserRef {
  id: string;
}

interface InterviewNode {
  id: string;
  user: { name: string };
  template: { name: string };
  status: string;
  startedAt: string | null;
  completedAt: string | null;
}

// ---------------------------------------------------------------------------
// GQL
// ---------------------------------------------------------------------------

const DASHBOARD_QUERY = gql`
  query AdminDashboard {
    getTemplates {
      id
      name
      status
    }
    getQuestions(first: 1) {
      totalCount
    }
    getTags(includeInactive: true) {
      id
    }
    listUsers {
      id
    }
    listAllInterviews(first: 5) {
      edges {
        node {
          id
          user { name }
          template { name }
          status
          startedAt
          completedAt
        }
      }
      totalCount
    }
  }
`;

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const cardStyle: React.CSSProperties = {
  backgroundColor: 'var(--white)',
  borderRadius: 8,
  padding: '24px',
  boxShadow: '0 1px 3px rgba(0,0,0,0.08)',
  border: '1px solid var(--ivory-tint)',
};

const statNumber: React.CSSProperties = {
  fontSize: 32,
  fontWeight: 700,
  color: 'var(--graphite)',
  fontFamily: 'var(--font-primary)',
  lineHeight: 1.1,
};

const statLabel: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 500,
  color: 'var(--grey)',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  marginTop: 4,
};

const statBreakdown: React.CSSProperties = {
  fontSize: 12,
  color: 'var(--grey)',
  marginTop: 8,
};

const colHeader: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  color: 'var(--grey)',
  textTransform: 'uppercase',
  letterSpacing: '0.07em',
};

const quickAction: React.CSSProperties = {
  padding: '10px 20px',
  borderRadius: 999,
  border: '1px solid var(--ivory-tint)',
  backgroundColor: 'var(--white)',
  color: 'var(--graphite)',
  fontFamily: 'var(--font-primary)',
  fontWeight: 500,
  fontSize: 14,
  cursor: 'pointer',
  textDecoration: 'none',
  display: 'inline-block',
};

// ---------------------------------------------------------------------------
// Status helpers
// ---------------------------------------------------------------------------

const STATUS_STYLES: Record<string, { bg: string; color: string }> = {
  scheduled: { bg: '#DBEAFE', color: '#1D4ED8' },
  in_progress: { bg: '#FEF3C7', color: '#92400E' },
  paused: { bg: '#F3E8FF', color: '#7C3AED' },
  completed: { bg: '#DCFCE7', color: '#15803D' },
  abandoned: { bg: '#F3F4F6', color: '#6B7280' },
  draft: { bg: '#FEF3C7', color: '#92400E' },
  published: { bg: '#DCFCE7', color: '#15803D' },
  archived: { bg: '#F3F4F6', color: '#6B7280' },
};

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

export default function AdminDashboard() {
  const { data, loading, error } = useQuery<{
    getTemplates: Template[];
    getQuestions: { totalCount: number };
    getTags: Tag[];
    listUsers: UserRef[];
    listAllInterviews: {
      edges: { node: InterviewNode }[];
      totalCount: number;
    };
  }>(DASHBOARD_QUERY, { fetchPolicy: 'cache-and-network' });

  const templates = data?.getTemplates ?? [];
  const questionCount = data?.getQuestions?.totalCount ?? 0;
  const tagCount = data?.getTags?.length ?? 0;
  const userCount = data?.listUsers?.length ?? 0;
  const interviewEdges = data?.listAllInterviews?.edges ?? [];
  const interviewTotal = data?.listAllInterviews?.totalCount ?? 0;

  // Template breakdown
  const templatesByStatus = templates.reduce<Record<string, number>>((acc, t) => {
    acc[t.status] = (acc[t.status] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <>
      {/* Header */}
      <header
        style={{
          padding: '20px 32px',
          borderBottom: '1px solid var(--ivory-tint)',
          backgroundColor: 'var(--white)',
        }}
      >
        <h2 style={{ fontWeight: 600, fontSize: 22, color: 'var(--graphite)' }}>Dashboard</h2>
        <p style={{ color: 'var(--grey)', fontSize: 14 }}>Arena administration overview</p>
      </header>

      {/* Content */}
      <div style={{ padding: '24px 32px' }}>
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
            Failed to load dashboard data: {error.message}
          </div>
        )}

        {loading && !data ? (
          <div style={{ textAlign: 'center', padding: '64px 0', color: 'var(--grey)', fontSize: 15 }}>
            Loading dashboard…
          </div>
        ) : (
          <>
            {/* Stats cards */}
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
                gap: 16,
                marginBottom: 32,
              }}
            >
              <div style={cardStyle}>
                <div style={statNumber}>{templates.length}</div>
                <div style={statLabel}>Templates</div>
                <div style={statBreakdown}>
                  {Object.entries(templatesByStatus).map(([status, count], i) => (
                    <span key={status}>
                      {i > 0 && ' · '}
                      {count} {status}
                    </span>
                  ))}
                </div>
              </div>

              <div style={cardStyle}>
                <div style={statNumber}>{questionCount}</div>
                <div style={statLabel}>Questions</div>
              </div>

              <div style={cardStyle}>
                <div style={statNumber}>{tagCount}</div>
                <div style={statLabel}>Tags</div>
              </div>

              <div style={cardStyle}>
                <div style={statNumber}>{userCount}</div>
                <div style={statLabel}>Users</div>
              </div>

              <div style={cardStyle}>
                <div style={statNumber}>{interviewTotal}</div>
                <div style={statLabel}>Interviews</div>
              </div>
            </div>

            {/* Recent interviews */}
            <div style={{ marginBottom: 32 }}>
              <h3
                style={{
                  fontWeight: 600,
                  fontSize: 16,
                  color: 'var(--graphite)',
                  marginBottom: 12,
                }}
              >
                Recent Interviews
              </h3>

              {interviewEdges.length === 0 ? (
                <div
                  style={{
                    ...cardStyle,
                    textAlign: 'center',
                    color: 'var(--grey)',
                    fontSize: 14,
                    padding: '32px',
                  }}
                >
                  No interviews yet.
                </div>
              ) : (
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
                      gridTemplateColumns: '1fr 1fr 100px 120px',
                      padding: '11px 18px',
                      borderBottom: '1px solid var(--ivory-tint)',
                      backgroundColor: 'var(--ivory)',
                      gap: 12,
                    }}
                  >
                    {['Candidate', 'Template', 'Status', 'Date'].map((h) => (
                      <span key={h} style={colHeader}>
                        {h}
                      </span>
                    ))}
                  </div>

                  {interviewEdges.map(({ node }, i) => {
                    const s = STATUS_STYLES[node.status] ?? STATUS_STYLES.scheduled;
                    return (
                      <div
                        key={node.id}
                        style={{
                          display: 'grid',
                          gridTemplateColumns: '1fr 1fr 100px 120px',
                          padding: '12px 18px',
                          borderBottom: i < interviewEdges.length - 1 ? '1px solid var(--ivory-tint)' : 'none',
                          alignItems: 'center',
                          gap: 12,
                        }}
                      >
                        <span style={{ fontSize: 14, fontWeight: 500, color: 'var(--graphite)' }}>
                          {node.user.name}
                        </span>
                        <span style={{ fontSize: 14, color: 'var(--graphite)' }}>
                          {node.template.name}
                        </span>
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
                          {node.status.replace(/_/g, ' ')}
                        </span>
                        <span style={{ fontSize: 13, color: 'var(--grey)' }}>
                          {formatDate(node.completedAt ?? node.startedAt)}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Quick actions */}
            <div>
              <h3
                style={{
                  fontWeight: 600,
                  fontSize: 16,
                  color: 'var(--graphite)',
                  marginBottom: 12,
                }}
              >
                Quick Actions
              </h3>
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                <Link href="/admin/templates" style={quickAction}>
                  New Template
                </Link>
                <Link href="/admin/questions" style={quickAction}>
                  New Question
                </Link>
                <Link href="/admin/tags" style={quickAction}>
                  Manage Tags
                </Link>
                <Link href="/admin/users" style={quickAction}>
                  Manage Users
                </Link>
                <Link href="/admin/interviews" style={quickAction}>
                  View Interviews
                </Link>
              </div>
            </div>
          </>
        )}
      </div>
    </>
  );
}
