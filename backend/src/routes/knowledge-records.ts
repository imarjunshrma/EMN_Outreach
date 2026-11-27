import { z } from 'zod';
import { route } from '../http/router.js';
import { ImportEntityTypeSchema } from '../../../shared/src/knowledge-import.js';
import { getKnowledgeRecord, listKnowledgeRecords } from '../services/knowledge-import-apply.js';

route({
  method: 'get', path: '/w/:workspaceId/ai-studio/knowledge-records', tag: 'AI Studio',
  summary: 'List workspace business knowledge records with their latest revisions', auth: 'workspace', role: 'VIEWER',
  query: z.object({
    kind: ImportEntityTypeSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(100),
    offset: z.coerce.number().int().min(0).default(0),
  }),
  handler: c => listKnowledgeRecords(c.workspaceId, c.query.kind, c.query.limit, c.query.offset),
});

route({
  method: 'get', path: '/w/:workspaceId/ai-studio/knowledge-records/:id', tag: 'AI Studio',
  summary: 'Read a workspace business knowledge record and its version history', auth: 'workspace', role: 'VIEWER',
  handler: c => getKnowledgeRecord(c.workspaceId, z.string().uuid().parse(c.params.id)),
});
