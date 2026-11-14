# github-core-clone-01 — a standalone GitHub-compatible git forge

One Node 22 process, no dependencies, no git binary, no outside service.
It serves git smart HTTP (upload-pack v2, receive-pack v0), the REST v3 API,
GraphQL v4 and MCP from its own in-memory store.

Entry for the [make.fun bounty](https://make.fun/bounty/github-core-clone-01)
"Build a GitHub-compatible git forge" ($500, deadline Fri 2026-11-21 13:30 WIB).

## Run

```sh
node main.ts
```

`main.ts` is the entrypoint: it binds an ephemeral port, registers it with
the suite at `$MAKEFUN_ENV_URL`, serves until the suite says done, exits 0.
See `STAGE1.md` for the kit findings, scoring model and module plan.
