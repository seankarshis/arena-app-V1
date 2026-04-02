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
      <div className="min-h-screen flex flex-col items-center justify-center bg-ivory p-6 text-center">
        <div className="max-w-[520px]">
          <p className="text-xs tracking-wide uppercase text-grey mb-3">
            Arena AI — elastichorizon
          </p>
          <h1 className="font-hero text-[32px] text-graphite mb-3">
            {templateName}
          </h1>
          <p className="text-grey text-base leading-relaxed mb-10">
            Your responses will be recorded as text. Take your time — you can
            pause at any point and resume within 72 hours.
          </p>
          {session.conflictingInterviewId ? (
            <div>
              <p className="text-graphite text-[15px] mb-5 p-3 px-4 bg-ivory-tint rounded border border-grey">
                You already have an interview in progress. Abandon it and start a fresh one?
              </p>
              <button
                onClick={() => void actions.abandonAndStart()}
                className="btn-primary py-3.5 px-10 text-base tracking-[0.02em] mr-3"
              >
                Abandon &amp; Start Fresh
              </button>
              <button
                onClick={() => router.push('/')}
                className="btn-ghost underline text-sm"
              >
                Go back
              </button>
            </div>
          ) : (
            <button
              onClick={() => void actions.startInterview()}
              className="btn-primary py-3.5 px-10 text-base tracking-[0.02em]"
            >
              Start Interview
            </button>
          )}
          <div className="mt-6">
            <button
              onClick={() => router.push('/')}
              className="btn-ghost underline text-sm"
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
        <div className="min-h-screen flex items-center justify-center bg-ivory text-grey">
          Loading…
        </div>
      }
    >
      <InterviewContent templateId={params.id} />
    </Suspense>
  );
}
