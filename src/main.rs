use std::path::PathBuf;
use std::process::ExitCode;

use clap::Parser;

mod server;

const OCEL_EXTENSIONS: [&str; 6] = ["json", "jsonocel", "sqlite", "db", "xml", "xmlocel"];

/// Local-first process mining studio for OCEL 2.0 event logs.
#[derive(Debug, Parser)]
#[command(name = "ocel-studio", version, about)]
struct Cli {
    /// OCEL 2.0 log to open (.json/.jsonocel, .sqlite/.db, .xml/.xmlocel).
    /// Without it the studio starts on the most recent log in its data
    /// directory, or empty with an offer to fetch the official sample.
    log: Option<PathBuf>,

    /// Port to serve the studio on (localhost only).
    #[arg(long, default_value_t = 6235)]
    port: u16,
}

fn data_dir() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("ocel-studio")
}

/// The most recently modified OCEL file in the data directory, if any.
fn latest_log(dir: &PathBuf) -> Option<PathBuf> {
    let entries = std::fs::read_dir(dir).ok()?;
    entries
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| {
            p.extension()
                .and_then(|e| e.to_str())
                .is_some_and(|e| OCEL_EXTENSIONS.contains(&e))
        })
        .max_by_key(|p| {
            std::fs::metadata(p)
                .and_then(|m| m.modified())
                .unwrap_or(std::time::SystemTime::UNIX_EPOCH)
        })
}

#[tokio::main]
async fn main() -> ExitCode {
    let cli = Cli::parse();
    let data_dir = data_dir();
    let initial = cli.log.or_else(|| latest_log(&data_dir));
    match server::run(initial, data_dir, cli.port).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(err) => {
            eprintln!("error: {err}");
            ExitCode::FAILURE
        }
    }
}
