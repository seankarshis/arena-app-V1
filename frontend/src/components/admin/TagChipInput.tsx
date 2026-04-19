'use client';

import React, { useRef, useState, useMemo } from 'react';
import { gql, useMutation, useApolloClient } from '@apollo/client';
import { cn } from '@/lib/utils';

interface Tag {
  id: string;
  label: string;
  isActive: boolean;
}

interface TagChipInputProps {
  value: Tag[];
  allTags: Tag[];
  onChange: (next: Tag[]) => void;
  disabled?: boolean;
  placeholder?: string;
}

const MAX_LABEL_LENGTH = 255;

const CREATE_TAG = gql`
  mutation TagChipCreateTag($label: String!) {
    createTag(label: $label) {
      id
      label
      isActive
    }
  }
`;

const GET_TAGS_FOR_CACHE = gql`
  query TagChipGetTags {
    getTags(includeInactive: false) {
      id
      label
      isActive
    }
  }
`;

export function TagChipInput({
  value,
  allTags,
  onChange,
  disabled,
  placeholder = 'Type to add a tag…',
}: TagChipInputProps) {
  const [draft, setDraft] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const client = useApolloClient();

  const [createTag] = useMutation<{ createTag: Tag }>(CREATE_TAG);

  const ghostMatch = useMemo(() => {
    const trimmed = draft;
    if (trimmed.length === 0) return null;
    const lower = trimmed.toLowerCase();
    const candidates = allTags
      .filter((t) => t.isActive)
      .filter((t) => !value.some((v) => v.id === t.id))
      .filter(
        (t) =>
          t.label.toLowerCase().startsWith(lower) &&
          t.label.length > trimmed.length,
      )
      .sort((a, b) => a.label.localeCompare(b.label));
    return candidates[0] ?? null;
  }, [allTags, value, draft]);

  const ghostSuffix = ghostMatch ? ghostMatch.label.slice(draft.length) : '';

  const commit = async (rawLabel: string) => {
    if (creating) return;
    const clean = rawLabel.trim();
    if (!clean || clean.length > MAX_LABEL_LENGTH) return;

    setError(null);

    // Already on the question (case-insensitive)?
    if (value.some((v) => v.label.toLowerCase() === clean.toLowerCase())) {
      setDraft('');
      return;
    }

    // Matches an existing active tag (case-insensitive)?
    const existing = allTags.find(
      (t) => t.isActive && t.label.toLowerCase() === clean.toLowerCase(),
    );
    if (existing) {
      onChange([...value, existing]);
      setDraft('');
      return;
    }

    // Create new.
    setCreating(true);
    try {
      const { data } = await createTag({
        variables: { label: clean },
        update: (cache, { data: res }) => {
          if (!res?.createTag) return;
          const prev = cache.readQuery<{ getTags: Tag[] }>({
            query: GET_TAGS_FOR_CACHE,
          });
          if (prev) {
            cache.writeQuery({
              query: GET_TAGS_FOR_CACHE,
              data: { getTags: [...prev.getTags, res.createTag] },
            });
          }
        },
      });
      if (data?.createTag) {
        onChange([...value, data.createTag]);
        setDraft('');
      }
    } catch (err) {
      const gqlErr = err as {
        graphQLErrors?: Array<{ extensions?: { code?: string } }>;
        message?: string;
      };
      const code = gqlErr.graphQLErrors?.[0]?.extensions?.code;
      if (code === 'DUPLICATE_ENTRY') {
        // Race: another actor just created it. Refetch and reuse.
        const { data } = await client.query<{ getTags: Tag[] }>({
          query: GET_TAGS_FOR_CACHE,
          fetchPolicy: 'network-only',
        });
        const hit = data.getTags.find(
          (t) => t.label.toLowerCase() === clean.toLowerCase(),
        );
        if (hit) {
          onChange([...value, hit]);
          setDraft('');
        } else {
          setError('Tag exists but could not be loaded');
        }
      } else {
        setError(gqlErr.message ?? 'Failed to create tag');
      }
    } finally {
      setCreating(false);
    }
  };

  const removeChip = (id: string) => {
    onChange(value.filter((t) => t.id !== id));
    inputRef.current?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Tab' && ghostMatch && draft.length > 0) {
      e.preventDefault();
      void commit(ghostMatch.label);
      return;
    }
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      if (draft.trim().length > 0) void commit(draft);
      return;
    }
    if (e.key === 'Backspace' && draft === '' && value.length > 0) {
      e.preventDefault();
      onChange(value.slice(0, -1));
      return;
    }
    if (e.key === 'Escape') {
      setDraft('');
      setError(null);
    }
  };

  return (
    <div>
      <div
        onClick={() => inputRef.current?.focus()}
        className={cn(
          'input-field text-sm flex flex-wrap items-center gap-1.5 cursor-text py-1.5 min-h-[38px]',
          disabled && 'opacity-60 cursor-not-allowed',
        )}
      >
        {value.map((tag) => (
          <span
            key={tag.id}
            className="inline-flex items-center gap-1 py-[3px] pl-2.5 pr-1 rounded-md text-[13px] border-[1.5px] border-horizon-red bg-horizon-red/[0.07] text-horizon-red"
          >
            {tag.label}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                removeChip(tag.id);
              }}
              disabled={disabled}
              aria-label={`Remove ${tag.label}`}
              className="inline-flex items-center justify-center w-4 h-4 rounded hover:bg-horizon-red/15 leading-none"
            >
              ×
            </button>
          </span>
        ))}

        <div className="relative flex-1 min-w-[140px]">
          <input
            ref={inputRef}
            type="text"
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              if (error) setError(null);
            }}
            onKeyDown={onKeyDown}
            disabled={disabled || creating}
            placeholder={value.length === 0 ? placeholder : ''}
            className="w-full bg-transparent outline-none text-sm text-graphite placeholder:text-grey/60"
          />
          {ghostSuffix && (
            <div
              aria-hidden="true"
              className="absolute inset-0 pointer-events-none flex items-center text-sm whitespace-pre"
            >
              <span className="invisible whitespace-pre">{draft}</span>
              <span className="text-grey/50 whitespace-pre">{ghostSuffix}</span>
            </div>
          )}
        </div>
      </div>

      <p className="text-grey text-[12px] leading-snug mt-1">
        Type a tag name. <kbd className="font-mono text-[11px]">Tab</kbd> accepts the
        suggestion; <kbd className="font-mono text-[11px]">Enter</kbd> or
        <kbd className="font-mono text-[11px] ml-1">,</kbd> adds what you typed.
        <kbd className="font-mono text-[11px] ml-1">Backspace</kbd> on an empty field removes the last tag.
      </p>

      {error && (
        <p className="text-horizon-red text-[12px] mt-1">{error}</p>
      )}
    </div>
  );
}
