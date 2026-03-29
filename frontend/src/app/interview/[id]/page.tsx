'use client';

import { useEffect, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { getUser } from '@/lib/auth';
import { useInterviewState } from '@/hooks/useInterviewState';
import InterviewUI from '@/components/InterviewUI';

// ---------------------------------------------------------------------------
// Inner component — needs Suspense boundary because it calls useSearchParams
// ---------------------------------------------------------------------------

function InterviewContent({ templateId }: { templateId: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const templateName = searchParams.get('name') ?? 'Interview';

  // Auth guard
  useEffect(() => {
    void getUser().then((user) => {
      if (!user) router.push('/login');
    });
  }, [router]);

  const { state, session, actions } = useInterviewState(templateId);

  // ---- READY: landing page before interview begins ----
  if (state === 'READY') {
    return (
      <div
        style={{
          minHeight: '100vh',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: 'var(--ivory)',
          fontFamily: 'var(--font-primary)',
          padding: 24,
          textAlign: 'center',
        }}
      >
        <div style={{ maxWidth: 520 }}>
          <p
            style={{
              fontSize: 12,
              letterSpacing: '0.1em',
              textTransform: 'uppercase',
              color: 'var(--grey)',
              marginBottom: 12,
            }}
          >
            Arena AI — elastichorizon
          </p>
          <h1
            style={{
              fontFamily: 'var(--font-hero)',
              fontSize: 32,
              color: 'var(--graphite)',
              marginBottom: 12,
            }}
          >
            {templateName}
          </h1>
          <p
            style={{
              color: 'var(--grey)',
              fontSize: 16,
              lineHeight: 1.6,
              marginBottom: 40,
            }}
          >
            Your responses will be recorded as text. Take your time — you can
            pause at any point and resume within 72 hours.
          </p>
          {session.conflictingInterviewId ? (
            <div>
              <p
                style={{
                  color: 'var(--graphite)',
                  fontSize: 15,
                  marginBottom: 20,
                  padding: '12px 16px',
                  backgroundColor: 'var(--ivory-tint)',
                  borderRadius: 8,
                  border: '1px solid var(--grey)',
                }}
              >
                You already have an interview in progress. Abandon it and start a fresh one?
              </p>
              <button
                onClick={() => void actions.abandonAndStart()}
                style={{
                  padding: '14px 40px',
                  borderRadius: 999,
                  border: 'none',
                  backgroundColor: 'var(--horizon-red)',
                  color: 'var(--white)',
                  fontFamily: 'var(--font-primary)',
                  fontWeight: 600,
                  fontSize: 16,
                  cursor: 'pointer',
                  letterSpacing: '0.02em',
                  marginRight: 12,
                }}
              >
                Abandon &amp; Start Fresh
              </button>
              <button
                onClick={() => router.push('/')}
                style={{
                  background: 'none',
                  border: 'none',
                  color: 'var(--grey)',
                  fontFamily: 'var(--font-primary)',
                  fontSize: 14,
                  cursor: 'pointer',
                  textDecoration: 'underline',
                }}
              >
                Go back
              </button>
            </div>
          ) : (
            <button
              onClick={() => void actions.startInterview()}
              style={{
                padding: '14px 40px',
                borderRadius: 999,
                border: 'none',
                backgroundColor: 'var(--horizon-red)',
                color: 'var(--white)',
                fontFamily: 'var(--font-primary)',
                fontWeight: 600,
                fontSize: 16,
                cursor: 'pointer',
                letterSpacing: '0.02em',
              }}
            >
              Start Interview
            </button>
          )}
          <div style={{ marginTop: 24 }}>
            <button
              onClick={() => router.push('/')}
              style={{
                background: 'none',
                border: 'none',
                color: 'var(--grey)',
                fontFamily: 'var(--font-primary)',
                fontSize: 14,
                cursor: 'pointer',
                textDecoration: 'underline',
              }}
            >
              Back to home
            </button>
          </div>
        </div>
      </div>
    );
  }

  return <InterviewUI state={state} session={session} actions={actions} />;
}

// ---------------------------------------------------------------------------
// Page component — provides Suspense boundary for useSearchParams
// ---------------------------------------------------------------------------

interface PageProps {
  params: { id: string };
}

export default function InterviewPage({ params }: PageProps) {
  return (
    <Suspense
      fallback={
        <div
          style={{
            minHeight: '100vh',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: 'var(--ivory)',
            fontFamily: 'var(--font-primary)',
            color: 'var(--grey)',
          }}
        >
          Loading…
        </div>
      }
    >
      <InterviewContent templateId={params.id} />
    </Suspense>
  );
}
