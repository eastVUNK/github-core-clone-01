// REST v3 (/api/v3) — v1 scope: repositories, branches, commits, contents,
// git/refs. Issues, pulls, labels and comments land in Stage 3; GraphQL and
// MCP in Stage 4.
//
// Wire facts (checks-rest.ts via CHECKS-INVENTORY.md §2-3, §6):
// - Every reply application/json, never HTML, non-empty X-GitHub-Request-Id;
//   GET /api/v3/ carries X-OAuth-Scopes. Errors are {message: string}.
// - Create repo / ref / file via PUT contents = 201; update file = 200 or 201;
//   PATCH repo/issue, GETs, merge = 200; DELETE repo = 204; DELETE contents =
//   200 {commit:{sha}}; missing repo/PR/contents/unknown route = 404 {message};
//   no token on a private repo = 401; stale contents sha = 409; unknown issue
//   label = 422; conflicted merge = 405.
// - POST /user/repos for an existing name = 422 with "already exists".
// - GET /user/repos paginates with Link rel="next" (per_page=10 in the check);
//   pages hold <=10 items, no duplicates across pages, same-origin next.
// - A label must be created before an issue may carry it (Stage 3).
// - Contents PUT on an unborn repo is its first commit; update needs the
//   current blob sha, reusing a stale one is 409; DELETE needs the current
//   blob sha in the body.

import {
  FORGE_EPOCH_SEC,
  FORGE_IDENTITY,
  FIXED_ISO,
  VIEWER_EMAIL,
  VIEWER_ID,
  VIEWER_LOGIN,
  VIEWER_NAME,
  hashObject,
  type Repo,
  type Store,
} from './store.ts';
import {
  buildCommit,
  buildTree,
  listCommits,
  parseCommit,
  parseTree,
  ZERO_OID,
  type TreeEntry,
} from './git.ts';

export interface RestReply {
  readonly status: number;
  readonly body: unknown;
  readonly headers?: Readonly<Record<string, string>>;
  readonly empty?: boolean;
}

const ok = (status: number, body: unknown, headers?: Readonly<Record<string, string>>): RestReply => ({ status, body, headers });
const err = (status: number, message: string): RestReply => ({ status, body: { message } });

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: Buffer.from(`Repository:${repo.id}`, 'utf8').toString('base64'),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER_ID, type: 'User' },
    private: repo.privateFlag,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    pushed_at: FIXED_ISO,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    url: `https://api.github.com/repos/${repo.owner}/${repo.name}`,
    clone_url: `https://github.com/${repo.owner}/${repo.name}.git`,
    git_url: `git://github.com/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@github.com:${repo.owner}/${repo.name}.git`,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    has_pages: false,
    has_downloads: true,
    archived: false,
    disabled: false,
    fork: false,
    forks_count: 0,
    stargazers_count: 0,
    watchers_count: 0,
    open_issues_count: repo.issues.size,
    license: null,
    topics: [],
    visibility: repo.privateFlag ? 'private' : 'public',
  };
}

function parseIdentity(line: string): { name: string; email: string; date: string } {
  const match = /^(.*?) <([^>]*)> (\d+) ([+-]\d{4})$/.exec(line);
  if (match === null) return { name: line, email: '', date: FIXED_ISO };
  const timestamp = Number.parseInt(match[3]!, 10);
  return {
    name: match[1]!,
    email: match[2]!,
    date: new Date(timestamp * 1000).toISOString(),
  };
}

function commitJson(repo: Repo, oid: string): Record<string, unknown> | null {
  const obj = repo.objects.get(oid);
  if (obj === undefined || obj.type !== 'commit') return null;
  const view = parseCommit(obj.data);
  const author = parseIdentity(view.author);
  const committer = parseIdentity(view.committer);
  return {
    sha: oid,
    commit: {
      message: view.message,
      author: { name: author.name, email: author.email, date: author.date },
      committer: { name: committer.name, email: committer.email, date: committer.date },
      tree: { sha: view.tree },
    },
    parents: view.parents.map((parent) => ({ sha: parent })),
    author: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    committer: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
  };
}

/** Resolve a `ref` query/body value (branch name, full ref, or commit oid). */
function resolveRef(repo: Repo, ref: string | undefined): string | undefined {
  if (ref === undefined || ref === '') return repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (repo.refs.has(ref)) return repo.refs.get(ref);
  const asBranch = repo.refs.get(`refs/heads/${ref}`);
  if (asBranch !== undefined) return asBranch;
  if (/^[0-9a-f]{40}$/.test(ref) && repo.objects.has(ref)) return ref;
  return undefined;
}

/** Walk a tree by path segments; returns the entry at the end, or null. */
function lookupPath(repo: Repo, rootTreeOid: string, segments: readonly string[]): TreeEntry | null {
  let treeOid = rootTreeOid;
  for (let index = 0; index < segments.length; index += 1) {
    const treeObj = repo.objects.get(treeOid);
    if (treeObj === undefined || treeObj.type !== 'tree') return null;
    const entry = parseTree(treeObj.data).find((e) => e.name === segments[index]);
    if (entry === undefined) return null;
    if (index === segments.length - 1) return entry;
    if (entry.mode !== '40000') return null;
    treeOid = entry.oid;
  }
  return null;
}

/**
 * Set (or delete, when blobOid is null) a path in a tree, bottom-up; returns
 * the new root tree oid. Empty directories are pruned.
 */
function setPathInTree(repo: Repo, rootTreeOid: string | null, segments: readonly string[], blobOid: string | null): string {
  if (segments.length === 0) throw new Error('empty path');
  const name = segments[0]!;
  if (segments.length === 1) {
    const entries: TreeEntry[] = [];
    if (rootTreeOid !== null) {
      const treeObj = repo.objects.get(rootTreeOid);
      if (treeObj !== undefined && treeObj.type === 'tree') {
        for (const entry of parseTree(treeObj.data)) if (entry.name !== name) entries.push(entry);
      }
    }
    if (blobOid !== null) entries.push({ mode: '100644', name, oid: blobOid });
    const data = buildTree(entries);
    const oid = hashObject('tree', data);
    repo.objects.set(oid, { type: 'tree', data });
    return oid;
  }
  let childOid: string | null = null;
  if (rootTreeOid !== null) {
    const treeObj = repo.objects.get(rootTreeOid);
    if (treeObj !== undefined && treeObj.type === 'tree') {
      const entry = parseTree(treeObj.data).find((e) => e.name === name && e.mode === '40000');
      childOid = entry?.oid ?? null;
    }
  }
  const newChild = setPathInTree(repo, childOid, segments.slice(1), blobOid);
  const entries: TreeEntry[] = [];
  if (rootTreeOid !== null) {
    const treeObj = repo.objects.get(rootTreeOid);
    if (treeObj !== undefined && treeObj.type === 'tree') {
      for (const entry of parseTree(treeObj.data)) if (entry.name !== name) entries.push(entry);
    }
  }
  // Keep the directory only when it still holds something.
  const childObj = repo.objects.get(newChild);
  const childEmpty =
    childObj !== undefined && childObj.type === 'tree' && parseTree(childObj.data).length === 0;
  if (!childEmpty) entries.push({ mode: '40000', name, oid: newChild });
  const data = buildTree(entries);
  const oid = hashObject('tree', data);
  repo.objects.set(oid, { type: 'tree', data });
  return oid;
}

/** Write a contents commit on `refName`; returns {blobSha, commitSha}. */
function writeContentsCommit(
  repo: Repo,
  refName: string,
  path: string,
  content: Buffer,
  message: string,
): { blobSha: string; commitSha: string } {
  const blobSha = hashObject('blob', content);
  repo.objects.set(blobSha, { type: 'blob', data: content });
  const tip = repo.refs.get(refName);
  const rootTree = tip === undefined ? null : parseCommit(repo.objects.get(tip)!.data).tree;
  const segments = path.split('/').filter((part) => part !== '');
  const newTree = setPathInTree(repo, rootTree, segments, blobSha);
  const commit = buildCommit({
    tree: newTree,
    parents: tip === undefined ? [] : [tip],
    message,
    author: FORGE_IDENTITY,
    committer: FORGE_IDENTITY,
    timestamp: FORGE_EPOCH_SEC,
  });
  const commitSha = hashObject('commit', commit);
  repo.objects.set(commitSha, { type: 'commit', data: commit });
  repo.refs.set(refName, commitSha);
  return { blobSha, commitSha };
}

function deleteContentsCommit(repo: Repo, refName: string, path: string, message: string): string {
  const tip = repo.refs.get(refName);
  if (tip === undefined) throw new Error('no tip');
  const rootTree = parseCommit(repo.objects.get(tip)!.data).tree;
  const segments = path.split('/').filter((part) => part !== '');
  const newTree = setPathInTree(repo, rootTree, segments, null);
  const commit = buildCommit({
    tree: newTree,
    parents: [tip],
    message,
    author: FORGE_IDENTITY,
    committer: FORGE_IDENTITY,
    timestamp: FORGE_EPOCH_SEC,
  });
  const commitSha = hashObject('commit', commit);
  repo.objects.set(commitSha, { type: 'commit', data: commit });
  repo.refs.set(refName, commitSha);
  return commitSha;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function bodyOf(body: unknown): Record<string, unknown> {
  return isRecord(body) ? body : {};
}

/** The v1 REST router. `segments` are the path parts after `/api/v3/`. */
export function handleRest(
  store: Store,
  method: string,
  segments: readonly string[],
  query: URLSearchParams,
  body: unknown,
  baseUrl: string,
): RestReply {
  // GET /api/v3/ — the root (no auth needed; the starter answers it openly).
  if (segments.length === 0) {
    if (method !== 'GET') return err(404, 'Not Found');
    return ok(200, {
      current_user_url: `${baseUrl}/api/v3/user`,
      authorizations_url: `${baseUrl}/api/v3/authorizations`,
      repository_url: `${baseUrl}/api/v3/repos/{owner}/{repo}`,
      user_url: `${baseUrl}/api/v3/users/{user}`,
    }, { 'x-oauth-scopes': 'repo, read:org' });
  }

  if (segments[0] === 'meta') {
    if (method !== 'GET') return err(404, 'Not Found');
    return ok(200, { installed_version: '1.0.0', verifiable_password_authentication: true });
  }

  if (segments[0] === 'user' && segments[1] === 'repos') {
    if (method === 'POST') {
      const input = bodyOf(body);
      const name = typeof input.name === 'string' ? input.name.trim() : '';
      if (name === '' || name.length > 100 || !/^[A-Za-z0-9._-]+$/.test(name)) {
        return err(422, 'Invalid repository name');
      }
      if (store.getRepo(VIEWER_LOGIN, name) !== undefined) {
        return err(422, 'Repository already exists');
      }
      const repo = store.createRepo(
        name,
        input.private === true,
        typeof input.description === 'string' ? input.description : '',
      );
      return ok(201, repoJson(repo));
    }
    if (method === 'GET') {
      const perPage = Math.min(100, Math.max(1, Number.parseInt(query.get('per_page') ?? '30', 10) || 30));
      const page = Math.max(1, Number.parseInt(query.get('page') ?? '1', 10) || 1);
      const all = store.listViewerRepos();
      const start = (page - 1) * perPage;
      const slice = all.slice(start, start + perPage);
      const headers: Record<string, string> = {};
      if (start + perPage < all.length) {
        const next = `${baseUrl}/api/v3/user/repos?per_page=${perPage}&page=${page + 1}`;
        const lastPage = Math.ceil(all.length / perPage);
        const last = `${baseUrl}/api/v3/user/repos?per_page=${perPage}&page=${lastPage}`;
        headers.link = `<${next}>; rel="next", <${last}>; rel="last"`;
      }
      return ok(200, slice.map(repoJson), headers);
    }
    return err(404, 'Not Found');
  }

  if (segments[0] === 'repos' && segments.length >= 3) {
    const owner = decodeURIComponent(segments[1]!);
    const name = decodeURIComponent(segments[2]!);
    // A repo belongs to the viewer; any other owner is 404, never 403.
    if (owner !== VIEWER_LOGIN) return err(404, 'Not Found');
    const repo = store.getRepo(owner, name);
    if (repo === undefined) return err(404, 'Not Found');

    const rest = segments.slice(3);
    if (rest.length === 0) {
      if (method === 'GET') return ok(200, repoJson(repo));
      if (method === 'PATCH') {
        const input = bodyOf(body);
        if (typeof input.description === 'string') repo.description = input.description;
        if (typeof input.private === 'boolean') repo.privateFlag = input.private;
        return ok(200, repoJson(repo));
      }
      if (method === 'DELETE') {
        store.deleteRepo(owner, name);
        return { status: 204, body: null, empty: true };
      }
      return err(404, 'Not Found');
    }

    if (rest[0] === 'branches' && rest.length === 1) {
      if (method !== 'GET') return err(404, 'Not Found');
      const branches = [...repo.refs.entries()]
        .filter(([ref]) => ref.startsWith('refs/heads/'))
        .map(([ref, oid]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha: oid }, protected: false }));
      return ok(200, branches);
    }

    if (rest[0] === 'git' && rest[1] === 'refs' && rest.length === 2) {
      if (method !== 'POST') return err(404, 'Not Found');
      const input = bodyOf(body);
      const ref = typeof input.ref === 'string' ? input.ref : '';
      const sha = typeof input.sha === 'string' ? input.sha : '';
      if (!ref.startsWith('refs/') || !/^[0-9a-f]{40}$/.test(sha) || repo.objects.get(sha) === undefined) {
        return err(422, 'Invalid ref or sha');
      }
      if (repo.refs.has(ref)) return err(422, 'Reference already exists');
      repo.refs.set(ref, sha);
      return ok(201, { ref, object: { sha }, url: `${baseUrl}/api/v3/repos/${owner}/${name}/git/refs/${encodeURIComponent(ref)}` });
    }

    if (rest[0] === 'commits' && rest.length === 1) {
      if (method !== 'GET') return err(404, 'Not Found');
      const tip = resolveRef(repo, query.get('sha') ?? undefined);
      if (tip === undefined) return ok(200, []);
      const commits = listCommits(repo, tip)
        .map((oid) => commitJson(repo, oid))
        .filter((entry): entry is Record<string, unknown> => entry !== null);
      return ok(200, commits);
    }

    if (rest[0] === 'contents') {
      const path = rest.slice(1).map((part) => decodeURIComponent(part)).join('/');
      if (method === 'GET') {
        const tip = resolveRef(repo, query.get('ref') ?? undefined);
        if (tip === undefined) return err(404, 'Not Found');
        const tipObj = repo.objects.get(tip);
        if (tipObj === undefined || tipObj.type !== 'commit') return err(404, 'Not Found');
        const rootTree = parseCommit(tipObj.data).tree;
        const segments = path.split('/').filter((part) => part !== '');
        if (segments.length === 0) return err(404, 'Not Found');
        const entry = lookupPath(repo, rootTree, segments);
        if (entry === null) return err(404, 'Not Found');
        if (entry.mode === '40000') {
          const treeObj = repo.objects.get(entry.oid);
          if (treeObj === undefined) return err(404, 'Not Found');
          return ok(200, parseTree(treeObj.data).map((child) => ({
            type: child.mode === '40000' ? 'dir' : 'file',
            name: child.name,
            path: `${path}/${child.name}`,
            sha: child.oid,
            size: child.mode === '40000' ? 0 : (repo.objects.get(child.oid)?.data.length ?? 0),
          })));
        }
        const blob = repo.objects.get(entry.oid);
        if (blob === undefined) return err(404, 'Not Found');
        return ok(200, {
          type: 'file',
          encoding: 'base64',
          name: segments[segments.length - 1],
          path,
          content: blob.data.toString('base64'),
          sha: entry.oid,
          size: blob.data.length,
        });
      }
      if (method === 'PUT') {
        const input = bodyOf(body);
        const message = typeof input.message === 'string' ? input.message : `Update ${path}`;
        const contentB64 = typeof input.content === 'string' ? input.content : '';
        let content: Buffer;
        try {
          content = Buffer.from(contentB64.replace(/[\r\n\t ]+/g, ''), 'base64');
        } catch {
          return err(422, 'content must be base64');
        }
        const branch = typeof input.branch === 'string' ? input.branch : repo.defaultBranch;
        const refName = `refs/heads/${branch}`;
        const tip = repo.refs.get(refName);
        const isUpdate = tip !== undefined;
        let existingSha: string | undefined;
        if (tip !== undefined) {
          const rootTree = parseCommit(repo.objects.get(tip)!.data).tree;
          const entry = lookupPath(repo, rootTree, path.split('/').filter((p) => p !== ''));
          existingSha = entry?.oid;
        }
        if (typeof input.sha === 'string' && input.sha !== '' && existingSha !== undefined && input.sha.toLowerCase() !== existingSha.toLowerCase()) {
          return err(409, 'sha does not match the current blob');
        }
        if (tip === undefined && repo.refs.size > 0) return err(404, 'Not Found');
        const { blobSha, commitSha } = writeContentsCommit(repo, refName, path, content, message);
        return ok(isUpdate && existingSha !== undefined ? 200 : 201, {
          content: { name: path.split('/').pop(), path, sha: blobSha, size: content.length, type: 'file', encoding: 'base64' },
          commit: { sha: commitSha },
        });
      }
      if (method === 'DELETE') {
        const input = bodyOf(body);
        const message = typeof input.message === 'string' ? input.message : `Delete ${path}`;
        const branch = typeof input.branch === 'string' ? input.branch : repo.defaultBranch;
        const refName = `refs/heads/${branch}`;
        const tip = repo.refs.get(refName);
        if (tip === undefined) return err(404, 'Not Found');
        const rootTree = parseCommit(repo.objects.get(tip)!.data).tree;
        const entry = lookupPath(repo, rootTree, path.split('/').filter((p) => p !== ''));
        if (entry === null) return err(404, 'Not Found');
        if (typeof input.sha === 'string' && input.sha !== '' && input.sha.toLowerCase() !== entry.oid.toLowerCase()) {
          return err(409, 'sha does not match the current blob');
        }
        const commitSha = deleteContentsCommit(repo, refName, path, message);
        return ok(200, { commit: { sha: commitSha } });
      }
      return err(404, 'Not Found');
    }

    return err(404, 'Not Found');
  }

  return err(404, 'Not Found');
}

export { ZERO_OID };
