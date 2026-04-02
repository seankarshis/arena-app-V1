'use client';

import React, { useState } from 'react';
import { useQuery, useMutation, gql } from '@apollo/client';
import { cn } from '@/lib/utils';
import { StatusBadge } from '@/components/ui/StatusBadge';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Tag {
  id: string;
  label: string;
}

interface TemplateRef {
  id: string;
  name: string;
  status: string;
}

interface Assignment {
  id: string;
  template: TemplateRef;
  status: string;
  assignedAt: string;
}

interface ConsentStatus {
  dataProcessing: boolean;
  audioRecording: boolean;
  aiInteraction: boolean;
  allGranted: boolean;
}

interface User {
  id: string;
  name: string;
  email: string;
  role: string;
  assignedTemplates: Assignment[];
  tags: Tag[];
  consentStatus: ConsentStatus;
}

// ---------------------------------------------------------------------------
// GQL
// ---------------------------------------------------------------------------

const LIST_USERS = gql`
  query AdminListUsers {
    listUsers {
      id
      name
      email
      role
      assignedTemplates {
        id
        template { id name status }
        status
        assignedAt
      }
      tags { id label }
      consentStatus {
        dataProcessing
        audioRecording
        aiInteraction
        allGranted
      }
    }
  }
`;

const GET_PUBLISHED_TEMPLATES = gql`
  query AdminGetPublishedTemplates {
    getTemplates(status: "published") {
      id
      name
    }
  }
`;

const ASSIGN_TEMPLATE = gql`
  mutation AdminAssignTemplate($userId: ID!, $templateId: ID!) {
    assignTemplateToUser(userId: $userId, templateId: $templateId) {
      id
      template { id name }
      status
      assignedAt
    }
  }
`;

const REMOVE_TEMPLATE = gql`
  mutation AdminRemoveTemplate($userId: ID!, $templateId: ID!) {
    removeTemplateFromUser(userId: $userId, templateId: $templateId)
  }
`;

// ---------------------------------------------------------------------------
// UserManager
// ---------------------------------------------------------------------------

export default function UserManager() {
  const [expandedUserId, setExpandedUserId] = useState<string | null>(null);
  const [assignTemplateId, setAssignTemplateId] = useState<string>('');
  const [assignError, setAssignError] = useState<string | null>(null);

  const { data, loading, error, refetch } = useQuery<{ listUsers: User[] }>(LIST_USERS, {
    fetchPolicy: 'cache-and-network',
  });

  const { data: templateData } = useQuery<{ getTemplates: { id: string; name: string }[] }>(
    GET_PUBLISHED_TEMPLATES,
    { fetchPolicy: 'cache-and-network' },
  );

  const [assignTemplate, { loading: assigning }] = useMutation(ASSIGN_TEMPLATE);
  const [removeTemplate, { loading: removing }] = useMutation(REMOVE_TEMPLATE);

  const users = data?.listUsers ?? [];
  const publishedTemplates = templateData?.getTemplates ?? [];

  const toggleExpand = (userId: string) => {
    setExpandedUserId((prev) => (prev === userId ? null : userId));
    setAssignTemplateId('');
    setAssignError(null);
  };

  const handleAssign = async (userId: string) => {
    if (!assignTemplateId) return;
    setAssignError(null);
    try {
      await assignTemplate({ variables: { userId, templateId: assignTemplateId } });
      setAssignTemplateId('');
      void refetch();
    } catch (err) {
      setAssignError((err as Error).message);
    }
  };

  const handleRemove = async (userId: string, templateId: string) => {
    try {
      await removeTemplate({ variables: { userId, templateId } });
      void refetch();
    } catch (err) {
      setAssignError((err as Error).message);
    }
  };

  return (
    <>
      {/* Header */}
      <header className="page-header">
        <div>
          <h2 className="font-semibold text-[22px] text-graphite">Users</h2>
          <p className="text-grey text-sm">
            View users, manage template assignments, and check consent status.
          </p>
        </div>
      </header>

      {/* Content */}
      <div className="page-content">
        {error && (
          <div role="alert" className="alert-error">
            Failed to load users: {error.message}
          </div>
        )}

        {loading && users.length === 0 ? (
          <div className="text-center py-16 text-grey text-[15px]">
            Loading users…
          </div>
        ) : users.length === 0 ? (
          <div className="text-center py-16 text-grey text-[15px]">
            No users found.
          </div>
        ) : (
          <div className="bg-white rounded-xl border border-ivory-tint overflow-hidden">
            {/* Table header */}
            <div className="grid grid-cols-[1fr_1fr_80px_120px_100px] py-2.5 px-[18px] border-b border-graphite/20 bg-graphite gap-3">
              {['Name', 'Email', 'Role', 'Templates', 'Consent'].map((h) => (
                <span key={h} className="col-header">
                  {h}
                </span>
              ))}
            </div>

            {/* Rows */}
            {users.map((user, i) => {
              const expanded = expandedUserId === user.id;
              const activeAssignments = user.assignedTemplates.filter((a) => a.status === 'active');

              return (
                <div key={user.id}>
                  {/* Main row */}
                  <div
                    onClick={() => toggleExpand(user.id)}
                    className={cn(
                      'grid grid-cols-[1fr_1fr_80px_120px_100px] py-3.5 px-[18px] items-center gap-3 cursor-pointer transition-colors duration-100 hover:bg-horizon-red/[0.03]',
                      !expanded && i < users.length - 1 && 'border-b border-ivory-tint',
                      i % 2 === 0 ? 'bg-white' : 'bg-ivory-tint',
                    )}
                  >
                    <span className="text-sm font-medium text-graphite">
                      {user.name}
                    </span>

                    <span className="text-sm text-grey">{user.email}</span>

                    <span
                      className={cn(
                        'badge',
                        user.role === 'admin'
                          ? 'bg-horizon-red text-white'
                          : 'bg-graphite text-white',
                      )}
                    >
                      {user.role}
                    </span>

                    <span className="text-sm text-graphite font-mono">
                      {activeAssignments.length}
                    </span>

                    <StatusBadge
                      status={user.consentStatus.allGranted ? 'granted' : 'denied'}
                    />
                  </div>

                  {/* Expanded detail */}
                  {expanded && (
                    <div
                      className={cn(
                        'py-4 px-[18px] pb-5 bg-horizon-red/[0.02]',
                        i < users.length - 1 && 'border-b border-ivory-tint',
                      )}
                    >
                      <div className="grid grid-cols-2 gap-6">
                        {/* Left: tags + consent */}
                        <div>
                          <h4 className="text-[13px] font-semibold text-graphite mb-2 uppercase tracking-wide">
                            Tags
                          </h4>
                          {user.tags.length === 0 ? (
                            <p className="text-[13px] text-grey">No tags assigned</p>
                          ) : (
                            <div className="flex flex-wrap gap-1.5">
                              {user.tags.map((tag) => (
                                <span
                                  key={tag.id}
                                  className="px-2.5 py-0.5 rounded-full text-xs font-medium bg-ivory-tint text-graphite"
                                >
                                  {tag.label}
                                </span>
                              ))}
                            </div>
                          )}

                          <h4 className="text-[13px] font-semibold text-graphite mb-2 mt-4 uppercase tracking-wide">
                            Consent
                          </h4>
                          <div className="flex flex-wrap gap-1.5">
                            <StatusBadge status={user.consentStatus.dataProcessing ? 'granted' : 'denied'} />
                            <StatusBadge status={user.consentStatus.audioRecording ? 'granted' : 'denied'} />
                            <StatusBadge status={user.consentStatus.aiInteraction ? 'granted' : 'denied'} />
                          </div>
                        </div>

                        {/* Right: template assignments */}
                        <div>
                          <h4 className="text-[13px] font-semibold text-graphite mb-2 uppercase tracking-wide">
                            Template Assignments
                          </h4>

                          {activeAssignments.length === 0 ? (
                            <p className="text-[13px] text-grey mb-3">
                              No active assignments
                            </p>
                          ) : (
                            <div className="flex flex-col gap-2 mb-3">
                              {activeAssignments.map((a) => (
                                <div
                                  key={a.id}
                                  className="flex items-center justify-between py-2 px-3 bg-white rounded-lg border border-ivory-tint"
                                >
                                  <div>
                                    <span className="text-sm font-medium text-graphite">
                                      {a.template.name}
                                    </span>
                                    <span className="text-xs text-grey ml-2.5">
                                      Assigned {new Date(a.assignedAt).toLocaleDateString()}
                                    </span>
                                  </div>
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      void handleRemove(user.id, a.template.id);
                                    }}
                                    disabled={removing}
                                    className={cn(
                                      'bg-transparent border-none text-red-700 text-lg leading-none px-1 font-primary',
                                      removing ? 'cursor-not-allowed' : 'cursor-pointer',
                                    )}
                                    title="Remove assignment"
                                  >
                                    ×
                                  </button>
                                </div>
                              ))}
                            </div>
                          )}

                          {/* Assign new template */}
                          <div className="flex gap-2 items-center">
                            <select
                              value={assignTemplateId}
                              onChange={(e) => setAssignTemplateId(e.target.value)}
                              className="input-field text-sm flex-1 cursor-pointer"
                            >
                              <option value="">Select template…</option>
                              {publishedTemplates
                                .filter((t) => !activeAssignments.some((a) => a.template.id === t.id))
                                .map((t) => (
                                  <option key={t.id} value={t.id}>
                                    {t.name}
                                  </option>
                                ))}
                            </select>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                void handleAssign(user.id);
                              }}
                              disabled={!assignTemplateId || assigning}
                              className={cn(
                                'btn-primary',
                                (!assignTemplateId || assigning) && 'opacity-50 cursor-not-allowed',
                              )}
                            >
                              {assigning ? 'Assigning…' : 'Assign'}
                            </button>
                          </div>

                          {assignError && (
                            <p className="text-red-700 text-[13px] mt-2 py-1.5 px-2.5 bg-red-100 rounded-md">
                              {assignError}
                            </p>
                          )}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}
