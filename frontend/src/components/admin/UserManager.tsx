'use client';

import React, { useState } from 'react';
import { useQuery, useMutation, gql } from '@apollo/client';

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
// Styles
// ---------------------------------------------------------------------------

const primaryBtn: React.CSSProperties = {
  padding: '8px 16px',
  borderRadius: 999,
  border: 'none',
  backgroundColor: 'var(--horizon-red)',
  color: 'var(--white)',
  fontFamily: 'var(--font-primary)',
  fontWeight: 600,
  fontSize: 13,
  cursor: 'pointer',
};

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
// ConsentBadge
// ---------------------------------------------------------------------------

function ConsentBadge({ granted, label }: { granted: boolean; label: string }) {
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '2px 8px',
        borderRadius: 999,
        fontSize: 11,
        fontWeight: 600,
        backgroundColor: granted ? '#DCFCE7' : '#F3F4F6',
        color: granted ? '#15803D' : '#6B7280',
        marginRight: 6,
      }}
    >
      {label}
    </span>
  );
}

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
          <h2 style={{ fontWeight: 600, fontSize: 22, color: 'var(--graphite)' }}>Users</h2>
          <p style={{ color: 'var(--grey)', fontSize: 14 }}>
            View users, manage template assignments, and check consent status.
          </p>
        </div>
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
            Failed to load users: {error.message}
          </div>
        )}

        {loading && users.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '64px 0', color: 'var(--grey)', fontSize: 15 }}>
            Loading users…
          </div>
        ) : users.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '64px 0', color: 'var(--grey)', fontSize: 15 }}>
            No users found.
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
                gridTemplateColumns: '1fr 1fr 80px 120px 100px',
                padding: '11px 18px',
                borderBottom: '1px solid var(--ivory-tint)',
                backgroundColor: 'var(--ivory)',
                gap: 12,
              }}
            >
              {['Name', 'Email', 'Role', 'Templates', 'Consent'].map((h) => (
                <span key={h} style={colHeader}>
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
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '1fr 1fr 80px 120px 100px',
                      padding: '14px 18px',
                      borderBottom: expanded ? 'none' : i < users.length - 1 ? '1px solid var(--ivory-tint)' : 'none',
                      alignItems: 'center',
                      gap: 12,
                      cursor: 'pointer',
                      backgroundColor: i % 2 === 0 ? 'var(--white)' : 'var(--ivory)',
                      transition: 'background-color 0.1s',
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = 'rgba(122,14,19,0.03)'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = i % 2 === 0 ? 'var(--white)' : 'var(--ivory)'; }}
                  >
                    <span style={{ fontSize: 14, fontWeight: 500, color: 'var(--graphite)' }}>
                      {user.name}
                    </span>

                    <span style={{ fontSize: 14, color: 'var(--grey)' }}>{user.email}</span>

                    <span
                      style={{
                        display: 'inline-block',
                        padding: '3px 10px',
                        borderRadius: 999,
                        fontSize: 12,
                        fontWeight: 600,
                        backgroundColor: user.role === 'admin' ? '#F3E8FF' : '#F3F4F6',
                        color: user.role === 'admin' ? '#7C3AED' : '#6B7280',
                        width: 'fit-content',
                      }}
                    >
                      {user.role}
                    </span>

                    <span
                      style={{
                        fontSize: 14,
                        color: 'var(--graphite)',
                        fontFamily: 'var(--font-mono)',
                      }}
                    >
                      {activeAssignments.length}
                    </span>

                    <span
                      style={{
                        display: 'inline-block',
                        padding: '3px 10px',
                        borderRadius: 999,
                        fontSize: 12,
                        fontWeight: 600,
                        backgroundColor: user.consentStatus.allGranted ? '#DCFCE7' : '#FEF3C7',
                        color: user.consentStatus.allGranted ? '#15803D' : '#92400E',
                        width: 'fit-content',
                      }}
                    >
                      {user.consentStatus.allGranted ? 'All granted' : 'Incomplete'}
                    </span>
                  </div>

                  {/* Expanded detail */}
                  {expanded && (
                    <div
                      style={{
                        padding: '16px 18px 20px',
                        borderBottom: i < users.length - 1 ? '1px solid var(--ivory-tint)' : 'none',
                        backgroundColor: 'rgba(122,14,19,0.02)',
                      }}
                    >
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 }}>
                        {/* Left: tags + consent */}
                        <div>
                          <h4
                            style={{
                              fontSize: 13,
                              fontWeight: 600,
                              color: 'var(--graphite)',
                              marginBottom: 8,
                              textTransform: 'uppercase',
                              letterSpacing: '0.05em',
                            }}
                          >
                            Tags
                          </h4>
                          {user.tags.length === 0 ? (
                            <p style={{ fontSize: 13, color: 'var(--grey)' }}>No tags assigned</p>
                          ) : (
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                              {user.tags.map((tag) => (
                                <span
                                  key={tag.id}
                                  style={{
                                    padding: '3px 10px',
                                    borderRadius: 999,
                                    fontSize: 12,
                                    fontWeight: 500,
                                    backgroundColor: 'var(--ivory-tint)',
                                    color: 'var(--graphite)',
                                  }}
                                >
                                  {tag.label}
                                </span>
                              ))}
                            </div>
                          )}

                          <h4
                            style={{
                              fontSize: 13,
                              fontWeight: 600,
                              color: 'var(--graphite)',
                              marginBottom: 8,
                              marginTop: 16,
                              textTransform: 'uppercase',
                              letterSpacing: '0.05em',
                            }}
                          >
                            Consent
                          </h4>
                          <div>
                            <ConsentBadge granted={user.consentStatus.dataProcessing} label="Data Processing" />
                            <ConsentBadge granted={user.consentStatus.audioRecording} label="Audio Recording" />
                            <ConsentBadge granted={user.consentStatus.aiInteraction} label="AI Interaction" />
                          </div>
                        </div>

                        {/* Right: template assignments */}
                        <div>
                          <h4
                            style={{
                              fontSize: 13,
                              fontWeight: 600,
                              color: 'var(--graphite)',
                              marginBottom: 8,
                              textTransform: 'uppercase',
                              letterSpacing: '0.05em',
                            }}
                          >
                            Template Assignments
                          </h4>

                          {activeAssignments.length === 0 ? (
                            <p style={{ fontSize: 13, color: 'var(--grey)', marginBottom: 12 }}>
                              No active assignments
                            </p>
                          ) : (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 12 }}>
                              {activeAssignments.map((a) => (
                                <div
                                  key={a.id}
                                  style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'space-between',
                                    padding: '8px 12px',
                                    backgroundColor: 'var(--white)',
                                    borderRadius: 8,
                                    border: '1px solid var(--ivory-tint)',
                                  }}
                                >
                                  <div>
                                    <span style={{ fontSize: 14, fontWeight: 500, color: 'var(--graphite)' }}>
                                      {a.template.name}
                                    </span>
                                    <span
                                      style={{
                                        fontSize: 12,
                                        color: 'var(--grey)',
                                        marginLeft: 10,
                                      }}
                                    >
                                      Assigned {new Date(a.assignedAt).toLocaleDateString()}
                                    </span>
                                  </div>
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      void handleRemove(user.id, a.template.id);
                                    }}
                                    disabled={removing}
                                    style={{
                                      background: 'none',
                                      border: 'none',
                                      color: '#B91C1C',
                                      cursor: removing ? 'not-allowed' : 'pointer',
                                      fontSize: 18,
                                      lineHeight: 1,
                                      padding: '0 4px',
                                      fontFamily: 'var(--font-primary)',
                                    }}
                                    title="Remove assignment"
                                  >
                                    ×
                                  </button>
                                </div>
                              ))}
                            </div>
                          )}

                          {/* Assign new template */}
                          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                            <select
                              value={assignTemplateId}
                              onChange={(e) => setAssignTemplateId(e.target.value)}
                              style={{ ...inputStyle, flex: 1, cursor: 'pointer' }}
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
                              style={{
                                ...primaryBtn,
                                opacity: !assignTemplateId || assigning ? 0.5 : 1,
                                cursor: !assignTemplateId || assigning ? 'not-allowed' : 'pointer',
                              }}
                            >
                              {assigning ? 'Assigning…' : 'Assign'}
                            </button>
                          </div>

                          {assignError && (
                            <p
                              style={{
                                color: '#B91C1C',
                                fontSize: 13,
                                marginTop: 8,
                                padding: '6px 10px',
                                backgroundColor: '#FEE2E2',
                                borderRadius: 6,
                              }}
                            >
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
