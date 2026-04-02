'use client';

import React, { useState } from 'react';
import { useQuery, useMutation, gql } from '@apollo/client';
import { useRouter } from 'next/navigation';
import { cn } from '@/lib/utils';
import { StatusBadge } from '@/components/ui/StatusBadge';

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
    <div className="modal-backdrop">
      <div className="modal-panel max-w-[520px]">
        <h2 className="font-semibold text-xl text-graphite mb-6">
          Create Template
        </h2>

        <form onSubmit={handleSubmit}>
          <div className="mb-4">
            <label className="block font-medium text-sm text-graphite mb-1.5">
              Template Name *
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              autoFocus
              className="input-field text-sm"
              placeholder="e.g. Senior Engineer Interview — Q2 2026"
            />
          </div>

          <div className="mb-6">
            <label className="block font-medium text-sm text-graphite mb-1.5">
              Description
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              className="input-field text-sm resize-y"
              placeholder="Optional: describe the purpose of this template…"
            />
          </div>

          {error && (
            <div className="alert-error mb-4">{error}</div>
          )}

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
              disabled={isSaving || !name.trim()}
              className="btn-primary"
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
    <>
      {/* Header */}
      <header className="page-header flex items-center justify-between gap-4">
        <div>
          <h2 className="font-semibold text-[22px] text-graphite mb-0.5">
            Interview Templates
          </h2>
          <p className="text-grey text-sm">
            Create and manage interview templates. Only published templates can be
            assigned to users.
          </p>
        </div>
        <button
          onClick={() => {
            setCreateError(null);
            setShowCreateModal(true);
          }}
          className="btn-primary"
        >
          + New Template
        </button>
      </header>

      {/* Content */}
      <div className="page-content">
        {error && (
          <div role="alert" className="alert-error mb-4">
            Failed to load templates: {error.message}
          </div>
        )}

        {loading && templates.length === 0 ? (
          <div className="text-center py-16 text-grey text-[15px]">
            Loading templates…
          </div>
        ) : templates.length === 0 ? (
          <div className="text-center py-16 text-grey text-[15px]">
            No templates yet. Create one to get started.
          </div>
        ) : (
          <div className="bg-white rounded border border-ivory-tint overflow-hidden">
            {/* Table header */}
            <div className="grid grid-cols-[1fr_120px_100px_80px] py-2.5 px-[18px] border-b border-graphite/20 bg-graphite gap-3">
              {['Template', 'Status', 'Questions', 'Action'].map((h) => (
                <span key={h} className="col-header">{h}</span>
              ))}
            </div>

            {templates.map((tpl, i) => (
              <div
                key={tpl.id}
                className={cn(
                  'grid grid-cols-[1fr_120px_100px_80px] py-4 px-[18px] items-center gap-3 border-b border-ivory-tint last:border-b-0 transition-colors duration-100 hover:bg-horizon-red/[0.03]',
                  i % 2 === 0 ? 'bg-white' : 'bg-ivory-tint'
                )}
              >
                {/* Name + description */}
                <div>
                  <p className={cn('text-sm font-medium text-graphite', tpl.description && 'mb-0.5')}>
                    {tpl.name}
                  </p>
                  {tpl.description && (
                    <p className="text-xs text-grey leading-snug overflow-hidden max-h-[2.8em]">
                      {tpl.description}
                    </p>
                  )}
                </div>

                <StatusBadge status={tpl.status} />

                <span className="text-sm text-graphite font-mono">
                  {tpl.questions.length}
                </span>

                <button
                  onClick={() => router.push(`/admin/templates/${tpl.id}`)}
                  className="btn-secondary py-1 px-3 text-[13px]"
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
    </>
  );
}
