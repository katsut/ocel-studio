# ocel-studio

Local-first process mining studio for [OCEL 2.0](https://www.ocel-standard.org/) event logs.

Open an OCEL 2.0 file (SQLite / JSON / XML) and discover your processes: insight
cards in plain language, a frequency-and-wait process map, trace variants with
measured lead times, inductive-miner models — and drill from every number down
to the real cases behind it. Without sending your event data anywhere.

![ocel-studio overview (dark)](docs/assets/overview-dark.jpeg)

## Status

The discovery loop is complete: one screen per question (overview / map / paths /
cases / model / data), a global carried context (object type, time range), and
every claim lands on real cases within two clicks. The log live-reloads when the
file changes on disk, so an incrementally synced log behaves like a living
dashboard. The platform layer is in place: the workspace screen lists every log
in the studio folder and switches between them, and registered data sources
(any command following the [connector contract](docs/connector-contract.md))
run on click with live v2 progress, credentials injected from the OS keychain,
and a Backlog preset that composes an `ocel-backlog pull` source. See
[ARCHITECTURE.md](ARCHITECTURE.md) for how it is built.

## Quickstart

Grab the all-in-one bundle from
[Releases](https://github.com/katsut/ocel-studio/releases) (macOS arm64 /
Linux x64 — the studio plus every connector, no toolchain needed):

```sh
tar -xzf ocel-studio-*.tar.gz && cd ocel-studio-*/
./ocel-studio
# → http://localhost:6235
```

No log yet? The studio starts empty and offers to fetch the official
[Order Management](https://zenodo.org/records/18373906) sample (21K events,
~35 MB) into its data directory with one click — the only network request it
ever makes on its own. Then point it at your own data; a public GitHub repo
needs no token:

```sh
./ocel-github pull --repo owner/name --out my-repo.sqlite
# open it from the studio's Workspace screen — or register the command as a
# source there and re-pull incrementally with one click
```

Backlog (`BACKLOG_BASE_URL` + `BACKLOG_API_KEY`), CSV exports from any tool,
and cleaning recipes ship in the same bundle.

### Building from source

```sh
pnpm --dir frontend install
pnpm --dir frontend build          # embedded into the binary at compile time
cargo run --release
cargo run --release -- path/to/log.sqlite   # open a specific .json / .sqlite / .xml
```

## The ocel family

| Layer | Repo | License |
|---|---|---|
| Core model, I/O, validation | [ocel-rs](https://github.com/katsut/ocel-rs) (crates.io: [`ocel`](https://crates.io/crates/ocel)) | MIT |
| ETL engine (StagingLog → OCEL) | [ocel-etl](https://github.com/katsut/ocel-etl) | MIT |
| GitHub connector | [ocel-etl-github](https://github.com/katsut/ocel-etl-github) | MIT |
| Backlog connector | [ocel-etl-backlog](https://github.com/katsut/ocel-etl-backlog) | MIT |
| CSV importer | [ocel-etl-csv](https://github.com/katsut/ocel-etl-csv) | MIT |
| Cleaning recipes | [ocel-transform](https://github.com/katsut/ocel-transform) (crates.io: [`ocel-transform`](https://crates.io/crates/ocel-transform)) | MIT |
| Local-LLM annotation + identity resolution | [ocel-annotate](https://github.com/katsut/ocel-annotate) | MIT |
| Analysis library (variants / OC-DFG / discovery / fitness / precision) | [ocel-mine](https://github.com/katsut/ocel-mine) (crates.io: [`ocel-mine`](https://crates.io/crates/ocel-mine)) | MIT |
| **Studio — UI + data source management (this repo)** | ocel-studio | **Elastic License 2.0** |

The studio never links connectors: it orchestrates them as child processes and reads
the OCEL 2.0 files they produce, so any tool that writes OCEL 2.0 works as a source.

## License

[Elastic License 2.0](LICENSE.txt) — free to use, copy, modify, and distribute,
including commercial and internal business use. The one thing you may not do is
provide ocel-studio itself to third parties as a hosted or managed service.
ELv2 is source-available, not an OSI-approved open source license; the library
layer of the ocel family is plain MIT.
