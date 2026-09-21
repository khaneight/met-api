import { z } from 'zod';

/**
 * Only the fields we use are validated; everything else is ignored so that
 * additive upstream changes don't break us.
 */
export const SearchResponseSchema = z.object({
  total: z.number().int().nonnegative(),
  // The Met returns `null` (not []) when nothing matches.
  objectIDs: z.array(z.number().int()).nullable(),
});

export const MetObjectSchema = z.object({
  objectID: z.number().int(),
  title: z.string().default(''),
  objectName: z.string().default(''),
  objectDate: z.string().default(''),
  objectBeginDate: z.number().int(),
  objectEndDate: z.number().int(),
  artistDisplayName: z.string().default(''),
  culture: z.string().default(''),
  department: z.string().default(''),
  medium: z.string().default(''),
  primaryImage: z.string().default(''),
  primaryImageSmall: z.string().default(''),
  objectURL: z.string().default(''),
});

export type MetObject = z.infer<typeof MetObjectSchema>;
