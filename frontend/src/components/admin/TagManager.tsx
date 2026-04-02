'use client';

import React, { useState, useMemo } from 'react';
import { useQuery, useMutation, gql } from '@apollo/client';
import { cn } from '@/lib/utils';
import { StatusBadge } from '@/components/ui/StatusBadge';

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
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-panel max-w-[520px]" onClick={(e) => e.stopPropagation()}>
        <h2 className="font-semibold text-xl text-graphite mb-6">
          {mode === 'create' ? 'Create Tag' : 'Edit Tag'}
        </h2>

        <form onSubmit={handleSubmit}>
          <div className="mb-4">
            <label className="block font-medium text-sm text-graphite mb-1.5">
              Label *
            </label>
            <input
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              required
              autoFocus
              className="input-field text-sm"
              placeholder="e.g. Leadership, React, Senior"
            />
          </div>

          {error && <div className="alert-error mb-4">{error}</div>}

          <div className="flex justify-end gap-3">
            <button
              type="button"
              onClick={onClose}
              disabled={isSaving}
              className={cn('btn-secondary', isSaving && 'opacity-60')}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSaving || !label.trim()}
              className="btn-primary"
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
      // silent
    }
  };

  return (
    <>
      {/* Header */}
      <header className="page-header flex items-center justify-between gap-4">
        <div>
          <h2 className="font-semibold text-[22px] text-graphite">Tags</h2>
          <p className="text-grey text-sm">
            Manage the controlled vocabulary of tags used across questions and users.
          </p>
        </div>
        <button onClick={openCreate} className="btn-primary">
          + New Tag
        </button>
      </header>

      {/* Content */}
      <div className="page-content">
        {/* Filters */}
        <div className="flex items-center gap-4 mb-5">
          <label className="flex items-center gap-2 text-sm text-graphite cursor-pointer select-none">
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
          <div role="alert" className="alert-error mb-4">
            Failed to load tags: {error.message}
          </div>
        )}

        {loading && tags.length === 0 ? (
          <div className="text-center py-16 text-grey text-[15px]">Loading tags…</div>
        ) : filteredTags.length === 0 ? (
          <div className="text-center py-16 text-grey text-[15px]">
            {tags.length === 0 ? 'No tags yet. Create one to get started.' : 'No tags match the current filters.'}
          </div>
        ) : (
          <div className="bg-white rounded border border-ivory-tint overflow-hidden">
            {/* Table header */}
            <div className="grid grid-cols-[1fr_100px_140px] py-2.5 px-[18px] border-b border-graphite/20 bg-graphite gap-3">
              {['Label', 'Status', 'Actions'].map((h) => (
                <span key={h} className="col-header">{h}</span>
              ))}
            </div>

            {/* Rows */}
            {filteredTags.map((tag, i) => (
              <div
                key={tag.id}
                className={cn(
                  'grid grid-cols-[1fr_100px_140px] py-3.5 px-[18px] items-center gap-3 transition-colors duration-100 hover:bg-horizon-red/[0.03]',
                  i < filteredTags.length - 1 && 'border-b border-ivory-tint',
                  i % 2 === 0 ? 'bg-white' : 'bg-ivory-tint'
                )}
              >
                <span className="text-sm font-medium text-graphite">{tag.label}</span>

                <StatusBadge status={tag.isActive ? 'active' : 'inactive'} />

                <div className="flex gap-2">
                  <button
                    onClick={() => openEdit(tag)}
                    className="btn-secondary py-1 px-3 text-[13px]"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => void handleToggleActive(tag)}
                    className={cn(
                      'py-1 px-3 text-[13px]',
                      tag.isActive ? 'btn-wine' : 'btn-secondary'
                    )}
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
