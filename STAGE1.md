# Stage 1 — kit, scoring model, language decision, module plan

Date: Sat 2026-11-14 ~13:45 WIB. Competition: `github-core-clone-01`,
"Build a GitHub-compatible git forge", $500 pot, top 20 paid (1st $100),
deadline Fri 2026-11-21 13:30 WIB (06:30Z). Harness agent/v1.
Repo: https://github.com/eastVUNK/github-core-clone-01 (public, created
2026-11-14 ~13:44 WIB, after the 13:30 WIB open).

## 1. Kit verification — PASS

- Manifest: `GET /api/competitions/github-core-clone-01/kit` with the
  @x13west API key → `agent-fun/kit/v1`, `bundle_sha256`
  `e20a304d0f86d6c8e36abba6fd51a5ffdb98ec3ead8ddba20a3ed36aa09ad754`,
  identical to the detail JSON's `bundleSha256`.
- Tarball: `https://make.fun/c/github-core-clone-01/kit`, 6,652,740 bytes,
  saved at `~/workspace/makefun/github-core-clone-01/kit/kit.tar.gz`.
  (Its own sha256 differs from `bundle_sha256` by design: that hash covers
  the uncompressed bundle, not the gzip — same as the btc-race kit.)
- Per-file verification: **63/63 files sha256 + size OK** against `kit.json`,
  unpacked to `kit/unpacked/github-core-clone-01-kit/`.
- Kit layout: `program/env/src/` (the sealed suite, full TypeScript source),
  `program/scorer/` (score.ts/columns.ts/main.ts + built score.mjs),
  `program/generator/draw.mjs`, `sdk/conformance/` (same suite + local
  runner), `starter/` (main.ts lifecycle + app.ts stub + MIT LICENSE),
  `practice/trial-{0,1,2}/` (scenario.json each: seed only, data is
  generated from it), `cli/makefun.mjs`, `competition.yaml`, `RULES.txt`.

## 2. What the suite actually does (from env/src, read in full)

Lifecycle (`program/env/src/main.ts`, `wire.ts`):
- Env listens on 8080 (`MAKEFUN_ENV_URL`). Entry binds an ephemeral port
  (port 0, never 8080), POSTs `{"port": N}` to `$MAKEFUN_ENV_URL/register`
  (first register wins; 409 otherwise), then polls GET `/done` until
  `{"done": true}` and exits 0.
- Boot budget 20 s. Boot probe: GET `/healthz` must answer 200 **twice**
  within 10 s. No register / failed probe = boot failure, all checks 0.
- Phases: conformance (budget 240 s) → benchmark (budget 240 s) → export.
  Wall budget 900 s, internal deadline = wall − 90 s. Each check runs
  alone with its own timeout (default 15 s, min 5 s, max 15 s); a timeout
  records 0 "deadline" and the next check still runs.
- Auth: every API call presents `Authorization: Bearer $MAKEFUN_SHOP_TOKEN`
  (same token in the entry's env). No token = 401. A repo belongs to the
  login the token names; same repo name under another owner = 404, never 403.
- Determinism: the scenario is fully seeded (`SCENARIO_SEED`
  0x6a09e667f3bcc909, epoch 2025-01-01): 12 users, 30 viewer repos, 6 org
  repos, 3 stranger repos, 60 file paths, 24 blobs, 60 commits, 60 issues,
  30 pulls. state.json holds only pass/fail bits and counts — no times,
  ports or dates — so live and replay exports must be byte-identical.
- Trial wall: a program still running at 900 s is stopped and scores 0.

## 3. Scoring model (manifest.ts + scorer/score.ts — the settled contract)

Score = feature + agent + perf, 0–1000. 120 conformance checks:

| group | checks | notes |
|---|---|---|
| git (smart HTTP) | 30 | clone/fetch/push, pack protocol |
| repos (REST) | 15 | repos, branches, commits, contents |
| issues (REST) | 15 | issues, comments, labels |
| pulls (REST) | 20 | PRs, files, merge |
| graphql | 20 | gh / github-mcp-server documents |
| mcp | 15 | also the agent column alone |
| protocol | 5 | status/JSON/auth/pagination/method |
| **total** | **120** | |

- feature = round(600 × passed / 120). agent = round(200 × passedMCP / 15).
  MCP counts twice (in feature's 120 and alone as agent) by design.
- perf = Σ over 4 workloads of round(clamp(25 − 12.5·log2(t / T_ref), 0, 50)).
  At T_ref = 25 pts; half T_ref = 38; double = 13; ≤ quarter = 50.
  Each workload: median of 3 rounds, after 5 untimed warm-ups, budget 60 s.
- Workloads: push = 200 sequential 1 KiB pushes (one receive-pack + new
  commit each); clone = 50 concurrent shallow (depth 1) clones of a
  200-commit repo; read = 2,000 sequential GET issue on one keep-alive
  connection; write = 200 sequential POST issue. Payloads are built before
  the clock starts; a workload over budget scores 0 and stops early.
- T_ref (calibration.json, median of 3 production runs of the house
  reference forge on dsh-makefun): push 1640.82 ms, clone 266.941 ms,
  read 2759.715 ms, write 348.965 ms. Per-push ≈ 8.2 ms, per-read ≈ 1.38 ms,
  per-write ≈ 1.7 ms, per-clone ≈ 5.3 ms (concurrent).
- Reference forge: **120/120 conformance in all 3 calibration runs**
  (state.json byte-identical), working 1 → feature 600 + agent 200 = 800,
  perf ≈ 100 at its own T_refs → **≈ 900 total**. Its perf_p50_us across
  runs: 712,790–900,674 (spread 26%).
- **The prize bar is the reference, not the field.** A prize needs a score
  strictly above the reference AND the 90% paired t-interval of the
  per-instance lead above 0 (a statistical tie does not beat it). The house
  entry is auto-entered 4 h before the deadline, always reaches the final,
  takes none of the 60 contender seats, holds its place but takes no prize.
  So the target is: 120/120 conformance AND perf > 100, i.e. faster than
  the reference on the timed workloads. Conformance alone (≈800) cannot win.
- Final is staged: every final entry runs 1 qualifying trial on scored
  instance 1; top 60 (plus ties with 60th) run all 3 instances, each trial
  replayed; contenders rank on mean score over 3; non-contenders rank below
  by qualifying score. A replay whose state export differs from live is
  listed and unranked. Ties: lower perf_p50_us (1000 × geometric mean of
  the four p50s, in µs), then earlier receipt. Build cost never breaks a tie.
- Practice: 3 instances from drand quicknet round 33447412 (2026-10-28);
  each submission runs 1 live trial on practice instance 0; score is
  provisional. Scored instances are drawn from the first drand round at or
  after the final phase starts (2026-11-21 06:40Z) — unknowable in advance.
- Reproduce: `node cli/makefun.mjs grade-local --kit . --bot <repository> --driver docker`.

## 4. Wire contract — the exact replies the suite requires

REST (`/api/v3`, every reply `application/json`, never HTML, non-empty
`X-GitHub-Request-Id`; errors are JSON with a string `message`):
- GET `/api/v3/` → 200 + `X-OAuth-Scopes` header. GET `/api/v3/meta` → 200
  with non-empty `installed_version`. GET `/api/v3/user/repos` → 200 list,
  multi-page links next via `Link: rel="next"`.
- POST `/api/v3/user/repos` → 201 repo object. GET repo → 200 / 404 JSON.
  PATCH repo → 200 with description updated. DELETE repo → 204, later GET 404.
- PUT contents → 201 create / 200 update / 409 stale sha. DELETE contents →
  200 `{commit:{sha}}`, later GET 404.
- POST labels → 201 `{name}`; an issue may only carry a label created here.
  POST issues → 201 open issue / 422 unknown label.
- POST pulls → 201 open, with head/base. GET pull → 200 / 404 unknown.
  PUT merge → 200 `{sha, merged:true, message}`, pull closed+merged, squash
  commit on default branch; 404 unknown PR, 405 conflicted.
- Unknown route → 404 JSON, never HTML. Malformed JSON body → 400.

Git smart HTTP (`/{owner}/{repo}.git`):
- Repo is created via REST first; a push cannot invent one. Missing repo =
  404 on both services' GET `/info/refs`, server stays up.
- upload-pack MUST speak protocol v2 (suite sends `Git-Protocol:
  version=2`): v2 capability advertisement + both ls-refs checks require
  it; a v0 answer loses those 3, rest fall back to v0.
- receive-pack is v0 only, must advertise `report-status`, `side-band-64k`,
  `delete-refs`. v0 advertisements open with `# service=git-upload-pack` /
  `# service=git-receive-pack`; v2 opens with `version 2`.
- Every update must fast-forward: non-FF push is refused per ref with
  `ng <ref> non-fast-forward`, ref does not move. Mixed push (1 FF + 1
  refused) applies the FF ref and answers one report line each (`ok` /
  `ng non-fast-forward`). Suite never force-pushes.
- Suite's git client (`git-client.ts`): pack READ supports v2/v3 packs,
  zlib, OFS_DELTA + REF_DELTA; pack WRITE is plain objects only (no deltas)
  for pushes. So our receive-pack must parse plain-object packs (delta
  resolution on receive is defence-in-depth, not the common path), and our
  upload-pack may send plain objects — simplest correct choice, and fastest
  to generate (no delta search).
- The GraphQL fixture pushes branches over our receive-pack using the same
  client (repo create via REST, ls-refs, fetch, push with report-status).

GraphQL (`POST /api/graphql`, bearer token; unauthenticated = exactly 401):
- Introspection must describe the documents gh / github-mcp-server send:
  `__type("Issue")` lists id, number, title, state, body;
  `__type("PullRequest")` lists id, number, headRefName, baseRefName,
  mergeable, state, merged, files; `__type("Repository")` lists id,
  databaseId, name, nameWithOwner, owner, defaultBranchRef,
  viewerPermission, hasIssuesEnabled, issue, issues, pullRequests,
  pullRequest; `SearchType` enumValues include ISSUE.
- `repository.issues` with `orderBy: {field: CREATED_AT, direction: DESC}`
  returns numbers DESC, ties by number DESC; `states: [OPEN]` omits closed.
- `createPullRequest` takes a repo id + a head branch pushed over git, opens
  a PR REST reads back with same head/base. Two operation documents in one
  body → two results in order. Unknown field → HTTP 200 with `errors`
  naming it. Unknown repo → `data.repository = null`, no errors.

MCP (`POST /mcp`, JSON-RPC 2.0 Streamable HTTP, `application/json` or SSE,
  each request answered inside 3 s):
- Revision 2026-07-28 (every request declares it; `server/discover` answers
  a result whose `supportedVersions` is a non-empty list of YYYY-MM-DD
  revisions), or handshake revision ≤ 2025-11-25 via `initialize` +
  `notifications/initialized`, optional `Mcp-Session-Id`.
- `tools/list` offers ≥ 6 tools incl. `create_repo`, `get_repo`,
  `create_issue`, `list_issues`, `create_pull_request`, `merge_pull_request`
  (a `github__` prefix is allowed, matched as suffix, case-insensitively);
  every tool has non-empty description + `inputSchema` of type object; two
  `tools/list` calls answer the same list byte for byte.
- Two concurrent `tools/call` keep their own JSON-RPC ids and answer for
  their own arguments. Args as github-mcp-server documents them
  (`create_repo {name}`, `get_repo {owner, repo}`, `create_issue {owner,
  repo, title, body?}`, `list_issues {owner, repo, state?}`,
  `create_pull_request {owner, repo, title, head, base}`,
  `merge_pull_request {owner, repo, pull_number}`); suite maps each argument
  onto the schema's nearest property name and fills `full_name` = owner/repo.
- Unknown tool → JSON-RPC −32602 or −32601, never HTTP 500. Missing required
  arg → `isError:true` or −32602. Non-JSON body → HTTP 400 with −32700
  (200 with −32700 from a pre-2026-07-28 server). No Authorization → 401.
- Tools act on the same store as REST: an MCP-created repo/issue reads back
  over `/api/v3` as the same objects, ids unchanged across reads.

## 5. Language decision — Node 22 + TypeScript (single process, stdlib only)

**Node 22, TypeScript, `main.ts` entrypoint** (the kit starter's lifecycle
kept verbatim). Not Python 3.13. Reasons:

1. **The kit is Node.** The suite, scorer, generator, local runner
   (`grade-local`) and starter are all Node 22; the prerequisites say
   "Needs Node 22". Developing in the same runtime as the grader removes a
   whole class of semantic surprises (JSON, HTTP, zlib behaviour).
2. **The timed workloads are Node-shaped.** Clone = 50 *concurrent*
   shallow clones: Node's event loop handles this with one thread and no
   GIL. Read = 2,000 sequential keep-alive GETs: Node's `node:http` server
   answers in ~1 ms with negligible per-request overhead; Python's stdlib
   `http.server` is threaded and slow, and asyncio would need a hand-built
   server anyway. Push/write are latency-bound per round-trip — V8 + native
   zlib win on every op.
3. **Packfiles are Buffer work.** `node:zlib` (deflate/inflate sync),
   `node:crypto` (SHA-1), and `Buffer` varint/binary parsing are exactly the
   primitives the pack protocol needs, all native and fast. Python has the
   same stdlib pieces, but its per-byte loops and GIL make pack generation
   measurably slower at 50-way concurrency.
4. **T_refs are the reference forge's Node numbers.** The reference (house)
   forge is a Node entry; beating its medians (push 8.2 ms/op, read
   1.38 ms/op) is a fight we want on equal runtime footing, with V8's JSON
   speed on our side.
5. **Type-stripping is the platform's own path.** The platform runs
   `node /bot/main.ts` on Node ≥ 22.18, which strips types natively — the
   starter is written for exactly this. No build step, no dependencies.

Risks accepted: type-stripping forbids enums/namespaces/parameter
properties in `.ts` (write plain TS); a single 8 MiB file cap (plan is
well under: ~150–250 KB total); no `git` binary and no packages at run
time (stdlib only: `node:http`, `node:zlib`, `node:crypto`).

## 6. Module plan (one process, in-memory store, no persistence needed)

The trial is one run: state lives in memory, keyed deterministically; no
disk store is required (the suite never restarts the entry mid-trial).
Determinism rule: no wall-clock time, no randomness, no port in any state
the suite exports — issue/PR numbers, oids and ordering derive only from
seeded inputs and insertion order.

```
main.ts        lifecycle only (starter file, kept verbatim): bind port 0,
               POST /register, poll /done, exit 0. No business logic.
app.ts         HTTP router + JSON discipline: every REST reply JSON with
               X-GitHub-Request-Id; 404 JSON never HTML; 400 malformed JSON;
               auth gate (Bearer MAKEFUN_SHOP_TOKEN; 401 without it).
store.ts       the store: users, repos, refs, objects, issues, labels,
               comments, PRs. Counters for issue/PR numbers per repo.
               Single source of truth for REST, GraphQL and MCP (same ids).
git-objects.ts object model: blob/tree/commit/tag parse+build, SHA-1
               (hashObject), tree/commit builders, reachability walk
               (collectReachable), canonical object bytes.
pack.ts        packfile read/write: pkt-line encode/decode, v2/v3 pack
               parse, zlib inflate, OFS/REF delta resolution, plain-object
               pack writer (no delta search — fast), checksum verify.
               Side-band-64k framing for upload-pack.
smart-http.ts  git smart HTTP: GET info/refs (v0 preamble + refs, v2
               advertisement `version 2` + ls-refs), POST git-upload-pack
               (v2: ls-refs + fetch; v0 fallback with side-band-64k),
               POST git-receive-pack v0 (advertise report-status,
               side-band-64k, delete-refs; unpack, FF check per ref,
               mixed ok/ng report).
rest.ts        REST v3 routes: / (scopes), /meta, user/repos (list+create,
               Link next), repos CRUD, branches/commits, contents (PUT
               201/200/409, DELETE 200), labels, issues (+comments),
               pulls (+merge → squash commit on default branch).
               Contents writes go through the git object store so a
               REST-created file is clonable over git and vice versa.
graphql.ts     GraphQL v4: minimal executor for the suite's documents —
               introspection (__type/__schema incl. SearchType ISSUE),
               repository/issues/pullRequests queries with orderBy/states,
               createPullRequest mutation, two-documents-in-one-body,
               unknown-field → 200 + errors, unknown repo → null, no errors.
mcp.ts         MCP Streamable HTTP: initialize / notifications/initialized /
               server/discover (supportedVersions), tools/list (byte-stable,
               ≥6 tools), tools/call (arg mapping incl. full_name, own
               JSON-RPC ids under concurrency), error codes (−32601/−32602/
               −32700), 401 without Authorization, 3 s budget.
```

Build order (several stages over the week):
- **Stage 2 — v1 core:** store + git objects + pack + smart HTTP
  (clone/fetch/push incl. v2), REST repos + contents, local grade-local
  trial against the kit's practice instance 0.
- **Stage 3 — REST complete:** issues/labels/comments, pulls + merge.
- **Stage 4 — GraphQL + MCP** on the same store.
- **Stage 5 — grade-local trials + tuning:** conformance first (120/120),
  then perf (push/clone/read/write vs T_ref; cache hot paths, zero-copy
  pack writes, keep-alive friendly server).
- **Stage 6 — final review + submit** (before Fri 2026-11-21 13:30 WIB;
  max 5 submissions/day, 10 total; last submission before deadline is final).

## 7. Repo / entry requirements — verified

- Public GitHub repo created after the open: `eastVUNK/github-core-clone-01`,
  created 2026-11-14 ~13:44 WIB (open 13:30 WIB), default branch `main`.
- OSI licence: MIT, `LICENSE` opens with `SPDX-License-Identifier: MIT`.
- Ownership claim: `.makefun/owner.json` = `{"wallet":
  "BghxTGURoYyWDjrUAnoBu5HWwRmnnoueR5PuDUfRb9gE"}` (the @x13west Solana
  wallet linked to the make.fun account). GitHub owner is the account's own
  (eastVUNK) in any case.
- Entrypoint: `main.ts` at repo root (to be added in Stage 2; the kit
  starter's lifecycle file). Size caps: ≤ 16 MiB total, ≤ 8 MiB per file.
- Transcript gate (applies at submission; this session is the builder):
  `thinking_reproduces` needs ≥ 30% of counted lines accounted for by
  transcripts and ≥ 1 authored line in main.ts; `thinking_revised` needs
  some file (entrypoint or code it runs) taking final content from ≥ 2
  assistant messages that write/edit it — so main.ts/app.ts must be written
  then revised in separate turns; `thinking_turns` needs ≥ 5 assistant turns
  with text/thinking; `thinking_priced` needs usage priced to a known model
  — Muse sessions must be bundled with `--muse-usage`; `thinking_fresh`
  (anchor line) applies to source-bundle entries only — this is a GitHub
  repo entry, so it skips as a note. Bundle `min_authored_coverage` is 0.8.
  Submissions: max 5/day, 10 total; last before deadline is final.
- Payout: escrow funded at open (`automation.escrow: at_open`); entries are
  signed by the linked Solana wallet; winners claim from escrow in USDC on
  Solana. No entry fee.
- Competition state at Stage 1: 5 submissions in the detail file (7 reported
  by the watch at 13:36 — detail file lists 5; the count moves fast),
  acceptingSubmissions = true.

## 8. Open items for Stage 2

- A check-by-check inventory of all 120 checks is being compiled from
  `checks-*.ts` + `git-client.ts` + `wire.ts` into `CHECKS-INVENTORY.md`
  (exact requests, assertions, edge strings) — the implementation spec.
- Open design questions to settle against the inventory: exact REST object
  shapes (repo/issue/PR JSON fields the suite asserts), contents-commit
  semantics (author/committer, message), GraphQL node ids (`id` format),
  MCP tool result shapes (`content` blocks), pagination sizes, and the
  upload-pack v2 `ls-refs`/`fetch` command set the suite actually sends.
