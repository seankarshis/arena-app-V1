import { cn } from '@/lib/utils';

type StatusVariant = 'active' | 'published' | 'completed' | 'draft' | 'paused' | 'archived';

const STATUS_MAP: Record<string, StatusVariant> = {
  // Interview statuses
  in_progress: 'active',
  scheduled: 'draft',
  completed: 'completed',
  paused: 'paused',
  abandoned: 'archived',
  // Template statuses
  published: 'published',
  draft: 'draft',
  archived: 'archived',
  // Boolean-like
  active: 'active',
  inactive: 'archived',
  granted: 'completed',
  denied: 'archived',
};

const VARIANT_CLASSES: Record<StatusVariant, string> = {
  active: 'badge-active',
  published: 'badge-published',
  completed: 'badge-completed',
  draft: 'badge-draft',
  paused: 'badge-paused',
  archived: 'badge-archived',
};

interface Props {
  status: string;
  className?: string;
}

export function StatusBadge({ status, className }: Props) {
  const variant = STATUS_MAP[status] ?? 'draft';
  const label = status.replace(/_/g, ' ');
  return (
    <span className={cn(VARIANT_CLASSES[variant], className)}>
      {label}
    </span>
  );
}
