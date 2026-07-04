# ADR 0004: Platform phase — workspace of logs, data sources, connector contract

- **Date:** 2026-07-05
- **Status:** Accepted
- **Builds on:** [ADR 0001](0001-local-first-architecture.md) (connectors orchestrated,
  never linked; workspace = directory; credentials in the OS keychain),
  [ADR 0003](0003-screen-per-question-ia.md) (one screen per question)

## Context

The discovery loop is complete: open one OCEL file, answer questions, land on real
cases. What is missing is the platform half of [workspace ADR 0004](https://github.com/katsut/ocel-workspace):
where does the file come from, how does it stay fresh, and how do several logs
coexist? Today the studio holds exactly one log (CLI argument, or the most recent
file in its data directory), and pulls happen outside the studio entirely.

The sample-log onboarding (#25) already introduced the data directory and the
pattern for server-side actions triggered by explicit clicks. The platform phase
grows that seed instead of inventing a second mechanism.

## Decisions

### 1. The workspace IS the data directory

One flat directory (`dirs::data_dir()/ocel-studio`), no nesting, no registry of
paths. Every OCEL file in it (`.json/.jsonocel`, `.sqlite/.db`, `.xml/.xmlocel`;
dotfiles excluded) is a log the studio can open; dropping a file in makes it appear,
deleting it makes it disappear. Files remain the source of truth — any tool that
writes OCEL 2.0 into the directory is a data source, whether the studio started it
or not (cron, CI, a manual `ocel-backlog pull`). The active log is server state;
switching is an explicit UI action. A log opened via CLI argument may live outside
the workspace — that stays supported and is simply shown as "outside the workspace".

Rejected: a workspace file registering arbitrary paths (breaks the "files are the
truth" property and invites dangling references), per-log subdirectories (nothing
needs them yet).

### 2. Sources are declarative configs; the reference kind is a plain command

A data source is a name plus a way to produce/refresh one OCEL file in the
workspace. Registered sources live in a single JSON file in the studio config
directory (never in the workspace — the workspace stays pure OCEL). The reference
kind is **`command`**: an arbitrary program the studio runs as a child process,
expected to (re)write the source's output file. This is testable today without any
credentials (e.g. `ocel convert sample.sqlite sample.json` is a valid connector),
and it keeps the contract honest: if our own UI can only integrate via the public
contract, so can anyone's tool.

Source-specific UX (e.g. a Backlog form that asks for base URL and project keys)
is a **preset** that expands to the same underlying command + environment — never a
separate code path.

Security stance (local-first honesty): source configs are local files authored by
the user, like a Makefile. The UI always shows the exact command line it will run,
runs it only on explicit click (or an explicitly enabled schedule, later), and
never imports configs from anywhere remote.

### 3. Connector contract v1 is frozen as documented; v2 is NDJSON progress on stdout

v1 (what `ocel-backlog pull` implements today) is frozen in
[connector-contract.md](../connector-contract.md): credentials via environment
variables, target/output via arguments, incremental refresh when `--out` exists,
exit 0 on success, human-readable diagnostics on stderr.

v2 adds machine-readable progress: one JSON object per stdout line (NDJSON) with a
small event vocabulary (`progress`, `log`, `done`). v2 is a **progressive
enhancement**: the studio parses stdout lines that look like v2 events and falls
back to a spinner plus stderr tail otherwise. A v1 connector is never broken by a
v2 studio, and vice versa.

### 4. Run model: one run per source, spawned by the studio, atomic where we control it

The studio spawns at most one child process per source at a time (a second run
request while one is in flight is rejected). Run state (running / succeeded /
failed, started-at, tail of stderr, parsed v2 progress) is held in memory and
exposed over the API; the studio is not a job queue and does not persist run
history in this phase. Connectors own their output files — the contract recommends
write-to-temp-then-rename so the studio's mtime-based reload only ever sees
complete files (our connectors do this; foreign commands are trusted to behave).

### 5. Credentials: OS keychain only, injected as environment variables

Per ADR 0001. A source config references secrets by name
(`env: { "BACKLOG_API_KEY": { "keyring": "backlog-demo" } }`); the studio resolves
them from the OS keychain (`keyring` crate, service `ocel-studio`) at spawn time
and passes them to the child's environment. Secrets never appear in config files,
API responses, or logs. Storing a secret happens through the UI (write-only field).

## Screen: ワークスペース / Workspace

One new sidebar screen answering one question (ADR 0003): **"What data am I looking
at, what else is there, and how does it stay fresh?"** It lists the workspace logs
(name, size, updated, active marker → 開く), the registered sources (command,
output, last run state → 実行), and states the directory path so the file-drop
workflow is discoverable. The header file chip navigates here.

## Build plan

| Phase | Scope | Verification |
|---|---|---|
| **P1** | Log list + switch: `GET /api/logs`, `POST /api/logs/open`, workspace screen, header chip navigates | Two logs in the workspace, switch in the browser, all screens recompute |
| **P2** | Sources + manual run (contract v1): source CRUD (command kind), `POST /api/sources/{name}/run`, run state polling, stderr tail on failure | A real command connector (`ocel convert`) producing a second log end-to-end |
| **P3** | Contract v2 progress parsing + progress UI; keyring-backed env; Backlog preset | v2 events from a stub connector; Backlog validated when E4 credentials arrive |
| Later | Scheduler (cron-like, explicit opt-in), run history, Tauri packaging | — |

## Consequences

- The `--out`-file boundary means the studio never holds connector-specific code;
  ocel-etl-backlog gains v2 progress emission in its own repo, on its own schedule.
- Multi-log support changes no analysis endpoint: they already operate on "the
  loaded log", and switching swaps it wholesale (caches key on URL + mtime).
- E4 (real Backlog data) stops being a blocker for platform structure — it becomes
  the validation milestone for P3.
