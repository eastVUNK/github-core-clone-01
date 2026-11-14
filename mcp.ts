// MCP over /mcp — JSON-RPC 2.0 over Streamable HTTP, modern era
// 2026-07-28 via `server/discover` (see CHECKS-INVENTORY.md §8). The six
// canonical tools map onto the same Store REST and GraphQL use, so an
// object created over MCP is the same object REST reads back.
//
// Wire notes the suite's mcp-client enforces:
// - discover answers `supportedVersions` (YYYY-MM-DD strings), `serverInfo`
//   (name + version, also under result._meta serverInfo) and
//   `capabilities.tools` (an object); no session is handed out.
// - tools/list is byte-identical across calls: the tool list is a fixed
//   constant, in fixed order.
// - tools/call answers JSON-RPC errors, never HTTP 500: unknown tool
//   -32601, invalid params -32602. A malformed JSON body is HTTP 400 with
//   -32700 (a modern server answering 200 for a parse error fails).
// - tools/call without a bearer is HTTP 401 (checked by app.ts before
//   this handler runs).
// - JSON-RPC ids are echoed verbatim, including string ids, so concurrent
//   calls keep their own answers.

import {
  FIXED_ISO,
  Store,
  VIEWER_ID,
  VIEWER_LOGIN,
  type Issue,
  type PullRequest,
  type Repo,
  type Store as StoreType,
} from './store.ts';
import { computePullFiles, squashMergePull } from './rest.ts';
import { parseCommit } from './git.ts';

const SERVER_NAME = 'forge';
const SERVER_VERSION = '1.0.0';
const PROTOCOL_VERSION = '2026-07-28';

interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, { type: string; description?: string }>; required: string[] };
}

/** Fixed order, fixed content — tools/list must be byte-identical every call. */
const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'Issue state filter: open, closed, or all' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch onto a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Pull request title' },
        body: { type: 'string', description: 'Pull request body' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request onto its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        pull_number: { type: 'number', description: 'Pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

type RpcId = string | number | null;

function rpcResult(id: RpcId, result: unknown): { status: number; json: unknown } {
  return { status: 200, json: { jsonrpc: '2.0', id, result } };
}

function rpcError(id: RpcId, code: number, message: string, status = 200): { status: number; json: unknown } {
  return { status, json: { jsonrpc: '2.0', id, error: { code, message } } };
}

function textResult(payload: Record<string, unknown>, isError = false): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
    ...(isError ? { isError: true } : {}),
  };
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function repoResult(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: Store.globalId('Repository', repo.id),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER_ID, type: 'User' },
    private: repo.privateFlag,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    url: `https://api.github.com/repos/${repo.owner}/${repo.name}`,
  };
}

function issueResult(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: Store.globalId('Issue', issue.id),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name })),
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `https://api.github.com/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function pullResult(repo: Repo, pull: PullRequest): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: Store.globalId('PullRequest', pull.id),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: pull.headSha },
    base: { ref: pull.baseRef, sha: pull.baseSha },
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `https://api.github.com/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

function lookupRepo(store: StoreType, owner: unknown, repoName: unknown): Repo | null {
  if (!nonEmptyString(owner) || !nonEmptyString(repoName)) return null;
  if (owner !== VIEWER_LOGIN) return null;
  return store.getRepo(owner, repoName) ?? null;
}

function callTool(store: StoreType, name: string, args: Record<string, unknown>): { result: Record<string, unknown> } | { error: { code: number; message: string } } {
  switch (name) {
    case 'create_repo': {
      if (!nonEmptyString(args.name)) return { error: { code: -32602, message: "Invalid params: missing required argument 'name'" } };
      const existing = store.getRepo(VIEWER_LOGIN, args.name);
      if (existing !== undefined) return { result: textResult(repoResult(existing)) };
      const repo = store.createRepo(
        args.name,
        args.private === true,
        typeof args.description === 'string' ? args.description : '',
      );
      return { result: textResult(repoResult(repo)) };
    }
    case 'get_repo': {
      const repo = lookupRepo(store, args.owner, args.repo);
      if (repo === null) return { error: { code: -32602, message: 'Invalid params: repository not found' } };
      return { result: textResult(repoResult(repo)) };
    }
    case 'create_issue': {
      if (!nonEmptyString(args.owner) || !nonEmptyString(args.repo) || !nonEmptyString(args.title)) {
        return { error: { code: -32602, message: "Invalid params: create_issue requires 'owner', 'repo' and 'title'" } };
      }
      const repo = lookupRepo(store, args.owner, args.repo);
      if (repo === null) return { error: { code: -32602, message: 'Invalid params: repository not found' } };
      const number = repo.nextIssueNumber++;
      const issue: Issue = {
        id: store.nextIssueIdFor(),
        number,
        title: args.title,
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open',
        labels: [],
        createdSeq: ++repo.seq,
        comments: [],
      };
      repo.issues.set(number, issue);
      return { result: textResult(issueResult(repo, issue)) };
    }
    case 'list_issues': {
      if (!nonEmptyString(args.owner) || !nonEmptyString(args.repo)) {
        return { error: { code: -32602, message: "Invalid params: list_issues requires 'owner' and 'repo'" } };
      }
      const repo = lookupRepo(store, args.owner, args.repo);
      if (repo === null) return { error: { code: -32602, message: 'Invalid params: repository not found' } };
      const state = typeof args.state === 'string' ? args.state.toLowerCase() : 'open';
      const issues = [...repo.issues.values()]
        .filter((issue) => state === 'all' || issue.state === state)
        .map((issue) => issueResult(repo, issue));
      return { result: textResult({ issues, total_count: issues.length }) };
    }
    case 'create_pull_request': {
      if (!nonEmptyString(args.owner) || !nonEmptyString(args.repo) || !nonEmptyString(args.title) || !nonEmptyString(args.head) || !nonEmptyString(args.base)) {
        return { error: { code: -32602, message: "Invalid params: create_pull_request requires 'owner', 'repo', 'title', 'head' and 'base'" } };
      }
      const repo = lookupRepo(store, args.owner, args.repo);
      if (repo === null) return { error: { code: -32602, message: 'Invalid params: repository not found' } };
      const headSha = repo.refs.get(`refs/heads/${args.head}`);
      const baseSha = repo.refs.get(`refs/heads/${args.base}`);
      if (headSha === undefined || baseSha === undefined) {
        return { error: { code: -32602, message: 'Invalid params: invalid head or base branch' } };
      }
      const headTip = repo.objects.get(headSha);
      const baseTip = repo.objects.get(baseSha);
      if (headTip === undefined || baseTip === undefined || headTip.type !== 'commit' || baseTip.type !== 'commit') {
        return { error: { code: -32602, message: 'Invalid params: invalid head or base branch' } };
      }
      const files = computePullFiles(repo, parseCommit(baseTip.data).tree, parseCommit(headTip.data).tree);
      const number = repo.nextPullNumber++;
      const pull: PullRequest = {
        id: store.nextPullIdFor(),
        number,
        title: args.title,
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open',
        merged: false,
        mergeCommitSha: null,
        mergedAt: null,
        headRef: args.head,
        baseRef: args.base,
        headSha,
        baseSha,
        createdSeq: ++repo.seq,
        files,
        headTreeSha: parseCommit(headTip.data).tree,
      };
      repo.pulls.set(number, pull);
      return { result: textResult(pullResult(repo, pull)) };
    }
    case 'merge_pull_request': {
      const pullNumber = typeof args.pull_number === 'number' ? args.pull_number : Number(args.pull_number);
      if (!nonEmptyString(args.owner) || !nonEmptyString(args.repo) || !Number.isSafeInteger(pullNumber) || pullNumber < 1) {
        return { error: { code: -32602, message: "Invalid params: merge_pull_request requires 'owner', 'repo' and 'pull_number'" } };
      }
      const repo = lookupRepo(store, args.owner, args.repo);
      if (repo === null) return { error: { code: -32602, message: 'Invalid params: repository not found' } };
      const pull = repo.pulls.get(pullNumber);
      if (pull === undefined) return { error: { code: -32602, message: 'Invalid params: pull request not found' } };
      const result = squashMergePull(repo, pull);
      if (!result.ok) {
        const message = result.reason === 'conflict'
          ? 'This pull request cannot be merged: merge conflict'
          : 'Pull request cannot be merged';
        return { result: textResult({ merged: false, number: pull.number, error: message }, true) };
      }
      return { result: textResult({ merged: true, number: pull.number, sha: result.sha, state: 'closed', ...pullResult(repo, pull) }) };
    }
    default:
      return { error: { code: -32601, message: `Unknown tool: ${name}` } };
  }
}

/** POST /mcp (and DELETE for the legacy session close). `bodyText` is the raw body. */
export function handleMcp(store: StoreType, method: string, bodyText: string): { status: number; json: unknown } {
  if (method === 'DELETE') return { status: 204, json: undefined };
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    // Modern transport: a malformed body is HTTP 400 with -32700.
    return rpcError(null, -32700, 'Parse error', 400);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return rpcError(null, -32600, 'Invalid Request');
  }
  const req = parsed as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
  const id: RpcId = typeof req.id === 'string' || typeof req.id === 'number' ? req.id : null;
  // A notification (no id) gets no JSON-RPC answer.
  if (req.id === undefined) return { status: 202, json: undefined };
  if (req.method === 'server/discover') {
    const serverInfo = { name: SERVER_NAME, version: SERVER_VERSION };
    return rpcResult(id, {
      supportedVersions: [PROTOCOL_VERSION],
      capabilities: { tools: {} },
      serverInfo,
      _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo },
    });
  }
  if (req.method === 'initialize') {
    const params = (req.params ?? {}) as { protocolVersion?: unknown };
    const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL_VERSION;
    return rpcResult(id, {
      protocolVersion: offered,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }
  if (req.method === 'tools/list') {
    return rpcResult(id, { tools: TOOLS });
  }
  if (req.method === 'tools/call') {
    const params = (req.params ?? {}) as { name?: unknown; arguments?: unknown };
    if (!nonEmptyString(params.name)) return rpcError(id, -32602, "Invalid params: missing tool name");
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    if (typeof args !== 'object' || args === null || Array.isArray(args)) {
      return rpcError(id, -32602, 'Invalid params: arguments must be an object');
    }
    const outcome = callTool(store, params.name, args);
    if ('error' in outcome) return rpcError(id, outcome.error.code, outcome.error.message);
    return rpcResult(id, outcome.result);
  }
  if (typeof req.method === 'string' && req.method.startsWith('notifications/')) {
    return { status: 202, json: undefined };
  }
  return rpcError(id, -32601, `Method not found: ${String(req.method)}`);
}
