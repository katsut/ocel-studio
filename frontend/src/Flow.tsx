import { useEffect, useRef, useState } from "react";
import { graphlib, layout } from "@dagrejs/dagre";
import { fetchDfg, type Dfg, type DfgEdge, type DfgNode, type TypeCount } from "./api.ts";
import { useMessages, type Messages } from "./i18n.tsx";

const NODE_H = 40;
const CHAR_W = 7.5;
const START = "__start__";
const END = "__end__";

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
  const x = node.x + node.width / 2;
  const y = node.y;
  return `M ${x},${y - 9} C ${x + 44},${y - 22} ${x + 44},${y + 22} ${x},${y + 9}`;
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
  g.setGraph({ rankdir: "TB", nodesep: 45, ranksep: 70, marginx: 16, marginy: 16 });
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
        x: node.x + node.width + 28,
        y: node.y + node.height / 2 - 16,
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

interface Tip {
  x: number;
  y: number;
  title: string;
  lines: string[];
}

export default function FlowPanel({
  types,
  preferred,
  modified,
}: {
  types: TypeCount[];
  preferred: string;
  modified: string;
}) {
  const t = useMessages();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<string>("");
  const [detail, setDetail] = useState(0);
  const [dfg, setDfg] = useState<Dfg | null>(null);
  const [tip, setTip] = useState<Tip | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fallback =
    preferred !== "" && types.some((ty) => ty.name === preferred)
      ? preferred
      : (types[0]?.name ?? "");
  const active =
    selected !== "" && types.some((ty) => ty.name === selected) ? selected : fallback;

  useEffect(() => {
    if (active === "") {
      return;
    }
    fetchDfg(active)
      .then((d) => {
        setDfg(d);
        setError(null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [active, modified]);

  if (active === "") {
    return null;
  }
  const filtered = dfg && dfg.objectType === active ? filterEdges(dfg, detail) : null;
  const laid = filtered ? buildLayout(filtered, t) : null;

  const place = (event: React.MouseEvent, title: string, lines: string[]) => {
    const box = scrollRef.current;
    if (!box) {
      return;
    }
    const rect = box.getBoundingClientRect();
    setTip({
      x: event.clientX - rect.left + box.scrollLeft + 14,
      y: event.clientY - rect.top + box.scrollTop + 14,
      title,
      lines,
    });
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
          <label>
            {t.objectTypeLabel}{" "}
            <select value={active} onChange={(e) => setSelected(e.target.value)}>
              {types.map((ty) => (
                <option key={ty.name} value={ty.name}>
                  {ty.name} ({ty.count.toLocaleString()})
                </option>
              ))}
            </select>
          </label>
        </span>
      </div>
      <p className="muted guide">{t.flowHint}</p>
      {dfg && filtered && filtered.edges.length < dfg.edges.length ? (
        <p className="muted">{t.edgesShown(filtered.edges.length, dfg.edges.length)}</p>
      ) : null}
      {error ? <div className="error">{error}</div> : null}
      {laid ? (
        <div className="flow-scroll" ref={scrollRef} onMouseLeave={() => setTip(null)}>
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
                markerWidth="7"
                markerHeight="7"
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
      ) : (
        <div className="loading">{t.loading}</div>
      )}
    </div>
  );
}
