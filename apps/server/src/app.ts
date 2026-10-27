import cookie from '@fastify/cookie';
import {
  PROTOCOL_VERSION,
  STREAM_RETRY_MS,
  type HealthResponse,
  type VersionResponse,
} from '@orchestrator/protocol';
import Fastify, { type FastifyBaseLogger } from 'fastify';
import type { Pool } from 'pg';
import { registerAgentRoutes } from './agents/routes.js';
import { registerAuthRoutes } from './auth/routes.js';
import { createDatabase } from './database.js';
import { GITHUB_API_URL, GITHUB_WEB_URL } from './github/client.js';
import { registerDownloads, defaultDaemonPackageDir, providedDaemonBuild } from './downloads.js';
import { registerEventLogRoutes } from './event-log.js';
import { registerGitHubRoutes } from './github/routes.js';
import { handleError } from './http.js';
import { registerAccountRoutes } from './machines/accounts.js';
import { registerTimeZoneRoutes } from './settings/time-zone.js';
import { Scheduler } from './scheduler/loop.js';
import { registerQueueRoutes } from './scheduler/routes.js';
import { DaemonGateway } from './machines/gateway.js';
import { registerMachineRoutes } from './machines/routes.js';
import { registerNeedsYouRoutes } from './needs-you.js';
import { registerProjectRoutes } from './projects/routes.js';
import { registerRequestRoutes } from './requests/routes.js';
import { ChangeFeed } from './realtime/changes.js';
import { registerStreamRoute } from './realtime/stream.js';
import { registerRunRoutes } from './runs/routes.js';
import { CiCheckAgain } from './runs/ci-again.js';
import { CiWatcher, type CiRead } from './runs/ci-wait.js';
import { RunService } from './runs/service.js';
import { BranchCleanUp } from './tickets/branch-clean-up.js';
import { AutomaticMerger } from './tickets/automatic-merge.js';
import { PullRequestWatcher } from './tickets/merge-watch.js';
import { PullRequestOpener } from './tickets/pull-request.js';
import { ReviewPoster } from './runs/review-post.js';
import { loadTemplates } from './agents/files.js';
import { deriveSecretKey } from './secrets.js';
import { registerSettingRoutes } from './settings/routes.js';
import { registerTicketRoutes } from './tickets/routes.js';
import { SERVER_VERSION } from './version.js';
import { registerWeb } from './web.js';

export interface AppDependencies {
  pool: Pool;
  logger: FastifyBaseLogger;
  /** ORCHESTRATOR_SECRET_KEY: encrypts stored secrets (ADR 0016). */
  secretKey: string;
  publicUrl: string;
  /** GitHub's REST API; tests use a local fake. */
  githubApiUrl?: string;
  /** Base of the clone URLs sent to daemons (05, section 4.1); tests use a local Git remote. */
  gitBaseUrl?: string;
  /** Clock for time-based rules (login throttling) and timestamps; tests replace it. */
  now?: () => Date;
  /** Folder of the built UI; `null` or absent serves the API only. */
  webRoot?: string | null;
  /** Milliseconds in one second of the daemon heartbeat settings; tests shorten it. */
  daemonSecondMs?: number;
  /** Folder of the daemon package served at `/downloads/`; tests build their own. */
  daemonPackageDir?: string;
  /** Interval of the realtime stream's keep-alive and session check; tests shorten it. */
  streamKeepAliveMs?: number;
  /**
   * False in tests: the CI checks start only when the test asks (`ciWatcherOf(app).tick()`), with
   * the test's clock (lot 3 step G1a).
   */
  ciTimers?: boolean;
  /**
   * False in tests: the scheduler's loop starts runs only when the test asks
   * (`schedulerOf(app).tick()`), with the test's clock (lot 4 step D2a).
   */
  schedulerTimers?: boolean;
  /** Milliseconds in one second of **Scheduler check interval**; tests of the timers shorten it. */
  schedulerSecondMs?: number;
}

const ciWatchers = new WeakMap<object, CiWatcher>();
const automaticMergers = new WeakMap<object, AutomaticMerger>();
const schedulers = new WeakMap<object, Scheduler>();

/** The application's scheduler, for tests that run its loop by hand. */
export function schedulerOf(app: object): Scheduler {
  const scheduler = schedulers.get(app);
  if (!scheduler) throw new Error('no scheduler for this application');
  return scheduler;
}

/** The application's CI checks, for tests that run them by hand. */
export function ciWatcherOf(app: object): CiWatcher {
  const watcher = ciWatchers.get(app);
  if (!watcher) throw new Error('no CI watcher for this application');
  return watcher;
}

/** The application's automatic merges, for tests that wait for a try to end. */
export function automaticMergerOf(app: object): AutomaticMerger {
  const merger = automaticMergers.get(app);
  if (!merger) throw new Error('no automatic merges for this application');
  return merger;
}

/** Builds the HTTP application without listening, so tests can use `inject`. */
export function buildApp(dependencies: AppDependencies) {
  const { pool, logger } = dependencies;
  const db = createDatabase(pool);
  const app = Fastify({ loggerInstance: logger });
  const daemonPackageDir = dependencies.daemonPackageDir ?? defaultDaemonPackageDir();
  const providedBuild = () => providedDaemonBuild(daemonPackageDir);
  app.setErrorHandler(handleError);
  void app.register(cookie);
  const gateway = new DaemonGateway({
    db,
    log: logger,
    publicUrl: dependencies.publicUrl,
    providedDaemonBuild: providedBuild,
    secondMs: dependencies.daemonSecondMs,
    now: dependencies.now,
  });
  const key = deriveSecretKey(dependencies.secretKey);
  // The clean-up after a merge, on GitHub and on the machines (lot 3 step J2), looked at by the
  // CI loop, at each end report and at each machine's reconnection.
  const branchCleanUps = new BranchCleanUp({
    db,
    key,
    apiUrl: dependencies.githubApiUrl ?? GITHUB_API_URL,
    log: logger,
    daemons: gateway,
    now: dependencies.now,
  });
  gateway.attachBranchCleanUps(branchCleanUps);
  let templates: ReturnType<typeof loadTemplates> | undefined;
  const pullRequests = new PullRequestOpener({
    db,
    key,
    apiUrl: dependencies.githubApiUrl ?? GITHUB_API_URL,
    log: logger,
    publicUrl: dependencies.publicUrl,
    templates: () => (templates ??= loadTemplates()),
    // The watcher records a merge the opener finds (lot 3 step J1); built below, with the runs.
    pullRequestSeen: (ticketId, pull) => watcher.seen(ticketId, pull),
    now: dependencies.now,
  });
  const reviewPosts = new ReviewPoster({
    db,
    key,
    apiUrl: dependencies.githubApiUrl ?? GITHUB_API_URL,
    log: logger,
    publicUrl: dependencies.publicUrl,
    templates: () => (templates ??= loadTemplates()),
    now: dependencies.now,
  });
  const runs = new RunService({
    db,
    log: logger,
    key,
    githubApiUrl: dependencies.githubApiUrl ?? GITHUB_API_URL,
    gitBaseUrl: dependencies.gitBaseUrl ?? GITHUB_WEB_URL,
    now: dependencies.now,
    secondMs: dependencies.daemonSecondMs,
    pullRequestWanted: (ticketId) => void pullRequests.request(ticketId),
    reviewPostWanted: (runId) => void reviewPosts.request(runId),
    automaticMergeWanted: (ticketId) => void merges.request(ticketId),
    endReported: (ticketId) => void branchCleanUps.runEnded(ticketId),
  });
  runs.attach(gateway);
  gateway.attachRuns(runs);
  // The tickets' pull requests watched on GitHub (lot 3 step J1), looked at by the CI loop.
  const watcher = new PullRequestWatcher({
    db,
    key,
    apiUrl: dependencies.githubApiUrl ?? GITHUB_API_URL,
    log: logger,
    runs,
    now: dependencies.now,
  });
  // The automatic merges (04, section 4; lot 5 step 5bis B): tried after Quality's approval, at
  // start, at each GitHub check and when a Claude account is resumed (owner's answer 7).
  const merges: AutomaticMerger = new AutomaticMerger({
    db,
    key,
    apiUrl: dependencies.githubApiUrl ?? GITHUB_API_URL,
    log: logger,
    readCommit: (repo, commit, pullRequest, startWaitOver): Promise<CiRead> =>
      ci.readCommit(repo, commit, pullRequest, startWaitOver),
    pullRequestSeen: (ticketId, pull) => watcher.seen(ticketId, pull),
    now: dependencies.now,
  });
  automaticMergers.set(app, merges);
  // The wait for CI of accepted submissions (04, section 3.1; lot 3 step G1a), restored from what
  // the runs keep: the first check at start, then every GitHub check interval.
  const ci = new CiWatcher({
    db,
    key,
    apiUrl: dependencies.githubApiUrl ?? GITHUB_API_URL,
    log: logger,
    outcomes: {
      recorded: (runId, commit, found) => runs.ciRecorded(runId, commit, found),
      decided: (runId, commit, decided) => runs.ciDecided(runId, commit, decided),
      timedOut: (runId, commit, detail) => runs.ciTimedOut(runId, commit, detail),
      roundDue: (runId) => runs.ciRoundDue(runId),
    },
    retryPullRequest: (ticketId) => pullRequests.request(ticketId),
    pullRequests: watcher,
    automaticMerges: merges,
    branchCleanUps,
    now: dependencies.now,
    timers: dependencies.ciTimers,
  });
  ciWatchers.set(app, ci);
  const ciAgain = new CiCheckAgain({
    db,
    key,
    apiUrl: dependencies.githubApiUrl ?? GITHUB_API_URL,
    log: logger,
    readCommit: (repo, commit, pullRequest, startWaitOver) =>
      ci.readCommit(repo, commit, pullRequest, startWaitOver),
    now: dependencies.now,
  });
  app.addHook('onReady', () => {
    ci.start();
  });
  gateway.register(app);
  // Dispatches waiting for their acknowledgement get their timers back after a restart. A
  // database problem is logged and does not stop the server: the health check reports it.
  app.addHook('onReady', async () => {
    await runs.restoreTimers().catch((error: unknown) => {
      logger.error({ err: error }, 'dispatch timers not restored');
    });
  });
  // The realtime stream's change feed (02, section 1; ADR 0029).
  const feed = new ChangeFeed({ pool, log: logger, retryMs: STREAM_RETRY_MS });
  app.addHook('onReady', async () => {
    await feed.start();
  });
  // The scheduler's loop (07, section 2; lot 4 step D2a): on each relevant change of the feed,
  // and at least once per **Scheduler check interval**.
  const scheduler = new Scheduler({
    db,
    pool,
    log: logger,
    runs,
    feed,
    now: dependencies.now,
    timers: dependencies.schedulerTimers,
    secondMs: dependencies.schedulerSecondMs,
  });
  schedulers.set(app, scheduler);
  app.addHook('onReady', () => {
    scheduler.start();
  });
  // Pull requests still wanted when the server stopped: tried once (04, section 3.1). Not awaited,
  // so GitHub's answers never delay the start.
  app.addHook('onReady', () => {
    void pullRequests.retryWanted().catch((error: unknown) => {
      logger.error({ err: error }, 'pull requests still wanted not tried again');
    });
  });
  // Quality's comment reviews still wanted when the server stopped: posted, or found on GitHub,
  // at most once (06, section 4.5; lot 3 step H3). Not awaited, as above.
  app.addHook('onReady', () => {
    void reviewPosts.retryWanted().catch((error: unknown) => {
      logger.error({ err: error }, 'comment reviews still wanted not posted');
    });
  });
  // Automatic merges wanted or sent when the server stopped: tried, or settled, once (04,
  // section 4). Not awaited, as above.
  app.addHook('onReady', () => {
    void merges.check().catch((error: unknown) => {
      logger.error({ err: error }, 'automatic merges still wanted not tried');
    });
  });
  app.addHook('onClose', async () => {
    await scheduler.close();
    await ci.close();
    runs.close();
    feed.close();
    await pullRequests.idle();
    await reviewPosts.idle();
    await merges.idle();
  });

  // Polled by Docker every few seconds: only failures are logged.
  app.get('/health', { logLevel: 'warn' }, async (request, reply) => {
    try {
      await pool.query('SELECT 1');
      return { status: 'ok', database: 'ok' } satisfies HealthResponse;
    } catch (error) {
      request.log.warn({ err: error }, 'health check: database unreachable');
      return reply.code(503).send({ status: 'error', database: 'error' } satisfies HealthResponse);
    }
  });

  registerDownloads(app, daemonPackageDir);

  app.get('/version', () => {
    return {
      server: SERVER_VERSION,
      protocol: PROTOCOL_VERSION,
      daemonBuild: providedBuild(),
    } satisfies VersionResponse;
  });

  void app.register((scope, _options, done) => {
    registerStreamRoute(scope, { db, feed, keepAliveMs: dependencies.streamKeepAliveMs });
    registerAuthRoutes(scope, {
      db,
      secureCookies: new URL(dependencies.publicUrl).protocol === 'https:',
      now: dependencies.now,
    });
    const github = {
      db,
      key,
      apiUrl: dependencies.githubApiUrl ?? GITHUB_API_URL,
    };
    registerGitHubRoutes(scope, github);
    registerProjectRoutes(scope, { ...github, now: dependencies.now });
    registerTicketRoutes(scope, {
      db,
      runs,
      pullRequests,
      ciAgain,
      watcher,
      now: dependencies.now,
    });
    registerRequestRoutes(scope, { db, runs, now: dependencies.now });
    registerRunRoutes(scope, { db, runs });
    registerAgentRoutes(scope, { db });
    registerNeedsYouRoutes(scope, {
      db,
      publicUrl: dependencies.publicUrl,
      providedDaemonBuild: providedBuild,
      runs,
      now: dependencies.now,
    });
    registerSettingRoutes(scope, { db });
    registerEventLogRoutes(scope, { db });
    registerAccountRoutes(scope, {
      db,
      now: dependencies.now,
      resumed: () => void merges.check().catch(() => undefined),
    });
    registerTimeZoneRoutes(scope, { db });
    registerQueueRoutes(scope, { db, now: dependencies.now });
    registerMachineRoutes(scope, {
      db,
      gateway,
      runs,
      publicUrl: dependencies.publicUrl,
      providedDaemonBuild: providedBuild,
      now: dependencies.now,
    });
    done();
  });

  registerWeb(app, dependencies.webRoot ?? null);

  return app;
}

export type App = ReturnType<typeof buildApp>;
