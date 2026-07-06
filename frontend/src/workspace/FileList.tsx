import { type LogsResponse } from "../api.ts";
import { useMessages, type Lang } from "../i18n.tsx";

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  if (bytes >= 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }
  return `${bytes} B`;
}

export default function FileList({
  lang,
  listing,
  error,
  opening,
  onOpen,
}: {
  lang: Lang;
  listing: LogsResponse | null;
  error: string | null;
  opening: string | null;
  onOpen: (name: string) => void;
}) {
  const t = useMessages();
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
                          onClick={() => onOpen(log.name)}
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
