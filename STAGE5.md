# Stage 5 — grade-local trials + tuning

Date: Sat 2026-11-14 ~21:20–21:35 WIB. Base: Stage 4 HEAD `6c25a1a2`.

## 1. Official grade-local — the real grader, 3 instances

Command (from the kit's own CLI):
`node cli/makefun.mjs grade-local --kit . --bot <repo> --worktree --driver process --instances 3 --json`

Two blockers found and cleared on the way:

- **No Docker on this VM** (`docker: command not found`, no podman).
  The kit's grade-local accepts `--driver process` — "runs a node bot on
  this machine, unisolated" — the sanctioned fallback. The score notes
  record it ("process driver … the server runs each trial in its docker
  sandbox"); the conformance and perf numbers are the sealed suite's, so
  they transfer — only the sandbox differs.
- **The kit's shipped practice instances lack `input/env/`**, so the
  first run voided ("the instance has no input/env/ for the env to read
  its seed from"). The generator only ever creates that directory
  (empty — the scenario seed is a fixed constant in the env); the
  instance digest hashes files only, so an empty dir does not change it.
  Fix, on a copy of the kit only (`kit-gradelocal/`, the verified kit
  is untouched): `mkdir practice/trial-{0,1,2}/input/env`. Digest
  verified unchanged (trial-0 still
  `2dbde1d1…`).

### Run A — pre-edit entry (HEAD 6c25a1a2)

| trial | feature | agent | perf | score | perf_p50_us |
|---|---|---|---|---|---|
| 0 | 600 | 200 | 160 | **960** | 349,531 |
| 1 | 600 | 200 | 152 | **952** | 389,707 |
| 2 | 600 | 200 | 163 | **963** | 342,025 |
| **aggregate** | 600 | 200 | 158.33 | **958.33** | 360,421 |

90% interval **[948.75, 967.92]**. All 3 trials finished, working,
deterministic (nondeterministic: 0), state_sha256 identical across
trials (`a0e98d49…`) — the replay check the final runs would pass.
Spend $0, 0 model requests.

Per-workload (trial 0 / 1 / 2, p50 ms → points):
push 466/528/436 → 48/45/49 (T_ref 1640.82); clone 135/160/166 →
37/34/34 (T_ref 266.94); read 1416/1419/1231 → 37/37/40 (T_ref
2759.72); write 167/193/154 → 38/36/40 (T_ref 348.97).

### Run B — after the main.ts gate fix (below)

| trial | feature | agent | perf | score |
|---|---|---|---|---|
| 0 | 600 | 200 | 148 | **948** |
| 1 | 600 | 200 | 152 | **952** |
| 2 | 600 | 200 | 163 | **963** |
| **aggregate** | 600 | 200 | 154.33 | **954.33** |

90% interval **[941.24, 967.43]**. Same state_sha256 (`a0e98d49…`) —
the edit changed no behaviour. **Six trials total: 948–963, mean
~956.** The reference forge is ~900 (120/120 + ~100 perf); the lead
is +48 to +63 on every trial, so the 90% paired t-interval of the lead
sits comfortably above 0.

## 2. Tuning decision: none

No perf change landed. The thinnest margin is clone (30–37 pts), and
it is protocol-bound — 3 round trips (advertise + ls-refs + fetch)
plus the client's own pack handling — not code-bound; read/write at
36–40 pts are the same HTTP + JSON + Node overhead per request. Trial
variance (152–163 perf) is larger than any micro-optimisation would
buy, and the rules forbid speculative rewrites. The only edit this
stage is the gate fix below.

## 3. Transcript-gate fix — main.ts genuinely revised

Reading the rules (`competition.yaml:275`, `RULES.txt:101`) found a
real hole: **thinking_reproduces requires the entrypoint (main.ts) to
have at least one authored line** — and main.ts was a verbatim copy of
the kit starter (`diff` vs `starter/main.ts`: identical), i.e. zero
authored lines. The submission would have failed that check.

Fix (this stage, authored in the transcript): main.ts now carries a
self-check — after `listen(0)` it dials its own `/healthz` (3 tries,
5 s timeout) before registering, exiting 1 if the server never
answers. A bind that silently fails would otherwise waste the whole
900 s wall on an env dialing a dead port; a healthy server answers on
loopback in milliseconds. Header comment rewritten to describe the
actual entry. The 409 case was deliberately left alone (the starter's
wait-it-out behaviour is correct: another entry serving means this
process exiting early could only hurt the trial).

Verified by Run B above: all 3 trials finished, same state hash,
self-check never misfired.

## 4. Transcript-gate shape for the submit step

- thinking_turns: **5 assistant turns** (Stages 1–5), each carrying
  text — ≥5 ✓.
- thinking_revised: rest.ts written Stage 2, revised Stages 3–4;
  main.ts copied Stage 2, revised Stage 5 — files the entrypoint runs
  take final content from ≥2 assistant messages ✓.
- thinking_reproduces: ≥30% of counted lines are authored or pasted
  in the transcript (every source file was written/edited here); main.ts
  now has authored lines ✓ (was the one hole; fixed above).
- thinking_priced: the submit bundle must be built with
  `--muse-usage` (Muse session usage rows) — a submit-time step, not
  verifiable from this chat.
- thinking_fresh: skipped for the GitHub-repo route (no anchor
  needed) ✓.
- thinking_wellformed / in_window: the bundle/export handles
  timestamps; nothing to fix in code.

## 5. Node version note

The first voided run noted "the server's harness runs v22.23.4, this
one v24.22.1". The harness adds `--experimental-strip-types` when the
runtime lacks native TS support (`process.features.typescript ? [] :
["--experimental-strip-types"]`), so the entry loads on the server's
Node 22. The code uses only stable APIs (node:http, node:crypto,
Buffer, URL, fetch) — nothing Node-24-only.

## 6. Next

- **Stage 6 — final review + submit** before Fri 2026-11-21 13:30 WIB:
  export transcript → bundle with `--muse-usage` → kit check → submit
  from the main chat. Entry is frozen: no code changes after this
  stage without re-running grade-local.
