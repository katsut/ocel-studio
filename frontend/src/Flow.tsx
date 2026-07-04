import { useEffect, useMemo, useState } from "react";
import { graphlib, layout } from "@dagrejs/dagre";
import {
  fetchDfg,
  fetchOcDfg,
  type Dfg,
  type DfgEdge,
  type DfgNode,
  type OcActivity,
  type OcDfg,
  type OcDfgEdge,
  type Range,
  type TypeCount,
} from "./api.ts";
import { useMessages, type Messages } from "./i18n.tsx";

const NODE_H = 40;
const CHAR_W = 7.5;
const START = "__start__";
const END = "__end__";
const PAIR_SEP = "";

interface LaidNode {
  id: string;
  label: string;
  data?: DfgNode;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface LaidEdge {
  key: string;
  d: string;
  width: number;
  data?: DfgEdge;
  label?: { count: string; wait: string; x: number; y: number };
}

interface Layout {
  width: number;
  height: number;
  totalTransitions: number;
  nodes: LaidNode[];
  edges: LaidEdge[];
}

function selfLoopPath(node: LaidNode): string {
  // drawn above the node (the graph flows left to right)
  const x = node.x + node.width / 2;
  const y = node.y;
  return `M ${x - 9},${y} C ${x - 26},${y - 46} ${x + 26},${y - 46} ${x + 9},${y}`;
}

/// Keep the strongest incoming/outgoing edge of every activity (so nothing
/// dangles), then add further edges by frequency up to the detail ratio.
function filterEdges(dfg: Dfg, detail: number): Dfg {
  const sorted = [...dfg.edges].sort((a, b) => b.frequency - a.frequency);
  const keep = new Set<DfgEdge>();
  for (const node of dfg.nodes) {
    const out = sorted.find((e) => e.from === node.activity);
    const inc = sorted.find((e) => e.to === node.activity);
    if (out) {
      keep.add(out);
    }
    if (inc) {
      keep.add(inc);
    }
  }
  const target = Math.max(keep.size, Math.round(sorted.length * detail));
  for (const edge of sorted) {
    if (keep.size >= target) {
      break;
    }
    keep.add(edge);
  }
  return { ...dfg, edges: sorted.filter((e) => keep.has(e)) };
}

function buildLayout(dfg: Dfg, t: Messages): Layout {
  const g = new graphlib.Graph();
  g.setGraph({ rankdir: "LR", nodesep: 34, ranksep: 90, marginx: 20, marginy: 40 });
  g.setDefaultEdgeLabel(() => ({}));

  for (const node of dfg.nodes) {
    g.setNode(node.activity, {
      width: Math.max(90, node.activity.length * CHAR_W + 28),
      height: NODE_H,
    });
  }
  const hasStart = dfg.nodes.some((n) => n.starts > 0);
  const hasEnd = dfg.nodes.some((n) => n.ends > 0);
  if (hasStart) {
    g.setNode(START, { width: 24, height: 24 });
  }
  if (hasEnd) {
    g.setNode(END, { width: 24, height: 24 });
  }

  const maxFreq = Math.max(1, ...dfg.edges.map((e) => e.frequency));
  const loops = dfg.edges.filter((e) => e.from === e.to);
  for (const edge of dfg.edges) {
    if (edge.from !== edge.to) {
      g.setEdge(edge.from, edge.to, { width: 90, height: 30, labelpos: "c" });
    }
  }
  for (const node of dfg.nodes) {
    if (node.starts > 0) {
      g.setEdge(START, node.activity, {});
    }
    if (node.ends > 0) {
      g.setEdge(node.activity, END, {});
    }
  }

  layout(g);

  const nodes: LaidNode[] = g.nodes().map((id) => {
    const n = g.node(id);
    return {
      id,
      label: id,
      data: dfg.nodes.find((d) => d.activity === id),
      x: n.x - n.width / 2,
      y: n.y - n.height / 2,
      width: n.width,
      height: n.height,
    };
  });

  const edges: LaidEdge[] = g.edges().map((ref) => {
    const e = g.edge(ref);
    const d = e.points
      .map((p: { x: number; y: number }, i: number) => `${i === 0 ? "M" : "L"} ${p.x},${p.y}`)
      .join(" ");
    const data = dfg.edges.find((x) => x.from === ref.v && x.to === ref.w);
    const width = data ? 1 + 3.5 * (data.frequency / maxFreq) : 1;
    const label =
      data && e.x !== undefined && e.y !== undefined
        ? {
            count: t.timesLabel(data.frequency.toLocaleString()),
            wait: `⏱ ${t.duration(data.medianSecs)}`,
            x: e.x,
            y: e.y,
          }
        : undefined;
    return { key: `${ref.v}→${ref.w}`, d, width, data, label };
  });

  for (const loop of loops) {
    const node = nodes.find((n) => n.id === loop.from);
    if (!node) {
      continue;
    }
    edges.push({
      key: `${loop.from}⟲`,
      d: selfLoopPath(node),
      width: 1 + 3.5 * (loop.frequency / maxFreq),
      data: loop,
      label: {
        count: t.timesLabel(loop.frequency.toLocaleString()),
        wait: "",
        x: node.x + node.width / 2,
        y: node.y - 38,
      },
    });
  }

  const graph = g.graph();
  return {
    width: Math.max(graph.width ?? 0, 400) + 60,
    height: graph.height ?? 0,
    totalTransitions: dfg.edges.reduce((sum, e) => sum + e.frequency, 0),
    nodes,
    edges,
  };
}

/// Per-type backbone filter for the overlay: each type keeps its own
/// strongest edges, so a small type is not drowned out by a big one.
function filterOcEdges(oc: OcDfg, detail: number): OcDfgEdge[] {
  const out: OcDfgEdge[] = [];
  for (const objectType of oc.objectTypes) {
    const nodes: DfgNode[] = [];
    for (const activity of oc.activities) {
      const per = activity.perType.find((p) => p.objectType === objectType);
      if (per) {
        nodes.push({
          activity: activity.activity,
          events: per.events,
          objects: per.objects,
          starts: per.starts,
          ends: per.ends,
        });
      }
    }
    const edges = oc.edges.filter((e) => e.objectType === objectType);
    const pseudo: Dfg = { objectType, objects: 0, withEvents: 0, nodes, edges };
    out.push(...(filterEdges(pseudo, detail).edges as OcDfgEdge[]));
  }
  return out;
}

interface OverlayLaid {
  width: number;
  height: number;
  nodes: { data: OcActivity; x: number; y: number; width: number; height: number }[];
  /// "from<US>to" -> shared dagre path for that pair.
  paths: Map<string, string>;
}

function buildOverlayLayout(activities: OcActivity[], edges: OcDfgEdge[]): OverlayLaid {
  const g = new graphlib.Graph();
  g.setGraph({ rankdir: "LR", nodesep: 34, ranksep: 90, marginx: 20, marginy: 46 });
  g.setDefaultEdgeLabel(() => ({}));

  for (const activity of activities) {
    g.setNode(activity.activity, {
      width: Math.max(90, activity.activity.length * CHAR_W + 28),
      height: NODE_H,
    });
  }
  const pairs = new Set(
    edges.filter((e) => e.from !== e.to).map((e) => `${e.from}${PAIR_SEP}${e.to}`),
  );
  for (const key of pairs) {
    const [from, to] = key.split(PAIR_SEP);
    g.setEdge(from, to, {});
  }

  layout(g);

  const nodes = activities.map((data) => {
    const n = g.node(data.activity);
    return {
      data,
      x: n.x - n.width / 2,
      y: n.y - n.height / 2,
      width: n.width,
      height: n.height,
    };
  });
  const paths = new Map<string, string>();
  for (const ref of g.edges()) {
    const e = g.edge(ref);
    const d = e.points
      .map((p: { x: number; y: number }, i: number) => `${i === 0 ? "M" : "L"} ${p.x},${p.y}`)
      .join(" ");
    paths.set(`${ref.v}${PAIR_SEP}${ref.w}`, d);
  }

  const graph = g.graph();
  return {
    width: Math.max(graph.width ?? 0, 400) + 60,
    height: graph.height ?? 0,
    nodes,
    paths,
  };
}

interface Tip {
  x: number;
  y: number;
  title: string;
  lines: string[];
}

type Selection =
  | { kind: "edge"; data: DfgEdge }
  | { kind: "node"; data: DfgNode }
  | { kind: "ocEdge"; data: OcDfgEdge }
  | { kind: "ocNode"; data: OcActivity };

export default function FlowPanel({
  objectType,
  objectTypes,
  slots,
  range,
  modified,
  onShowCases,
}: {
  objectType: string;
  objectTypes: TypeCount[];
  slots: Map<string, number>;
  range: Range | null;
  modified: string;
  onShowCases: (from: string, to: string, objectType: string) => void;
}) {
  const t = useMessages();
  const [detail, setDetail] = useState(0);
  const [extra, setExtra] = useState<string[]>([]);
  const [dfg, setDfg] = useState<Dfg | null>(null);
  const [oc, setOc] = useState<{ forKey: string; data: OcDfg } | null>(null);
  const [tip, setTip] = useState<Tip | null>(null);
  const [sel, setSel] = useState<Selection | null>(null);
  const [error, setError] = useState<string | null>(null);

  // the base type follows the global selector; overlay picks reset with it
  useEffect(() => {
    setExtra([]);
  }, [objectType]);

  const types = useMemo(() => [objectType, ...extra], [objectType, extra]);
  const typesKey = types.join(",");

  useEffect(() => {
    if (objectType === "") {
      return;
    }
    setSel(null);
    if (types.length === 1) {
      fetchDfg(objectType, range)
        .then((d) => {
          setDfg(d);
          setError(null);
        })
        .catch((err) => setError(err instanceof Error ? err.message : String(err)));
    } else {
      fetchOcDfg(types, range)
        .then((data) => {
          setOc({ forKey: typesKey, data });
          setError(null);
        })
        .catch((err) => setError(err instanceof Error ? err.message : String(err)));
    }
  }, [objectType, types, typesKey, range, modified]);

  const overlayMode = types.length > 1;
  const filtered = !overlayMode && dfg && dfg.objectType === objectType ? filterEdges(dfg, detail) : null;
  const laid = filtered ? buildLayout(filtered, t) : null;

  const ocData = overlayMode && oc && oc.forKey === typesKey ? oc.data : null;
  const ocEdges = ocData ? filterOcEdges(ocData, detail) : null;
  const ocLaid = ocData && ocEdges ? buildOverlayLayout(ocData.activities, ocEdges) : null;

  const slotOf = (ty: string) => slots.get(ty) ?? 8;

  const place = (event: React.MouseEvent, title: string, lines: string[]) => {
    const width = 330;
    const height = 130;
    let x = event.clientX + 14;
    let y = event.clientY + 14;
    if (x + width > window.innerWidth) {
      x = event.clientX - width - 14;
    }
    if (y + height > window.innerHeight) {
      y = event.clientY - height - 14;
    }
    setTip({ x, y, title, lines });
  };

  const edgeTip = (event: React.MouseEvent, edge: DfgEdge) => {
    const total = laid?.totalTransitions ?? 0;
    const pct = total > 0 ? ((edge.frequency / total) * 100).toFixed(1) : "0";
    const lines = [
      t.tipMoves(edge.frequency.toLocaleString(), `${pct}%`),
      t.tipObjects(edge.objects.toLocaleString()),
    ];
    if (edge.from !== edge.to) {
      lines.splice(1, 0, t.tipWait(t.duration(edge.medianSecs), t.duration(edge.meanSecs)));
    }
    place(event, edge.from === edge.to ? t.tipLoopTitle(edge.from) : `${edge.from} → ${edge.to}`, lines);
  };

  const nodeTip = (event: React.MouseEvent, node: DfgNode) => {
    const lines = [t.tipNodeEvents(node.events.toLocaleString(), node.objects.toLocaleString())];
    if (node.starts > 0 || node.ends > 0) {
      lines.push(t.tipNodeStartEnd(node.starts.toLocaleString(), node.ends.toLocaleString()));
    }
    place(event, node.activity, lines);
  };

  const ocEdgeTip = (event: React.MouseEvent, edge: OcDfgEdge) => {
    const lines = [
      t.tipEdgeType(edge.objectType),
      t.timesLabel(edge.frequency.toLocaleString()),
      t.tipObjects(edge.objects.toLocaleString()),
    ];
    if (edge.from !== edge.to) {
      lines.splice(2, 0, t.tipWait(t.duration(edge.medianSecs), t.duration(edge.meanSecs)));
    }
    place(event, edge.from === edge.to ? t.tipLoopTitle(edge.from) : `${edge.from} → ${edge.to}`, lines);
  };

  const ocNodeTip = (event: React.MouseEvent, activity: OcActivity) => {
    const lines = [
      t.tipOcTotal(activity.events.toLocaleString()),
      ...activity.perType.map((p) =>
        t.tipOcPerType(p.objectType, p.events.toLocaleString(), p.objects.toLocaleString()),
      ),
    ];
    place(event, activity.activity, lines);
  };

  const toggleType = (name: string) => {
    if (name === objectType) {
      return;
    }
    setSel(null);
    setExtra((cur) => (cur.includes(name) ? cur.filter((x) => x !== name) : [...cur, name]));
  };

  // only types with a stable palette slot can join the overlay
  const chipTypes = objectTypes.filter((ty) => slots.has(ty.name));

  const ocMaxFreq = ocEdges ? Math.max(1, ...ocEdges.map((e) => e.frequency)) : 1;
  const ocGroups = useMemo(() => {
    const groups = new Map<string, OcDfgEdge[]>();
    for (const edge of ocEdges ?? []) {
      const key = `${edge.from}${PAIR_SEP}${edge.to}`;
      const group = groups.get(key);
      if (group) {
        group.push(edge);
      } else {
        groups.set(key, [edge]);
      }
    }
    return groups;
  }, [ocEdges]);
  const usedSlots = [...new Set((ocEdges ?? []).map((e) => slotOf(e.objectType)))];

  const totalOcEdges = ocData?.edges.length ?? 0;

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>{t.flowPanel}</h2>
        <span className="panel-controls">
          <label>
            {t.detailLabel}{" "}
            <input
              type="range"
              min={0}
              max={100}
              step={5}
              value={Math.round(detail * 100)}
              onChange={(e) => setDetail(Number(e.target.value) / 100)}
            />
          </label>
        </span>
      </div>
      <div className="type-chips">
        <span className="muted">{t.overlayLabel}</span>
        {chipTypes.map((ty) => {
          const active = types.includes(ty.name);
          return (
            <button
              key={ty.name}
              className={active ? "type-chip active" : "type-chip"}
              title={ty.name === objectType ? t.overlayBaseTitle : undefined}
              onClick={() => toggleType(ty.name)}
              style={{ "--chip-cat": `var(--cat-${slotOf(ty.name)})` } as React.CSSProperties}
            >
              <span className="type-dot" />
              {ty.name}
            </button>
          );
        })}
      </div>
      <p className="muted guide">
        {overlayMode ? t.overlayHint : `${t.flowHint} ${t.selectionHint}`}
      </p>
      {!overlayMode && dfg && filtered && filtered.edges.length < dfg.edges.length ? (
        <p className="muted">{t.edgesShown(filtered.edges.length, dfg.edges.length)}</p>
      ) : null}
      {overlayMode && ocEdges && ocEdges.length < totalOcEdges ? (
        <p className="muted">{t.edgesShown(ocEdges.length, totalOcEdges)}</p>
      ) : null}
      {error ? <div className="error">{error}</div> : null}
      {!overlayMode && laid ? (
        <div className="map-body">
        <div className="flow-scroll" onMouseLeave={() => setTip(null)}>
          <svg
            className="flow"
            width={laid.width}
            height={laid.height}
            viewBox={`0 0 ${laid.width} ${laid.height}`}
          >
            <defs>
              <marker
                id="arrow"
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
              <g
                key={edge.key}
                className={edge.data ? "flow-hover" : undefined}
                onMouseMove={edge.data ? (e) => edgeTip(e, edge.data!) : undefined}
                onMouseLeave={() => setTip(null)}
                onClick={edge.data ? () => setSel({ kind: "edge", data: edge.data! }) : undefined}
              >
                <path
                  className="flow-edge"
                  d={edge.d}
                  strokeWidth={edge.width}
                  markerEnd="url(#arrow)"
                />
                {edge.data ? (
                  // invisible fat stroke so thin edges are easy to hover
                  <path className="flow-edge-hit" d={edge.d} />
                ) : null}
                {edge.label ? (
                  <text className="flow-edge-label" x={edge.label.x} y={edge.label.y}>
                    <tspan x={edge.label.x} dy={edge.label.wait === "" ? 0 : -3}>
                      {edge.label.count}
                    </tspan>
                    {edge.label.wait === "" ? null : (
                      <tspan x={edge.label.x} dy={12}>
                        {edge.label.wait}
                      </tspan>
                    )}
                  </text>
                ) : null}
              </g>
            ))}
            {laid.nodes.map((node) =>
              node.id === START || node.id === END ? (
                <g key={node.id}>
                  <circle
                    className={node.id === START ? "flow-start" : "flow-end"}
                    cx={node.x + node.width / 2}
                    cy={node.y + node.height / 2}
                    r={node.id === START ? 9 : 8}
                  />
                  {node.id === END ? (
                    <circle
                      className="flow-end-outer"
                      cx={node.x + node.width / 2}
                      cy={node.y + node.height / 2}
                      r={12}
                    />
                  ) : null}
                </g>
              ) : (
                <g
                  key={node.id}
                  className="flow-hover"
                  onMouseMove={node.data ? (e) => nodeTip(e, node.data!) : undefined}
                  onMouseLeave={() => setTip(null)}
                  onClick={node.data ? () => setSel({ kind: "node", data: node.data! }) : undefined}
                >
                  <rect
                    className="flow-node"
                    x={node.x}
                    y={node.y}
                    width={node.width}
                    height={node.height}
                    rx={9}
                  />
                  <text
                    className="flow-node-label"
                    x={node.x + node.width / 2}
                    y={node.y + 17}
                  >
                    {node.label}
                  </text>
                  <text
                    className="flow-node-count"
                    x={node.x + node.width / 2}
                    y={node.y + 31}
                  >
                    {node.data?.events.toLocaleString() ?? ""}
                  </text>
                </g>
              ),
            )}
          </svg>
          {tip ? (
            <div className="flow-tip" style={{ left: tip.x, top: tip.y }}>
              <div className="flow-tip-title">{tip.title}</div>
              {tip.lines.map((line) => (
                <div key={line}>{line}</div>
              ))}
            </div>
          ) : null}
        </div>
        {sel && (sel.kind === "edge" || sel.kind === "node") ? (
          <aside className="sel-panel">
            <div className="panel-head">
              <div className="sel-title">
                {sel.kind === "edge"
                  ? sel.data.from === sel.data.to
                    ? t.tipLoopTitle(sel.data.from)
                    : `${sel.data.from} → ${sel.data.to}`
                  : sel.data.activity}
              </div>
              <button className="link-button" onClick={() => setSel(null)}>
                {t.closeLabel}
              </button>
            </div>
            {sel.kind === "edge" ? (
              <>
                <p className="muted">
                  {t.tipMoves(
                    sel.data.frequency.toLocaleString(),
                    `${(laid.totalTransitions > 0
                      ? (sel.data.frequency / laid.totalTransitions) * 100
                      : 0
                    ).toFixed(1)}%`,
                  )}
                </p>
                {sel.data.from !== sel.data.to ? (
                  <p className="muted">
                    {t.tipWait(t.duration(sel.data.medianSecs), t.duration(sel.data.meanSecs))}
                  </p>
                ) : null}
                <p className="muted">{t.tipObjects(sel.data.objects.toLocaleString())}</p>
                <button
                  className="link-button"
                  onClick={() => onShowCases(sel.data.from, sel.data.to, objectType)}
                >
                  {t.showCases} →
                </button>
              </>
            ) : (
              <>
                <p className="muted">
                  {t.tipNodeEvents(
                    sel.data.events.toLocaleString(),
                    sel.data.objects.toLocaleString(),
                  )}
                </p>
                {sel.data.starts > 0 || sel.data.ends > 0 ? (
                  <p className="muted">
                    {t.tipNodeStartEnd(
                      sel.data.starts.toLocaleString(),
                      sel.data.ends.toLocaleString(),
                    )}
                  </p>
                ) : null}
              </>
            )}
          </aside>
        ) : null}
        </div>
      ) : null}
      {overlayMode && ocLaid && ocEdges ? (
        <div className="map-body">
        <div className="flow-scroll" onMouseLeave={() => setTip(null)}>
          <svg
            className="flow"
            width={ocLaid.width}
            height={ocLaid.height}
            viewBox={`0 0 ${ocLaid.width} ${ocLaid.height}`}
          >
            <defs>
              {usedSlots.map((slot) => (
                <marker
                  key={slot}
                  id={`arrow-cat-${slot}`}
                  viewBox="0 0 8 8"
                  refX="7"
                  refY="4"
                  markerWidth="9"
                  markerHeight="9"
                  markerUnits="userSpaceOnUse"
                  orient="auto-start-reverse"
                >
                  <path d="M 0 0 L 8 4 L 0 8 z" style={{ fill: `var(--cat-${slot})` }} />
                </marker>
              ))}
            </defs>
            {[...ocGroups.entries()].flatMap(([key, group]) => {
              const [from, to] = key.split(PAIR_SEP);
              const loop = from === to;
              const node = loop ? ocLaid.nodes.find((n) => n.data.activity === from) : null;
              const base = loop
                ? node
                  ? selfLoopPath({
                      id: from,
                      label: from,
                      x: node.x,
                      y: node.y,
                      width: node.width,
                      height: node.height,
                    })
                  : null
                : (ocLaid.paths.get(key) ?? null);
              if (base === null) {
                return [];
              }
              return group.map((edge, i) => {
                const offset = (i - (group.length - 1) / 2) * 4;
                const slot = slotOf(edge.objectType);
                return (
                  <g
                    key={`${key}:${edge.objectType}`}
                    className="flow-hover"
                    transform={`translate(0, ${offset})`}
                    onMouseMove={(e) => ocEdgeTip(e, edge)}
                    onMouseLeave={() => setTip(null)}
                    onClick={() => setSel({ kind: "ocEdge", data: edge })}
                  >
                    <path
                      className="flow-edge oc-edge"
                      d={base}
                      style={{ stroke: `var(--cat-${slot})` }}
                      strokeWidth={1 + 3.5 * (edge.frequency / ocMaxFreq)}
                      markerEnd={`url(#arrow-cat-${slot})`}
                    />
                    <path className="flow-edge-hit" d={base} />
                  </g>
                );
              });
            })}
            {ocLaid.nodes.map((node) => (
              <g
                key={node.data.activity}
                className="flow-hover"
                onMouseMove={(e) => ocNodeTip(e, node.data)}
                onMouseLeave={() => setTip(null)}
                onClick={() => setSel({ kind: "ocNode", data: node.data })}
              >
                <rect
                  className="flow-node"
                  x={node.x}
                  y={node.y}
                  width={node.width}
                  height={node.height}
                  rx={9}
                />
                <text className="flow-node-label" x={node.x + node.width / 2} y={node.y + 17}>
                  {node.data.activity}
                </text>
                <text className="flow-node-count" x={node.x + node.width / 2} y={node.y + 31}>
                  {node.data.events.toLocaleString()}
                </text>
              </g>
            ))}
          </svg>
          {tip ? (
            <div className="flow-tip" style={{ left: tip.x, top: tip.y }}>
              <div className="flow-tip-title">{tip.title}</div>
              {tip.lines.map((line) => (
                <div key={line}>{line}</div>
              ))}
            </div>
          ) : null}
        </div>
        {sel && (sel.kind === "ocEdge" || sel.kind === "ocNode") ? (
          <aside className="sel-panel">
            <div className="panel-head">
              <div className="sel-title">
                {sel.kind === "ocEdge"
                  ? sel.data.from === sel.data.to
                    ? t.tipLoopTitle(sel.data.from)
                    : `${sel.data.from} → ${sel.data.to}`
                  : sel.data.activity}
              </div>
              <button className="link-button" onClick={() => setSel(null)}>
                {t.closeLabel}
              </button>
            </div>
            {sel.kind === "ocEdge" ? (
              <>
                <p className="muted">
                  <span
                    className="type-dot inline"
                    style={{ "--chip-cat": `var(--cat-${slotOf(sel.data.objectType)})` } as React.CSSProperties}
                  />
                  {t.tipEdgeType(sel.data.objectType)}
                </p>
                <p className="muted">{t.timesLabel(sel.data.frequency.toLocaleString())}</p>
                {sel.data.from !== sel.data.to ? (
                  <p className="muted">
                    {t.tipWait(t.duration(sel.data.medianSecs), t.duration(sel.data.meanSecs))}
                  </p>
                ) : null}
                <p className="muted">{t.tipObjects(sel.data.objects.toLocaleString())}</p>
                <button
                  className="link-button"
                  onClick={() => onShowCases(sel.data.from, sel.data.to, sel.data.objectType)}
                >
                  {t.showCases} →
                </button>
              </>
            ) : (
              <>
                <p className="muted">{t.tipOcTotal(sel.data.events.toLocaleString())}</p>
                {sel.data.perType.map((p) => (
                  <p className="muted" key={p.objectType}>
                    <span
                      className="type-dot inline"
                      style={{ "--chip-cat": `var(--cat-${slotOf(p.objectType)})` } as React.CSSProperties}
                    />
                    {t.tipOcPerType(
                      p.objectType,
                      p.events.toLocaleString(),
                      p.objects.toLocaleString(),
                    )}
                  </p>
                ))}
              </>
            )}
          </aside>
        ) : null}
        </div>
      ) : null}
      {(!overlayMode && !laid) || (overlayMode && !ocLaid) ? (
        <div className="loading">{t.loading}</div>
      ) : null}
    </div>
  );
}
