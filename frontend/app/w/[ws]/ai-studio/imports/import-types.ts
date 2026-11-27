'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useWs } from '@/lib/hooks';

export type ImportFields = Record<string, unknown>;
export type ReviewStatus = 'APPROVED' | 'REJECTED' | 'SKIP' | 'NEEDS_REVIEW';
export type ImportCounts = Partial<Record<string, number>>;

export interface ImportSummary {
  id: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  templateVersion?: string | null;
  errorSummary?: string | null;
  progress?: number | null;
  processingStep?: string | null;
  counts?: ImportCounts;
  _count?: { files: number; items: number };
}

export interface ImportItem {
  id: string;
  fileId?: string | null;
  entityType: string;
  destination: string;
  status: string;
  payload: ImportFields;
  proposedValue?: ImportFields | null;
  existingValue?: ImportFields | null;
  confidence?: number | null;
  classification?: string | null;
  verificationStatus?: string | null;
  sourceLocator?: string | null;
  sourceExcerpt?: string | null;
  mappingExplanation?: string | null;
  conflictReason?: string | null;
  duplicateCandidates?: unknown[] | null;
  relationships?: Array<{ entityType: string; externalId: string }> | null;
  reviewNote?: string | null;
  destinationEntityId?: string | null;
  applicationResult?: string | null;
  appliedAt?: string | null;
  updatedAt?: string | null;
  error?: string | null;
}

export interface ImportSession extends ImportSummary {
  files: Array<{ id: string; fileName: string; byteCount: number; status?: string | null; error?: string | null }>;
  items: ImportItem[];
  auditEvents?: Array<{ id: string; action: string; createdAt: string; data?: unknown; metadata?: unknown }>;
}

export const isProcessing = (s: string) => ['UPLOADED', 'PROCESSING', 'READY', 'APPLYING'].includes(s);

export function useCanReviewImports() {
  const ws = useWs();
  const me = useQuery({
    queryKey: ['me'],
    queryFn: () => api<{ workspaces: Array<{ id: string; role: string }> }>('/auth/me'),
  });
  return ['OWNER', 'ADMIN'].includes(me.data?.workspaces.find((w) => w.id === ws)?.role ?? '');
}

export function importItemName(item: ImportItem) {
  const data = item.proposedValue ?? item.payload;
  for (const [key, value] of Object.entries(data)) {
    if (/^(name|title|opportunity)$|Name$/i.test(key) && typeof value === 'string' && value.trim()) return value;
  }
  return item.sourceLocator ?? '';
}
