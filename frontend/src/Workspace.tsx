import { useCallback, useEffect, useState } from "react";
import {
  deleteSource,
  fetchLogs,
  fetchSources,
  joinCommandLine,
  openLog,
  runSource,
  saveSource,
  splitCommandLine,
  type LogsResponse,
  type SourceView,
} from "./api.ts";
import { useMessages, type Lang } from "./i18n.tsx";

const SOURCES_POLL_MS = 2000;

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  if (bytes >= 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }
  return `${bytes} B`;
}

function SourceRow({
  source,
  lang,
  onRun,
  onDelete,
}: {
  source: SourceView;
  lang: Lang;
  onRun: () => void;
  onDelete: () => void;
}) {
  const t = useMessages();
  const run = source.run;
  const running = run?.state === "running";
  const locale = lang === "ja" ? "ja-JP" : "en-US";
  return (
    <>
      <tr>
        <td className="mono">{source.name}</td>
        <td className="mono src-command">{joinCommandLine(source.command, source.args)}</td>
        <td>
          {run === null ? (
            <span className="muted">—</span>
          ) : running ? (
            <span>{t.srcRunning}</span>
          ) : run.state === "succeeded" ? (
            <span className="meta-ok">
              {t.srcSucceeded(new Date(run.finished ?? run.started).toLocaleString(locale))}
            </span>
          ) : (
            <span className="meta-warn">{t.srcFailed(run.exitCode)}</span>
          )}
        </td>
        <td className="num">
          <button className="link-button" disabled={running} onClick={onRun}>
            {t.srcRunLabel}
          </button>{" "}
          <button className="link-button" disabled={running} onClick={onDelete}>
            {t.srcDeleteLabel}
          </button>
        </td>
      </tr>
      {run?.state === "failed" && run.stderrTail ? (
        <tr>
          <td colSpan={4}>
            <pre className="stderr-tail">{run.stderrTail}</pre>
          </td>
        </tr>
      ) : null}
    </>
  );
}

export default function WorkspacePanel({
  lang,
  modified,
  onOpened,
}: {
  lang: Lang;
  modified: string;
  onOpened: () => void;
}) {
  const t = useMessages();
  const [listing, setListing] = useState<LogsResponse | null>(null);
  const [sources, setSources] = useState<SourceView[] | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [newCommand, setNewCommand] = useState("");
  const [error, setError] = useState<string | null>(null);

  const refreshLogs = useCallback(() => {
    fetchLogs()
      .then((next) => {
        setListing(next);
        setError(null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  useEffect(() => {
    refreshLogs();
  }, [refreshLogs, modified]);

  // sources (and the files their runs produce) change outside the mtime
  // cycle, so poll both while this screen is visible
  useEffect(() => {
    const check = () => {
      fetchSources()
        .then(setSources)
        .catch((err) => setError(err instanceof Error ? err.message : String(err)));
    };
    check();
    const timer = setInterval(() => {
      check();
      refreshLogs();
    }, SOURCES_POLL_MS);
    return () => clearInterval(timer);
  }, [refreshLogs]);

  const open = (name: string) => {
    setOpening(name);
    openLog(name)
      .then(() => {
        setOpening(null);
        onOpened();
        refreshLogs();
      })
      .catch((err) => {
        setOpening(null);
        setError(err instanceof Error ? err.message : String(err));
      });
  };

  const act = (request: Promise<SourceView[]>) => {
    request
      .then((next) => {
        setSources(next);
        setError(null);
        refreshLogs();
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  };

  const add = () => {
    const parts = splitCommandLine(newCommand);
    if (newName.trim() === "" || parts.length === 0) {
      return;
    }
    act(saveSource(newName.trim(), parts[0], parts.slice(1)));
    setNewName("");
    setNewCommand("");
  };

  return (
    <>
      <div className="panel">
        <div className="panel-head">
          <h2>{t.workspacePanel}</h2>
        </div>
        <p className="muted guide">{t.workspaceHint}</p>
        {error ? <div className="error">{error}</div> : null}
        {listing ? (
          <>
            {listing.activeOutside ? (
              <p className="muted">{t.workspaceOutsideNote(listing.activeOutside)}</p>
            ) : null}
            {listing.logs.length === 0 ? (
              <p className="muted">{t.workspaceEmpty}</p>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>{t.fileCol}</th>
                    <th className="num">{t.sizeCol}</th>
                    <th>{t.updatedCol}</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {listing.logs.map((log) => (
                    <tr key={log.name}>
                      <td className="mono">{log.name}</td>
                      <td className="num">{formatSize(log.size)}</td>
                      <td>
                        {new Date(log.modified).toLocaleString(lang === "ja" ? "ja-JP" : "en-US")}
                      </td>
                      <td className="num">
                        {log.active ? (
                          <span className="active-badge">{t.activeBadge}</span>
                        ) : (
                          <button
                            className="link-button"
                            disabled={opening !== null}
                            onClick={() => open(log.name)}
                          >
                            {opening === log.name ? t.loading : t.openLabel}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <p className="muted">{t.workspaceDirNote(listing.dataDir)}</p>
          </>
        ) : (
          <div className="loading">{t.loading}</div>
        )}
      </div>
      <div className="panel">
        <div className="panel-head">
          <h2>{t.sourcesPanel}</h2>
        </div>
        <p className="muted guide">{t.sourcesHint}</p>
        {sources === null ? (
          <div className="loading">{t.loading}</div>
        ) : (
          <>
            {sources.length > 0 ? (
              <table>
                <thead>
                  <tr>
                    <th>{t.srcNameCol}</th>
                    <th>{t.srcCommandCol}</th>
                    <th>{t.srcStatusCol}</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {sources.map((source) => (
                    <SourceRow
                      key={source.name}
                      source={source}
                      lang={lang}
                      onRun={() => act(runSource(source.name))}
                      onDelete={() => act(deleteSource(source.name))}
                    />
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="muted">{t.sourcesEmpty}</p>
            )}
            <div className="source-form">
              <input
                type="text"
                placeholder={t.srcNamePlaceholder}
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
              />
              <input
                type="text"
                className="source-command-input"
                placeholder={t.srcCommandPlaceholder}
                value={newCommand}
                onChange={(e) => setNewCommand(e.target.value)}
              />
              <button
                className="rerun-button"
                disabled={newName.trim() === "" || newCommand.trim() === ""}
                onClick={add}
              >
                {t.srcAddLabel}
              </button>
            </div>
            <p className="muted guide">{t.sourcesExactNote}</p>
          </>
        )}
      </div>
    </>
  );
}
