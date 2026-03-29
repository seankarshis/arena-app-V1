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