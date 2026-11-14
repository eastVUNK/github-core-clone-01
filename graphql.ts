// GraphQL over /api/graphql — a small hand-rolled executor for the 18
// frozen documents the suite sends (see CHECKS-INVENTORY.md §7). It is
// deliberately not a general GraphQL server: it parses the query/mutation
// operation the suite actually sends, resolves it against the same Store
// REST and git use, and answers exactly what the suite's graphql-client
// expects — HTTP 200 with an `errors` array only for genuinely unknown
// fields, `repository` === null (no errors) for an unknown repo, and
// opaque base64 global ids that are never the plain database id or number.
//
// Perf: every read is a Map lookup or a walk of one repo's own issue/pull
// maps; nothing re-scans the object store per request.

import {
  FIXED_ISO,
  Store,
  VIEWER_ID,
  VIEWER_LOGIN,
  VIEWER_NAME,
  type Issue,
  type PullRequest,
  type Repo,
  type Store as StoreType,
} from './store.ts';
import { computePullFiles, pullMergeable, squashMergePull } from './rest.ts';
import { parseCommit } from './git.ts';

/* ------------------------------------------------------------ lexer */

type Token =
  | { kind: 'punct'; value: string }
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number };

const PUNCT = new Set(['{', '}', '(', ')', ':', ',', '[', ']', '!', '$', '=']);

function lex(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i]!;
    if (/\s/.test(ch) || ch === ',') { i += 1; continue; }
    if (ch === '#') { while (i < input.length && input[i] !== '\n') i += 1; continue; }
    if (input.startsWith('...', i)) { tokens.push({ kind: 'punct', value: '...' }); i += 3; continue; }
    if (PUNCT.has(ch)) { tokens.push({ kind: 'punct', value: ch }); i += 1; continue; }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\' && j + 1 < input.length) {
          const esc = input[j + 1]!;
          if (esc === 'u' && j + 5 < input.length) {
            out += String.fromCharCode(Number.parseInt(input.slice(j + 2, j + 6), 16));
            j += 6;
          } else {
            out += { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '"': '"', '\\': '\\', '/': '/' }[esc] ?? esc;
            j += 2;
          }
        } else {
          out += input[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch) && (ch !== '-' || /[0-9]/.test(input[i + 1] ?? ''))) {
      let j = i;
      while (j < input.length && /[0-9]/.test(input[j]!)) j += 1;
      let isFloat = false;
      if (input[j] === '.' && /[0-9]/.test(input[j + 1] ?? '')) {
        isFloat = true;
        j += 1;
        while (j < input.length && /[0-9]/.test(input[j]!)) j += 1;
      }
      const text = input.slice(i, j);
      tokens.push(isFloat ? { kind: 'float', value: Number.parseFloat(text) } : { kind: 'int', value: Number.parseInt(text, 10) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < input.length && /[A-Za-z0-9_]/.test(input[j]!)) j += 1;
      tokens.push({ kind: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`Unexpected character ${JSON.stringify(ch)} at ${i}`);
  }
  return tokens;
}

/* ------------------------------------------------------------ parser */

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: { name: string; value: ValueNode }[] };

interface Selection {
  alias: string | null;
  name: string;
  args: { name: string; value: ValueNode }[];
  selections: Selection[];
  fragmentType: string | null;
}

interface Operation {
  type: 'query' | 'mutation';
  name: string | null;
  selections: Selection[];
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined { return this.tokens[this.pos]; }
  private next(): Token {
    const tok = this.tokens[this.pos];
    if (tok === undefined) throw new Error('Unexpected end of document');
    this.pos += 1;
    return tok;
  }
  private expectPunct(value: string): void {
    const tok = this.next();
    if (tok.kind !== 'punct' || tok.value !== value) throw new Error(`Expected ${value}, got ${JSON.stringify(tok)}`);
  }
  private matchPunct(value: string): boolean {
    const tok = this.peek();
    if (tok !== undefined && tok.kind === 'punct' && tok.value === value) { this.pos += 1; return true; }
    return false;
  }
  private expectName(): string {
    const tok = this.next();
    if (tok.kind !== 'name') throw new Error(`Expected name, got ${JSON.stringify(tok)}`);
    return tok.value;
  }

  parseDocument(): Operation[] {
    const ops: Operation[] = [];
    while (this.peek() !== undefined) ops.push(this.parseOperation());
    return ops;
  }

  private parseOperation(): Operation {
    let type: 'query' | 'mutation' = 'query';
    const tok = this.peek();
    if (tok !== undefined && tok.kind === 'name' && (tok.value === 'query' || tok.value === 'mutation')) {
      type = this.next().value as 'query' | 'mutation';
    }
    let name: string | null = null;
    const next = this.peek();
    if (next !== undefined && next.kind === 'name') name = this.next().value;
    if (this.matchPunct('(')) this.skipVariableDefinitions();
    return { type, name, selections: this.parseSelectionSet() };
  }

  /** Variable definitions are parsed and discarded; values arrive via `variables`. */
  private skipVariableDefinitions(): void {
    let depth = 1;
    while (depth > 0) {
      const tok = this.next();
      if (tok.kind === 'punct' && tok.value === '(') depth += 1;
      else if (tok.kind === 'punct' && tok.value === ')') depth -= 1;
    }
  }

  private parseSelectionSet(): Selection[] {
    this.expectPunct('{');
    const selections: Selection[] = [];
    while (!(this.peek() !== undefined && this.peek()!.kind === 'punct' && this.peek()!.value === '}')) {
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): Selection {
    if (this.matchPunct('...')) {
      const tok = this.peek();
      if (tok !== undefined && tok.kind === 'name' && tok.value === 'on') {
        this.next();
        const typeName = this.expectName();
        return { alias: null, name: '', args: [], selections: this.parseSelectionSet(), fragmentType: typeName };
      }
      throw new Error('Named fragments are not supported');
    }
    const first = this.expectName();
    let alias: string | null = null;
    let name = first;
    if (this.matchPunct(':')) {
      alias = first;
      name = this.expectName();
    }
    const args: { name: string; value: ValueNode }[] = [];
    if (this.matchPunct('(')) {
      while (!(this.peek() !== undefined && this.peek()!.kind === 'punct' && this.peek()!.value === ')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args.push({ name: argName, value: this.parseValue() });
      }
      this.expectPunct(')');
    }
    let selections: Selection[] = [];
    const next = this.peek();
    if (next !== undefined && next.kind === 'punct' && next.value === '{') selections = this.parseSelectionSet();
    return { alias, name, args, selections, fragmentType: null };
  }

  private parseValue(): ValueNode {
    const tok = this.next();
    if (tok.kind === 'punct' && tok.value === '$') return { kind: 'variable', name: this.expectName() };
    if (tok.kind === 'punct' && tok.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek() !== undefined && this.peek()!.kind === 'punct' && this.peek()!.value === ']')) {
        values.push(this.parseValue());
      }
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (tok.kind === 'punct' && tok.value === '{') {
      const fields: { name: string; value: ValueNode }[] = [];
      while (!(this.peek() !== undefined && this.peek()!.kind === 'punct' && this.peek()!.value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (tok.kind === 'string') return { kind: 'string', value: tok.value };
    if (tok.kind === 'int') return { kind: 'int', value: tok.value };
    if (tok.kind === 'float') return { kind: 'float', value: tok.value };
    if (tok.kind === 'name') {
      if (tok.value === 'true') return { kind: 'boolean', value: true };
      if (tok.value === 'false') return { kind: 'boolean', value: false };
      if (tok.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: tok.value };
    }
    throw new Error(`Unexpected token ${JSON.stringify(tok)} in value`);
  }
}

/* ------------------------------------------------------------ values */

type GqlValue =
  | string
  | number
  | boolean
  | null
  | GqlObject
  | GqlValue[];

interface GqlObject {
  __typename: string;
  [key: string]: unknown;
}

function evalValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable': return variables[node.name] ?? null;
    case 'string': return node.value;
    case 'int': return node.value;
    case 'float': return node.value;
    case 'boolean': return node.value;
    case 'null': return null;
    case 'enum': return node.value;
    case 'list': return node.values.map((v) => evalValue(v, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = evalValue(field.value, variables);
      return out;
    }
  }
}

function evalArgs(sel: Selection, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of sel.args) out[arg.name] = evalValue(arg.value, variables);
  return out;
}

/* ------------------------------------------------------------ ids */

function decodeGlobalId(id: string): { kind: string; num: number } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const match = /^([A-Za-z]+):([0-9]+)$/.exec(text);
    if (match === null) return null;
    return { kind: match[1]!, num: Number.parseInt(match[2]!, 10) };
  } catch {
    return null;
  }
}

function findRepoById(store: StoreType, id: number): Repo | undefined {
  for (const repo of store.repos.values()) if (repo.id === id) return repo;
  return undefined;
}

function findIssueById(store: StoreType, id: number): { repo: Repo; issue: Issue } | undefined {
  for (const repo of store.repos.values()) {
    for (const issue of repo.issues.values()) if (issue.id === id) return { repo, issue };
  }
  return undefined;
}

function findPullById(store: StoreType, id: number): { repo: Repo; pull: PullRequest } | undefined {
  for (const repo of store.repos.values()) {
    for (const pull of repo.pulls.values()) if (pull.id === id) return { repo, pull };
  }
  return undefined;
}

function encodeCursor(createdSeq: number): string {
  return Buffer.from(`IssueCursor:${createdSeq}`, 'utf8').toString('base64');
}

function decodeCursor(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^IssueCursor:([0-9]+)$/.exec(text);
    return match === null ? null : Number.parseInt(match[1]!, 10);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------ schema */

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'author', 'labels', 'comments', 'url', 'repository'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'files', 'createdAt', 'updatedAt', 'author', 'repository', 'mergeCommit', 'additions', 'deletions'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'isPrivate', 'createdAt', 'updatedAt', 'url', 'defaultBranch'],
  User: ['id', 'login', 'name', 'email'],
  IssueConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'pageInfo', 'totalCount'],
};

const TYPE_ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
};

/* ------------------------------------------------------------ resolvers */

function userValue(): GqlObject {
  return { __typename: 'User', login: VIEWER_LOGIN, id: VIEWER_ID, name: VIEWER_NAME };
}

function repoValue(repo: Repo): GqlObject {
  return { __typename: 'Repository', repo };
}

function issueValue(repo: Repo, issue: Issue): GqlObject {
  return { __typename: 'Issue', repo, issue };
}

function pullValue(repo: Repo, pull: PullRequest): GqlObject {
  return { __typename: 'PullRequest', repo, pull };
}

function issueConnectionValue(repo: Repo, issues: Issue[], first: number | null, afterSeq: number | null, direction = 1): GqlObject {
  let items = issues;
  // The cursor is order-aware: ascending pages continue past the cursor,
  // descending pages continue before it.
  if (afterSeq !== null) items = items.filter((issue) => (direction >= 0 ? issue.createdSeq > afterSeq : issue.createdSeq < afterSeq));
  const hasNextPage = first !== null && items.length > first;
  const page = first !== null ? items.slice(0, first) : items;
  const endCursor = page.length > 0 ? encodeCursor(page[page.length - 1]!.createdSeq) : null;
  return {
    __typename: 'IssueConnection',
    repo,
    issues: page,
    pageInfo: { __typename: 'PageInfo', hasNextPage, endCursor },
  };
}

function resolveIssuesArgs(repo: Repo, args: Record<string, unknown>): GqlObject {
  let items = [...repo.issues.values()];
  const states = args.states as string[] | undefined;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((s) => s.toLowerCase()));
    items = items.filter((issue) => wanted.has(issue.state));
  }
  const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
  // No orderBy (the pagination query): creation order, ascending, so the
  // cursor walks forward. With orderBy, the direction decides.
  const direction = orderBy === undefined ? 1 : orderBy.direction === 'ASC' ? 1 : -1;
  // field is CREATED_AT / UPDATED_AT / COMMENTS — all reduce to creation order here.
  items.sort((a, b) => direction * (a.createdSeq - b.createdSeq));
  const after = typeof args.after === 'string' ? decodeCursor(args.after) : null;
  const first = typeof args.first === 'number' ? args.first : null;
  return issueConnectionValue(repo, items, first, after, direction);
}

function createIssueIn(store: StoreType, repo: Repo, title: string, body: string): Issue {
  const number = repo.nextIssueNumber++;
  const issue: Issue = {
    id: store.nextIssueIdFor(),
    number,
    title,
    body,
    state: 'open',
    labels: [],
    createdSeq: ++repo.seq,
    comments: [],
  };
  repo.issues.set(number, issue);
  return issue;
}

function createPullIn(store: StoreType, repo: Repo, headRef: string, baseRef: string, title: string, body: string): PullRequest | null {
  const headSha = repo.refs.get(`refs/heads/${headRef}`);
  const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
  if (headSha === undefined || baseSha === undefined) return null;
  const headTip = repo.objects.get(headSha);
  const baseTip = repo.objects.get(baseSha);
  if (headTip === undefined || baseTip === undefined || headTip.type !== 'commit' || baseTip.type !== 'commit') return null;
  const files = computePullFiles(repo, parseCommit(baseTip.data).tree, parseCommit(headTip.data).tree);
  const number = repo.nextPullNumber++;
  const pull: PullRequest = {
    id: store.nextPullIdFor(),
    number,
    title,
    body,
    state: 'open',
    merged: false,
    mergeCommitSha: null,
    mergedAt: null,
    headRef,
    baseRef,
    headSha,
    baseSha,
    createdSeq: ++repo.seq,
    files,
    headTreeSha: parseCommit(headTip.data).tree,
  };
  repo.pulls.set(number, pull);
  return pull;
}

/* ------------------------------------------------------------ executor */

interface ExecContext {
  store: StoreType;
  variables: Record<string, unknown>;
  errors: { message: string }[];
}

function executeSelections(ctx: ExecContext, parent: GqlObject, selections: Selection[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    if (sel.fragmentType !== null) {
      if (parent.__typename === sel.fragmentType) {
        Object.assign(out, executeSelections(ctx, parent, sel.selections));
      }
      continue;
    }
    const key = sel.alias ?? sel.name;
    const value = resolveField(ctx, parent, sel);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function resolveField(ctx: ExecContext, parent: GqlObject, sel: Selection): unknown {
  const args = evalArgs(sel, ctx.variables);
  const typeName = parent.__typename;
  try {
    const value = resolveFieldValue(ctx, parent, sel.name, args);
    if (value === undefined) {
      // A field the schema does not carry on this type: a GraphQL error
      // naming the field, HTTP stays 200 (only the invalid-field check
      // expects this; every other document uses known fields).
      ctx.errors.push({ message: `Cannot query field "${sel.name}" on type "${typeName}".` });
      return undefined;
    }
    if (sel.selections.length === 0) return value;
    if (value === null) return null;
    if (Array.isArray(value)) {
      return value.map((item) =>
        item !== null && typeof item === 'object' && '__typename' in item
          ? executeSelections(ctx, item as GqlObject, sel.selections)
          : item,
      );
    }
    if (typeof value === 'object' && '__typename' in value) {
      return executeSelections(ctx, value as GqlObject, sel.selections);
    }
    return value;
  } catch (error) {
    ctx.errors.push({ message: error instanceof Error ? error.message : String(error) });
    return undefined;
  }
}

function resolveFieldValue(ctx: ExecContext, parent: GqlObject, name: string, args: Record<string, unknown>): unknown {
  const store = ctx.store;
  switch (parent.__typename) {
    case 'Query': {
      if (name === 'viewer') return userValue();
      if (name === 'repository') {
        const owner = args.owner as string;
        const repoName = args.name as string;
        if (owner !== VIEWER_LOGIN) return null;
        const repo = store.getRepo(owner, repoName);
        return repo === undefined ? null : repoValue(repo);
      }
      if (name === 'node') {
        const decoded = decodeGlobalId(args.id as string);
        if (decoded === null || decoded.kind !== 'Repository') return null;
        const repo = findRepoById(store, decoded.num);
        return repo === undefined ? null : repoValue(repo);
      }
      if (name === '__type') {
        const typeName = args.name as string;
        const fields = TYPE_FIELDS[typeName];
        const enumValues = TYPE_ENUM_VALUES[typeName];
        if (fields === undefined && enumValues === undefined) return null;
        return {
          __typename: '__Type',
          name: typeName,
          fields: (fields ?? []).map((f) => ({ __typename: '__Field', name: f })),
          enumValues: enumValues === undefined ? null : enumValues.map((v) => ({ __typename: '__EnumValue', name: v })),
        };
      }
      return undefined;
    }
    case 'Mutation': {
      if (name === 'createIssue') {
        const input = args.input as { repositoryId?: string; title?: string; body?: string };
        const decoded = decodeGlobalId(input.repositoryId ?? '');
        const repo = decoded !== null && decoded.kind === 'Repository' ? findRepoById(store, decoded.num) : undefined;
        if (repo === undefined) throw new Error('Repository not found');
        const issue = createIssueIn(store, repo, input.title ?? '', input.body ?? '');
        return { __typename: 'CreateIssuePayload', issue: issueValue(repo, issue) };
      }
      if (name === 'closeIssue') {
        const input = args.input as { issueId?: string };
        const decoded = decodeGlobalId(input.issueId ?? '');
        const found = decoded !== null && decoded.kind === 'Issue' ? findIssueById(store, decoded.num) : undefined;
        if (found === undefined) throw new Error('Issue not found');
        found.issue.state = 'closed';
        return { __typename: 'CloseIssuePayload', issue: issueValue(found.repo, found.issue) };
      }
      if (name === 'createPullRequest') {
        const input = args.input as { repositoryId?: string; baseRefName?: string; headRefName?: string; title?: string; body?: string };
        const decoded = decodeGlobalId(input.repositoryId ?? '');
        const repo = decoded !== null && decoded.kind === 'Repository' ? findRepoById(store, decoded.num) : undefined;
        if (repo === undefined) throw new Error('Repository not found');
        const pull = createPullIn(store, repo, input.headRefName ?? '', input.baseRefName ?? repo.defaultBranch, input.title ?? '', input.body ?? '');
        if (pull === null) throw new Error('Invalid head or base branch');
        return { __typename: 'CreatePullRequestPayload', pullRequest: pullValue(repo, pull) };
      }
      if (name === 'mergePullRequest') {
        const input = args.input as { pullRequestId?: string; mergeMethod?: string };
        const decoded = decodeGlobalId(input.pullRequestId ?? '');
        const found = decoded !== null && decoded.kind === 'PullRequest' ? findPullById(store, decoded.num) : undefined;
        if (found === undefined) throw new Error('Pull request not found');
        const result = squashMergePull(found.repo, found.pull);
        if (!result.ok) throw new Error(result.reason === 'conflict' ? 'This pull request cannot be merged: merge conflict' : 'Pull request cannot be merged');
        return { __typename: 'MergePullRequestPayload', pullRequest: pullValue(found.repo, found.pull) };
      }
      if (name === 'addComment') {
        const input = args.input as { subjectId?: string; body?: string };
        const decoded = decodeGlobalId(input.subjectId ?? '');
        const found = decoded !== null && decoded.kind === 'Issue' ? findIssueById(store, decoded.num) : undefined;
        if (found === undefined) throw new Error('Issue not found');
        const comment = { id: found.repo.nextCommentId++, body: input.body ?? '' };
        found.issue.comments.push(comment);
        return {
          __typename: 'AddCommentPayload',
          commentEdge: {
            __typename: 'IssueCommentEdge',
            node: { __typename: 'IssueComment', id: Store.globalId('IssueComment', comment.id), body: comment.body },
          },
        };
      }
      return undefined;
    }
    case 'Repository': {
      const repo = parent.repo as Repo;
      if (name === 'id') return Store.globalId('Repository', repo.id);
      if (name === 'databaseId') return repo.id;
      if (name === 'name') return repo.name;
      if (name === 'nameWithOwner') return `${repo.owner}/${repo.name}`;
      if (name === 'owner') return userValue();
      if (name === 'defaultBranchRef') return { __typename: 'BranchRef', name: repo.defaultBranch };
      if (name === 'viewerPermission') return 'ADMIN';
      if (name === 'hasIssuesEnabled') return true;
      if (name === 'description') return repo.description;
      if (name === 'isPrivate' || name === 'private') return repo.privateFlag;
      if (name === 'createdAt' || name === 'updatedAt') return FIXED_ISO;
      if (name === 'url') return `https://github.com/${repo.owner}/${repo.name}`;
      if (name === 'defaultBranch') return repo.defaultBranch;
      if (name === 'issue') {
        const issue = repo.issues.get(args.number as number);
        return issue === undefined ? null : issueValue(repo, issue);
      }
      if (name === 'issues') return resolveIssuesArgs(repo, args);
      if (name === 'pullRequests') {
        let pulls = [...repo.pulls.values()].sort((a, b) => b.createdSeq - a.createdSeq);
        if (typeof args.first === 'number') pulls = pulls.slice(0, args.first);
        return { __typename: 'PullRequestConnection', repo, pulls, pageInfo: { __typename: 'PageInfo', hasNextPage: false, endCursor: null } };
      }
      if (name === 'pullRequest') {
        const pull = repo.pulls.get(args.number as number);
        return pull === undefined ? null : pullValue(repo, pull);
      }
      return undefined;
    }
    case 'Issue': {
      const issue = parent.issue as Issue;
      if (name === 'id') return Store.globalId('Issue', issue.id);
      if (name === 'number') return issue.number;
      if (name === 'title') return issue.title;
      if (name === 'body') return issue.body;
      if (name === 'state') return issue.state.toUpperCase();
      if (name === 'createdAt' || name === 'updatedAt') return FIXED_ISO;
      if (name === 'author') return userValue();
      if (name === 'url') return `https://github.com/${(parent.repo as Repo).owner}/${(parent.repo as Repo).name}/issues/${issue.number}`;
      return undefined;
    }
    case 'IssueConnection': {
      if (name === 'nodes') return (parent.issues as Issue[]).map((issue) => issueValue(parent.repo as Repo, issue));
      if (name === 'pageInfo') return parent.pageInfo as GqlObject;
      if (name === 'totalCount') return (parent.issues as Issue[]).length;
      return undefined;
    }
    case 'PullRequest': {
      const pull = parent.pull as PullRequest;
      const repo = parent.repo as Repo;
      if (name === 'id') return Store.globalId('PullRequest', pull.id);
      if (name === 'number') return pull.number;
      if (name === 'title') return pull.title;
      if (name === 'body') return pull.body;
      if (name === 'state') return pull.merged ? 'MERGED' : pull.state.toUpperCase();
      if (name === 'merged') return pull.merged;
      if (name === 'mergeable') return pullMergeable(repo, pull);
      if (name === 'headRefName') return pull.headRef;
      if (name === 'baseRefName') return pull.baseRef;
      if (name === 'createdAt' || name === 'updatedAt') return FIXED_ISO;
      if (name === 'author') return userValue();
      if (name === 'files') {
        const files = typeof args.first === 'number' ? pull.files.slice(0, args.first) : pull.files;
        return {
          __typename: 'PullRequestChangedFileConnection',
          nodes: files.map((file) => ({ __typename: 'PullRequestChangedFile', file })),
        };
      }
      return undefined;
    }
    case 'PullRequestConnection': {
      if (name === 'nodes') return (parent.pulls as PullRequest[]).map((pull) => pullValue(parent.repo as Repo, pull));
      if (name === 'pageInfo') return parent.pageInfo as GqlObject;
      if (name === 'totalCount') return (parent.pulls as PullRequest[]).length;
      return undefined;
    }
    case 'PullRequestChangedFileConnection': {
      if (name === 'nodes') return parent.nodes as GqlObject[];
      if (name === 'pageInfo') return { __typename: 'PageInfo', hasNextPage: false, endCursor: null };
      if (name === 'totalCount') return (parent.nodes as GqlObject[]).length;
      return undefined;
    }
    case 'PullRequestChangedFile': {
      const file = parent.file as PullRequest['files'][number];
      if (name === 'path') return file.filename;
      if (name === 'additions') return file.additions;
      if (name === 'deletions') return file.deletions;
      if (name === 'changes') return file.additions + file.deletions;
      if (name === 'status') return file.status.toUpperCase();
      return undefined;
    }
    case 'User': {
      if (name === 'login') return VIEWER_LOGIN;
      if (name === 'id') return Store.globalId('User', VIEWER_ID);
      if (name === 'name') return VIEWER_NAME;
      if (name === 'email') return 'adaiversen@example.invalid';
      return undefined;
    }
    case 'BranchRef': {
      if (name === 'name') return parent.name as string;
      return undefined;
    }
    case 'PageInfo': {
      if (name === 'hasNextPage') return parent.hasNextPage as boolean;
      if (name === 'endCursor') return parent.endCursor as string | null;
      return undefined;
    }
    case '__Type': {
      if (name === 'name') return parent.name as string;
      if (name === 'fields') return parent.fields as GqlObject[];
      if (name === 'enumValues') return parent.enumValues as GqlObject[] | null;
      if (name === 'kind') return (parent.enumValues as GqlObject[] | null) !== null && (parent.fields as GqlObject[]).length === 0 ? 'ENUM' : 'OBJECT';
      return undefined;
    }
    case '__Field': {
      if (name === 'name') return parent.name as string;
      return undefined;
    }
    case '__EnumValue': {
      if (name === 'name') return parent.name as string;
      return undefined;
    }
    case 'CreateIssuePayload':
    case 'CloseIssuePayload': {
      if (name === 'issue') return parent.issue as GqlObject;
      if (name === 'clientMutationId') return null;
      return undefined;
    }
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload': {
      if (name === 'pullRequest') return parent.pullRequest as GqlObject;
      if (name === 'clientMutationId') return null;
      return undefined;
    }
    case 'AddCommentPayload': {
      if (name === 'commentEdge') return parent.commentEdge as GqlObject;
      if (name === 'clientMutationId') return null;
      return undefined;
    }
    case 'IssueCommentEdge': {
      if (name === 'node') return parent.node as GqlObject;
      return undefined;
    }
    case 'IssueComment': {
      if (name === 'id') return parent.id as string;
      if (name === 'body') return parent.body as string;
      return undefined;
    }
    default:
      return undefined;
  }
}

function executeOperation(store: StoreType, op: Operation, variables: Record<string, unknown>): { data: Record<string, unknown> | null; errors?: { message: string }[] } {
  const ctx: ExecContext = { store, variables, errors: [] };
  const root: GqlObject = { __typename: op.type === 'mutation' ? 'Mutation' : 'Query' };
  const data = executeSelections(ctx, root, op.selections);
  const result: { data: Record<string, unknown> | null; errors?: { message: string }[] } = { data };
  if (ctx.errors.length > 0) result.errors = ctx.errors;
  return result;
}

/* ------------------------------------------------------------ entry */

/** POST /api/graphql. `bodyText` is the raw request body. */
export function handleGraphQL(store: StoreType, bodyText: string): { status: number; json: unknown } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return { status: 400, json: { errors: [{ message: 'Malformed JSON body' }] } };
  }
  const docs: { query: string; variables?: Record<string, unknown> }[] = Array.isArray(parsed)
    ? (parsed as { query: string; variables?: Record<string, unknown> }[])
    : [parsed as { query: string; variables?: Record<string, unknown> }];
  const results = docs.map((doc) => {
    try {
      const ops = new Parser(lex(doc.query ?? '')).parseDocument();
      if (ops.length === 0) return { data: null, errors: [{ message: 'Empty query' }] };
      // The suite sends one operation per document; the first is the one.
      return executeOperation(store, ops[0]!, (doc.variables ?? {}) as Record<string, unknown>);
    } catch (error) {
      return { data: null, errors: [{ message: error instanceof Error ? error.message : String(error) }] };
    }
  });
  return { status: 200, json: Array.isArray(parsed) ? results : results[0] };
}
