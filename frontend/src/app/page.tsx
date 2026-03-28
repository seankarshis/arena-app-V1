'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery, useApolloClient, gql } from '@apollo/client';
import { getUser, logout } from '@/lib/auth';

// ---------------------------------------------------------------------------
// GraphQL
// ---------------------------------------------------------------------------

const GET_MY_ASSIGNED_TEMPLATES = gql`
  query GetMyAssignedTemplates {
    getMyAssignedTemplates {
      assignment {
        id
        template {
          id
          name
          description
        }
        status
        completedAt
      }
      interviewStatus
    }
  }
`;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TemplateAssignment {
  assignment: {
    id: string;
    template: {
      id: string;
      name: string;
      description: string | null;
    };
    status: string;
    completedAt: string | null;
  };
  interviewStatus: string | null;
}

interface GetMyAssignedTemplatesData {
  getMyAssignedTemplates: TemplateAssignment[];
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function HomePage() {
  const router = useRouter();
  const client = useApolloClient();

  useEffect(() => {
    void getUser().then((user) => {
      if (!user) router.push('/login');
    });
  }, [router]);

  const { data, loading, error } = useQuery<GetMyAssignedTemplatesData>(
    GET_MY_ASSIGNED_TEMPLATES
  );

  async function handleSignOut() {
    await logout();
    await client.clearStore();
    router.push('/login');
  }

  function handleStartInterview(templateId: string, templateName: string) {
    router.push(
      `/interview/${templateId}?name=${encodeURIComponent(templateName)}`
    );
  }

  // ---- Loading ----
  if (loading) {
    return (
      <div
        style={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: 'var(--ivory)',
          fontFamily: 'var(--font-primary)',
        }}
      >
        <p style={{ color: 'var(--grey)' }}>Loading your interviews…</p>
      </div>
    );
  }

  // ---- Error ----
  if (error) {
    return (
      <div
        style={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: 'var(--ivory)',
          fontFamily: 'var(--font-primary)',
        }}
      >
        <p style={{ color: 'var(--horizon-red)' }}>
          Failed to load interviews. Please try refreshing.
        </p>
      </div>
    );
  }

  const templates = data?.getMyAssignedTemplates ?? [];

  return (
    <div
      style={{
        minHeight: '100vh',
        backgroundColor: 'var(--ivory)',
        fontFamily: 'var(--font-primary)',
        padding: '40px 24px',
      }}
    >
      {/* Header */}
      <header
        style={{
          maxWidth: 800,
          margin: '0 auto',
          marginBottom: 48,
          display: 'flex',
          alignItems: 'baseline',
          gap: 12,
        }}
      >
        <h1
          style={{
            fontFamily: 'var(--font-hero)',
            fontSize: 28,
            color: 'var(--graphite)',
          }}
        >
          Arena
        </h1>
        <span style={{ color: 'var(--grey)', fontSize: 14 }}>
          elastichorizon
        </span>
        <span style={{ flex: 1 }} />
        <button
          onClick={handleSignOut}
          style={{
            background: 'none',
            border: 'none',
            fontFamily: 'var(--font-primary)',
            fontSize: 14,
            fontWeight: 500,
            color: 'var(--grey)',
            cursor: 'pointer',
            padding: '4px 8px',
            borderRadius: 4,
            transition: 'color 0.15s',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--horizon-red)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--grey)'; }}
        >
          Sign out
        </button>
      </header>

      {/* Main */}
      <main style={{ maxWidth: 800, margin: '0 auto' }}>
        <h2
          style={{
            fontSize: 20,
            fontWeight: 600,
            color: 'var(--graphite)',
            marginBottom: 24,
          }}
        >
          Your Interviews
        </h2>

        {templates.length === 0 ? (
          <div
            style={{
              padding: 32,
              backgroundColor: 'var(--white)',
              borderRadius: 8,
              textAlign: 'center',
              color: 'var(--grey)',
              boxShadow: '0 1px 3px rgba(0,0,0,0.08)',
            }}
          >
            No interviews have been assigned to you yet.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {templates.map(({ assignment, interviewStatus }) => {
              const isCompleted =
                assignment.completedAt !== null ||
                interviewStatus === 'completed';
              const isInProgress = interviewStatus === 'in_progress';
              const buttonLabel = isInProgress
                ? 'Resume Interview'
                : 'Start Interview';

              return (
                <div
                  key={assignment.id}
                  style={{
                    padding: 24,
                    backgroundColor: 'var(--white)',
                    borderRadius: 8,
                    boxShadow: '0 1px 3px rgba(0,0,0,0.08)',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    gap: 16,
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <h3
                      style={{
                        fontSize: 18,
                        fontWeight: 500,
                        color: 'var(--graphite)',
                        marginBottom: 4,
                      }}
                    >
                      {assignment.template.name}
                    </h3>
                    {assignment.template.description && (
                      <p style={{ color: 'var(--grey)', fontSize: 14 }}>
                        {assignment.template.description}
                      </p>
                    )}
                    {isCompleted && assignment.completedAt && (
                      <p
                        style={{
                          color: 'var(--grey)',
                          fontSize: 12,
                          marginTop: 4,
                        }}
                      >
                        Completed{' '}
                        {new Date(assignment.completedAt).toLocaleDateString()}
                      </p>
                    )}
                    {isCompleted && (
                      <span
                        style={{
                          display: 'inline-block',
                          marginTop: 6,
                          padding: '2px 10px',
                          borderRadius: 999,
                          backgroundColor: 'var(--ivory-tint)',
                          color: 'var(--grey)',
                          fontSize: 12,
                        }}
                      >
                        Completed
                      </span>
                    )}
                  </div>

                  {!isCompleted && (
                    <button
                      onClick={() =>
                        handleStartInterview(
                          assignment.template.id,
                          assignment.template.name
                        )
                      }
                      style={{
                        flexShrink: 0,
                        padding: '10px 24px',
                        borderRadius: 999,
                        border: 'none',
                        backgroundColor: 'var(--horizon-red)',
                        color: 'var(--white)',
                        fontFamily: 'var(--font-primary)',
                        fontWeight: 600,
                        fontSize: 14,
                        cursor: 'pointer',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {buttonLabel}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </main>

      <footer
        style={{
          maxWidth: 800,
          margin: '48px auto 0',
          textAlign: 'center',
          color: 'var(--grey)',
          fontSize: 12,
        }}
      >
        &copy; {new Date().getFullYear()} elastichorizon
      </footer>
    </div>
  );
}
