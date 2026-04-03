'use client';

import React from 'react';
import { useQuery, gql } from '@apollo/client';
import Link from 'next/link';
import { cn } from '@/lib/utils';
import { StatusBadge } from '@/components/ui/StatusBadge';

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
// Helpers
// ---------------------------------------------------------------------------

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
      <header className="page-header">
        <h2 className="font-semibold text-[22px] text-graphite">Dashboard</h2>
        <p className="text-grey text-sm">Arena administration overview</p>
      </header>

      {/* Content */}
      <div className="page-content">
        {error && (
          <div role="alert" className="alert-error mb-4">
            Failed to load dashboard data: {error.message}
          </div>
        )}

        {loading && !data ? (
          <div className="text-center py-16 text-grey text-[15px]">
            Loading dashboard…
          </div>
        ) : (
          <>
            {/* Stats cards */}
            <div className="grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-4 mb-8">
              <div className="card">
                <div className="text-[32px] font-bold text-graphite leading-none">{templates.length}</div>
                <div className="text-[13px] font-medium text-grey uppercase tracking-stat mt-1">Templates</div>
                <div className="text-xs text-grey mt-2">
                  {Object.entries(templatesByStatus).map(([status, count], i) => (
                    <span key={status}>
                      {i > 0 && ' · '}
                      {count} {status}
                    </span>
                  ))}
                </div>
              </div>

              <div className="card">
                <div className="text-[32px] font-bold text-graphite leading-none">{questionCount}</div>
                <div className="text-[13px] font-medium text-grey uppercase tracking-stat mt-1">Questions</div>
              </div>

              <div className="card">
                <div className="text-[32px] font-bold text-graphite leading-none">{tagCount}</div>
                <div className="text-[13px] font-medium text-grey uppercase tracking-stat mt-1">Tags</div>
              </div>

              <div className="card">
                <div className="text-[32px] font-bold text-graphite leading-none">{userCount}</div>
                <div className="text-[13px] font-medium text-grey uppercase tracking-stat mt-1">Users</div>
              </div>

              <div className="card">
                <div className="text-[32px] font-bold text-graphite leading-none">{interviewTotal}</div>
                <div className="text-[13px] font-medium text-grey uppercase tracking-stat mt-1">Interviews</div>
              </div>
            </div>

            {/* Recent interviews */}
            <div className="mb-8">
              <h3 className="font-semibold text-base text-graphite mb-3">
                Recent Interviews
              </h3>

              {interviewEdges.length === 0 ? (
                <div className="card text-center text-grey text-sm p-8">
                  No interviews yet.
                </div>
              ) : (
                <div className="bg-white rounded border border-ivory-tint overflow-hidden">
                  {/* Table header */}
                  <div className="grid grid-cols-[1fr_1fr_100px_120px] py-2.5 px-[18px] border-b border-graphite/20 bg-graphite gap-3">
                    {['Candidate', 'Template', 'Status', 'Date'].map((h) => (
                      <span key={h} className={cn('col-header', h === 'Status' && 'text-center')}>{h}</span>
                    ))}
                  </div>

                  {interviewEdges.map(({ node }, i) => (
                    <div
                      key={node.id}
                      className={cn(
                        'grid grid-cols-[1fr_1fr_100px_120px] py-3 px-[18px] items-center gap-3 border-b border-ivory-tint last:border-b-0 transition-colors duration-100 hover:bg-horizon-red/[0.03]',
                        i % 2 === 0 ? 'bg-white' : 'bg-ivory-tint'
                      )}
                    >
                      <span className="text-sm font-medium text-graphite">
                        {node.user.name}
                      </span>
                      <span className="text-sm text-graphite">
                        {node.template.name}
                      </span>
                      <div className="text-center">
                        <StatusBadge status={node.status} />
                      </div>
                      <span className="text-[13px] text-grey">
                        {formatDate(node.completedAt ?? node.startedAt)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Quick actions */}
            <div>
              <h3 className="font-semibold text-base text-graphite mb-3">
                Quick Actions
              </h3>
              <div className="flex gap-3 flex-wrap">
                {[
                  { href: '/admin/templates', label: 'New Template' },
                  { href: '/admin/questions', label: 'New Question' },
                  { href: '/admin/tags', label: 'Manage Tags' },
                  { href: '/admin/users', label: 'Manage Users' },
                  { href: '/admin/interviews', label: 'View Interviews' },
                ].map((action) => (
                  <Link
                    key={action.href}
                    href={action.href}
                    className="btn-secondary inline-block no-underline"
                  >
                    {action.label}
                  </Link>
                ))}
              </div>
            </div>
          </>
        )}
      </div>
    </>
  );
}
