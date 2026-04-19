'use client';

import React, { useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { useQuery, gql } from '@apollo/client';
import { cn } from '@/lib/utils';
import { StatusBadge } from '@/components/ui/StatusBadge';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CoverageEntry {
  questionId: string;
  status: string;
  confidence: string | null;
  summary: string | null;
  lastUpdatedTurn: number | null;
}

interface ActiveThread {
  id: string;
  topic: string;
  status: string;
  relatedQuestionIds: string[];
  openedAtTurn: number;
}

interface InterviewCoverageMap {
  interviewId: string;
  sessionVersion: string;
  entries: CoverageEntry[];
  activeThreads: ActiveThread[];
  parseFailureCount: number;
}

interface InterviewDetail {
  id: string;
  status: string;
  startedAt: string | null;
  completedAt: string | null;
  user: { id: string; name: string; email: string };
  template: { id: string; name: string };
  responses: { id: string }[];
  costSummary: {
    totalLlmPromptTokens: number;
    totalLlmCompletionTokens: number;
    totalSttDurationSeconds: number;
    totalTtsCharacters: number;
  };
}

// ---------------------------------------------------------------------------
// GQL
// ---------------------------------------------------------------------------

const GET_INTERVIEW_SESSION = gql`
  query AdminGetInterviewSession($id: ID!) {
    getInterview(id: $id) {
      id
      status
      startedAt
      completedAt
      user { id name email }
      template { id name }
      responses { id }
      costSummary {
        totalLlmPromptTokens
        totalLlmCompletionTokens
        totalSttDurationSeconds
        totalTtsCharacters
      }
    }
    coverageMap(interviewId: $id) {
      interviewId
      sessionVersion
      parseFailureCount
      entries {
        questionId
        status
        confidence
        summary
        lastUpdatedTurn
      }
      activeThreads {
        id
        topic
        status
        relatedQuestionIds
        openedAtTurn
      }
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

// Coverage status display labels and badge styles
const COVERAGE_STATUS_LABEL: Record<string, string> = {
  not_started: 'Not Started',
  partially_covered: 'Partial',
  fully_covered: 'Covered',
  skipped: 'Skipped',
};

const COVERAGE_STATUS_CLASS: Record<string, string> = {
  not_started: 'bg-ivory-tint text-graphite border border-graphite/20',
  partially_covered: 'bg-arena-amber/20 text-arena-amber border border-arena-amber/30',
  fully_covered: 'bg-graphite text-white border border-graphite',
  skipped: 'bg-dark-maroon text-ivory border border-dark-maroon',
};

// Thread status badge style (open/resolved/dropped as possible values from runtime)
const THREAD_STATUS_CLASS: Record<string, string> = {
  open: 'bg-horizon-red/10 text-horizon-red border border-horizon-red/30',
  resolved: 'bg-graphite text-white border border-graphite',
  dropped: 'bg-ivory-tint text-grey border border-graphite/20',
};

function coverageStatusBadge(status: string): React.ReactNode {
  const label = COVERAGE_STATUS_LABEL[status] ?? status.replace(/_/g, ' ');
  const cls = COVERAGE_STATUS_CLASS[status] ?? 'bg-ivory-tint text-graphite border border-graphite/20';
  return (
    <span className={cn('inline-block px-2 py-0.5 rounded text-xs font-semibold capitalize', cls)}>
      {label}
    </span>
  );
}

function threadStatusBadge(status: string): React.ReactNode {
  const cls = THREAD_STATUS_CLASS[status] ?? 'bg-ivory-tint text-grey border border-graphite/20';
  return (
    <span className={cn('inline-block px-2 py-0.5 rounded text-xs font-semibold capitalize', cls)}>
      {status}
    </span>
  );
}

// Confidence bar: color-coded by value (high=green, medium=yellow, low=red)
function ConfidenceBar({ confidence }: { confidence: string | null }) {
  if (!confidence) {
    return <span className="text-xs text-grey italic">—</span>;
  }

  const widthMap: Record<string, string> = {
    high: 'w-full',
    medium: 'w-2/3',
    low: 'w-1/3',
  };
  const colorMap: Record<string, string> = {
    high: 'bg-green-600',
    medium: 'bg-yellow-500',
    low: 'bg-horizon-red',
  };
  const labelMap: Record<string, string> = {
    high: 'high',
    medium: 'med',
    low: 'low',
  };

  const barWidth = widthMap[confidence] ?? 'w-1/3';
  const barColor = colorMap[confidence] ?? 'bg-grey';
  const label = labelMap[confidence] ?? confidence;

  return (
    <div className="flex items-center gap-2">
      <div className="w-16 h-1.5 rounded-full bg-ivory-tint overflow-hidden">
        <div className={cn('h-full rounded-full', barWidth, barColor)} />
      </div>
      <span className="text-xs text-grey font-mono">{label}</span>
    </div>
  );
}

// Status distribution bar chart (Tailwind divs only)
function StatusDistributionBar({ entries }: { entries: CoverageEntry[] }) {
  if (entries.length === 0) return null;

  const counts: Record<string, number> = {
    fully_covered: 0,
    partially_covered: 0,
    skipped: 0,
    not_started: 0,
  };
  for (const e of entries) {
    if (e.status in counts) counts[e.status]++;
    else counts[e.status] = (counts[e.status] ?? 0) + 1;
  }

  const total = entries.length;
  const segments: { key: string; label: string; count: number; barColor: string; textColor: string }[] = [
    { key: 'fully_covered', label: 'Covered', count: counts.fully_covered, barColor: 'bg-graphite', textColor: 'text-graphite' },
    { key: 'partially_covered', label: 'Partial', count: counts.partially_covered, barColor: 'bg-arena-amber', textColor: 'text-arena-amber' },
    { key: 'skipped', label: 'Skipped', count: counts.skipped, barColor: 'bg-dark-maroon', textColor: 'text-dark-maroon' },
    { key: 'not_started', label: 'Not Started', count: counts.not_started, barColor: 'bg-ivory-tint', textColor: 'text-grey' },
  ].filter((s) => s.count > 0);

  return (
    <div className="space-y-3">
      {/* Stacked bar */}
      <div className="flex h-3 rounded-full overflow-hidden bg-ivory-tint">
        {segments.map((seg) => (
          <div
            key={seg.key}
            className={cn('h-full transition-all', seg.barColor)}
            style={{ width: `${(seg.count / total) * 100}%` }}
            title={`${seg.label}: ${seg.count}`}
          />
        ))}
      </div>
      {/* Legend */}
      <div className="flex flex-wrap gap-x-5 gap-y-1.5">
        {segments.map((seg) => (
          <div key={seg.key} className="flex items-center gap-1.5">
            <div className={cn('w-2.5 h-2.5 rounded-sm', seg.barColor === 'bg-ivory-tint' ? 'bg-ivory-tint border border-graphite/20' : seg.barColor)} />
            <span className={cn('text-xs', seg.textColor)}>
              {seg.label} <span className="font-semibold font-mono">{seg.count}</span>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// CoverageMapPanel
// ---------------------------------------------------------------------------

function CoverageMapPanel({ interviewId }: { interviewId: string }) {
  const { data, loading, error } = useQuery<{
    getInterview: InterviewDetail | null;
    coverageMap: InterviewCoverageMap | null;
  }>(GET_INTERVIEW_SESSION, {
    variables: { id: interviewId },
    fetchPolicy: 'cache-and-network',
  });

  const interview = data?.getInterview ?? null;
  const coverageMap = data?.coverageMap ?? null;

  return (
    <>
      {/* Page header */}
      <header className="page-header flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <Link
            href="/admin/interviews"
            className="text-grey hover:text-horizon-red text-sm font-medium transition-colors"
          >
            ← Interviews
          </Link>
          <span className="text-grey/40">/</span>
          <h2 className="font-semibold text-[22px] text-graphite">
            {loading && !interview ? 'Loading…' : (interview ? interview.user.name : 'Session Review')}
          </h2>
          {interview && <StatusBadge status={interview.status} />}
        </div>
        {interview && (
          <span className="text-xs text-grey font-mono">{interview.id}</span>
        )}
      </header>

      <div className="page-content space-y-6">
        {error && (
          <div role="alert" className="alert-error">
            Failed to load session data: {error.message}
          </div>
        )}

        {loading && !data && (
          <div className="text-center py-16 text-grey text-[15px]">
            Loading session data…
          </div>
        )}

        {/* Interview info strip */}
        {interview && (
          <div className="bg-white rounded border border-ivory-tint px-6 py-4 flex flex-wrap gap-8">
            <div>
              <span className="col-header block mb-1">Candidate</span>
              <span className="text-sm text-graphite font-medium">{interview.user.name}</span>
              <br />
              <span className="text-xs text-grey">{interview.user.email}</span>
            </div>
            <div>
              <span className="col-header block mb-1">Template</span>
              <span className="text-sm text-graphite">{interview.template.name}</span>
            </div>
            <div>
              <span className="col-header block mb-1">Started</span>
              <span className="text-sm text-graphite">{formatDate(interview.startedAt)}</span>
            </div>
            <div>
              <span className="col-header block mb-1">Completed</span>
              <span className="text-sm text-graphite">{formatDate(interview.completedAt)}</span>
            </div>
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
            </div>
          </div>
        )}

        {/* Session Review section */}
        {data && (
          <>
            {coverageMap === null ? (
              <div className="bg-white rounded border border-ivory-tint px-6 py-5">
                <h3 className="font-semibold text-[16px] text-graphite mb-2">Session Review</h3>
                <p className="text-sm text-grey">
                  This interview ran on the legacy session engine. Coverage map is only available for
                  interviews using the orchestration loop (sessionVersion=v2-coverage).
                </p>
              </div>
            ) : (
              <>
                {/* Summary header */}
                <div className="bg-dark-maroon rounded px-6 py-4">
                  <div className="flex items-baseline gap-6 flex-wrap">
                    <div>
                      <span className="text-xs text-ivory/60 uppercase tracking-wider font-semibold block mb-0.5">
                        Session Version
                      </span>
                      <span className="text-ivory font-mono text-sm font-semibold">
                        {coverageMap.sessionVersion}
                      </span>
                    </div>
                    <div>
                      <span className="text-xs text-ivory/60 uppercase tracking-wider font-semibold block mb-0.5">
                        Parse Failures
                      </span>
                      <span className={cn(
                        'font-mono text-sm font-semibold',
                        coverageMap.parseFailureCount > 0 ? 'text-arena-amber' : 'text-ivory'
                      )}>
                        {coverageMap.parseFailureCount}
                      </span>
                    </div>
                    <div>
                      <span className="text-xs text-ivory/60 uppercase tracking-wider font-semibold block mb-0.5">
                        Questions Tracked
                      </span>
                      <span className="text-ivory font-mono text-sm font-semibold">
                        {coverageMap.entries.length}
                      </span>
                    </div>
                    <div>
                      <span className="text-xs text-ivory/60 uppercase tracking-wider font-semibold block mb-0.5">
                        Active Threads
                      </span>
                      <span className="text-ivory font-mono text-sm font-semibold">
                        {coverageMap.activeThreads.length}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Status distribution */}
                {coverageMap.entries.length > 0 && (
                  <div className="bg-white rounded border border-ivory-tint px-6 py-5">
                    <h3 className="font-semibold text-[15px] text-graphite mb-3">Coverage Distribution</h3>
                    <StatusDistributionBar entries={coverageMap.entries} />
                  </div>
                )}

                {/* Questions table */}
                <div className="bg-white rounded border border-ivory-tint overflow-hidden">
                  <div className="px-6 py-4 border-b border-ivory-tint">
                    <h3 className="font-semibold text-[15px] text-graphite">Questions</h3>
                  </div>
                  {coverageMap.entries.length === 0 ? (
                    <div className="px-6 py-8 text-center text-sm text-grey">
                      No coverage entries recorded for this session.
                    </div>
                  ) : (
                    <>
                      {/* Table header */}
                      <div className="grid grid-cols-[1fr_120px_100px_80px_120px] gap-3 px-6 py-2.5 border-b border-graphite/20 bg-graphite">
                        {['Question ID', 'Status', 'Confidence', 'Last Turn', 'Summary'].map((h) => (
                          <span key={h} className="col-header">{h}</span>
                        ))}
                      </div>
                      {coverageMap.entries.map((entry, i) => (
                        <div
                          key={entry.questionId}
                          className={cn(
                            'grid grid-cols-[1fr_120px_100px_80px_120px] gap-3 px-6 py-3.5 items-start',
                            i < coverageMap.entries.length - 1 && 'border-b border-ivory-tint',
                            i % 2 === 0 ? 'bg-white' : 'bg-ivory-tint/40'
                          )}
                        >
                          <span className="text-xs font-mono text-graphite break-all">
                            {entry.questionId}
                          </span>
                          <div>{coverageStatusBadge(entry.status)}</div>
                          <ConfidenceBar confidence={entry.confidence} />
                          <span className="text-sm text-grey font-mono">
                            {entry.lastUpdatedTurn !== null && entry.lastUpdatedTurn !== undefined
                              ? `T${entry.lastUpdatedTurn}`
                              : '—'}
                          </span>
                          <div className="text-xs text-graphite leading-relaxed">
                            {entry.summary ? (
                              <span title={entry.summary}>
                                {entry.summary.length > 80
                                  ? entry.summary.slice(0, 80) + '…'
                                  : entry.summary}
                              </span>
                            ) : (
                              <span className="text-grey italic">—</span>
                            )}
                          </div>
                        </div>
                      ))}
                    </>
                  )}
                </div>

                {/* Threads section */}
                <div className="bg-white rounded border border-ivory-tint overflow-hidden">
                  <div className="px-6 py-4 border-b border-ivory-tint">
                    <h3 className="font-semibold text-[15px] text-graphite">Threads</h3>
                  </div>
                  {coverageMap.activeThreads.length === 0 ? (
                    <div className="px-6 py-8 text-center text-sm text-grey">
                      No active threads recorded for this session.
                    </div>
                  ) : (
                    <div className="divide-y divide-ivory-tint">
                      {coverageMap.activeThreads.map((thread) => (
                        <div key={thread.id} className="px-6 py-4">
                          <div className="flex items-start gap-3 flex-wrap">
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-medium text-graphite">{thread.topic}</p>
                              <p className="text-xs text-grey mt-0.5">
                                Opened at turn{' '}
                                <span className="font-mono font-semibold">T{thread.openedAtTurn}</span>
                              </p>
                            </div>
                            <div className="flex items-center gap-2 shrink-0">
                              {threadStatusBadge(thread.status)}
                            </div>
                          </div>
                          {thread.relatedQuestionIds.length > 0 && (
                            <div className="mt-2.5 flex flex-wrap gap-1.5">
                              <span className="text-xs text-grey mr-1">Related:</span>
                              {thread.relatedQuestionIds.map((qid) => (
                                <span
                                  key={qid}
                                  className="inline-block px-2 py-0.5 rounded bg-ivory-tint border border-graphite/15 text-xs font-mono text-graphite cursor-default"
                                  title={qid}
                                >
                                  {qid.length > 12 ? qid.slice(0, 12) + '…' : qid}
                                </span>
                              ))}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </>
            )}
          </>
        )}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function InterviewDetailPage() {
  const params = useParams();
  const id = params.id as string;
  return <CoverageMapPanel interviewId={id} />;
}
