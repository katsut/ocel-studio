import { useEffect, useState } from "react";
import {
  fetchCase,
  fetchCases,
  type CaseDetail,
  type CasesPage,
} from "./api.ts";
import { useMessages } from "./i18n.tsx";
import type { Lang } from "./i18n.tsx";

const PAGE_SIZE = 25;

function formatTime(iso: string, lang: Lang): string {
  return new Date(iso).toLocaleString(lang === "ja" ? "ja-JP" : "en-US");
}

function shortPath(activities: string[]): string {
  if (activities.length <= 4) {
    return activities.join(" → ");
  }
  return `${activities[0]} → … → ${activities[activities.length - 1]} (${activities.length})`;
}

function Timeline({
  detail,
  lang,
  onBack,
}: {
  detail: CaseDetail;
  lang: Lang;
  onBack: () => void;
}) {
  const t = useMessages();
  return (
    <div className="panel">
      <div className="panel-head">
        <h2 className="mono">{detail.objectId}</h2>
        <button className="link-button" onClick={onBack}>
          ← {t.backToCases}
        </button>
      </div>
      <p className="muted guide">{t.caseTimelineHint}</p>
      <ol className="timeline">
        {detail.items.map((event) => (
          <li key={event.id} className="tl-item">
            <span className="tl-time mono">{formatTime(event.time, lang)}</span>
            <span className="tl-activity">{event.eventType}</span>
            <span className="tl-others">
              {event.objects
                .filter((obj) => obj.id !== detail.objectId)
                .slice(0, 6)
                .map((obj) => (
                  <span className="chip" key={`${obj.id}:${obj.qualifier}`} title={obj.qualifier}>
                    {obj.id}
                  </span>
                ))}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

export default function CasesPanel({
  objectType,
  modified,
  lang,
  variantFilter,
  onClearFilter,
}: {
  objectType: string;
  modified: string;
  lang: Lang;
  variantFilter: string[] | null;
  onClearFilter: () => void;
}) {
  const t = useMessages();
  const [page, setPage] = useState<CasesPage | null>(null);
  const [offset, setOffset] = useState(0);
  const [detail, setDetail] = useState<CaseDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setOffset(0);
    setDetail(null);
  }, [objectType, variantFilter]);

  useEffect(() => {
    fetchCases(objectType, variantFilter, offset, PAGE_SIZE)
      .then((p) => {
        setPage(p);
        setError(null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [objectType, variantFilter, offset, modified]);

  const open = (id: string) => {
    fetchCase(id)
      .then(setDetail)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  };

  if (detail) {
    return <Timeline detail={detail} lang={lang} onBack={() => setDetail(null)} />;
  }

  const from = page && page.total > 0 ? page.offset + 1 : 0;
  const to = page ? Math.min(page.offset + page.items.length, page.total) : 0;
  return (
    <div className="panel">
      <div className="panel-head">
        <h2>{t.casesPanel}</h2>
        {variantFilter ? (
          <button className="filter-chip" onClick={onClearFilter} title={t.clearFilter}>
            {t.filterVariant(shortPath(variantFilter))} ✕
          </button>
        ) : null}
      </div>
      <p className="muted guide">{t.casesHint}</p>
      {error ? <div className="error">{error}</div> : null}
      {page ? (
        <>
          <table>
            <thead>
              <tr>
                <th>{t.idCol}</th>
                <th>{t.caseStartCol}</th>
                <th className="num">{t.leadCol}</th>
                <th className="num">{t.caseStepsCol}</th>
                <th>{t.sequenceCol}</th>
              </tr>
            </thead>
            <tbody>
              {page.items.map((item) => (
                <tr key={item.objectId} className="row-link" onClick={() => open(item.objectId)}>
                  <td className="mono">{item.objectId}</td>
                  <td className="mono">{formatTime(item.start, lang)}</td>
                  <td className="num">{t.duration(item.leadSecs)}</td>
                  <td className="num">{item.events.toLocaleString()}</td>
                  <td className="muted">{shortPath(item.activities)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="pager">
            <button onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))} disabled={offset === 0}>
              {t.prev}
            </button>
            <span>
              {t.rangeOf(from.toLocaleString(), to.toLocaleString(), page.total.toLocaleString())}
            </span>
            <button onClick={() => setOffset(offset + PAGE_SIZE)} disabled={to >= page.total}>
              {t.next}
            </button>
          </div>
        </>
      ) : (
        <div className="loading">{t.loading}</div>
      )}
    </div>
  );
}
