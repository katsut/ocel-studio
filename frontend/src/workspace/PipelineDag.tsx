import { graphlib, layout } from "@dagrejs/dagre";
import { type DeclarationSetView, type LogEntry, type SourceView } from "../api.ts";
import { useMessages } from "../i18n.tsx";

type Stage = 1 | 2 | 3 | 4 | 5;

const STAGES: Stage[] = [1, 2, 3, 4, 5];
const MARGIN = 12;
const HEADING = 22;
const BAND_PAD = 8;

/// Stage of a source, judged from its command's basename only: the server
/// knows nothing about stages.
function sourceStage(s: SourceView): Stage {
  const base = s.command.split(/[\\/]/).pop() ?? s.command;
  if (base === "ocel-annotate" || base === "ocel-aliases") {
    return 2;
  }
  if (base === "ocel-transform") {
    return 4;
  }
  return 1;
}

/// The workspace as a pipeline in five stages: raw logs, shared decisions,
/// business-event logs, per-purpose declarations, per-purpose views. Sources
/// and declaration sets are the transforms, files are the edges between them.
export default function PipelineDag({
  logs,
  sources,
  views,
  onOpen,
  onSelectView,
}: {
  logs: LogEntry[];
  sources: SourceView[];
  views: DeclarationSetView[];
  onOpen: (name: string) => void;
  onSelectView: (name: string) => void;
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
  for (const v of views) {
    if (v.baseLog) {
      files.add(v.baseLog);
    }
  }
  if (sources.length === 0 && files.size === 0 && views.length === 0) {
    return null;
  }

  // a file sits one stage after the source that produces it; stage-1
  // connectors keep their output in stage 1 (raw operation logs)
  const stageOf = new Map<string, Stage>();
  for (const name of files) {
    stageOf.set(`f:${name}`, 1);
  }
  for (const s of sources) {
    const stage = sourceStage(s);
    stageOf.set(`s:${s.name}`, stage);
    if (s.output) {
      const produced = (stage === 1 ? 1 : stage + 1) as Stage;
      const id = `f:${s.output}`;
      stageOf.set(id, Math.max(stageOf.get(id) ?? 1, produced) as Stage);
    }
  }
  // a declaration refines its base log: stage 4 on logs from stages 1-3,
  // stage 5 when the base log is already purpose-specific
  for (const v of views) {
    const base = v.baseLog ? (stageOf.get(`f:${v.baseLog}`) ?? 1) : 1;
    stageOf.set(`v:${v.name}`, Math.min(Math.max(base + 1, 4), 5) as Stage);
  }

  const g = new graphlib.Graph();
  g.setGraph({ rankdir: "LR", nodesep: 14, ranksep: 46, marginx: 0, marginy: 0 });
  g.setDefaultEdgeLabel(() => ({}));
  const width = (text: string) => Math.max(70, text.length * 7.2 + 28);
  for (const stage of STAGES) {
    g.setNode(`stage:${stage}`, { width: 0, height: 0 });
    if (stage < 5) {
      g.setEdge(`stage:${stage}`, `stage:${stage + 1}`);
    }
  }
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
  for (const v of views) {
    g.setNode(`v:${v.name}`, { width: width(v.name) + 12, height: 30 });
    if (v.baseLog) {
      // stage 5 has no upper anchor, so a stage-5 declaration simply takes
      // the next rank after its stage-5 base log (dagre cannot lay out
      // same-rank edges)
      g.setEdge(`f:${v.baseLog}`, `v:${v.name}`);
    }
  }
  // anchors bound every node from both sides, so stage bands never overlap
  for (const [id, stage] of stageOf) {
    g.setEdge(`stage:${stage}`, id);
    if (stage < 5) {
      g.setEdge(id, `stage:${stage + 1}`);
    }
  }
  layout(g);

  const visible = g.nodes().filter((id) => !id.startsWith("stage:"));
  const box = (id: string) => g.node(id) as { x: number; y: number; width: number; height: number };
  const left = Math.min(...visible.map((id) => box(id).x - box(id).width / 2)) - BAND_PAD;
  const right = Math.max(...visible.map((id) => box(id).x + box(id).width / 2)) + BAND_PAD;
  const top = Math.min(...visible.map((id) => box(id).y - box(id).height / 2)) - BAND_PAD;
  const bottom = Math.max(...visible.map((id) => box(id).y + box(id).height / 2)) + BAND_PAD;
  const offsetX = MARGIN - left;
  const offsetY = MARGIN + HEADING - top;
  const w = Math.max(right - left + MARGIN * 2, 60);
  const h = Math.max(bottom - top + HEADING + MARGIN * 2, 40);

  const stageTitle: Record<Stage, string> = {
    1: t.pipelineStageRaw,
    2: t.pipelineStageShared,
    3: t.pipelineStageEvents,
    4: t.pipelineStageDeclare,
    5: t.pipelineStageViews,
  };
  const bands = STAGES.flatMap((stage) => {
    const members = visible.filter((id) => stageOf.get(id) === stage);
    if (members.length === 0) {
      return [];
    }
    const x0 = Math.min(...members.map((id) => box(id).x - box(id).width / 2)) - BAND_PAD;
    const x1 = Math.max(...members.map((id) => box(id).x + box(id).width / 2)) + BAND_PAD;
    return [{ stage, x0, x1 }];
  });

  const runColor = (s: SourceView) =>
    s.run === null
      ? "var(--muted)"
      : s.run.state === "running"
        ? "var(--accent)"
        : s.run.state === "succeeded"
          ? "var(--status-good)"
          : "var(--status-serious)";

  const viewTitle = (v: DeclarationSetView) => {
    const lines = [`${t.declRecipeLabel}: ${v.recipe ?? t.declNoRecipe}`];
    if (v.via && v.via.length > 0) {
      lines.push(`${t.declViaOnly}: ${v.via.join(", ")}`);
    }
    if (v.notVia && v.notVia.length > 0) {
      lines.push(`${t.declNotViaOnly}: ${v.notVia.join(", ")}`);
    }
    if (v.period && (v.period.from || v.period.to)) {
      lines.push(`${t.declPeriodLabel}: ${v.period.from ?? ""} – ${v.period.to ?? ""}`);
    }
    lines.push(t.pipelineViewHint);
    return lines.join("\n");
  };

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
          <g transform={`translate(${offsetX.toFixed(1)}, ${offsetY.toFixed(1)})`}>
            {bands.map((b) => (
              <g key={`band-${b.stage}`}>
                <rect
                  x={b.x0}
                  y={top}
                  width={b.x1 - b.x0}
                  height={bottom - top}
                  rx={8}
                  className="dag-stage-band"
                />
                <text x={b.x0 + 4} y={top - 7} className="dag-stage-label">
                  {`${b.stage} ${stageTitle[b.stage]}`}
                </text>
              </g>
            ))}
            {g
              .edges()
              .filter((e) => !e.v.startsWith("stage:") && !e.w.startsWith("stage:"))
              .map((e) => {
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
            {visible.map((id) => {
              const node = box(id);
              const name = id.slice(2);
              const at = `translate(${node.x - node.width / 2}, ${node.y - node.height / 2})`;
              if (id.startsWith("v:")) {
                const view = views.find((v) => v.name === name);
                return (
                  <g
                    key={id}
                    transform={at}
                    className="dag-node dag-view"
                    onClick={() => onSelectView(name)}
                  >
                    {view ? <title>{viewTitle(view)}</title> : null}
                    <rect width={node.width} height={node.height} rx={4} className="dag-view-rect" />
                    <path
                      d={`M 12 ${node.height / 2 - 5} L 17 ${node.height / 2} L 12 ${node.height / 2 + 5} L 7 ${node.height / 2} Z`}
                      className="dag-view-diamond"
                    />
                    <text
                      x={node.width / 2 + 6}
                      y={node.height / 2 + 4}
                      textAnchor="middle"
                      className="dag-label"
                    >
                      {name}
                    </text>
                  </g>
                );
              }
              const isFile = id.startsWith("f:");
              const missing = isFile && !logs.some((l) => l.name === name);
              const source = sources.find((s) => s.name === name);
              return (
                <g
                  key={id}
                  transform={at}
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
          </g>
        </svg>
      </div>
    </div>
  );
}
