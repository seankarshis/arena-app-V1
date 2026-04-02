'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery, useApolloClient, gql } from '@apollo/client';
import { getUser, logout } from '@/lib/auth';
import { cn } from '@/lib/utils';

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
      <div className="min-h-screen flex items-center justify-center bg-ivory">
        <p className="text-grey">Loading your interviews…</p>
      </div>
    );
  }

  // ---- Error ----
  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-ivory">
        <p className="text-horizon-red">
          Failed to load interviews. Please try refreshing.
        </p>
      </div>
    );
  }

  const templates = data?.getMyAssignedTemplates ?? [];

  return (
    <div className="min-h-screen bg-ivory px-6 py-10">
      {/* Header */}
      <header className="max-w-[800px] mx-auto mb-12 flex items-baseline gap-3">
        <h1 className="font-hero text-[28px] text-graphite">ARENA AI</h1>
        <span className="text-grey text-sm">elastichorizon</span>
        <span className="flex-1" />
        <button
          onClick={handleSignOut}
          className="btn-ghost text-sm font-medium"
        >
          Sign out
        </button>
      </header>

      {/* Main */}
      <main className="max-w-[800px] mx-auto">
        <h2 className="text-xl font-semibold text-graphite mb-6">
          Your Interviews
        </h2>

        {templates.length === 0 ? (
          <div className="card p-8 text-center text-grey">
            No interviews have been assigned to you yet.
          </div>
        ) : (
          <div className="flex flex-col gap-4">
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
                  className={cn(
                    'card-interactive flex justify-between items-center gap-4',
                    isCompleted && 'opacity-80'
                  )}
                >
                  <div className="flex-1 min-w-0">
                    <h3 className="text-lg font-medium text-graphite mb-1">
                      {assignment.template.name}
                    </h3>
                    {assignment.template.description && (
                      <p className="text-grey text-sm">
                        {assignment.template.description}
                      </p>
                    )}
                    {isCompleted && assignment.completedAt && (
                      <p className="text-grey text-xs mt-1">
                        Completed{' '}
                        {new Date(assignment.completedAt).toLocaleDateString()}
                      </p>
                    )}
                    {isCompleted && (
                      <span className="badge-completed inline-block mt-1.5">
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
                      className="btn-primary shrink-0 whitespace-nowrap"
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

      <footer className="max-w-[800px] mx-auto mt-12 text-center text-grey text-xs">
        &copy; {new Date().getFullYear()} elastichorizon
      </footer>
    </div>
  );
}
