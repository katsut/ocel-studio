use std::path::PathBuf;
use std::process::ExitCode;

use clap::Parser;

mod server;

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

fn config_dir() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("ocel-studio")
}

#[tokio::main]
async fn main() -> ExitCode {
    let cli = Cli::parse();
    match server::run(cli.log, data_dir(), config_dir(), cli.port).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(err) => {
            eprintln!("error: {err}");
            ExitCode::FAILURE
        }
    }
}
