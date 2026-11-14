import { createHash } from 'node:crypto';

// The forge's store: one in-memory store for every surface (REST, GraphQL,
// MCP, git). A trial runs the entry once, so nothing is persisted to disk;
// everything the suite can observe derives from insertion order and the
// seeded inputs, never from a clock, randomness or the port.
//
// Identity: the suite's bearer token names the scenario's viewer. The
// scenario is a pure function of the kit's constant SCENARIO_SEED
// (program/env/src/wire.ts buildScenario()), identical in every trial, so
// the viewer login is the fixed string below, verified by running
// buildScenario() against the kit: viewer adaiversen (id 1000),
// stranger olgabauer. A repository belongs to the viewer; the same name
// under any other owner is 404, never 403.

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const DEFAULT_BRANCH = 'main';
/** Fixed timestamp for commits the forge itself writes (contents, merges). */
export const FORGE_EPOCH_SEC = 1_700_000_000;
export const FORGE_IDENTITY = 'ada iversen <adaiversen@example.invalid>';
/** Fixed ISO timestamps on REST objects: nothing the suite exports may vary. */
export const FIXED_ISO = '2025-01-01T00:00:00Z';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  readonly type: GitObjectType;
  readonly data: Buffer;
}

export interface Issue {
  readonly id: number;
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  readonly createdSeq: number;
  readonly comments: IssueComment[];
}

export interface IssueComment {
  readonly id: number;
  body: string;
}

export interface PullRequest {
  readonly id: number;
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergeCommitSha: string | null;
  mergedAt: string | null;
  readonly headRef: string;
  readonly baseRef: string;
  readonly headSha: string;
  readonly baseSha: string;
  readonly createdSeq: number;
  /** Files changed by the PR, in push order: {path, status, additions, deletions}. */
  readonly files: PullFile[];
  /** The head branch tip at PR creation, for conflict detection on merge. */
  readonly headTreeSha: string;
}

export interface PullFile {
  readonly filename: string;
  readonly status: 'added' | 'modified' | 'removed';
  readonly additions: number;
  readonly deletions: number;
}

export interface Repo {
  readonly id: number;
  readonly name: string;
  readonly owner: string;
  privateFlag: boolean;
  description: string;
  readonly defaultBranch: string;
  /** oid store: every object ever pushed or written through any surface. */
  readonly objects: Map<string, GitObject>;
  /** refs: full ref name -> tip oid. */
  readonly refs: Map<string, string>;
  readonly labels: Map<string, { name: string; color: string }>;
  readonly issues: Map<number, Issue>;
  readonly pulls: Map<number, PullRequest>;
  nextIssueNumber: number;
  nextPullNumber: number;
  nextCommentId: number;
  /** Monotonic creation sequence, shared by issues and pulls for ordering. */
  seq: number;
}

export class Store {
  readonly repos = new Map<string, Repo>();
  private nextRepoId = 1;
  private nextIssueId = 1;
  private nextPullId = 1;

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  createRepo(name: string, privateFlag: boolean, description: string): Repo {
    const repo: Repo = {
      id: this.nextRepoId++,
      name,
      owner: VIEWER_LOGIN,
      privateFlag,
      description,
      defaultBranch: DEFAULT_BRANCH,
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextIssueNumber: 1,
      nextPullNumber: 1,
      nextCommentId: 1,
      seq: 0,
    };
    this.repos.set(this.key(VIEWER_LOGIN, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  listViewerRepos(): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === VIEWER_LOGIN) out.push(repo);
    return out;
  }

  nextIssueIdFor(): number {
    return this.nextIssueId++;
  }

  nextPullIdFor(): number {
    return this.nextPullId++;
  }

  /** Opaque, stable global id (GraphQL `id`): base64 of `Type:<database id>`. */
  static globalId(kind: string, id: number): string {
    return Buffer.from(`${kind}:${id}`, 'utf8').toString('base64');
  }
}

/** SHA-1 over `<type> <size>\0` + bytes: the object id. */
export function hashObject(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}
