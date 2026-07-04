import { useCallback, useEffect, useState } from "react";
import {
  deleteSource,
  fetchLogs,
  fetchSources,
  joinCommandLine,
  openLog,
  runSource,
  saveSource,
  setSecret,
  splitCommandLine,
  type EnvValue,
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
  const progress = running ? run.progress : null;
  return (
    <>
      <tr>
        <td className="mono">{source.name}</td>
        <td
          className="mono src-command"
          title={joinCommandLine(source.command, source.args)}
        >
          {joinCommandLine(source.command, source.args)}
          {source.env && Object.keys(source.env).length > 0 ? (
            <div className="env-line">
              {Object.entries(source.env).map(([key, value]) => (
                <span key={key} className="env-chip">
                  {key}=
                  {"keyring" in value ? `•••• (${t.envKeychainBadge})` : value.value}
                </span>
              ))}
            </div>
          ) : null}
        </td>
        <td>
          {run === null ? (
            <span className="muted">—</span>
          ) : running ? (
            <span>{t.srcRunning}</span>
          ) : run.state === "succeeded" ? (
            <span className="meta-ok">
              {t.srcSucceeded(new Date(run.finished ?? run.started).toLocaleString(locale))}
              {run.summary
                ? ` — ${t.srcSummary(
                    run.summary.events.toLocaleString(),
                    run.summary.objects.toLocaleString(),
                  )}`
                : ""}
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
      {progress ? (
        <tr>
          <td colSpan={4}>
            <div className="run-progress">
              <span className="muted">
                {progress.stage}{" "}
                {progress.total !== null
                  ? `${progress.done.toLocaleString()} / ${progress.total.toLocaleString()}`
                  : progress.done.toLocaleString()}
              </span>
              <div className="progress-track">
                <div
                  className={
                    progress.total !== null ? "progress-fill" : "progress-fill indeterminate"
                  }
                  style={
                    progress.total !== null && progress.total > 0
                      ? { width: `${Math.min(100, (progress.done / progress.total) * 100)}%` }
                      : undefined
                  }
                />
              </div>
            </div>
          </td>
        </tr>
      ) : null}
      {run && run.logs && run.logs.length > 0 ? (
        <tr>
          <td colSpan={4}>
            <pre className="stderr-tail">{run.logs.join("\n")}</pre>
          </td>
        </tr>
      ) : null}
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
            <BacklogPresetForm onAdd={act} />
          </>
        )}
      </div>
    </>
  );
}

/// A preset is sugar over the same source mechanism: it stores the API key
/// in the OS keychain and composes an `ocel-backlog pull` command + env —
/// never a separate code path (ADR 0004).
function BacklogPresetForm({ onAdd }: { onAdd: (request: Promise<SourceView[]>) => void }) {
  const t = useMessages();
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [projects, setProjects] = useState("");
  const [out, setOut] = useState("backlog.sqlite");
  const [command, setCommand] = useState("ocel-backlog");

  const ready =
    name.trim() !== "" &&
    baseUrl.trim() !== "" &&
    apiKey !== "" &&
    projects.trim() !== "" &&
    out.trim() !== "" &&
    command.trim() !== "";

  const add = () => {
    const sourceName = name.trim();
    const env: Record<string, EnvValue> = {
      BACKLOG_BASE_URL: { value: baseUrl.trim() },
      BACKLOG_API_KEY: { keyring: sourceName },
    };
    const args = ["pull", "--project", projects.trim(), "--out", out.trim()];
    onAdd(
      setSecret(sourceName, apiKey).then(() =>
        saveSource(sourceName, command.trim(), args, env),
      ),
    );
    setName("");
    setBaseUrl("");
    setApiKey("");
    setProjects("");
  };

  return (
    <details className="preset-form">
      <summary>{t.backlogPresetTitle}</summary>
      <p className="muted guide">{t.backlogPresetHint}</p>
      <div className="preset-grid">
        <input
          type="text"
          placeholder={t.srcNamePlaceholder}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <input
          type="text"
          placeholder="https://example.backlog.com"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
        />
        <input
          type="password"
          placeholder={t.backlogApiKeyPlaceholder}
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
        />
        <input
          type="text"
          placeholder={t.backlogProjectsPlaceholder}
          value={projects}
          onChange={(e) => setProjects(e.target.value)}
        />
        <input
          type="text"
          placeholder="backlog.sqlite"
          value={out}
          onChange={(e) => setOut(e.target.value)}
        />
        <input
          type="text"
          placeholder="ocel-backlog"
          value={command}
          onChange={(e) => setCommand(e.target.value)}
        />
        <button className="rerun-button" disabled={!ready} onClick={add}>
          {t.srcAddLabel}
        </button>
      </div>
    </details>
  );
}
