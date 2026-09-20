import { z } from 'zod';

export const BrowseQuery = z.object({
  kind: z.enum(['observations', 'captures', 'transcripts', 'entities', 'state']).default('observations'),
  query: z.string().trim().max(2000).default(''),
  from: z.coerce.number().finite().nonnegative().optional(),
  to: z.coerce.number().finite().nonnegative().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(40),
  cursor: z.string().max(1000).optional(),
  history: z.enum(['true', 'false']).default('false').transform(v => v === 'true'),
  entityKind: z.enum(['person', 'object', 'place', 'event']).optional(),
}).strict().refine(v => v.from === undefined || v.to === undefined || v.from <= v.to, 'Invalid time range')
  .refine(v => !v.entityKind || v.kind === 'entities', 'entityKind only applies to entities');
export type BrowseFilter = z.output<typeof BrowseQuery>;
export const BrowseCursor = z.object({
  filter: z.string(), snapshot: z.number().int().nonnegative(),
  at: z.number().finite().nonnegative(), row: z.number().int().positive(),
}).strict();
export interface BrowseItem {
  id: string; kind: string; at: number; title: string; text: string; status: string | null;
  captureId: string | null; entityId: string | null; data: Record<string, unknown>;
}
