import { useCallback, useEffect, useState } from "react";
import {
  fetchEvents,
  fetchStatus,
  fetchSummary,
  type EventsPage,
  type Summary,
  type TypeCount,
} from "./api.ts";
import { I18nProvider, MESSAGES, useMessages, type Lang } from "./i18n.tsx";
import {
  applyTheme,
  loadLang,
  loadTheme,
  nextTheme,
  saveLang,
  themeIcon,
  type Theme,
} from "./preferences.ts";
import VariantsPanel from "./Variants.tsx";

const PAGE_SIZE = 50;
const POLL_MS = 2000;

function formatTime(iso: string, lang: Lang): string {
  return new Date(iso).toLocaleString(lang === "ja" ? "ja-JP" : "en-US");
}

function StatCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="card">
      <div className="card-label">{label}</div>
      <div className="card-value">{value}</div>
      {hint ? <div className="card-hint">{hint}</div> : null}
    </div>
  );
}

function TypeTable({ title, rows }: { title: string; rows: TypeCount[] }) {
  const t = useMessages();
  return (
    <div className="panel">
      <h2>{title}</h2>
      <table>
        <thead>
          <tr>
            <th>{t.typeCol}</th>
            <th className="num">{t.countCol}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.name}>
              <td>{row.name}</td>
              <td className="num">{row.count.toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const OBJECT_CHIP_LIMIT = 4;

function EventsPanel({
  page,
  lang,
  onPage,
}: {
  page: EventsPage;
  lang: Lang;
  onPage: (offset: number) => void;
}) {
  const t = useMessages();
  const from = page.total === 0 ? 0 : page.offset + 1;
  const to = Math.min(page.offset + page.items.length, page.total);
  return (
    <div className="panel">
      <h2>{t.eventsPanel}</h2>
      <table>
        <thead>
          <tr>
            <th>{t.timeCol}</th>
            <th>{t.typeCol}</th>
            <th>{t.idCol}</th>
            <th>{t.objectsCol}</th>
          </tr>
        </thead>
        <tbody>
          {page.items.map((event) => (
            <tr key={event.id}>
              <td className="mono">{formatTime(event.time, lang)}</td>
              <td>{event.eventType}</td>
              <td className="mono">{event.id}</td>
              <td>
                {event.objects.slice(0, OBJECT_CHIP_LIMIT).map((obj) => (
                  <span className="chip" key={`${obj.id}:${obj.qualifier}`} title={obj.qualifier}>
                    {obj.id}
                  </span>
                ))}
                {event.objects.length > OBJECT_CHIP_LIMIT ? (
                  <span className="chip more">+{event.objects.length - OBJECT_CHIP_LIMIT}</span>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="pager">
        <button onClick={() => onPage(Math.max(0, page.offset - PAGE_SIZE))} disabled={page.offset === 0}>
          {t.prev}
        </button>
        <span>
          {t.rangeOf(from.toLocaleString(), to.toLocaleString(), page.total.toLocaleString())}
        </span>
        <button onClick={() => onPage(page.offset + PAGE_SIZE)} disabled={to >= page.total}>
          {t.next}
        </button>
      </div>
    </div>
  );
}

function Dashboard({
  lang,
  theme,
  onLang,
  onTheme,
}: {
  lang: Lang;
  theme: Theme;
  onLang: (lang: Lang) => void;
  onTheme: (theme: Theme) => void;
}) {
  const t = useMessages();
  const [summary, setSummary] = useState<Summary | null>(null);
  const [page, setPage] = useState<EventsPage | null>(null);
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (at: number) => {
    try {
      const [s, p] = await Promise.all([fetchSummary(), fetchEvents(at, PAGE_SIZE)]);
      setSummary(s);
      setPage(p);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh(offset);
  }, [refresh, offset]);

  useEffect(() => {
    const timer = setInterval(() => {
      fetchStatus()
        .then((status) => {
          if (summary && status.modified !== summary.modified) {
            void refresh(offset);
          }
        })
        .catch(() => setError(t.serverUnreachable));
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [summary, offset, refresh, t]);

  const fileName = summary ? (summary.path.split("/").pop() ?? summary.path) : "";
  return (
    <>
      <header>
        <span className="brand">ocel-studio</span>
        {summary ? (
          <>
            <span className="file" title={summary.path}>
              {fileName}
            </span>
            <span className="modified">{t.updated(formatTime(summary.modified, lang))}</span>
          </>
        ) : null}
        <span className="controls">
          <button title={t.themeTitle} onClick={() => onTheme(nextTheme(theme))}>
            {themeIcon(theme)}
          </button>
          <button title={t.langTitle} onClick={() => onLang(lang === "ja" ? "en" : "ja")}>
            {lang === "ja" ? "EN" : "JA"}
          </button>
        </span>
      </header>
      {error ? <div className="error">{error}</div> : null}
      {summary && page ? (
        <main>
          <div className="cards">
            <StatCard label={t.events} value={summary.events.toLocaleString()} />
            <StatCard label={t.objects} value={summary.objects.toLocaleString()} />
            <StatCard
              label={t.timeRange}
              value={summary.timeRange ? formatTime(summary.timeRange.start, lang) : "—"}
              hint={summary.timeRange ? `→ ${formatTime(summary.timeRange.end, lang)}` : undefined}
            />
            <StatCard
              label={t.validation}
              value={
                summary.violations.length === 0 ? t.valid : t.violations(summary.violations.length)
              }
            />
          </div>
          {summary.violations.length > 0 ? (
            <details className="panel violations">
              <summary>{t.violations(summary.violations.length)}</summary>
              <ul>
                {summary.violations.map((violation) => (
                  <li key={violation}>{violation}</li>
                ))}
              </ul>
            </details>
          ) : null}
          <div className="columns">
            <TypeTable title={t.eventTypes} rows={summary.eventTypes} />
            <TypeTable title={t.objectTypes} rows={summary.objectTypes} />
          </div>
          <VariantsPanel types={summary.objectTypes} modified={summary.modified} />
          <EventsPanel page={page} lang={lang} onPage={setOffset} />
        </main>
      ) : (
        <div className="loading">{error ?? t.loading}</div>
      )}
    </>
  );
}

export default function App() {
  const [lang, setLang] = useState<Lang>(loadLang);
  const [theme, setTheme] = useState<Theme>(loadTheme);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  const changeLang = (next: Lang) => {
    saveLang(next);
    setLang(next);
  };

  return (
    <I18nProvider value={MESSAGES[lang]}>
      <Dashboard lang={lang} theme={theme} onLang={changeLang} onTheme={setTheme} />
    </I18nProvider>
  );
}
