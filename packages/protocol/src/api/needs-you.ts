import { z } from 'zod';
import { ProjectKey, SetupStep } from './projects.js';

/**
 * One item of "Needs you" (02, section 4), besides the GitHub connection problems of
 * `GET /api/github`. Each lot adds its own types.
 */
export const NeedsYouItem = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('project_setup_failed'),
    project: z.object({ key: ProjectKey, name: z.string() }),
    step: SetupStep,
    reason: z.string(),
    since: z.iso.datetime(),
  }),
]);
export type NeedsYouItem = z.infer<typeof NeedsYouItem>;

/** `GET /api/needs-you`: oldest first. */
export const NeedsYouResponse = z.object({ items: z.array(NeedsYouItem) });
export type NeedsYouResponse = z.infer<typeof NeedsYouResponse>;
