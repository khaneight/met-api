import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ValidationError } from '../errors.js';
import { MAX_OFFSET, type RecentWorksService } from './service.js';

export const DEFAULT_QUERY = 'bread';
export const MAX_LIMIT = 20;

const RecentWorksQuerySchema = z.object({
  q: z.string().trim().min(1).max(200).default(DEFAULT_QUERY),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(5),
  offset: z.coerce.number().int().min(0).max(MAX_OFFSET).default(0),
  hasImages: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
});

export function registerWorksRoutes(app: FastifyInstance, service: RecentWorksService): void {
  /**
   * GET /works/recent?q=bread&limit=5&offset=0&hasImages=true
   * Returns a page of works matching `q`, most recent objectEndDate first.
   */
  app.get('/works/recent', async (request, reply) => {
    const parsed = RecentWorksQuerySchema.safeParse(request.query);
    if (!parsed.success) throw new ValidationError(z.flattenError(parsed.error).fieldErrors);

    const { hasImages, ...rest } = parsed.data;
    const result = await service.findRecent(hasImages === undefined ? rest : { ...rest, hasImages });

    // Results are served from our upstream cache; let clients/CDNs reuse briefly.
    reply.header('cache-control', 'public, max-age=300');
    return result;
  });
}
