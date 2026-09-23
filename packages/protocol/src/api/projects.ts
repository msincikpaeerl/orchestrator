import { z } from 'zod';
import { TicketStatus } from './tickets.js';

/**
 * Branch protection of a project's default branch (01, section 3.1; 08, section 3.1).
 * `not_available`: the owner's GitHub plan does not offer it for this repository.
 * `not_applied`: a linked repository, which the Orchestrator never changes.
 */
export const BranchProtection = z.enum(['applied', 'not_available', 'failed', 'not_applied']);
export type BranchProtection = z.infer<typeof BranchProtection>;

/** Harness elements looked for in a linked repository, in the order of 08, section 3.4. */
export const HarnessElement = z.enum(['claude_md', 'user_docs', 'dev_docs', 'adrs', 'ci_workflow']);
export type HarnessElement = z.infer<typeof HarnessElement>;

/** 2 to 6 uppercase letters, prefix of ticket numbers (01, section 3.1). Immutable. */
export const ProjectKey = z.string().regex(/^[A-Z]{2,6}$/, 'must be 2 to 6 uppercase letters');
export type ProjectKey = z.infer<typeof ProjectKey>;

export const ProjectKind = z.enum(['web_app', 'website', 'android_app']);
export type ProjectKind = z.infer<typeof ProjectKind>;

export const ProjectStatus = z.enum(['active', 'archived']);
export type ProjectStatus = z.infer<typeof ProjectStatus>;

export const RepositoryOrigin = z.enum(['created', 'linked']);
export type RepositoryOrigin = z.infer<typeof RepositoryOrigin>;

export const SetupStatus = z.enum(['in_progress', 'ready', 'failed']);
export type SetupStatus = z.infer<typeof SetupStatus>;

/**
 * Steps of the repository setup, in order. A new repository goes through `repository`,
 * `skeleton` and `branch_protection` (08, section 3.1); a linked one through `harness` only
 * (08, section 3.4). Trying again resumes from the failed step.
 */
export const SetupStep = z.enum(['repository', 'skeleton', 'branch_protection', 'harness']);
export type SetupStep = z.infer<typeof SetupStep>;

export const SETUP_STEPS: Readonly<Record<RepositoryOrigin, readonly SetupStep[]>> = {
  created: ['repository', 'skeleton', 'branch_protection'],
  linked: ['harness'],
};

/** GitHub's rule for repository names: letters, digits, `.`, `-` and `_`, at most 100. */
export const RepositoryName = z
  .string()
  .regex(/^[A-Za-z0-9._-]{1,100}$/, 'may only contain letters, digits, ".", "-" and "_"')
  .refine((name) => name !== '.' && name !== '..', 'cannot be "." or ".."');

/** URL-safe name from a display name; for a new repository, the suggested repository name. */
export function slugify(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9._]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 100);
}

export const ProjectName = z.string().trim().min(1).max(100);
export const ProjectDescription = z.string().trim().max(1000);

export const Project = z.object({
  id: z.uuid(),
  key: ProjectKey,
  name: z.string(),
  slug: z.string(),
  description: z.string(),
  kind: ProjectKind,
  repository: z.object({
    owner: z.string(),
    name: z.string(),
    origin: RepositoryOrigin,
    private: z.boolean(),
    /** Null until the new repository is created. */
    defaultBranch: z.string().nullable(),
  }),
  setup: z.object({
    status: SetupStatus,
    /** The step running or failed; null when ready. */
    step: SetupStep.nullable(),
    /** Why the setup failed, written for the owner; null unless failed. */
    failure: z.string().nullable(),
  }),
  /** Null until the branch protection step of a new repository has run. */
  branchProtection: BranchProtection.nullable(),
  /** Linked repositories only: missing elements at the last check; null before the first one. */
  harness: z.object({ missing: z.array(HarnessElement), checkedAt: z.iso.datetime() }).nullable(),
  status: ProjectStatus,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Project = z.infer<typeof Project>;

/** Number of tickets in each state; every state is present, 0 when it has none. */
export const TicketCounts = z.record(TicketStatus, z.int().min(0));
export type TicketCounts = z.infer<typeof TicketCounts>;

/** A project as the project list shows it (02, section 6.1). */
export const ProjectListItem = Project.extend({ ticketCounts: TicketCounts });
export type ProjectListItem = z.infer<typeof ProjectListItem>;

export const ProjectListResponse = z.object({ projects: z.array(ProjectListItem) });
export type ProjectListResponse = z.infer<typeof ProjectListResponse>;

/** `GET /api/projects?archived=true` also lists archived projects. */
export const ProjectListQuery = z.object({
  archived: z.enum(['true', 'false']).default('false'),
});

const NewProjectFields = {
  name: ProjectName,
  key: ProjectKey,
  kind: ProjectKind,
  description: ProjectDescription.default(''),
};

/** New project (02, section 6.2): a new repository, or one of the owner's existing ones. */
export const CreateProjectRequest = z.object({
  ...NewProjectFields,
  repository: z.discriminatedUnion('origin', [
    z.object({ origin: z.literal('created'), name: RepositoryName, private: z.boolean() }),
    z.object({ origin: z.literal('linked'), name: RepositoryName }),
  ]),
});
export type CreateProjectRequest = z.infer<typeof CreateProjectRequest>;

/** Project settings (02, section 6.5): the key, repository and kind cannot be changed. */
export const UpdateProjectRequest = z
  .strictObject({ name: ProjectName, description: ProjectDescription })
  .partial()
  .refine((value) => value.name !== undefined || value.description !== undefined, {
    message: 'nothing to change',
  });
export type UpdateProjectRequest = z.infer<typeof UpdateProjectRequest>;

/** `GET /api/projects/availability`: each value given is checked. */
export const AvailabilityQuery = z.object({
  key: z.string().optional(),
  repositoryName: z.string().optional(),
});

export const Availability = z.enum(['free', 'taken', 'invalid']);
export type Availability = z.infer<typeof Availability>;

export const AvailabilityResponse = z.object({
  /** `taken`: used by another project, archived ones included. */
  key: Availability.optional(),
  /** `taken`: a repository with this name exists on the owner's GitHub account. */
  repositoryName: Availability.optional(),
});
export type AvailabilityResponse = z.infer<typeof AvailabilityResponse>;

/** The owner's repositories that can be linked: personal account, not archived, not linked. */
export const LinkableRepositoriesResponse = z.object({
  repositories: z.array(
    z.object({ name: z.string(), private: z.boolean(), defaultBranch: z.string() }),
  ),
});
export type LinkableRepositoriesResponse = z.infer<typeof LinkableRepositoriesResponse>;
