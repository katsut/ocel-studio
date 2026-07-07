ocel-studio — local-first process mining for OCEL 2.0 event logs
https://github.com/katsut/ocel-studio

Everything runs on your machine. Your event data never leaves it.

QUICK START

  1. Put this directory on your PATH (or run binaries with ./):

       export PATH="$PWD:$PATH"

  2. Start the studio and open http://localhost:6235

       ./ocel-studio

     First visit offers the official sample log (one click, ~35 MB
     from Zenodo) — the only network request the studio ever makes
     on its own.

  3. Mine your own data. Pull a public GitHub repo's issue/PR history
     (no token needed) into the studio workspace, then open it from
     the Workspace screen:

       ./ocel-github pull --repo owner/name --out fd.sqlite

     Backlog (BACKLOG_BASE_URL + BACKLOG_API_KEY env), CSV exports
     (./ocel-csv --mapping mapping.json), and cleaning recipes
     (./ocel-transform) work the same way — or register them as
     sources inside the studio and run them with one click.

WHAT'S IN THE BOX

  ocel-studio     the UI (single binary, embedded frontend)
  ocel-github     GitHub issues/PRs -> OCEL 2.0
  ocel-backlog    Backlog issues + change history -> OCEL 2.0
  ocel-csv        any CSV export -> OCEL 2.0 (declarative mapping)
  ocel-transform  deterministic cleaning recipes with preview
  ocel-annotate   local-LLM/embedding/rules text labeling (Ollama)
  ocel-aliases    identity-resolution proposals (human-approved)

macOS NOTE

  If Gatekeeper complains about unsigned binaries, clear the
  quarantine flag after checking the SHA-256:

    xattr -d com.apple.quarantine ./ocel-studio ./ocel-*

LICENSES

  ocel-studio: Elastic License 2.0 (see LICENSE.txt)
  connectors and CLIs: MIT — sources at github.com/katsut
