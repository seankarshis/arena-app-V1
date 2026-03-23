'use client';

import { useParams } from 'next/navigation';
import TemplateBuilder from '@/components/admin/TemplateBuilder';

export default function TemplatePage() {
  const params = useParams();
  const id = params.id as string;
  return <TemplateBuilder templateId={id} />;
}
