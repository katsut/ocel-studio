# Connector CLI contract

A connector is any executable that produces or refreshes an OCEL 2.0 file. The
studio starts connectors as child processes and reads the files they write — it
never links them ([ADR 0001](adr/0001-local-first-architecture.md), decision 2).
Anything that follows this contract can be registered as a data source, in any
language.

Reference implementation: [`ocel-backlog pull`](https://github.com/katsut/ocel-etl-backlog).

## v1 (current)

- **Credentials** come from environment variables (e.g. `BACKLOG_BASE_URL`,
  `BACKLOG_API_KEY`). Never from arguments — argument lists leak into process
  listings and logs.
- **Target and output** come from arguments; the output file is named by `--out`
  (any OCEL 2.0 extension: `.json/.jsonocel`, `.sqlite/.db`, `.xml/.xmlocel`).
- **Incremental by default**: if the `--out` file exists, refresh it in place
  (e.g. only entities updated since the newest event); a `--full` flag forces a
  complete pull. Connectors that cannot sync incrementally simply rewrite the file.
- **Atomic writes recommended**: write to a temporary file and rename onto the
  target, so file watchers (including the studio's mtime reload) never observe a
  half-written log.
- **Exit code** 0 on success, non-zero on failure.
- **stderr** is for human-readable progress and diagnostics. The studio shows the
  tail of stderr when a run fails.
- **stdout** is reserved (see v2). A v1 connector should keep it quiet.

## v2 (progress protocol) — specified, adoption pending

v2 adds machine-readable progress so the studio can render more than a spinner.
Everything in v1 still holds.

A v2 connector writes **one JSON object per line to stdout** (NDJSON). Event
vocabulary:

```jsonl
{"event":"progress","stage":"issues","done":140,"total":532}
{"event":"log","level":"info","message":"project DEMO: 532 issues"}
{"event":"done","events":21008,"objects":10840}
```

- `progress` — `stage` is a short connector-chosen label; `total` may be omitted
  when unknown (the studio shows an indeterminate bar for that stage).
- `log` — `level` is `info` or `warn`; surfaced in the run detail. Errors belong
  on stderr with a non-zero exit.
- `done` — optional summary emitted once, right before a successful exit.

Rules:

- Unknown `event` values and unparseable lines are **ignored** by the studio —
  a v1 connector (silent stdout) and a v2 studio are always compatible, and a v2
  connector degrades to v1 behavior under any other orchestrator.
- Events are advisory. The source of truth for success is the exit code; the
  source of truth for data is the output file.
- No event may contain credentials.

## Registering a connector as a studio source

A source is a name plus the command that refreshes its output file, e.g.:

```json
{
  "name": "backlog-demo",
  "command": "ocel-backlog",
  "args": ["pull", "--project", "DEMO,OPS", "--out", "backlog-demo.sqlite"],
  "env": { "BACKLOG_BASE_URL": { "value": "https://example.backlog.com" },
           "BACKLOG_API_KEY": { "keyring": "backlog-demo" } }
}
```

Relative `--out` paths resolve inside the studio workspace (the data directory).
`keyring` references resolve from the OS keychain at spawn time; secrets never
appear in this file, in API responses, or in logs.
