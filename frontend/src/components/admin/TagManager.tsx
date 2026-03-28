'use client';

import React, { useState, useMemo } from 'react';
import { useQuery, useMutation, gql } from '@apollo/client';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Tag {
  id: string;
  label: string;
  isActive: boolean;
}

// ---------------------------------------------------------------------------
// GQL
// ---------------------------------------------------------------------------

const GET_TAGS = gql`
  query AdminGetAllTags {
    getTags(includeInactive: true) {
      id
      label
      isActive
    }
  }
`;

const CREATE_TAG = gql`
  mutation AdminCreateTag($label: String!) {
    createTag(label: $label) {
      id
      label
      isActive
    }
  }
`;

const UPDATE_TAG = gql`
  mutation AdminUpdateTag($id: ID!, $label: String, $isActive: Boolean) {
    updateTag(id: $id, label: $label, isActive: $isActive) {
      id
      label
      isActive
    }
  }
`;

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const primaryBtn: React.CSSProperties = {
  padding: '10px 20px',
  borderRadius: 999,
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
  borderRadius: 6,
  border: '1px solid var(--grey)',
  backgroundColor: 'var(--ivory-tint)',
  fontFamily: 'var(--font-primary)',
  fontSize: 14,
  color: 'var(--graphite)',
  outline: 'none',
  width: '100%',
};

const colHeader: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  color: 'var(--grey)',
  textTransform: 'uppercase',
  letterSpacing: '0.07em',
};

// ---------------------------------------------------------------------------
// TagModal
// ---------------------------------------------------------------------------

interface TagModalProps {
  mode: 'create' | 'edit';
  tag: Tag | null;
  onSave: (data: { label: string }) => void;
  onClose: () => void;
  isSaving: boolean;
  error: string | null;
}

function TagModal({ mode, tag, onSave, onClose, isSaving, error }: TagModalProps) {
  const [label, setLabel] = useState(tag?.label ?? '');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSave({ label: label.trim() });
  };

  return (
    <div
      onClick={onClose}
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
        onClick={(e) => e.stopPropagation()}
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
          {mode === 'create' ? 'Create Tag' : 'Edit Tag'}
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
              Label *
            </label>
            <input
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              required
              autoFocus
              style={inputStyle}
              placeholder="e.g. Leadership, React, Senior"
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
              disabled={isSaving || !label.trim()}
              style={{
                ...primaryBtn,
                opacity: isSaving || !label.trim() ? 0.5 : 1,
                cursor: isSaving || !label.trim() ? 'not-allowed' : 'pointer',
              }}
            >
              {isSaving ? 'Saving…' : mode === 'create' ? 'Create' : 'Save Changes'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// TagManager
// ---------------------------------------------------------------------------

export default function TagManager() {
  const [modalMode, setModalMode] = useState<'create' | 'edit' | null>(null);
  const [editingTag, setEditingTag] = useState<Tag | null>(null);
  const [modalError, setModalError] = useState<string | null>(null);
  const [showInactive, setShowInactive] = useState(false);

  const { data, loading, error, refetch } = useQuery<{ getTags: Tag[] }>(GET_TAGS, {
    fetchPolicy: 'cache-and-network',
  });

  const [createTag, { loading: creating }] = useMutation(CREATE_TAG);
  const [updateTag, { loading: updating }] = useMutation(UPDATE_TAG);

  const tags = data?.getTags ?? [];

  // Derive unique tag types for filter dropdown
  // Filter tags
  const filteredTags = useMemo(() => {
    return tags.filter((t) => {
      if (!showInactive && !t.isActive) return false;
      return true;
    });
  }, [tags, showInactive]);

  const openCreate = () => {
    setModalError(null);
    setEditingTag(null);
    setModalMode('create');
  };

  const openEdit = (tag: Tag) => {
    setModalError(null);
    setEditingTag(tag);
    setModalMode('edit');
  };

  const closeModal = () => {
    setModalMode(null);
    setEditingTag(null);
    setModalError(null);
  };

  const handleSave = async (data: { label: string }) => {
    setModalError(null);
    try {
      if (modalMode === 'create') {
        await createTag({ variables: data });
      } else if (editingTag) {
        await updateTag({ variables: { id: editingTag.id, ...data } });
      }
      void refetch();
      closeModal();
    } catch (err) {
      setModalError((err as Error).message);
    }
  };

  const handleToggleActive = async (tag: Tag) => {
    try {
      await updateTag({ variables: { id: tag.id, isActive: !tag.isActive } });
      void refetch();
    } catch {
      // silent — could add toast later
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
          <h2 style={{ fontWeight: 600, fontSize: 22, color: 'var(--graphite)' }}>Tags</h2>
          <p style={{ color: 'var(--grey)', fontSize: 14 }}>
            Manage the controlled vocabulary of tags used across questions and users.
          </p>
        </div>
        <button onClick={openCreate} style={primaryBtn}>
          + New Tag
        </button>
      </header>

      {/* Content */}
      <div style={{ padding: '24px 32px' }}>
        {/* Filters */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 16,
            marginBottom: 20,
          }}
        >
          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              fontSize: 14,
              color: 'var(--graphite)',
              cursor: 'pointer',
              userSelect: 'none',
            }}
          >
            <input
              type="checkbox"
              checked={showInactive}
              onChange={(e) => setShowInactive(e.target.checked)}
              style={{ accentColor: 'var(--horizon-red)' }}
            />
            Show inactive
          </label>
        </div>

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
            Failed to load tags: {error.message}
          </div>
        )}

        {loading && tags.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '64px 0', color: 'var(--grey)', fontSize: 15 }}>
            Loading tags…
          </div>
        ) : filteredTags.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '64px 0', color: 'var(--grey)', fontSize: 15 }}>
            {tags.length === 0 ? 'No tags yet. Create one to get started.' : 'No tags match the current filters.'}
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
                gridTemplateColumns: '1fr 100px 140px',
                padding: '11px 18px',
                borderBottom: '1px solid var(--ivory-tint)',
                backgroundColor: 'var(--ivory)',
                gap: 12,
              }}
            >
              {['Label', 'Status', 'Actions'].map((h) => (
                <span key={h} style={colHeader}>
                  {h}
                </span>
              ))}
            </div>

            {/* Rows */}
            {filteredTags.map((tag, i) => (
                <div
                  key={tag.id}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '1fr 100px 140px',
                    padding: '14px 18px',
                    borderBottom: i < filteredTags.length - 1 ? '1px solid var(--ivory-tint)' : 'none',
                    alignItems: 'center',
                    gap: 12,
                    backgroundColor: i % 2 === 0 ? 'var(--white)' : 'var(--ivory)',
                  }}
                >
                  <span style={{ fontSize: 14, fontWeight: 500, color: 'var(--graphite)' }}>
                    {tag.label}
                  </span>

                  <span
                    style={{
                      display: 'inline-block',
                      padding: '3px 10px',
                      borderRadius: 999,
                      fontSize: 12,
                      fontWeight: 600,
                      backgroundColor: tag.isActive ? '#DCFCE7' : '#F3F4F6',
                      color: tag.isActive ? '#15803D' : '#6B7280',
                      width: 'fit-content',
                    }}
                  >
                    {tag.isActive ? 'Active' : 'Inactive'}
                  </span>

                  <div style={{ display: 'flex', gap: 8 }}>
                    <button
                      onClick={() => openEdit(tag)}
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
                    <button
                      onClick={() => void handleToggleActive(tag)}
                      style={{
                        background: 'none',
                        border: '1px solid var(--ivory-tint)',
                        borderRadius: 6,
                        padding: '5px 12px',
                        fontSize: 13,
                        color: tag.isActive ? '#B91C1C' : '#15803D',
                        cursor: 'pointer',
                        fontFamily: 'var(--font-primary)',
                      }}
                    >
                      {tag.isActive ? 'Deactivate' : 'Activate'}
                    </button>
                  </div>
                </div>
            ))}
          </div>
        )}
      </div>

      {/* Modal */}
      {modalMode && (
        <TagModal
          mode={modalMode}
          tag={editingTag}
          onSave={(d) => void handleSave(d)}
          onClose={closeModal}
          isSaving={creating || updating}
          error={modalError}
        />
      )}
    </>
  );
}
