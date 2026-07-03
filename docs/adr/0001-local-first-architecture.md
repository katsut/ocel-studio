# ADR 0001: Local-first architecture

- **Date:** 2026-07-03
- **Status:** Accepted

## Context

ocel-studio is the product shell of the ocel family: a process mining studio that
opens [OCEL 2.0](https://www.ocel-standard.org/) event logs and, eventually, manages
the data sources that produce them. Process event data is among the most sensitive
data an organization has (who did what, when, how slowly), so the studio must be
usable without sending any of it anywhere.

Two sibling layers constrain this design:

- **ocel** (crates.io, MIT) — model, I/O, validation. The studio's only way to read logs.
- **ocel-mine** (planned, MIT) — deterministic analysis (variants / DFG / OC-DFG /
  metrics). The studio computes nothing itself; it renders what ocel-mine returns.

The boundary rule for what belongs here: **anything that touches state, configuration,
or the outside world** (credentials, schedules, child processes, UI). Anything that is
a deterministic computation over an OCEL log belongs in ocel-mine.

## Decisions

### 1. Form: single binary, local web app

One `ocel-studio` binary runs an [axum](https://github.com/tokio-rs/axum) HTTP server
bound to localhost and opens the browser. The frontend is built with Vite + React +
TypeScript (pnpm) and embedded into the binary at compile time (rust-embed), so a
release is one file with zero runtime dependencies. Event data never leaves the machine.

Packaging as a desktop app (Tauri wrap) stays possible later; nothing in this
architecture assumes a browser chrome.

### 2. Connectors are orchestrated, never linked

The studio starts connectors (e.g. [`ocel-backlog`](https://github.com/katsut/ocel-etl-backlog))
as child processes and reads the OCEL 2.0 files they produce. It has no compile-time
knowledge of any source system. Consequences:

- any tool that writes OCEL 2.0 works as a data source, and any CLI following the
  contract below can be registered as a connector
- source-specific concerns (API limits, pagination, auth flows) stay in connector repos

**Connector CLI contract v1** (as implemented by `ocel-backlog` today):

- credentials via environment variables; target and output via arguments
  (`--project`, `--out`)
- output is an OCEL 2.0 file; if `--out` exists, the connector refreshes it
  incrementally (`--full` forces a full pull)
- exit code 0 on success; progress and diagnostics on stderr (human-readable)

Machine-readable progress (`--progress json`) will be specified as contract v2 when
the data-source management UI is built.

### 3. Credentials in the OS keychain, config in the config dir

Secrets (connector API keys) are stored via the OS keychain (`keyring` crate:
macOS Keychain / Windows Credential Manager / Secret Service) and passed to child
processes as environment variables. Non-secret configuration (registered sources,
project keys, sync settings, workspace paths) lives as TOML under the platform config
directory (`directories` crate). Nothing secret is ever written into a studio workspace.

### 4. A workspace is a directory of OCEL files

The unit the studio opens is a directory containing OCEL 2.0 `.sqlite` files (plus
studio config). Files are watched; when a connector or an external pull rewrites one,
open views reload. This makes the "living dashboard" workflow (cron-driven incremental
pulls) work with no coupling.

### 5. Analysis is rendered, not computed

Views like OC-DFG, variants, and lead-time metrics call ocel-mine and render its
serde-JSON output. Until ocel-mine exists, the studio limits itself to I/O-level
views (log summary, event/object tables, validation results) via the `ocel` crate —
no interim mining code that would later be deleted.

## Pending

- Graph rendering library for OC-DFG (decide when the view is built; candidates:
  cytoscape.js + elk layout)
- Sync scheduler design (cron-like, contract v2 dependent)
- Tauri packaging (optional, later)

## License note

ocel-studio is source-available under the
[Elastic License 2.0](../../LICENSE.txt); the library layer of the family is MIT.
