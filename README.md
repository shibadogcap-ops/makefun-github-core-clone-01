# Forge — a GitHub-compatible git forge in a single Node process

[![make.fun bounty](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/shibadogcap-ops/makefun-github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/shibadogcap-ops/makefun-github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01)

Forge is a standalone git forge: one Node process serving git smart HTTP, the GitHub REST v3 subset, GraphQL v4, and an MCP endpoint, all backed by a single in-memory store. There are no runtime dependencies and no `git` binary — the git object model, packfiles (including delta chains), and the wire protocol are implemented in pure TypeScript using only the standard library.

Built for the [github-core-clone-01 bounty on make.fun](https://make.fun/bounty/github-core-clone-01).

## Run it

```
node --experimental-strip-types main.ts
```

On startup the process binds an ephemeral port, registers itself with the lifecycle endpoint at `$MAKEFUN_ENV_URL`, and serves HTTP until it is told it is done. The API token for authentication comes from `$MAKEFUN_SHOP_TOKEN`.

## Surface

| Route | Purpose |
| --- | --- |
| `GET /healthz` | Health check |
| `POST /api/v3/...` | GitHub REST v3 subset: repositories, contents, issues, pulls, labels |
| `POST /api/graphql` | GraphQL v4 endpoint |
| `POST /mcp` | MCP endpoint |
| `/{owner}/{repo}.git/...` | Git smart HTTP: info/refs advertisements, fetch (protocol v0 and v2), receive-pack |

## Architecture

- `main.ts` — entrypoint: binds the port, registers with `$MAKEFUN_ENV_URL`, serves until shutdown is requested.
- `app.ts` — HTTP core: request routing, authentication, and the top-level server wiring.
- `store.ts` — in-memory store holding repositories, refs, issues, pulls, and labels.
- `repos.ts` — repository and ref manipulation on top of the store.
- `gitobj.ts` — pure-TS git objects (blob, tree, commit, tag) and packfile reading/writing with delta support.
- `contents.ts` — file and directory contents API.
- `issues.ts` — issues and comments.
- `pulls.ts` — pull requests, diffs, and merge handling.
- `gitproto.ts` — git smart HTTP protocol: advertisements, ls-refs, fetch v2/v0, receive-pack.
- `graphql.ts` — GraphQL v4 schema and resolvers backed by the same store.
- `mcp.ts` — MCP (Model Context Protocol) endpoint exposing repository operations as tools.

## Design notes

- **In-memory store.** Everything lives in one process and one store. This keeps the forge fast and deterministic — no database, no persistence layer, no filesystem layout to manage.
- **Deterministic timestamps.** When `$MAKEFUN_TRIAL_NOW` is set, all generated timestamps derive from it, so runs are reproducible.
- **Pure-TypeScript packs.** `gitobj.ts` implements object serialization, packfile parsing and generation, and REF/OFS delta resolution without invoking `git`.
- **Protocol v2.** Fetch supports protocol version 2 including `shallow` and `deepen`/`deepen-since`/`deepen-not` handling; protocol v0 is served for older clients.

## License

MIT — see [LICENSE](LICENSE).
