# ocel-studio

Local-first process mining studio for [OCEL 2.0](https://www.ocel-standard.org/) event logs.

Open an OCEL 2.0 file (SQLite / JSON / XML) and see your processes: object-centric
directly-follows graphs, trace variants, lead times. Connect your issue trackers and
keep the log synced — without sending your event data anywhere.

## Status

Early scaffold. The architecture is being laid down; nothing to run yet.
Design decisions are recorded in [docs/adr](docs/adr/).

## The ocel family

| Layer | Repo | License |
|---|---|---|
| Core model, I/O, validation | [ocel-rs](https://github.com/katsut/ocel-rs) (crates.io: [`ocel`](https://crates.io/crates/ocel)) | MIT |
| ETL engine (StagingLog → OCEL) | [ocel-etl](https://github.com/katsut/ocel-etl) | MIT |
| Backlog connector | [ocel-etl-backlog](https://github.com/katsut/ocel-etl-backlog) | MIT |
| Analysis library (variants / OC-DFG / metrics) | ocel-mine (planned) | MIT |
| **Studio — UI + data source management (this repo)** | ocel-studio | **Elastic License 2.0** |

The studio never links connectors: it orchestrates them as child processes and reads
the OCEL 2.0 files they produce, so any tool that writes OCEL 2.0 works as a source.

## License

[Elastic License 2.0](LICENSE.txt) — free to use, copy, modify, and distribute,
including commercial and internal business use. The one thing you may not do is
provide ocel-studio itself to third parties as a hosted or managed service.
ELv2 is source-available, not an OSI-approved open source license; the library
layer of the ocel family is plain MIT.
