import { useCallback, useEffect, useState } from "react";
import { graphlib, layout } from "@dagrejs/dagre";
import {
  deleteRecipe,
  deleteSource,
  fetchLogs,
  fetchRecipes,
  fetchRuns,
  fetchSources,
  joinCommandLine,
  openLog,
  previewTransform,
  runSource,
  saveRecipe,
  saveSource,
  setSecret,
  splitCommandLine,
  type EnvValue,
  type LogEntry,
  type LogsResponse,
  type Recipe,
  type RecipeStep,
  type RecipeView,
  type RunRecord,
  type SourceView,
  type TransformPreview,
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
      {listing && sources ? (
        <PipelineDag logs={listing.logs} sources={sources} onOpen={open} />
      ) : null}
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
      {listing ? (
        <RecipesSection
          logs={listing.logs}
          activeLog={listing.logs.find((log) => log.active)?.name ?? null}
          onSourcesChanged={act}
        />
      ) : null}
    </>
  );
}

// --- pipeline DAG ------------------------------------------------------------

/// The workspace as a pipeline: sources and recipes are the transforms,
/// files are the edges between them. Only sources carrying input/output
/// metadata contribute edges; plain files still show as standalone nodes.
function PipelineDag({
  logs,
  sources,
  onOpen,
}: {
  logs: LogEntry[];
  sources: SourceView[];
  onOpen: (name: string) => void;
}) {
  const t = useMessages();
  const files = new Set<string>(logs.map((l) => l.name));
  for (const s of sources) {
    if (s.input) {
      files.add(s.input);
    }
    if (s.output) {
      files.add(s.output);
    }
  }
  if (sources.length === 0 && files.size === 0) {
    return null;
  }

  const g = new graphlib.Graph();
  g.setGraph({ rankdir: "LR", nodesep: 14, ranksep: 46, marginx: 12, marginy: 12 });
  g.setDefaultEdgeLabel(() => ({}));
  const width = (text: string) => Math.max(70, text.length * 7.2 + 28);
  for (const name of files) {
    g.setNode(`f:${name}`, { width: width(name), height: 30 });
  }
  for (const s of sources) {
    g.setNode(`s:${s.name}`, { width: width(s.name), height: 30 });
    if (s.input) {
      g.setEdge(`f:${s.input}`, `s:${s.name}`);
    }
    if (s.output) {
      g.setEdge(`s:${s.name}`, `f:${s.output}`);
    }
  }
  layout(g);
  const graph = g.graph() as { width?: number; height?: number };
  const w = Math.max(graph.width ?? 0, 60);
  const h = Math.max(graph.height ?? 0, 40);

  const runColor = (s: SourceView) =>
    s.run === null
      ? "var(--muted)"
      : s.run.state === "running"
        ? "var(--accent)"
        : s.run.state === "succeeded"
          ? "var(--status-good)"
          : "var(--status-serious)";

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>{t.pipelinePanel}</h2>
      </div>
      <p className="muted guide">{t.pipelineHint}</p>
      <div className="flow-scroll">
        <svg className="dag-svg" width={w} height={h} viewBox={`0 0 ${w} ${h}`}>
          <defs>
            <marker
              id="dag-arrow"
              viewBox="0 0 8 8"
              refX="7"
              refY="4"
              markerWidth="7"
              markerHeight="7"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 8 4 L 0 8 z" fill="var(--muted)" />
            </marker>
          </defs>
          {g.edges().map((e) => {
            const points = (g.edge(e) as { points: { x: number; y: number }[] }).points;
            const d = points
              .map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`)
              .join(" ");
            return (
              <path
                key={`${e.v}->${e.w}`}
                d={d}
                fill="none"
                stroke="var(--muted)"
                strokeWidth={1.2}
                markerEnd="url(#dag-arrow)"
              />
            );
          })}
          {g.nodes().map((id) => {
            const node = g.node(id) as { x: number; y: number; width: number; height: number };
            const name = id.slice(2);
            const isFile = id.startsWith("f:");
            const missing = isFile && !logs.some((l) => l.name === name);
            const source = sources.find((s) => s.name === name);
            return (
              <g
                key={id}
                transform={`translate(${node.x - node.width / 2}, ${node.y - node.height / 2})`}
                className={isFile && !missing ? "dag-node dag-file" : "dag-node"}
                onClick={isFile && !missing ? () => onOpen(name) : undefined}
              >
                <rect
                  width={node.width}
                  height={node.height}
                  rx={isFile ? 14 : 4}
                  className={isFile ? "dag-file-rect" : "dag-source-rect"}
                  style={missing ? { strokeDasharray: "4 3" } : undefined}
                />
                {!isFile && source ? (
                  <circle cx={12} cy={node.height / 2} r={4} fill={runColor(source)} />
                ) : null}
                <text
                  x={isFile ? node.width / 2 : node.width / 2 + 6}
                  y={node.height / 2 + 4}
                  textAnchor="middle"
                  className="dag-label"
                >
                  {name}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}

// --- transform recipes -------------------------------------------------------

type StepKind =
  | "dropEventTypes"
  | "keepEventTypes"
  | "dropEventsWhere"
  | "renameEventTypes"
  | "timeWindow"
  | "keepObjectTypes"
  | "mapObjectIds"
  | "dropObjectsWithoutEvents";

const STEP_KINDS: StepKind[] = [
  "dropEventTypes",
  "keepEventTypes",
  "dropEventsWhere",
  "renameEventTypes",
  "timeWindow",
  "keepObjectTypes",
  "mapObjectIds",
  "dropObjectsWithoutEvents",
];

function stepKind(step: RecipeStep): StepKind {
  if (typeof step === "string") {
    return step;
  }
  return Object.keys(step)[0] as StepKind;
}

function emptyStep(kind: StepKind): RecipeStep {
  switch (kind) {
    case "dropEventTypes":
      return { dropEventTypes: [] };
    case "keepEventTypes":
      return { keepEventTypes: [] };
    case "dropEventsWhere":
      return { dropEventsWhere: {} };
    case "renameEventTypes":
      return { renameEventTypes: {} };
    case "timeWindow":
      return { timeWindow: {} };
    case "keepObjectTypes":
      return { keepObjectTypes: [] };
    case "mapObjectIds":
      return { mapObjectIds: { aliases: {} } };
    case "dropObjectsWithoutEvents":
      return "dropObjectsWithoutEvents";
  }
}

const splitList = (raw: string): string[] =>
  raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");

/// "old=new" pairs, comma separated.
const splitRenames = (raw: string): Record<string, string> => {
  const renames: Record<string, string> = {};
  for (const pair of splitList(raw)) {
    const eq = pair.indexOf("=");
    if (eq > 0) {
      renames[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
    }
  }
  return renames;
};

function StepEditor({
  step,
  onChange,
  onRemove,
}: {
  step: RecipeStep;
  onChange: (next: RecipeStep) => void;
  onRemove: () => void;
}) {
  const t = useMessages();
  const kind = stepKind(step);
  return (
    <div className="step-row">
      <select
        value={kind}
        onChange={(e) => onChange(emptyStep(e.target.value as StepKind))}
      >
        {STEP_KINDS.map((k) => (
          <option key={k} value={k}>
            {t.stepNames[k]}
          </option>
        ))}
      </select>
      {kind === "dropEventTypes" || kind === "keepEventTypes" || kind === "keepObjectTypes" ? (
        <input
          type="text"
          className="step-wide"
          placeholder={t.stepTypesPlaceholder}
          defaultValue={(Object.values(step)[0] as string[]).join(", ")}
          onBlur={(e) => onChange({ [kind]: splitList(e.target.value) } as RecipeStep)}
        />
      ) : kind === "renameEventTypes" ? (
        <input
          type="text"
          className="step-wide"
          placeholder={t.stepRenamePlaceholder}
          defaultValue={Object.entries((step as { renameEventTypes: Record<string, string> }).renameEventTypes)
            .map(([from, to]) => `${from}=${to}`)
            .join(", ")}
          onBlur={(e) => onChange({ renameEventTypes: splitRenames(e.target.value) })}
        />
      ) : kind === "mapObjectIds" ? (
        <input
          type="text"
          className="step-wide"
          placeholder={t.stepAliasPlaceholder}
          defaultValue={Object.entries(
            (step as { mapObjectIds: { aliases: Record<string, string> } }).mapObjectIds.aliases,
          )
            .map(([from, to]) => `${from}=${to}`)
            .join(", ")}
          onBlur={(e) => onChange({ mapObjectIds: { aliases: splitRenames(e.target.value) } })}
        />
      ) : kind === "timeWindow" ? (
        (() => {
          const window = (step as { timeWindow: { from?: string; to?: string } }).timeWindow;
          return (
            <>
              <input
                type="date"
                value={window.from ?? ""}
                onChange={(e) =>
                  onChange({ timeWindow: { ...window, from: e.target.value || undefined } })
                }
              />
              <input
                type="date"
                value={window.to ?? ""}
                onChange={(e) =>
                  onChange({ timeWindow: { ...window, to: e.target.value || undefined } })
                }
              />
            </>
          );
        })()
      ) : kind === "dropEventsWhere" ? (
        (() => {
          const p = (step as { dropEventsWhere: Record<string, string | number | undefined> })
            .dropEventsWhere;
          const set = (key: string, value: string) =>
            onChange({
              dropEventsWhere: { ...p, [key]: value === "" ? undefined : value },
            } as RecipeStep);
          return (
            <>
              <input
                type="text"
                placeholder={t.predEventType}
                defaultValue={(p.eventType as string) ?? ""}
                onBlur={(e) => set("eventType", e.target.value)}
              />
              <input
                type="text"
                placeholder={t.predAttr}
                defaultValue={(p.attr as string) ?? ""}
                onBlur={(e) => set("attr", e.target.value)}
              />
              <input
                type="text"
                className="step-wide"
                placeholder={t.predMatches}
                defaultValue={(p.matches as string) ?? ""}
                onBlur={(e) => set("matches", e.target.value)}
              />
            </>
          );
        })()
      ) : null}
      <button className="link-button" onClick={onRemove}>
        ×
      </button>
    </div>
  );
}

function stepSummary(step: RecipeStep): string {
  const kind = stepKind(step);
  if (typeof step === "string") {
    return kind;
  }
  const value = Object.values(step)[0];
  if (Array.isArray(value)) {
    return `${kind} (${value.length})`;
  }
  if (kind === "renameEventTypes") {
    return `${kind} (${Object.keys(value as object).length})`;
  }
  if (kind === "mapObjectIds") {
    return `${kind} (${Object.keys((value as { aliases: object }).aliases).length})`;
  }
  return kind;
}

function RecipesSection({
  logs,
  activeLog,
  onSourcesChanged,
}: {
  logs: LogEntry[];
  activeLog: string | null;
  onSourcesChanged: (request: Promise<SourceView[]>) => void;
}) {
  const t = useMessages();
  const [recipes, setRecipes] = useState<RecipeView[] | null>(null);
  const [editing, setEditing] = useState<Recipe | null>(null);
  const [preview, setPreview] = useState<TransformPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sourcify, setSourcify] = useState<{ recipe: RecipeView; input: string; output: string } | null>(null);

  const refresh = useCallback(() => {
    fetchRecipes()
      .then((next) => {
        setRecipes(next);
        setError(null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const act = (request: Promise<RecipeView[]>) => {
    request
      .then((next) => {
        setRecipes(next);
        setError(null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  };

  const runPreview = (recipe: Recipe) => {
    setPreviewing(true);
    previewTransform(recipe)
      .then((result) => {
        setPreview(result);
        setError(null);
        setPreviewing(false);
      })
      .catch((err) => {
        setPreview(null);
        setPreviewing(false);
        setError(err instanceof Error ? err.message : String(err));
      });
  };

  const registerSource = () => {
    if (!sourcify) {
      return;
    }
    const { recipe, input, output } = sourcify;
    onSourcesChanged(
      saveSource(
        recipe.name,
        "ocel-transform",
        ["--in", input, "--recipe", recipe.file, "--out", output],
        undefined,
        { input, output },
      ),
    );
    setSourcify(null);
  };

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>{t.recipesPanel}</h2>
      </div>
      <p className="muted guide">{t.recipesHint}</p>
      {error ? <div className="error">{error}</div> : null}
      {recipes === null ? (
        <div className="loading">{t.loading}</div>
      ) : recipes.length > 0 ? (
        <table>
          <thead>
            <tr>
              <th>{t.srcNameCol}</th>
              <th>{t.recipeStepsCol}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {recipes.map((recipe) => (
              <tr key={recipe.name}>
                <td className="mono">{recipe.name}</td>
                <td className="muted">{recipe.steps.map(stepSummary).join(" → ")}</td>
                <td className="num">
                  <button
                    className="link-button"
                    onClick={() => {
                      setEditing({ name: recipe.name, steps: recipe.steps });
                      setPreview(null);
                    }}
                  >
                    {t.recipeEditLabel}
                  </button>{" "}
                  <button
                    className="link-button"
                    onClick={() =>
                      setSourcify({
                        recipe,
                        input: activeLog ?? logs[0]?.name ?? "",
                        output: `${(activeLog ?? "log").replace(/\.[^.]+$/, "")}.${recipe.name}.sqlite`,
                      })
                    }
                  >
                    {t.recipeSourceLabel}
                  </button>{" "}
                  <button className="link-button" onClick={() => act(deleteRecipe(recipe.name))}>
                    {t.srcDeleteLabel}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="muted">{t.recipesEmpty}</p>
      )}
      {sourcify ? (
        <div className="source-form">
          <span className="mono">{sourcify.recipe.name}</span>
          <select
            value={sourcify.input}
            onChange={(e) => setSourcify({ ...sourcify, input: e.target.value })}
          >
            {logs.map((log) => (
              <option key={log.name} value={log.name}>
                {log.name}
              </option>
            ))}
          </select>
          <span className="muted">→</span>
          <input
            type="text"
            className="source-command-input"
            value={sourcify.output}
            onChange={(e) => setSourcify({ ...sourcify, output: e.target.value })}
          />
          <button
            className="rerun-button"
            disabled={sourcify.input === "" || sourcify.output.trim() === ""}
            onClick={registerSource}
          >
            {t.recipeRegisterLabel}
          </button>
          <button className="link-button" onClick={() => setSourcify(null)}>
            {t.closeLabel}
          </button>
        </div>
      ) : null}
      {editing === null ? (
        <button
          className="rerun-button"
          onClick={() => {
            setEditing({ name: "", steps: [] });
            setPreview(null);
          }}
        >
          {t.recipeNewLabel}
        </button>
      ) : (
        <div className="recipe-editor">
          <div className="source-form">
            <input
              type="text"
              placeholder={t.srcNamePlaceholder}
              value={editing.name}
              onChange={(e) => setEditing({ ...editing, name: e.target.value })}
            />
            <button
              className="link-button"
              onClick={() =>
                setEditing({ ...editing, steps: [...editing.steps, emptyStep("dropEventTypes")] })
              }
            >
              {t.recipeAddStep}
            </button>
          </div>
          {editing.steps.map((step, index) => (
            <StepEditor
              // eslint-disable-next-line react/no-array-index-key
              key={`${stepKind(step)}-${index}`}
              step={step}
              onChange={(next) => {
                const steps = [...editing.steps];
                steps[index] = next;
                setEditing({ ...editing, steps });
              }}
              onRemove={() =>
                setEditing({ ...editing, steps: editing.steps.filter((_, i) => i !== index) })
              }
            />
          ))}
          <div className="source-form">
            <button
              className="rerun-button"
              disabled={previewing || editing.steps.length === 0}
              onClick={() => runPreview(editing)}
            >
              {previewing ? t.loading : t.recipePreviewLabel}
            </button>
            <button
              className="rerun-button"
              disabled={editing.name.trim() === "" || editing.steps.length === 0}
              onClick={() => {
                act(saveRecipe(editing));
                setEditing(null);
              }}
            >
              {t.recipeSaveLabel}
            </button>
            <button
              className="link-button"
              onClick={() => {
                setEditing(null);
                setPreview(null);
              }}
            >
              {t.closeLabel}
            </button>
          </div>
          <p className="muted guide">{t.recipePreviewNote}</p>
        </div>
      )}
      {preview ? (
        <div className="recipe-preview">
          <table>
            <thead>
              <tr>
                <th>{t.recipeStepCol}</th>
                <th className="num">{t.events}</th>
                <th className="num">{t.objects}</th>
                <th className="num">{t.recipeDroppedCol}</th>
              </tr>
            </thead>
            <tbody>
              {preview.steps.map((step, index) => (
                <tr key={`${step.step}-${index}`}>
                  <td className="mono">{step.step}</td>
                  <td className="num">
                    {step.eventsBefore.toLocaleString()} → {step.eventsAfter.toLocaleString()}
                  </td>
                  <td className="num">
                    {step.objectsBefore.toLocaleString()} → {step.objectsAfter.toLocaleString()}
                  </td>
                  <td className="num">{step.droppedTotal.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {preview.steps
            .filter((step) => step.droppedEvents.length > 0)
            .map((step, index) => (
              <details key={`${step.step}-drop-${index}`} className="misfits">
                <summary>{t.recipeDroppedHeader(step.step, step.droppedTotal.toLocaleString())}</summary>
                <table>
                  <tbody>
                    {step.droppedEvents.map((event) => (
                      <tr key={event.id}>
                        <td className="mono">{event.eventType}</td>
                        <td>{new Date(event.time).toLocaleString()}</td>
                        <td className="dropped-attrs">
                          {event.attributes.map(([name, value]) => `${name}: ${value}`).join(" · ")}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </details>
            ))}
        </div>
      ) : null}
    </div>
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
