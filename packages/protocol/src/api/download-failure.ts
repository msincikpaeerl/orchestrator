import type { z } from 'zod';
import { DownloadFailure } from '../daemon/git.js';
import { PushPermission } from './token-permissions.js';

/**
 * A run's failed download of the project at its start, as screens show it (lot 3 step K2): the
 * machine's reason and words, with the permission the token needs when GitHub's words say the
 * repository is out of its reach (in the token page's words, as for a refused push).
 */
export const RunDownloadFailure = DownloadFailure.extend({ permission: PushPermission.nullable() });
export type RunDownloadFailure = z.infer<typeof RunDownloadFailure>;
