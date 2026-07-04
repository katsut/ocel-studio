import { useCallback, useEffect, useMemo, useState } from "react";
import {
  caseLikeType,
  clearApiCache,
  fetchEvents,
  fetchSample,
  fetchStatus,
  fetchSummary,
  typeSlots,
  type CaseFilter,
  type EventsPage,
  type Range,
  type Status,
  type Summary,
  type TypeCount,
} from "./api.ts";
import Insights from "./Insights.tsx";
import { I18nProvider, MESSAGES, useMessages, type Lang } from "./i18n.tsx";
import {
  applyGuides,
  applyTheme,
  loadGuides,
  loadLang,
  loadTheme,
  nextTheme,
  saveLang,
  themeIcon,
  type Theme,
} from "./preferences.ts";
import CasesPanel from "./Cases.tsx";
import FlowPanel from "./Flow.tsx";
import ModelPanel from "./Model.tsx";
import VariantsPanel from "./Variants.tsx";

const PAGE_SIZE = 50;
const POLL_MS = 2000;

export type Screen = "overview" | "map" | "paths" | "cases" | "model" | "data";

function EmptyState({ dataDir }: { dataDir: string }) {
  const t = useMessages();
  const [fetching, setFetching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = () => {
    setFetching(true);
    setError(null);
    fetchSample()
      // the status poll picks the loaded log up on its next tick
      .catch((err) => {
        setError(err instanceof Error ? err.message : String(err));
        setFetching(false);
      });
  };

  return (
    <div className="empty-state">
      <img className="empty-logo" src="/favicon.svg" alt="" />
      <h1>{t.emptyTitle}</h1>
      <p>{t.emptyBody}</p>
      <button className="rerun-button" disabled={fetching} onClick={start}>
        {fetching ? t.emptyDownloading : t.emptySampleButton}
      </button>
      <p className="muted">{t.emptySampleNote(dataDir)}</p>
      <p className="muted">{t.emptyCliHint}</p>
      {error ? <div className="error">{error}</div> : null}
    </div>
  );
}

function formatTime(iso: string, lang: Lang): string {
  return new Date(iso).toLocaleString(lang === "ja" ? "ja-JP" : "en-US");
}

function formatDate(iso: string, lang: Lang): string {
  return new Date(iso).toLocaleDateString(lang === "ja" ? "ja-JP" : "en-US");
}

function TypeTable({ title, hint, rows }: { title: string; hint: string; rows: TypeCount[] }) {
  const t = useMessages();
  return (
    <div className="panel">
      <h2>{title}</h2>
      <p className="muted guide">{hint}</p>
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
      <p className="muted guide">{t.eventsHint}</p>
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
  guides,
  onLang,
  onTheme,
  onGuides,
}: {
  lang: Lang;
  theme: Theme;
  guides: boolean;
  onLang: (lang: Lang) => void;
  onTheme: (theme: Theme) => void;
  onGuides: (on: boolean) => void;
}) {
  const t = useMessages();
  const [screen, setScreen] = useState<Screen>("overview");
  const [chosenType, setChosenType] = useState<string>("");
  const [caseFilter, setCaseFilter] = useState<CaseFilter | null>(null);
  const [range, setRange] = useState<Range | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [page, setPage] = useState<EventsPage | null>(null);
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (at: number, r: Range | null) => {
    try {
      const [s, p] = await Promise.all([fetchSummary(r), fetchEvents(at, PAGE_SIZE, r)]);
      setSummary(s);
      setPage(p);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const loaded = status?.loaded === true;

  useEffect(() => {
    if (loaded) {
      void refresh(offset, range);
    }
  }, [loaded, refresh, offset, range]);

  useEffect(() => {
    const check = () => {
      fetchStatus()
        .then((next) => {
          setStatus(next);
          if (next.loaded && summary && next.modified !== summary.modified) {
            clearApiCache();
            void refresh(offset, range);
          }
        })
        .catch(() => setError(t.serverUnreachable));
    };
    check();
    const timer = setInterval(check, POLL_MS);
    return () => clearInterval(timer);
  }, [summary, offset, range, refresh, t]);

  const fileName = summary ? (summary.path.split("/").pop() ?? summary.path) : "";
  const slots = useMemo(() => typeSlots(summary?.objectTypes ?? []), [summary]);
  const preferred = summary ? (caseLikeType(summary.typeStats) ?? "") : "";
  const objectType =
    summary && chosenType !== "" && summary.objectTypes.some((ty) => ty.name === chosenType)
      ? chosenType
      : preferred;

  const nav: { key: Screen; label: string }[] = [
    { key: "overview", label: t.navOverview },
    { key: "map", label: t.navMap },
    { key: "paths", label: t.navPaths },
    { key: "cases", label: t.navCases },
    { key: "model", label: t.navModel },
    { key: "data", label: t.navData },
  ];

  return (
    <>
      <header>
        <img className="logo" src="/favicon.svg" alt="" />
        <span className="brand">ocel-studio</span>
        {summary ? (
          <>
            <span className="file" title={summary.path}>
              {fileName}
            </span>
            <select
              className="header-select"
              title={t.objectTypeLabel}
              value={objectType}
              onChange={(e) => {
                setChosenType(e.target.value);
                setCaseFilter(null);
              }}
            >
              {summary.objectTypes.map((ty) => (
                <option key={ty.name} value={ty.name}>
                  {ty.name} ({ty.count.toLocaleString()})
                </option>
              ))}
            </select>
            <span className="header-range" title={`${t.rangeTitle} — ${t.rangeNote}`}>
              <input
                type="date"
                value={range?.from ?? ""}
                onChange={(e) => setRange({ from: e.target.value, to: range?.to ?? "" })}
              />
              <span className="muted">–</span>
              <input
                type="date"
                value={range?.to ?? ""}
                onChange={(e) => setRange({ from: range?.from ?? "", to: e.target.value })}
              />
              {range ? (
                <button className="link-button" onClick={() => setRange(null)}>
                  ✕
                </button>
              ) : null}
            </span>
          </>
        ) : null}
        <span className="controls">
          <button
            title={t.guidesTitle}
            className={guides ? "toggle-on" : undefined}
            onClick={() => onGuides(!guides)}
          >
            ⓘ
          </button>
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
        <div className="shell">
          <nav className="sidebar">
            {nav.map((item) => (
              <button
                key={item.key}
                className={screen === item.key ? "nav-item nav-active" : "nav-item"}
                onClick={() => setScreen(item.key)}
              >
                {item.label}
              </button>
            ))}
          </nav>
          <main>
            {screen === "overview" ? (
              <>
                {objectType !== "" && summary.timeRange ? (
                  <p className="lead">
                    {t.dataIntro(
                      formatDate(summary.timeRange.start, lang),
                      formatDate(summary.timeRange.end, lang),
                      summary.events.toLocaleString(),
                      objectType,
                      (
                        summary.typeStats.find((s) => s.objectType === objectType)?.objects ?? 0
                      ).toLocaleString(),
                    )}
                  </p>
                ) : null}
                <p className="meta-bar">
                  <span>
                    <strong>{summary.events.toLocaleString()}</strong> {t.events}
                  </span>
                  <span>
                    <strong>{summary.objects.toLocaleString()}</strong> {t.objects}
                  </span>
                  <span className={summary.violations.length === 0 ? "meta-ok" : "meta-warn"}>
                    {summary.violations.length === 0
                      ? `✓ ${t.valid}`
                      : `⚠ ${t.violations(summary.violations.length)}`}
                  </span>
                  <span className="meta-updated">{t.updated(formatTime(summary.modified, lang))}</span>
                </p>
                {objectType !== "" ? (
                  <Insights objectType={objectType} range={range} modified={summary.modified} onNavigate={setScreen} />
                ) : null}
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
                  <TypeTable title={t.eventTypes} hint={t.eventTypesHint} rows={summary.eventTypes} />
                  <TypeTable title={t.objectTypes} hint={t.objectTypesHint} rows={summary.objectTypes} />
                </div>
              </>
            ) : null}
            {screen === "map" && objectType !== "" ? (
              <FlowPanel
                objectType={objectType}
                objectTypes={summary.objectTypes}
                slots={slots}
                range={range}
                modified={summary.modified}
                onShowCases={(from, to, forType) => {
                  if (forType !== objectType) {
                    setChosenType(forType);
                  }
                  setCaseFilter({ kind: "edge", from, to });
                  setScreen("cases");
                }}
              />
            ) : null}
            {screen === "paths" && objectType !== "" ? (
              <VariantsPanel
                objectType={objectType}
                range={range}
                modified={summary.modified}
                onShowCases={(activities) => {
                  setCaseFilter({ kind: "variant", activities });
                  setScreen("cases");
                }}
              />
            ) : null}
            {screen === "cases" && objectType !== "" ? (
              <CasesPanel
                objectType={objectType}
                range={range}
                modified={summary.modified}
                lang={lang}
                filter={caseFilter}
                onClearFilter={() => setCaseFilter(null)}
              />
            ) : null}
            {screen === "model" && objectType !== "" ? (
              <ModelPanel
                objectType={objectType}
                range={range}
                modified={summary.modified}
                onShowCases={(activities) => {
                  setCaseFilter({ kind: "variant", activities });
                  setScreen("cases");
                }}
              />
            ) : null}
            {screen === "data" ? <EventsPanel page={page} lang={lang} onPage={setOffset} /> : null}
          </main>
        </div>
      ) : status && !status.loaded ? (
        <EmptyState dataDir={status.dataDir} />
      ) : (
        <div className="loading">{error ?? t.intro}</div>
      )}
    </>
  );
}

export default function App() {
  const [lang, setLang] = useState<Lang>(loadLang);
  const [theme, setTheme] = useState<Theme>(loadTheme);
  const [guides, setGuides] = useState<boolean>(loadGuides);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  useEffect(() => {
    applyGuides(guides);
  }, [guides]);

  const changeLang = (next: Lang) => {
    saveLang(next);
    setLang(next);
  };

  return (
    <I18nProvider value={MESSAGES[lang]}>
      <Dashboard
        lang={lang}
        theme={theme}
        guides={guides}
        onLang={changeLang}
        onTheme={setTheme}
        onGuides={setGuides}
      />
    </I18nProvider>
  );
}
