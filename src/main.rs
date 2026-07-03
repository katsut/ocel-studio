use std::path::PathBuf;
use std::process::ExitCode;

use clap::Parser;

mod server;

/// Local-first process mining studio for OCEL 2.0 event logs.
#[derive(Debug, Parser)]
#[command(name = "ocel-studio", version, about)]
struct Cli {
    /// OCEL 2.0 log to open (.json/.jsonocel, .sqlite/.db, .xml/.xmlocel).
    log: PathBuf,

    /// Port to serve the studio on (localhost only).
    #[arg(long, default_value_t = 6235)]
    port: u16,
}

#[tokio::main]
async fn main() -> ExitCode {
    let cli = Cli::parse();
    match server::run(cli.log, cli.port).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(err) => {
            eprintln!("error: {err}");
            ExitCode::FAILURE
        }
    }
}
