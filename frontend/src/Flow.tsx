import { useEffect, useState } from "react";
import { graphlib, layout } from "@dagrejs/dagre";
import { fetchDfg, type Dfg, type TypeCount } from "./api.ts";
import { useMessages } from "./i18n.tsx";

const NODE_H = 40;
const CHAR_W = 7.5;
const START = "__start__";
const END = "__end__";

function fmtGap(secs: number): string {
  if (secs >= 86400) {
    return `${(secs / 86400).toFixed(1)}d`;
  }
  if (secs >= 3600) {
    return `${(secs / 3600).toFixed(1)}h`;
  }
  if (secs >= 60) {
    return `${Math.round(secs / 60)}m`;
  }
  return `${Math.round(secs)}s`;
}

interface LaidNode {
  id: string;
  label: string;
  events: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface LaidEdge {
  key: string;
  d: string;
  width: number;
  label?: { text: string; x: number; y: number };
  marker: boolean;
}

interface Layout {
  width: number;
  height: number;
  nodes: LaidNode[];
  edges: LaidEdge[];
}

function selfLoopPath(node: LaidNode): string {
  const x = node.x + node.width / 2;
  const y = node.y;
  return `M ${x},${y - 9} C ${x + 44},${y - 22} ${x + 44},${y + 22} ${x},${y + 9}`;
}

function buildLayout(dfg: Dfg): Layout {
  const g = new graphlib.Graph();
  g.setGraph({ rankdir: "TB", nodesep: 45, ranksep: 65, marginx: 16, marginy: 16 });
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
      g.setEdge(edge.from, edge.to, { width: 70, height: 14, labelpos: "c" });
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
    const data = dfg.nodes.find((d) => d.activity === id);
    return {
      id,
      label: id,
      events: data?.events ?? 0,
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
            text: `${data.frequency.toLocaleString()}× ~${fmtGap(data.medianSecs)}`,
            x: e.x,
            y: e.y,
          }
        : undefined;
    return { key: `${ref.v}→${ref.w}`, d, width, label, marker: true };
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
      label: {
        text: `${loop.frequency.toLocaleString()}×`,
        x: node.x + node.width + 26,
        y: node.y + node.height / 2 - 18,
      },
      marker: true,
    });
  }

  const graph = g.graph();
  return {
    width: Math.max(graph.width ?? 0, 400) + 60,
    height: graph.height ?? 0,
    nodes,
    edges,
  };
}

export default function FlowPanel({
  types,
  modified,
}: {
  types: TypeCount[];
  modified: string;
}) {
  const t = useMessages();
  const [selected, setSelected] = useState<string>("");
  const [dfg, setDfg] = useState<Dfg | null>(null);
  const [error, setError] = useState<string | null>(null);

  const active =
    selected !== "" && types.some((ty) => ty.name === selected)
      ? selected
      : (types[0]?.name ?? "");

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
  const laid = dfg && dfg.objectType === active ? buildLayout(dfg) : null;
  return (
    <div className="panel">
      <div className="panel-head">
        <h2>{t.flowPanel}</h2>
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
      </div>
      {error ? <div className="error">{error}</div> : null}
      {laid ? (
        <div className="flow-scroll">
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
              <g key={edge.key}>
                <path
                  className="flow-edge"
                  d={edge.d}
                  strokeWidth={edge.width}
                  markerEnd={edge.marker ? "url(#arrow)" : undefined}
                />
                {edge.label ? (
                  <text className="flow-edge-label" x={edge.label.x} y={edge.label.y}>
                    {edge.label.text}
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
                <g key={node.id}>
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
                    {node.events.toLocaleString()}
                  </text>
                </g>
              ),
            )}
          </svg>
        </div>
      ) : (
        <div className="loading">{t.loading}</div>
      )}
    </div>
  );
}
