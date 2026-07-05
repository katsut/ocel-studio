# Architecture

How ocel-studio is built. For the connector interface, see
[docs/connector-contract.md](docs/connector-contract.md).

## One binary, local-first

A single Rust binary serves everything on `127.0.0.1`: an axum JSON API and the
frontend (Vite/React/TypeScript), embedded at compile time with `rust-embed`
from `frontend/dist/`. There is no database and no network dependency at
analysis time — event data never leaves the machine. The only outbound request
is the explicit sample-log download button.

## The workspace is a directory

The data directory (`dirs::data_dir()/ocel-studio`) *is* the workspace: every
OCEL file in it (`.sqlite`/`.json`/`.xml` and friends) is a log you can open;
files are the source of truth. On start the newest readable log is opened;
`POST /api/logs/open` switches (bare file names only — no path traversal).

## Lazy reload

One log is held in memory (`RwLock<Option<Loaded>>`). Every API request
compares the file's mtime and re-reads on change, so a connector re-writing a
log shows up on the next 2-second poll without push machinery. The frontend
caches responses by URL and drops the whole cache when the mtime changes —
every endpoint is a pure function of file content plus query parameters.

## Analysis

All mining is delegated to the [`ocel-mine`](https://crates.io/crates/ocel-mine)
crate per object type: variants, DFG/OC-DFG, discovery (inductive with a noise
threshold, heuristics, alpha), exact replay fitness, ETC precision, lead times.
An optional time window (`from`/`to`) recomputes any endpoint on a filtered
copy of the log. The screens share a global context — object type and time
range travel in the header, and every aggregate number can drill down to the
real cases behind it.

## Data sources are commands

A registered source is a command line plus environment variables, run as a
child process with the workspace as its working directory (one run per source
at a time). Anything following the connector contract works; contract-v2
connectors stream NDJSON progress on stdout, rendered live. Presets (e.g.
Backlog) are sugar that compose the same command mechanism — never a separate
code path. Credential-typed variables are references into the OS keychain
(service `ocel-studio`), resolved only at spawn time: secrets never appear in
config files, API responses, or logs. The write-only secrets API can store and
delete them, not read them.
