# GitHub-compatible git forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/lalantang973-bit/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard)
[![reward](https://make.fun/badge/github-core-clone-01/lalantang973-bit/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01)

A standalone, GitHub-compatible git forge that runs as a single process with no
database, no git binary, no UI and no outside service. Built for the
[github-core-clone-01 bounty on make.fun](https://make.fun/bounty/github-core-clone-01).

## What it serves

One Node process serves all four surfaces agents already speak, from a single
in-memory store:

- **Git smart HTTP** (`/{owner}/{repo}.git`): upload-pack protocol v2
  (advertise, `ls-refs`, `fetch` with shallow/deepen) and receive-pack v0
  (advertise, push with `report-status` and `side-band-64k`). The object
  store is implemented from scratch: loose objects, refs, packfile reading
  (PACK v2, OFS_DELTA/REF_DELTA) and writing (plain objects, no deltas).
  Pushes are fast-forward only; a non-fast-forward update is refused
  per ref with `ng <ref> non-fast-forward`.
- **REST v3** (`/api/v3`): repositories, branches, commits, contents, git
  refs, labels, issues, comments and pull requests, including squash merge
  with three-way conflict detection. Every reply is `application/json`
  with a non-empty `X-GitHub-Request-Id`; a missing token is 401 and a
  repository under another owner is 404, never 403.
- **GraphQL** (`/api/graphql`): the documents `gh` and `github-mcp-server`
  send — `viewer`, `repository` (with `issue`, `issues`, `pullRequests`,
  `pullRequest`), `node(id:)`, `__type` introspection for `Issue`,
  `PullRequest`, `Repository` and `SearchType`, the `createIssue`,
  `closeIssue`, `createPullRequest`, `mergePullRequest` and `addComment`
  mutations, and batched operation arrays. Global ids are opaque and
  stable; an unknown field is HTTP 200 with an `errors` array.
- **MCP** (`/mcp`): JSON-RPC 2.0 Streamable HTTP, revision `2026-07-28`
  via `server/discover`, with six tools — `create_repo`, `get_repo`,
  `create_issue`, `list_issues`, `create_pull_request`,
  `merge_pull_request` — over the same store as REST, so ids are stable
  across reads.

## Run it

```sh
node main.ts
```

`main.ts` binds an ephemeral port on `127.0.0.1`, registers it by POSTing
`{"port": N}` to `$MAKEFUN_ENV_URL/register`, serves `GET /healthz`, and
long-polls `GET $MAKEFUN_ENV_URL/done`, exiting 0 when the trial reports
done. Without `$MAKEFUN_ENV_URL` it just listens and logs. The token owner
is read from `$MAKEFUN_SHOP_TOKEN`; the bearer token is required on the
REST, GraphQL and MCP surfaces.

Only the Node standard library is used — no install step, no native addon.

## Layout

- `main.ts` — lifecycle: bind, register, serve until done, exit 0.
- `app.ts` — HTTP server and routing for the four surfaces.
- `store.ts` — in-memory store (repos, issues, pull requests, labels,
  comments) plus the git object model: objects, refs, trees, commits,
  reachability, and the squash merge.
- `git.ts` — pkt-line codec, packfile read/write, protocol v2 upload-pack
  and v0 receive-pack.
- `rest.ts` — REST v3 handlers.
- `graphql.ts` — a small GraphQL parser and executor.
- `mcp.ts` — MCP JSON-RPC handlers.

## Local score

Practice trials against the kit's sealed suite (3 trials, `--driver process`):

- **978 / 1000** mean (agent 200, feature 600, perf ~178)
- **120 / 120** conformance checks on every trial
- roughly 3× faster than the reference forge on the four timed workloads
