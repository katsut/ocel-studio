import { useEffect, useState } from "react";
import {
  fetchRuns,
  joinCommandLine,
  type RunRecord,
  type SourceView,
} from "../api.ts";
import { useMessages, type Lang } from "../i18n.tsx";

export default function SourceRow({
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
  const [history, setHistory] = useState<RunRecord[] | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const finished = run?.finished ?? null;
  useEffect(() => {
    if (!showHistory) {
      return;
    }
    fetchRuns(source.name)
      .then(setHistory)
      .catch((err: unknown) => {
        console.error("run history unavailable:", err);
        setHistory([]);
      });
    // re-fetch when the live run completes so the new record appears
  }, [showHistory, source.name, finished]);
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
          <button className="link-button" onClick={() => setShowHistory((s) => !s)}>
            {t.srcHistoryLabel}
          </button>{" "}
          <button className="link-button" disabled={running} onClick={onDelete}>
            {t.srcDeleteLabel}
          </button>
        </td>
      </tr>
      {showHistory ? (
        <tr>
          <td colSpan={4}>
            {history === null ? null : history.length === 0 ? (
              <p className="muted run-history-empty">{t.srcHistoryEmpty}</p>
            ) : (
              <ul className="run-history">
                {history.map((record) => {
                  const seconds =
                    (new Date(record.finished).getTime() - new Date(record.started).getTime()) /
                    1000;
                  return (
                    <li key={`${record.source}-${record.started}`}>
                      <span
                        className={record.state === "succeeded" ? "meta-ok" : "meta-warn"}
                      >
                        {record.state === "succeeded" ? "●" : "▲"}
                      </span>{" "}
                      {new Date(record.started).toLocaleString(locale)}
                      {" · "}
                      {t.srcHistoryDuration(seconds.toFixed(seconds < 10 ? 1 : 0))}
                      {record.state === "succeeded" && record.summary
                        ? ` · ${t.srcSummary(
                            record.summary.events.toLocaleString(),
                            record.summary.objects.toLocaleString(),
                          )}`
                        : null}
                      {record.state === "failed" ? (
                        <>
                          {` · ${t.srcFailed(record.exitCode ?? null)}`}
                          {record.stderrTail ? (
                            <details>
                              <summary className="muted">stderr</summary>
                              <pre className="stderr-tail">{record.stderrTail}</pre>
                            </details>
                          ) : null}
                        </>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </td>
        </tr>
      ) : null}
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
