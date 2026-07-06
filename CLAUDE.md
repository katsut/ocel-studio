# CLAUDE.md — ocel-studio

Local-first process-mining GUI: one Rust binary (axum JSON API + embedded
Vite/React frontend) over one loaded OCEL log. Concepts and design live in
[ARCHITECTURE.md](ARCHITECTURE.md); the connector interface in
[docs/connector-contract.md](docs/connector-contract.md).

## Build, run, verify

```sh
cd frontend && pnpm build     # tsc + vite → dist/ (rust-embed bakes it in)
cargo build --release         # AFTER pnpm build, or you ship stale assets
./target/release/ocel-studio  # http://localhost:6235
cargo clippy --all-targets -- -D warnings && cargo fmt --check
```

CI (Check job) runs the pnpm build inside cargo check — a frontend type error
fails CI even if you only touched Rust.

## Map

- `src/main.rs` — CLI args, data/config dir resolution, server start
- `src/server/mod.rs` — `Loaded` (log + mtime lazy reload), `AppState`,
  embedded assets, the router (`server::run`)
- `src/server/workspace.rs` — log listing/open/status + sample download
- `src/server/sources.rs` — sources CRUD/run, `watch_child` (contract v1/v2
  NDJSON), run history (`runs.json`), keychain env + secrets
- `src/server/analysis.rs` — summary/events/variants/dfg/ocdfg/model/cases/
  leadtimes + time-window (`Cow<Ocel>`) helpers
- `src/server/recipes.rs` — recipes CRUD + transform preview
- `frontend/src/App.tsx` — screen router, global type/range selectors,
  status poll, `caseLikeType` default-type pick
- `frontend/src/api.ts` — every API type + fetcher; URL-keyed cache dropped
  on mtime change
- `frontend/src/{Insights,Flow,Variants,Cases,Model}.tsx` — one screen each
  (overview cards / map / paths / cases / model tabs)
- `frontend/src/Workspace.tsx` — thin composer over
  `frontend/src/workspace/{FileList,PipelineDag,Sources,SourceRow,Recipes,
  StepEditor}.tsx`
- `frontend/src/i18n.tsx` — the whole en/ja dictionary (`Messages` type keeps
  both locales complete at compile time)
- `frontend/src/styles.css` — design tokens at the top (`--accent`, `--muted`,
  `--chip`, `--cat-1..8`); **only use variables that exist** — an unknown CSS
  variable silently renders black

## Invariants and traps

- **macOS: config_dir == data_dir.** Any non-log file in the config dir
  (`sources.json`, `runs.json`, `recipes/`) must be excluded in BOTH
  `logs_by_recency` (startup auto-open) and the `/api/logs` handler.
- Secrets: OS keychain only (service `ocel-studio`), resolved at spawn;
  never in config files, API responses, or logs. `/api/secrets` is
  write-only.
- Sources run one-at-a-time per source (409), cwd = workspace, stdout is
  contract NDJSON, stderr keeps an 8 KB tail.
- Analysis is delegated to `ocel-mine` (registry version) — no ad-hoc mining
  code here. Time-window filtering builds a `Cow<Ocel>` sublog per request.
- All UI text goes through `i18n.tsx` (both locales or the build fails);
  self-explanatory screens are the product bar (education-first UX).

## Conventions

- Issue → branch → PR → CI green → squash-merge; never commit to main.
- Screenshots/browser checks: claude-in-chrome MCP; studio must be restarted
  after rebuild (`pgrep -f ocel-studio | xargs kill`, run detached).
- Design docs (ADRs, user-story map, design system) are **not in this repo**
  — they live in the private ocel-workspace under `docs/studio/`.
