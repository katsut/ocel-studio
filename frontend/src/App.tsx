import { useCallback, useEffect, useMemo, useState } from "react";
import {
  caseLikeType,
  clearApiCache,
  deleteView,
  fetchEvents,
  fetchRecipes,
  fetchSample,
  fetchStatus,
  fetchSummary,
  fetchVerify,
  fetchViews,
  openLog,
  saveView,
  typeSlots,
  VIEW_NAME_PATTERN,
  type CaseFilter,
  type Declaration,
  type DeclarationSet,
  type DeclarationSetView,
  type EventsPage,
  type Status,
  type Summary,
  type TypeCount,
  type Verification,
} from "./api.ts";
import Insights from "./Insights.tsx";
import { I18nProvider, MESSAGES, useMessages, type Lang } from "./i18n.tsx";
import {
  applyGuides,
  applyTheme,
  loadGuides,
  loadLang,
  loadTheme,
  loadViewName,
  nextTheme,
  saveLang,
  saveViewName,
  themeIcon,
  type Theme,
} from "./preferences.ts";
import CasesPanel from "./Cases.tsx";
import ConformancePanel from "./Conformance.tsx";
import FlowPanel from "./Flow.tsx";
import ModelPanel from "./Model.tsx";
import VariantsPanel from "./Variants.tsx";
import WorkspacePanel from "./Workspace.tsx";

const PAGE_SIZE = 50;
const POLL_MS = 2000;

export type Screen =
  | "overview"
  | "map"
  | "paths"
  | "cases"
  | "model"
  | "conformance"
  | "data"
  | "workspace";

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

type ViaMode = "any" | "via" | "notVia";

function viaMode(declaration: Declaration): ViaMode {
  if (declaration.via !== undefined) {
    return "via";
  }
  return declaration.notVia !== undefined ? "notVia" : "any";
}

function VerifyStrip({
  caseType,
  verification,
  verifyError,
  loading,
}: {
  caseType: string;
  verification: Verification | null;
  verifyError: string | null;
  loading: boolean;
}) {
  const t = useMessages();
  const conv = verification?.convergence ?? null;
  const div = verification?.divergence ?? null;
  const conn = verification?.connectivity ?? null;

  const convSentence =
    conv === null
      ? null
      : conv.worstActivity !== null
        ? t.verifyConvergenceSentence(caseType, conv.worstActivity.name, conv.worstActivity.mean.toFixed(1))
        : t.verifyConvergenceSentenceWhole(caseType, conv.mean.toFixed(1));

  const divSentence = div === null ? null : t.verifyDivergenceSentence(`${Math.round(div.share * 100)}%`);
  const divWorstSentence =
    div?.worstActivity !== null && div?.worstActivity !== undefined
      ? t.verifyDivergenceSentenceWorst(div.worstActivity.name)
      : null;

  const connSentence =
    conn === null
      ? null
      : conn.collapsed
        ? t.verifyConnectivityCollapsed
        : t.verifyConnectivitySentence(
            conn.components.toLocaleString(),
            `${Math.round(conn.largestShare * 100)}%`,
          );

  return (
    <>
    <div className={loading ? "verify-strip verify-loading" : "verify-strip"}>
      <div className={conv !== null && conv.mean >= 1.5 ? "verify-tile verify-warn" : "verify-tile"}>
        <h3>{t.verifyConvergenceTitle}</h3>
        <div className="verify-figure">{conv !== null ? `×${conv.mean.toFixed(1)}` : "…"}</div>
        {convSentence !== null ? <p>{convSentence}</p> : <p>…</p>}
      </div>
      <div className={div !== null && div.share >= 0.3 ? "verify-tile verify-warn" : "verify-tile"}>
        <h3>{t.verifyDivergenceTitle}</h3>
        <div className="verify-figure">{div !== null ? `${Math.round(div.share * 100)}%` : "…"}</div>
        {divSentence !== null ? <p>{divSentence}</p> : <p>…</p>}
        {divWorstSentence !== null ? <p>{divWorstSentence}</p> : null}
      </div>
      <div
        className={
          conn !== null && conn.collapsed
            ? "verify-tile verify-serious"
            : conn !== null && conn.largestShare >= 0.5
              ? "verify-tile verify-warn"
              : "verify-tile"
        }
      >
        <h3>{t.verifyConnectivityTitle}</h3>
        <div className="verify-figure">{conn !== null ? conn.components.toLocaleString() : "…"}</div>
        {connSentence !== null ? <p>{connSentence}</p> : <p>…</p>}
        {conn !== null ? <p className="muted">{t.verifyWalkTypes(conn.walkTypes.join(", "))}</p> : null}
      </div>
    </div>
    {verifyError ? <div className="error">{verifyError}</div> : null}
    </>
  );
}

function DeclarationBar({
  objectTypes,
  caseType,
  declaration,
  note,
  recipes,
  viewName,
  baseLog,
  logPath,
  error,
  verification,
  verifyError,
  verifyLoading,
  onChange,
  onNote,
  onSave,
  onDelete,
  onOpenBaseLog,
}: {
  objectTypes: TypeCount[];
  caseType: string;
  declaration: Declaration;
  note: string;
  recipes: string[];
  viewName: string | null;
  baseLog: string | null;
  logPath: string | null;
  error: string | null;
  verification: Verification | null;
  verifyError: string | null;
  verifyLoading: boolean;
  onChange: (next: Declaration) => void;
  onNote: (next: string) => void;
  onSave: (name: string) => void;
  onDelete: () => void;
  onOpenBaseLog: (name: string) => void;
}) {
  const t = useMessages();
  const [naming, setNaming] = useState(false);
  const [newName, setNewName] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);

  const mode = viaMode(declaration);
  const picked = declaration.via ?? declaration.notVia ?? [];
  const period = declaration.period ?? null;

  const setMode = (next: ViaMode) => {
    if (next === "any") {
      onChange({ ...declaration, via: undefined, notVia: undefined });
    } else if (next === "via") {
      onChange({ ...declaration, via: picked, notVia: undefined });
    } else {
      onChange({ ...declaration, via: undefined, notVia: picked });
    }
  };

  const toggle = (name: string) => {
    const next = picked.includes(name)
      ? picked.filter((ty) => ty !== name)
      : [...picked, name];
    if (mode === "notVia") {
      onChange({ ...declaration, via: undefined, notVia: next });
    } else {
      onChange({ ...declaration, via: next, notVia: undefined });
    }
  };

  const confirmName = () => {
    const name = newName.trim();
    if (!VIEW_NAME_PATTERN.test(name)) {
      setNameError(t.declNameInvalid);
      return;
    }
    setNameError(null);
    setNaming(false);
    setNewName("");
    onSave(name);
  };

  return (
    <div className="decl-bar">
      {baseLog !== null && logPath !== null && baseLog !== logPath ? (
        <div className="decl-row decl-baselog">
          <span>{t.declBaseLogHint(baseLog)}</span>
          <button className="link-button" onClick={() => onOpenBaseLog(baseLog)}>
            {t.openLabel}
          </button>
        </div>
      ) : null}
      <div className="decl-row">
        <label>
          {t.declCaseTypeLabel}{" "}
          <select
            className="header-select"
            value={caseType}
            onChange={(e) => onChange({ ...declaration, caseType: e.target.value })}
          >
            {objectTypes.map((ty) => (
              <option key={ty.name} value={ty.name}>
                {ty.name} ({ty.count.toLocaleString()})
              </option>
            ))}
          </select>
        </label>
        <label>
          {t.declRecipeLabel}{" "}
          <select
            className="header-select"
            value={declaration.recipe ?? ""}
            onChange={(e) =>
              onChange({
                ...declaration,
                recipe: e.target.value === "" ? undefined : e.target.value,
              })
            }
          >
            <option value="">{t.declNoRecipe}</option>
            {recipes.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <span className="header-range" title={t.rangeNote}>
          {t.declPeriodLabel}{" "}
          <input
            type="date"
            value={period?.from ?? ""}
            onChange={(e) =>
              onChange({
                ...declaration,
                period: { from: e.target.value, to: period?.to ?? "" },
              })
            }
          />
          <span className="muted">–</span>
          <input
            type="date"
            value={period?.to ?? ""}
            onChange={(e) =>
              onChange({
                ...declaration,
                period: { from: period?.from ?? "", to: e.target.value },
              })
            }
          />
          {period ? (
            <button
              className="link-button"
              title={t.declPeriodClear}
              onClick={() => onChange({ ...declaration, period: null })}
            >
              ✕
            </button>
          ) : null}
        </span>
      </div>
      <div className="decl-row">
        <span className="decl-modes" role="radiogroup" aria-label={t.declViaLabel}>
          {(["any", "via", "notVia"] as ViaMode[]).map((option) => (
            <label key={option}>
              <input
                type="radio"
                name="decl-via-mode"
                checked={mode === option}
                onChange={() => setMode(option)}
              />{" "}
              {option === "any"
                ? t.declViaAny
                : option === "via"
                  ? t.declViaOnly
                  : t.declNotViaOnly}
            </label>
          ))}
        </span>
        {mode === "any" ? null : (
          <span className="type-chips decl-chips">
            {objectTypes
              .filter((ty) => ty.name !== caseType)
              .map((ty) => (
                <button
                  key={ty.name}
                  className={picked.includes(ty.name) ? "type-chip active" : "type-chip"}
                  onClick={() => toggle(ty.name)}
                >
                  {ty.name}
                </button>
              ))}
          </span>
        )}
      </div>
      <p className="muted guide">{mode === "notVia" ? t.declNotViaHint : t.declViaHint}</p>
      <VerifyStrip
        caseType={caseType}
        verification={verification}
        verifyError={verifyError}
        loading={verifyLoading}
      />
      <div className="decl-row">
        <input
          className="decl-note"
          placeholder={t.declNotePlaceholder}
          size={40}
          value={note}
          onChange={(e) => onNote(e.target.value)}
        />
        <button
          className="rerun-button"
          disabled={viewName === null}
          title={viewName === null ? t.declSaveNeedsName : undefined}
          onClick={() => onSave(viewName ?? "")}
        >
          {t.declSaveLabel}
        </button>
        <button
          className="rerun-button"
          onClick={() => {
            setNaming(true);
            setNameError(null);
            setNewName(viewName ?? "");
          }}
        >
          {t.declSaveAsLabel}
        </button>
        {viewName !== null ? (
          <button className="link-button" onClick={onDelete}>
            {t.declDeleteLabel}
          </button>
        ) : null}
      </div>
      {naming ? (
        <div className="decl-row">
          <input
            placeholder={t.declNamePlaceholder}
            value={newName}
            autoFocus
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                confirmName();
              }
            }}
          />
          <button className="rerun-button" onClick={confirmName}>
            {t.declSaveLabel}
          </button>
          <button
            className="link-button"
            onClick={() => {
              setNaming(false);
              setNameError(null);
            }}
          >
            {t.closeLabel}
          </button>
        </div>
      ) : null}
      {nameError ? <div className="error">{nameError}</div> : null}
      {error ? <div className="error">{error}</div> : null}
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
  const [declaration, setDeclaration] = useState<Declaration>({ caseType: "" });
  const [note, setNote] = useState("");
  const [selectedView, setSelectedView] = useState<string | null>(null);
  const [views, setViews] = useState<DeclarationSetView[]>([]);
  const [recipes, setRecipes] = useState<string[]>([]);
  const [editing, setEditing] = useState(false);
  const [viewError, setViewError] = useState<string | null>(null);
  const [caseFilter, setCaseFilter] = useState<CaseFilter | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [page, setPage] = useState<EventsPage | null>(null);
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [verification, setVerification] = useState<Verification | null>(null);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const [verifyLoading, setVerifyLoading] = useState(false);

  const refresh = useCallback(async (at: number, d: Declaration) => {
    try {
      const [s, p] = await Promise.all([fetchSummary(d), fetchEvents(at, PAGE_SIZE, d)]);
      setSummary(s);
      setPage(p);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const fileName = summary ? (summary.path.split("/").pop() ?? summary.path) : "";
  const slots = useMemo(() => typeSlots(summary?.objectTypes ?? []), [summary]);
  const preferred = summary
    ? (caseLikeType(summary.typeStats, summary.eventTypes.length) ?? "")
    : "";
  // The heuristic only proposes a starting point: a declared case type wins
  // whenever the loaded log still has that type.
  const objectType =
    summary &&
    declaration.caseType !== "" &&
    summary.objectTypes.some((ty) => ty.name === declaration.caseType)
      ? declaration.caseType
      : preferred;
  const resolved = useMemo<Declaration>(
    () => ({ ...declaration, caseType: objectType }),
    [declaration, objectType],
  );

  const loaded = status?.loaded === true;

  useEffect(() => {
    if (loaded) {
      void refresh(offset, resolved);
    }
  }, [loaded, refresh, offset, resolved]);

  useEffect(() => {
    if (!loaded || resolved.caseType === "") {
      return;
    }
    let active = true;
    setVerifyLoading(true);
    fetchVerify(resolved)
      .then((v) => {
        if (!active) {
          return;
        }
        setVerification(v);
        setVerifyError(null);
      })
      .catch((err) => {
        if (!active) {
          return;
        }
        setVerifyError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (active) {
          setVerifyLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [loaded, resolved, summary?.modified]);

  useEffect(() => {
    const check = () => {
      fetchStatus()
        .then((next) => {
          setStatus(next);
          if (next.loaded && summary && next.modified !== summary.modified) {
            clearApiCache();
            void refresh(offset, resolved);
          }
        })
        .catch(() => setError(t.serverUnreachable));
    };
    check();
    const timer = setInterval(check, POLL_MS);
    return () => clearInterval(timer);
  }, [summary, offset, resolved, refresh, t]);

  const applySet = useCallback((set: DeclarationSet) => {
    setDeclaration({
      caseType: set.caseType,
      recipe: set.recipe,
      via: set.via,
      notVia: set.notVia,
      period: set.period
        ? { from: set.period.from ?? "", to: set.period.to ?? "" }
        : null,
    });
    setNote(set.note ?? "");
    setSelectedView(set.name);
    setCaseFilter(null);
  }, []);

  useEffect(() => {
    fetchViews()
      .then((list) => {
        setViews(list);
        const stored = loadViewName();
        if (stored === null) {
          return;
        }
        const found = list.find((v) => v.name === stored);
        if (found) {
          applySet(found);
        } else {
          saveViewName(null);
        }
      })
      .catch((err) => setViewError(err instanceof Error ? err.message : String(err)));
    fetchRecipes()
      .then((list) => setRecipes(list.map((recipe) => recipe.name)))
      .catch((err) => setViewError(err instanceof Error ? err.message : String(err)));
  }, [applySet]);

  // Any edit lands in the unnamed declaration until it is saved under a name.
  const editDeclaration = (next: Declaration) => {
    setDeclaration(next);
    setSelectedView(null);
    saveViewName(null);
    setCaseFilter(null);
  };

  const editNote = (next: string) => {
    setNote(next);
    setSelectedView(null);
    saveViewName(null);
  };

  const selectView = (name: string | null) => {
    setViewError(null);
    if (name === null) {
      setSelectedView(null);
      saveViewName(null);
      return;
    }
    const set = views.find((v) => v.name === name);
    if (set) {
      applySet(set);
      saveViewName(name);
    }
  };

  const storeView = (name: string) => {
    const period = declaration.period;
    const set: DeclarationSet = {
      name,
      caseType: objectType,
      ...(status?.path ? { baseLog: status.path } : {}),
      ...(declaration.recipe ? { recipe: declaration.recipe } : {}),
      ...(declaration.via && declaration.via.length > 0 ? { via: declaration.via } : {}),
      ...(declaration.notVia && declaration.notVia.length > 0
        ? { notVia: declaration.notVia }
        : {}),
      ...(period && (period.from !== "" || period.to !== "")
        ? {
            period: {
              ...(period.from !== "" ? { from: period.from } : {}),
              ...(period.to !== "" ? { to: period.to } : {}),
            },
          }
        : {}),
      ...(note.trim() !== "" ? { note: note.trim() } : {}),
    };
    saveView(set)
      .then((list) => {
        setViews(list);
        setSelectedView(name);
        saveViewName(name);
        setViewError(null);
      })
      .catch((err) => setViewError(err instanceof Error ? err.message : String(err)));
  };

  const removeView = () => {
    if (selectedView === null) {
      return;
    }
    deleteView(selectedView)
      .then((list) => {
        setViews(list);
        setSelectedView(null);
        saveViewName(null);
        setViewError(null);
      })
      .catch((err) => setViewError(err instanceof Error ? err.message : String(err)));
  };

  const openBaseLog = (name: string) => {
    openLog(name)
      .then((next) => {
        clearApiCache();
        setStatus(next);
        setCaseFilter(null);
        setOffset(0);
      })
      .catch((err) => setViewError(err instanceof Error ? err.message : String(err)));
  };

  const activeSet = views.find((v) => v.name === selectedView) ?? null;
  const declSummary = [
    objectType,
    declaration.recipe,
    declaration.via && declaration.via.length > 0 ? `via ${declaration.via.join(",")}` : null,
    declaration.notVia && declaration.notVia.length > 0
      ? `notVia ${declaration.notVia.join(",")}`
      : null,
    declaration.period ? `${declaration.period.from || "…"}–${declaration.period.to || "…"}` : null,
  ]
    .filter((part) => part !== null && part !== undefined && part !== "")
    .join(" · ");

  const nav: ({ key: Screen; label: string } | { header: string })[] = [
    { key: "overview", label: t.navOverview },
    { key: "workspace", label: t.navWorkspace },
    { header: t.navGroupDiscovery },
    { key: "map", label: t.navMap },
    { key: "paths", label: t.navPaths },
    { key: "cases", label: t.navCases },
    { key: "model", label: t.navModel },
    { key: "conformance", label: t.navConformance },
    { key: "data", label: t.navData },
  ];

  return (
    <>
      <header>
        <img className="logo" src="/favicon.svg" alt="" />
        <span className="brand">ocel-studio</span>
        {summary ? (
          <>
            <button
              className="file file-button"
              title={`${summary.path} — ${t.navWorkspace}`}
              onClick={() => setScreen("workspace")}
            >
              {fileName}
            </button>
            <select
              className="header-select"
              title={t.declViewLabel}
              value={selectedView ?? ""}
              onChange={(e) => selectView(e.target.value === "" ? null : e.target.value)}
            >
              <option value="">{t.declUnnamed}</option>
              {views.map((view) => (
                <option key={view.name} value={view.name}>
                  {view.name}
                </option>
              ))}
            </select>
            <span className="decl-summary" title={t.declBarTitle}>
              {declSummary}
            </span>
            <button
              title={t.declBarTitle}
              className={editing ? "toggle-on" : undefined}
              onClick={() => setEditing(!editing)}
            >
              {t.declEditLabel}
            </button>
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
      {summary && editing ? (
        <DeclarationBar
          objectTypes={summary.objectTypes}
          caseType={objectType}
          declaration={declaration}
          note={note}
          recipes={recipes}
          viewName={selectedView}
          baseLog={activeSet?.baseLog ?? null}
          logPath={status?.path ?? null}
          error={viewError}
          verification={verification}
          verifyError={verifyError}
          verifyLoading={verifyLoading}
          onChange={editDeclaration}
          onNote={editNote}
          onSave={storeView}
          onDelete={removeView}
          onOpenBaseLog={openBaseLog}
        />
      ) : null}
      {error ? <div className="error">{error}</div> : null}
      {summary && page ? (
        <div className="shell">
          <nav className="sidebar">
            {nav.map((item) =>
              "header" in item ? (
                <div key={`header:${item.header}`} className="nav-group">
                  {item.header}
                </div>
              ) : (
                <button
                  key={item.key}
                  className={screen === item.key ? "nav-item nav-active" : "nav-item"}
                  onClick={() => setScreen(item.key)}
                >
                  {item.label}
                </button>
              ),
            )}
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
                  <Insights
                    objectType={objectType}
                    declaration={resolved}
                    modified={summary.modified}
                    onNavigate={setScreen}
                  />
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
                declaration={resolved}
                modified={summary.modified}
                onShowCases={(from, to, forType) => {
                  if (forType !== objectType) {
                    editDeclaration({ ...declaration, caseType: forType });
                  }
                  setCaseFilter({ kind: "edge", from, to });
                  setScreen("cases");
                }}
              />
            ) : null}
            {screen === "paths" && objectType !== "" ? (
              <VariantsPanel
                objectType={objectType}
                declaration={resolved}
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
                declaration={resolved}
                modified={summary.modified}
                lang={lang}
                filter={caseFilter}
                onClearFilter={() => setCaseFilter(null)}
              />
            ) : null}
            {screen === "model" && objectType !== "" ? (
              <ModelPanel
                objectType={objectType}
                declaration={resolved}
                viewName={selectedView}
                modified={summary.modified}
                onShowCases={(activities) => {
                  setCaseFilter({ kind: "variant", activities });
                  setScreen("cases");
                }}
              />
            ) : null}
            {screen === "conformance" ? (
              <ConformancePanel
                declaration={resolved}
                lang={lang}
                onShowCases={(forType, activities) => {
                  if (forType !== objectType) {
                    editDeclaration({ ...declaration, caseType: forType });
                  }
                  setCaseFilter({ kind: "variant", activities });
                  setScreen("cases");
                }}
              />
            ) : null}
            {screen === "data" ? <EventsPanel page={page} lang={lang} onPage={setOffset} /> : null}
            {screen === "workspace" ? (
              <WorkspacePanel
                lang={lang}
                modified={summary.modified}
                onOpened={() => {
                  clearApiCache();
                  setCaseFilter(null);
                  setOffset(0);
                  setScreen("overview");
                  void refresh(0, resolved);
                }}
              />
            ) : null}
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
