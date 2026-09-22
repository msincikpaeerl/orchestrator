import {
  InspectGitHubTokenRequest,
  SaveGitHubTokenRequest,
  type InspectGitHubTokenResponse,
} from '@orchestrator/protocol';
import type { FastifyInstance } from 'fastify';
import { requireSession } from '../auth/routes.js';
import type { Database } from '../database.js';
import { HttpError, parseInput } from '../http.js';
import { SecretUnreadableError, loadSecret, type SecretKey } from '../secrets.js';
import type { Settings } from '../settings.js';
import { GitHubUnreachableError, createGitHubClient } from './client.js';
import {
  GITHUB_TOKEN_SECRET,
  isPast,
  loadStatus,
  markTokenInvalid,
  saveCheck,
  saveToken,
} from './connection.js';
import { checkToken, inspectToken, isFineGrainedToken } from './token-check.js';

export interface GitHubRoutesOptions {
  db: Database;
  key: SecretKey;
  settings: Settings;
  apiUrl: string;
}

/**
 * Wizard step 2 and Settings > GitHub connection (02, sections 3 and 10). The token goes from
 * the browser to the server and GitHub only: no answer contains it and it is never logged.
 */
export function registerGitHubRoutes(app: FastifyInstance, options: GitHubRoutesOptions) {
  const { db, key, settings, apiUrl } = options;

  const clientFor = (token: string) =>
    createGitHubClient({ apiUrl, token, timeoutSeconds: settings.githubRequestTimeoutSeconds });

  function requireFineGrained(token: string) {
    if (!isFineGrainedToken(token)) {
      throw new HttpError(
        422,
        'github_token_not_fine_grained',
        'This is not a fine-grained personal access token (it must start with github_pat_)',
      );
    }
  }

  async function reachingGitHub<T>(action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error) {
      if (error instanceof GitHubUnreachableError) {
        app.log.warn({ err: error }, 'GitHub unreachable');
        throw new HttpError(502, 'github_unreachable', 'GitHub could not be reached; try again');
      }
      throw error;
    }
  }

  const invalidToken = () =>
    new HttpError(
      422,
      'github_token_invalid',
      'GitHub rejected this token: it is wrong, expired or revoked',
    );

  app.get('/api/github', async (request) => {
    await requireSession(db, request);
    return loadStatus(db, settings);
  });

  app.post('/api/github/token/inspect', async (request) => {
    await requireSession(db, request);
    const { token } = parseInput(InspectGitHubTokenRequest, request.body);
    requireFineGrained(token);
    const identity = await reachingGitHub(() => inspectToken(clientFor(token)));
    if (!identity.valid) throw invalidToken();
    return {
      account: identity.account,
      suggestedExpiresOn: identity.suggestedExpiresOn,
    } satisfies InspectGitHubTokenResponse;
  });

  app.put('/api/github/token', async (request) => {
    await requireSession(db, request);
    const { token, expiresOn } = parseInput(SaveGitHubTokenRequest, request.body);
    requireFineGrained(token);
    if (expiresOn !== null && isPast(expiresOn)) {
      throw new HttpError(422, 'expiry_date_in_past', 'The expiry date is in the past');
    }
    const check = await reachingGitHub(() => checkToken(clientFor(token)));
    if (!check.valid) throw invalidToken();
    await saveToken(db, key, { token, expiresOn, ...check });
    request.log.info({ account: check.account }, 'GitHub token saved');
    return loadStatus(db, settings);
  });

  app.post('/api/github/token/check', async (request) => {
    await requireSession(db, request);
    let token: string | null;
    try {
      token = await loadSecret(db, key, GITHUB_TOKEN_SECRET);
    } catch (error) {
      if (!(error instanceof SecretUnreadableError)) throw error;
      request.log.error({ err: error }, 'stored GitHub token unreadable');
      throw new HttpError(
        409,
        'github_token_unreadable',
        'The saved token cannot be decrypted with the current ORCHESTRATOR_SECRET_KEY; save the token again',
      );
    }
    if (token === null) throw new HttpError(409, 'github_not_connected', 'No GitHub token saved');
    const check = await reachingGitHub(() => checkToken(clientFor(token)));
    if (check.valid) await saveCheck(db, check);
    else await markTokenInvalid(db, 'owner', 'GET /user');
    return loadStatus(db, settings);
  });
}
