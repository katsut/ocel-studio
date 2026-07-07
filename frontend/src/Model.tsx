import { useEffect, useState } from "react";
import { graphlib, layout } from "@dagrejs/dagre";
import {
  DEFAULT_MODEL_PARAMS,
  fetchModel,
  registerModel,
  type Algo,
  type HeuristicEdge,
  type HeuristicsNet,
  type ModelParams,
  type ModelResult,
  type PetriNet,
  type PowlModel,
  type PrecisionReport,
  type ProcessTree,
  type Range,
  type ReplayReport,
} from "./api.ts";
import { useMessages, type Messages } from "./i18n.tsx";

const OPERATOR: Record<string, string> = {
  sequence: "→",
  exclusive: "✕",
  parallel: "＋",
  loop: "↺",
};

const NODE_H = 40;
const CHAR_W = 7.5;

function TreeNode({ tree }: { tree: ProcessTree }) {
  const t = useMessages();
  if (tree.type === "activity") {
    return <span className="tree-activity">{tree.label}</span>;
  }
  if (tree.type === "tau") {
    return (
      <span className="tree-tau" title={t.opTau}>
        τ
      </span>
    );
  }
  const horizontal = tree.type === "sequence";
  const opTitle: Record<string, string> = {
    sequence: t.opSequence,
    exclusive: t.opExclusive,
    parallel: t.opParallel,
    loop: t.opLoop,
  };
  return (
    <span className={`tree-group tree-${tree.type}`}>
      <span className="tree-op" title={opTitle[tree.type]}>
        {OPERATOR[tree.type]}
      </span>
      <span className={horizontal ? "tree-row" : "tree-col"}>
        {tree.children.map((child, i) => (
          <TreeNode key={i} tree={child} />
        ))}
      </span>
    </span>
  );
}

/// Topological order of partial-order children (stable for ties).
function topoOrder(count: number, order: [number, number][]): number[] {
  const indegree = new Array<number>(count).fill(0);
  for (const [, j] of order) {
    indegree[j] += 1;
  }
  const result: number[] = [];
  const ready: number[] = [];
  for (let i = 0; i < count; i += 1) {
    if (indegree[i] === 0) {
      ready.push(i);
    }
  }
  while (ready.length > 0) {
    const next = ready.shift();
    if (next === undefined) {
      break;
    }
    result.push(next);
    for (const [i, j] of order) {
      if (i === next) {
        indegree[j] -= 1;
        if (indegree[j] === 0) {
          ready.push(j);
        }
      }
    }
  }
  return result.length === count ? result : Array.from({ length: count }, (_, i) => i);
}

/// Are all child pairs comparable (a total order)? Then no badges needed.
function isTotalOrder(count: number, order: [number, number][]): boolean {
  const before: boolean[][] = Array.from({ length: count }, () =>
    new Array<boolean>(count).fill(false),
  );
  for (const [i, j] of order) {
    before[i][j] = true;
  }
  for (let k = 0; k < count; k += 1) {
    for (let i = 0; i < count; i += 1) {
      if (before[i][k]) {
        for (let j = 0; j < count; j += 1) {
          if (before[k][j]) {
            before[i][j] = true;
          }
        }
      }
    }
  }
  for (let i = 0; i < count; i += 1) {
    for (let j = i + 1; j < count; j += 1) {
      if (!before[i][j] && !before[j][i]) {
        return false;
      }
    }
  }
  return true;
}

function PowlNode({ model }: { model: PowlModel }) {
  const t = useMessages();
  if (model.type === "activity") {
    return <span className="tree-activity">{model.label}</span>;
  }
  if (model.type === "tau") {
    return (
      <span className="tree-tau" title={t.opTau}>
        τ
      </span>
    );
  }
  if (model.type === "exclusive" || model.type === "loop") {
    return (
      <span className={`tree-group tree-${model.type}`}>
        <span className="tree-op" title={model.type === "exclusive" ? t.opExclusive : t.opLoop}>
          {OPERATOR[model.type]}
        </span>
        <span className="tree-col">
          {model.children.map((child, i) => (
            <PowlNode key={i} model={child} />
          ))}
        </span>
      </span>
    );
  }
  const topo = topoOrder(model.children.length, model.order);
  const total = isTotalOrder(model.children.length, model.order);
  return (
    <span className="tree-group tree-sequence">
      <span className="tree-op" title={t.opPartialOrder}>
        ≺
      </span>
      <span className="tree-row">
        {topo.map((index) => (
          <span key={index} className="powl-child">
            {total ? null : <span className="powl-badge">{index + 1}</span>}
            <PowlNode model={model.children[index]} />
          </span>
        ))}
      </span>
      {total || model.order.length === 0 ? null : (
        <span className="powl-order">
          {model.order.map(([i, j]) => `${i + 1}≺${j + 1}`).join("・")}
        </span>
      )}
    </span>
  );
}

interface Laid {
  width: number;
  height: number;
  nodes: { id: string; x: number; y: number; width: number; height: number }[];
  edges: { key: string; d: string; x?: number; y?: number }[];
}

function selfLoopPath(x: number, y: number): string {
  return `M ${x - 9},${y} C ${x - 26},${y - 46} ${x + 26},${y - 46} ${x + 9},${y}`;
}

/// Shared dagre left-to-right layout for the graph-shaped model views.
function lay(
  nodes: { id: string; width: number; height: number }[],
  edges: { from: string; to: string; label: boolean }[],
): Laid {
  const g = new graphlib.Graph();
  g.setGraph({ rankdir: "LR", nodesep: 30, ranksep: 80, marginx: 20, marginy: 46 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const node of nodes) {
    g.setNode(node.id, { width: node.width, height: node.height });
  }
  for (const edge of edges) {
    if (edge.from !== edge.to) {
      g.setEdge(edge.from, edge.to, edge.label ? { width: 80, height: 26, labelpos: "c" } : {});
    }
  }
  layout(g);
  const laidNodes = g.nodes().map((id) => {
    const n = g.node(id);
    return { id, x: n.x - n.width / 2, y: n.y - n.height / 2, width: n.width, height: n.height };
  });
  const laidEdges = g.edges().map((ref) => {
    const e = g.edge(ref);
    const d = e.points
      .map((p: { x: number; y: number }, i: number) => `${i === 0 ? "M" : "L"} ${p.x},${p.y}`)
      .join(" ");
    return { key: `${ref.v}→${ref.w}`, d, x: e.x, y: e.y };
  });
  const graph = g.graph();
  return {
    width: Math.max(graph.width ?? 0, 400) + 40,
    height: graph.height ?? 0,
    nodes: laidNodes,
    edges: laidEdges,
  };
}

function HeuristicsView({ net, t }: { net: HeuristicsNet; t: Messages }) {
  const laid = lay(
    net.activities.map((a) => ({
      id: a.activity,
      width: Math.max(90, a.activity.length * CHAR_W + 28),
      height: NODE_H,
    })),
    net.edges.map((e) => ({ from: e.from, to: e.to, label: true })),
  );
  const byKey = new Map<string, HeuristicEdge>(net.edges.map((e) => [`${e.from}→${e.to}`, e]));
  const maxFreq = Math.max(1, ...net.edges.map((e) => e.frequency));
  const nodeOf = new Map(laid.nodes.map((n) => [n.id, n]));
  const loops = net.edges.filter((e) => e.from === e.to);

  return (
    <svg className="flow" width={laid.width} height={laid.height} viewBox={`0 0 ${laid.width} ${laid.height}`}>
      <defs>
        <marker
          id="dep-arrow"
          viewBox="0 0 8 8"
          refX="7"
          refY="4"
          markerWidth="9"
          markerHeight="9"
          markerUnits="userSpaceOnUse"
          orient="auto-start-reverse"
        >
          <path d="M 0 0 L 8 4 L 0 8 z" className="flow-arrow" />
        </marker>
      </defs>
      {laid.edges.map((edge) => {
        const data = byKey.get(edge.key);
        return (
          <g key={edge.key} className="flow-hover">
            <path
              className="flow-edge"
              d={edge.d}
              strokeWidth={data ? 1 + 3.5 * (data.frequency / maxFreq) : 1}
              markerEnd="url(#dep-arrow)"
            />
            {data ? <path className="flow-edge-hit" d={edge.d} /> : null}
            {data && edge.x !== undefined && edge.y !== undefined ? (
              <text className="flow-edge-label" x={edge.x} y={edge.y}>
                <tspan x={edge.x} dy={-3}>
                  {t.timesLabel(data.frequency.toLocaleString())}
                </tspan>
                <tspan x={edge.x} dy={12}>
                  {t.depLabel(data.dependency.toFixed(2))}
                </tspan>
              </text>
            ) : null}
          </g>
        );
      })}
      {loops.map((loop) => {
        const node = nodeOf.get(loop.from);
        if (!node) {
          return null;
        }
        const cx = node.x + node.width / 2;
        return (
          <g key={`${loop.from}⟲`} className="flow-hover">
            <path
              className="flow-edge"
              d={selfLoopPath(cx, node.y)}
              strokeWidth={1 + 3.5 * (loop.frequency / maxFreq)}
              markerEnd="url(#dep-arrow)"
            />
            <text className="flow-edge-label" x={cx} y={node.y - 38}>
              {t.timesLabel(loop.frequency.toLocaleString())}
            </text>
          </g>
        );
      })}
      {laid.nodes.map((node) => {
        const data = net.activities.find((a) => a.activity === node.id);
        return (
          <g key={node.id}>
            <rect
              className="flow-node"
              x={node.x}
              y={node.y}
              width={node.width}
              height={node.height}
              rx={9}
            />
            <text className="flow-node-label" x={node.x + node.width / 2} y={node.y + 17}>
              {node.id}
            </text>
            <text className="flow-node-count" x={node.x + node.width / 2} y={node.y + 31}>
              {data?.frequency.toLocaleString() ?? ""}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

function PetriView({ net }: { net: PetriNet }) {
  const nodes = [
    ...net.transitions.map((name) => ({
      id: `t:${name}`,
      width: Math.max(90, name.length * CHAR_W + 28),
      height: NODE_H,
    })),
    ...net.places.map((p) => ({ id: `p:${p.id}`, width: 26, height: 26 })),
  ];
  const edges = net.places.flatMap((p) => [
    ...p.inputs.map((from) => ({ from: `t:${from}`, to: `p:${p.id}`, label: false })),
    ...p.outputs.map((to) => ({ from: `p:${p.id}`, to: `t:${to}`, label: false })),
  ]);
  const laid = lay(nodes, edges);
  const placeOf = new Map(net.places.map((p) => [`p:${p.id}`, p]));

  return (
    <svg className="flow" width={laid.width} height={laid.height} viewBox={`0 0 ${laid.width} ${laid.height}`}>
      <defs>
        <marker
          id="petri-arrow"
          viewBox="0 0 8 8"
          refX="7"
          refY="4"
          markerWidth="9"
          markerHeight="9"
          markerUnits="userSpaceOnUse"
          orient="auto-start-reverse"
        >
          <path d="M 0 0 L 8 4 L 0 8 z" className="flow-arrow" />
        </marker>
      </defs>
      {laid.edges.map((edge) => (
        <path
          key={edge.key}
          className="flow-edge"
          d={edge.d}
          strokeWidth={1.4}
          markerEnd="url(#petri-arrow)"
        />
      ))}
      {laid.nodes.map((node) => {
        const place = placeOf.get(node.id);
        if (place) {
          const source = place.inputs.length === 0;
          const sink = place.outputs.length === 0;
          const cx = node.x + node.width / 2;
          const cy = node.y + node.height / 2;
          return (
            <g key={node.id}>
              <circle className="petri-place" cx={cx} cy={cy} r={13} />
              {source ? <circle className="flow-start" cx={cx} cy={cy} r={6} /> : null}
              {sink ? <circle className="flow-end" cx={cx} cy={cy} r={6} /> : null}
            </g>
          );
        }
        const name = node.id.slice(2);
        return (
          <g key={node.id}>
            <rect
              className="flow-node"
              x={node.x}
              y={node.y}
              width={node.width}
              height={node.height}
              rx={4}
            />
            <text className="flow-node-label" x={node.x + node.width / 2} y={node.y + 24}>
              {name}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

const MISFIT_ROWS = 5;

interface Simplicity {
  activities: number;
  operators: number;
  flower: boolean;
}

function countActivities(tree: ProcessTree): number {
  if (tree.type === "activity") {
    return 1;
  }
  if (tree.type === "tau") {
    return 0;
  }
  return tree.children.reduce((sum, child) => sum + countActivities(child), 0);
}

/// Size of the structure, plus whether it contains a flower part: a loop
/// with a silent body over 3+ activities replays anything — the exact case
/// the fitness note warns about.
function measureSimplicity(tree: ProcessTree): Simplicity {
  if (tree.type === "activity" || tree.type === "tau") {
    return { activities: countActivities(tree), operators: 0, flower: false };
  }
  const flowerHere =
    tree.type === "loop" &&
    tree.children[0]?.type === "tau" &&
    tree.children.slice(1).reduce((sum, child) => sum + countActivities(child), 0) >= 3;
  return tree.children.reduce(
    (acc, child) => {
      const sub = measureSimplicity(child);
      return {
        activities: acc.activities + sub.activities,
        operators: acc.operators + sub.operators,
        flower: acc.flower || sub.flower,
      };
    },
    { activities: 0, operators: 1, flower: flowerHere },
  );
}

function SimplicityLine({ tree }: { tree: ProcessTree }) {
  const t = useMessages();
  const s = measureSimplicity(tree);
  return (
    <p className="muted">
      {t.simplicityLine(s.activities.toLocaleString(), s.operators.toLocaleString())}
      {s.flower ? <span className="flower-warn"> ⚠ {t.flowerBadge}</span> : null}
    </p>
  );
}

export function FitnessStrip({
  replay,
  precision,
  onShowCases,
}: {
  replay: ReplayReport;
  precision: PrecisionReport;
  onShowCases: (activities: string[]) => void;
}) {
  const t = useMessages();
  const misfitTraces = replay.traces - replay.fitting;
  const pct = replay.traces > 0 ? ((replay.fitting / replay.traces) * 100).toFixed(1) : "0";
  return (
    <div className="fitness">
      <p className="fitness-line">
        {replay.fitting === replay.traces
          ? t.fitnessAllFit
          : t.fitnessLine(
              replay.fitting.toLocaleString(),
              replay.traces.toLocaleString(),
              pct,
            )}
      </p>
      <p className="fitness-line" title={t.precisionHint}>
        {t.precisionLine((precision.precision * 100).toFixed(1))}
      </p>
      {replay.misfits.length > 0 ? (
        <details className="misfits">
          <summary>{t.misfitHeader(misfitTraces.toLocaleString())}</summary>
          <p className="muted guide">{t.misfitHint}</p>
          <table>
            <tbody>
              {replay.misfits.slice(0, MISFIT_ROWS).map((misfit) => (
                <tr
                  key={misfit.activities.join("")}
                  className="row-link"
                  onClick={() => onShowCases(misfit.activities)}
                >
                  <td className="num">{misfit.count.toLocaleString()}</td>
                  <td>{misfit.activities.join(" → ")}</td>
                  <td className="num">
                    <span className="link-button">{t.showCases} →</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {replay.misfits.length > MISFIT_ROWS ? (
            <p className="muted">
              {t.moreVariants(MISFIT_ROWS, replay.misfits.length)}
            </p>
          ) : null}
        </details>
      ) : null}
    </div>
  );
}

export default function ModelPanel({
  objectType,
  range,
  modified,
  onShowCases,
}: {
  objectType: string;
  range: Range | null;
  modified: string;
  onShowCases: (activities: string[]) => void;
}) {
  const t = useMessages();
  const [staged, setStaged] = useState<ModelParams>(DEFAULT_MODEL_PARAMS);
  const [applied, setApplied] = useState<ModelParams>(DEFAULT_MODEL_PARAMS);
  const [model, setModel] = useState<{ forType: string; result: ModelResult } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [regOpen, setRegOpen] = useState(false);
  const [regName, setRegName] = useState("");
  const [regNote, setRegNote] = useState("");
  const [regBusy, setRegBusy] = useState(false);
  const [regDone, setRegDone] = useState<string | null>(null);
  const [regError, setRegError] = useState<string | null>(null);

  useEffect(() => {
    if (objectType === "") {
      return;
    }
    fetchModel(objectType, applied, range)
      .then((result) => {
        setModel({ forType: objectType, result });
        setError(null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [objectType, applied, range, modified]);

  const switchAlgo = (algo: Algo) => {
    const next = { ...staged, algo };
    setStaged(next);
    setApplied(next);
  };

  const dirty =
    staged.algo === "inductive" || staged.algo === "powl"
      ? staged.noise !== applied.noise
      : staged.algo === "heuristics"
        ? staged.dependency !== applied.dependency || staged.minEdge !== applied.minEdge
        : false;

  const descriptions: Record<Algo, string> = {
    inductive: t.algoInductiveDesc,
    powl: t.algoPowlDesc,
    heuristics: t.algoHeuristicsDesc,
    alpha: t.algoAlphaDesc,
  };
  const hints: Record<Algo, string> = {
    inductive: t.modelHintInductive,
    powl: t.modelHintPowl,
    heuristics: t.modelHintHeuristics,
    alpha: t.modelHintAlpha,
  };

  const result = model && model.forType === objectType ? model.result : null;

  // Registration freezes the applied params plus the current header range as
  // the agreed scope — the server re-mines exactly that and stores the model.
  const submitRegister = () => {
    const name = regName.trim();
    setRegBusy(true);
    setRegError(null);
    registerModel({
      name,
      note: regNote.trim(),
      objectType,
      algo: applied.algo,
      params:
        applied.algo === "inductive" || applied.algo === "powl" ? { noise: applied.noise } : {},
      scope: {
        ...(range?.from ? { from: range.from } : {}),
        ...(range?.to ? { to: range.to } : {}),
      },
    })
      .then(() => {
        setRegDone(t.registerDone(name));
        setRegOpen(false);
        setRegName("");
        setRegNote("");
      })
      .catch((err) => setRegError(err instanceof Error ? err.message : String(err)))
      .finally(() => setRegBusy(false));
  };

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>{t.modelPanel}</h2>
        <span className="panel-controls">
          <span className="algo-switch" role="tablist" aria-label={t.algoLabel}>
            {(["inductive", "powl", "heuristics", "alpha"] as Algo[]).map((algo) => (
              <button
                key={algo}
                role="tab"
                aria-selected={applied.algo === algo}
                className={applied.algo === algo ? "algo-tab active" : "algo-tab"}
                onClick={() => switchAlgo(algo)}
              >
                {algo === "inductive"
                  ? t.algoInductive
                  : algo === "powl"
                    ? t.algoPowl
                    : algo === "heuristics"
                      ? t.algoHeuristics
                      : t.algoAlpha}
              </button>
            ))}
          </span>
        </span>
      </div>
      <p className="muted guide">{descriptions[applied.algo]}</p>
      <div className="model-params">
        {applied.algo === "inductive" || applied.algo === "powl" ? (
          <label title={t.paramNoiseHint}>
            {t.paramNoise}{" "}
            <input
              type="range"
              min={0}
              max={50}
              step={5}
              value={Math.round(staged.noise * 100)}
              onChange={(e) => setStaged({ ...staged, noise: Number(e.target.value) / 100 })}
            />{" "}
            <span className="param-value">{Math.round(staged.noise * 100)}%</span>
          </label>
        ) : applied.algo === "heuristics" ? (
          <>
            <label title={t.paramDependencyHint}>
              {t.paramDependency}{" "}
              <input
                type="range"
                min={50}
                max={99}
                step={1}
                value={Math.round(staged.dependency * 100)}
                onChange={(e) =>
                  setStaged({ ...staged, dependency: Number(e.target.value) / 100 })
                }
              />{" "}
              <span className="param-value">{staged.dependency.toFixed(2)}</span>
            </label>
            <label>
              {t.paramMinEdge}{" "}
              <input
                type="number"
                min={1}
                className="param-number"
                value={staged.minEdge}
                onChange={(e) =>
                  setStaged({ ...staged, minEdge: Math.max(1, Number(e.target.value) || 1) })
                }
              />
            </label>
          </>
        ) : null}
        {applied.algo !== "alpha" ? (
          <button className="rerun-button" disabled={!dirty} onClick={() => setApplied(staged)}>
            {t.rerunLabel}
          </button>
        ) : null}
        {applied.algo !== "heuristics" ? (
          <button
            className="rerun-button"
            disabled={result === null || regBusy}
            onClick={() => {
              setRegOpen((open) => !open);
              setRegDone(null);
              setRegError(null);
            }}
          >
            {t.registerLabel}
          </button>
        ) : null}
      </div>
      {regOpen && applied.algo !== "heuristics" ? (
        <>
          <p className="muted guide">{t.registerHint}</p>
          <div className="source-form">
            <input
              placeholder={t.registerNamePlaceholder}
              value={regName}
              onChange={(e) => setRegName(e.target.value)}
            />
            <input
              placeholder={t.registerNotePlaceholder}
              size={40}
              value={regNote}
              onChange={(e) => setRegNote(e.target.value)}
            />
            <button
              className="rerun-button"
              disabled={regBusy || regName.trim() === ""}
              onClick={submitRegister}
            >
              {t.registerLabel}
            </button>
            <button className="link-button" onClick={() => setRegOpen(false)}>
              {t.closeLabel}
            </button>
          </div>
        </>
      ) : null}
      {regDone ? <p className="meta-ok">✓ {regDone}</p> : null}
      {regError ? <div className="error">{regError}</div> : null}
      {error ? <div className="error">{error}</div> : null}
      {result ? (
        result.algo === "inductive" ? (
          <>
            <FitnessStrip
              replay={result.replay}
              precision={result.precision}
              onShowCases={onShowCases}
            />
            <SimplicityLine tree={result.tree} />
            <div className="tree-scroll">
              <TreeNode tree={result.tree} />
            </div>
          </>
        ) : result.algo === "powl" ? (
          <>
            <FitnessStrip
              replay={result.replay}
              precision={result.precision}
              onShowCases={onShowCases}
            />
            <div className="tree-scroll">
              <PowlNode model={result.model} />
            </div>
          </>
        ) : result.algo === "heuristics" ? (
          <div className="flow-scroll">
            <p className="fitness-line">
              {t.coverageLine(
                result.net.coveredSuccessions.toLocaleString(),
                result.net.totalSuccessions.toLocaleString(),
                result.net.totalSuccessions > 0
                  ? (
                      (result.net.coveredSuccessions / result.net.totalSuccessions) *
                      100
                    ).toFixed(1)
                  : "0",
              )}
            </p>
            <p className="muted">{t.heuristicsEdgeCount(result.net.edges.length)}</p>
            <HeuristicsView net={result.net} t={t} />
          </div>
        ) : (
          <div className="flow-scroll">
            {result.net.warnings.length > 0 ? (
              <p className="muted">
                {t.modelWarnings}: {result.net.warnings.join(" · ")}
              </p>
            ) : null}
            <FitnessStrip
              replay={result.replay}
              precision={result.precision}
              onShowCases={onShowCases}
            />
            <PetriView net={result.net} />
          </div>
        )
      ) : (
        <div className="loading">{t.loading}</div>
      )}
      <p className="muted guide">
        {hints[applied.algo]}
        {applied.algo !== "heuristics" ? ` ${t.fitnessNote}` : ""}
      </p>
    </div>
  );
}
