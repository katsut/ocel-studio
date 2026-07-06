import { graphlib, layout } from "@dagrejs/dagre";
import { type LogEntry, type SourceView } from "../api.ts";
import { useMessages } from "../i18n.tsx";

/// The workspace as a pipeline: sources and recipes are the transforms,
/// files are the edges between them. Only sources carrying input/output
/// metadata contribute edges; plain files still show as standalone nodes.
export default function PipelineDag({
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
