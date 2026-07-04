import { useCallback, useEffect, useState } from "react";
import { fetchLogs, openLog, type LogsResponse } from "./api.ts";
import { useMessages, type Lang } from "./i18n.tsx";

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  if (bytes >= 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }
  return `${bytes} B`;
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
  const [opening, setOpening] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    fetchLogs()
      .then((next) => {
        setListing(next);
        setError(null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh, modified]);

  const open = (name: string) => {
    setOpening(name);
    openLog(name)
      .then(() => {
        setOpening(null);
        onOpened();
        refresh();
      })
      .catch((err) => {
        setOpening(null);
        setError(err instanceof Error ? err.message : String(err));
      });
  };

  return (
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
  );
}
