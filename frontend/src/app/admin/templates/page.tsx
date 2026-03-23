'use client';

import React, { useState } from 'react';
import { useQuery, useMutation, gql } from '@apollo/client';
import { useRouter } from 'next/navigation';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface InterviewTemplate {
  id: string;
  name: string;
  description: string | null;
  status: string;
  questions: { id: string }[];
}

// ---------------------------------------------------------------------------
// GQL
// ---------------------------------------------------------------------------

const GET_TEMPLATES = gql`
  query AdminGetTemplates {
    getTemplates {
      id
      name
      description
      status
      questions { id }
    }
  }
`;

const CREATE_TEMPLATE = gql`
  mutation AdminCreateTemplate($name: String!, $description: String) {
    createTemplate(name: $name, description: $description) {
      id
      name
      description
      status
    }
  }
`;

// ---------------------------------------------------------------------------
// Shared styles
// ---------------------------------------------------------------------------

const primaryBtn: React.CSSProperties = {
  padding: '10px 20px',
  borderRadius: 8,
  border: 'none',
  backgroundColor: 'var(--horizon-red)',
  color: 'var(--white)',
  fontFamily: 'var(--font-primary)',
  fontWeight: 600,
  fontSize: 14,
  cursor: 'pointer',
};

const secondaryBtn: React.CSSProperties = {
  padding: '10px 20px',
  borderRadius: 8,
  border: '1px solid var(--ivory-tint)',
  backgroundColor: 'var(--white)',
  color: 'var(--graphite)',
  fontFamily: 'var(--font-primary)',
  fontWeight: 500,
  fontSize: 14,
  cursor: 'pointer',
};

const inputStyle: React.CSSProperties = {
  padding: '10px 14px',
  borderRadius: 8,
  border: '1px solid var(--ivory-tint)',
  backgroundColor: 'var(--ivory-tint)',
  fontFamily: 'var(--font-primary)',
  fontSize: 14,
  color: 'var(--graphite)',
  outline: 'none',
  width: '100%',
};

// ---------------------------------------------------------------------------
// CreateTemplateModal
// ---------------------------------------------------------------------------

interface CreateModalProps {
  onSave: (name: string, description: string) => void;
  onClose: () => void;
  isSaving: boolean;
  error: string | null;
}

function CreateTemplateModal({ onSave, onClose, isSaving, error }: CreateModalProps) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSave(name.trim(), description.trim());
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 50,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'rgba(26,26,26,0.5)',
      }}
    >
      <div
        style={{
          backgroundColor: 'var(--white)',
          borderRadius: 12,
          padding: 32,
          width: '100%',
          maxWidth: 520,
          boxShadow: '0 8px 32px rgba(0,0,0,0.18)',
        }}
      >
        <h2
          style={{
            fontFamily: 'var(--font-primary)',
            fontWeight: 600,
            fontSize: 20,
            color: 'var(--graphite)',
            marginBottom: 24,
          }}
        >
          Create Template
        </h2>

        <form onSubmit={handleSubmit}>
          <div style={{ marginBottom: 18 }}>
            <label
              style={{
                display: 'block',
                fontWeight: 500,
                fontSize: 14,
                color: 'var(--graphite)',
                marginBottom: 6,
              }}
            >
              Template Name *
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              autoFocus
              style={inputStyle}
              placeholder="e.g. Senior Engineer Interview — Q2 2026"
            />
          </div>

          <div style={{ marginBottom: 24 }}>
            <label
              style={{
                display: 'block',
                fontWeight: 500,
                fontSize: 14,
                color: 'var(--graphite)',
                marginBottom: 6,
              }}
            >
              Description
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              style={{ ...inputStyle, resize: 'vertical' }}
              placeholder="Optional: describe the purpose of this template…"
            />
          </div>

          {error && (
            <p
              style={{
                color: 'var(--horizon-red)',
                fontSize: 14,
                marginBottom: 16,
                padding: '8px 12px',
                backgroundColor: '#FEE2E2',
                borderRadius: 6,
              }}
            >
              {error}
            </p>
          )}

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 12 }}>
            <button
              type="button"
              onClick={onClose}
              disabled={isSaving}
              style={{ ...secondaryBtn, opacity: isSaving ? 0.6 : 1 }}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSaving || !name.trim()}
              style={{
                ...primaryBtn,
                opacity: isSaving || !name.trim() ? 0.5 : 1,
                cursor: isSaving || !name.trim() ? 'not-allowed' : 'pointer',
              }}
            >
              {isSaving ? 'Creating…' : 'Create & Edit'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Status badge helper
// ---------------------------------------------------------------------------

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, React.CSSProperties> = {
    published: { backgroundColor: '#DCFCE7', color: '#15803D' },
    archived: { backgroundColor: '#F3F4F6', color: '#6B7280' },
    draft: { backgroundColor: '#FEF3C7', color: '#92400E' },
  };
  const s = styles[status] ?? styles.draft;
  return (
    <span
      style={{
        padding: '3px 10px',
        borderRadius: 999,
        fontSize: 12,
        fontWeight: 600,
        ...s,
      }}
    >
      {status.charAt(0).toUpperCase() + status.slice(1)}
    </span>
  );
}

// ---------------------------------------------------------------------------
// TemplatesPage
// ---------------------------------------------------------------------------

export default function TemplatesPage() {
  const router = useRouter();
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const { data, loading, error, refetch } = useQuery<{
    getTemplates: InterviewTemplate[];
  }>(GET_TEMPLATES, { fetchPolicy: 'cache-and-network' });

  const [createTemplate, { loading: creating }] = useMutation(CREATE_TEMPLATE);

  const handleCreate = async (name: string, description: string) => {
    setCreateError(null);
    try {
      const result = await createTemplate({
        variables: { name, description: description || null },
      });
      const newId = (result.data as { createTemplate: { id: string } })
        .createTemplate.id;
      void refetch();
      router.push(`/admin/templates/${newId}`);
    } catch (err) {
      setCreateError((err as Error).message);
    }
  };

  const templates = data?.getTemplates ?? [];

  return (
    <div
      style={{
        minHeight: '100vh',
        backgroundColor: 'var(--ivory)',
        fontFamily: 'var(--font-primary)',
      }}
    >
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
          <h2
            style={{
              fontFamily: 'var(--font-primary)',
              fontWeight: 600,
              fontSize: 22,
              color: 'var(--graphite)',
              marginBottom: 2,
            }}
          >
            Interview Templates
          </h2>
          <p style={{ color: 'var(--grey)', fontSize: 14 }}>
            Create and manage interview templates. Only published templates can be
            assigned to users.
          </p>
        </div>
        <button
          onClick={() => {
            setCreateError(null);
            setShowCreateModal(true);
          }}
          style={primaryBtn}
        >
          + New Template
        </button>
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
            Failed to load templates: {error.message}
          </div>
        )}

        {loading && templates.length === 0 ? (
          <div
            style={{
              textAlign: 'center',
              padding: '64px 0',
              color: 'var(--grey)',
              fontSize: 15,
            }}
          >
            Loading templates…
          </div>
        ) : templates.length === 0 ? (
          <div
            style={{
              textAlign: 'center',
              padding: '64px 0',
              color: 'var(--grey)',
              fontSize: 15,
            }}
          >
            No templates yet. Create one to get started.
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
                gridTemplateColumns: '1fr 120px 100px 80px',
                padding: '11px 18px',
                borderBottom: '1px solid var(--ivory-tint)',
                backgroundColor: 'var(--ivory)',
                gap: 12,
              }}
            >
              {['Template', 'Status', 'Questions', 'Action'].map((h) => (
                <span
                  key={h}
                  style={{
                    fontSize: 11,
                    fontWeight: 600,
                    color: 'var(--grey)',
                    textTransform: 'uppercase',
                    letterSpacing: '0.07em',
                  }}
                >
                  {h}
                </span>
              ))}
            </div>

            {templates.map((tpl, i) => (
              <div
                key={tpl.id}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '1fr 120px 100px 80px',
                  padding: '16px 18px',
                  borderBottom:
                    i < templates.length - 1
                      ? '1px solid var(--ivory-tint)'
                      : 'none',
                  alignItems: 'center',
                  gap: 12,
                }}
              >
                {/* Name + description */}
                <div>
                  <p
                    style={{
                      fontSize: 14,
                      fontWeight: 500,
                      color: 'var(--graphite)',
                      marginBottom: tpl.description ? 3 : 0,
                    }}
                  >
                    {tpl.name}
                  </p>
                  {tpl.description && (
                    <p
                      style={{
                        fontSize: 12,
                        color: 'var(--grey)',
                        lineHeight: 1.4,
                        overflow: 'hidden',
                        maxHeight: '2.8em',
                      }}
                    >
                      {tpl.description}
                    </p>
                  )}
                </div>

                <StatusBadge status={tpl.status} />

                <span
                  style={{
                    fontSize: 14,
                    color: 'var(--graphite)',
                    fontFamily: 'var(--font-mono)',
                  }}
                >
                  {tpl.questions.length}
                </span>

                <button
                  onClick={() => router.push(`/admin/templates/${tpl.id}`)}
                  style={{
                    background: 'none',
                    border: '1px solid var(--ivory-tint)',
                    borderRadius: 6,
                    padding: '5px 12px',
                    fontSize: 13,
                    color: 'var(--graphite)',
                    cursor: 'pointer',
                    fontFamily: 'var(--font-primary)',
                  }}
                >
                  Edit
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Create modal */}
      {showCreateModal && (
        <CreateTemplateModal
          onSave={(name, description) => void handleCreate(name, description)}
          onClose={() => setShowCreateModal(false)}
          isSaving={creating}
          error={createError}
        />
      )}
    </div>
  );
}
