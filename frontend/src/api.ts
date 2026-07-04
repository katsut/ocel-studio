export interface TypeCount {
  name: string;
  count: number;
}

export interface TypeStats {
  objectType: string;
  objects: number;
  withEvents: number;
  medianTraceLen: number;
}

export interface Summary {
  path: string;
  modified: string;
  events: number;
  objects: number;
  eventTypes: TypeCount[];
  objectTypes: TypeCount[];
  typeStats: TypeStats[];
  timeRange: { start: string; end: string } | null;
  violations: string[];
}

/// The most case-like type: workable median trace length first, then the
/// simplest lifecycle, best events coverage, most objects.
export function caseLikeType(stats: TypeStats[]): string | null {
  const workable = stats.filter(
    (s) => s.withEvents > 0 && s.medianTraceLen >= 3 && s.medianTraceLen <= 20,
  );
  const pool = workable.length > 0 ? workable : stats.filter((s) => s.withEvents > 0);
  if (pool.length === 0) {
    return stats[0]?.objectType ?? null;
  }
  const coverage = (s: TypeStats) => s.withEvents / Math.max(1, s.objects);
  return pool.reduce((best, s) => {
    if (s.medianTraceLen !== best.medianTraceLen) {
      return s.medianTraceLen < best.medianTraceLen ? s : best;
    }
    if (coverage(s) !== coverage(best)) {
      return coverage(s) > coverage(best) ? s : best;
    }
    return s.objects > best.objects ? s : best;
  }).objectType;
}

export interface RelatedObject {
  id: string;
  qualifier: string;
}

export interface EventRow {
  id: string;
  eventType: string;
  time: string;
  objects: RelatedObject[];
}

export interface EventsPage {
  total: number;
  offset: number;
  items: EventRow[];
}

export interface Range {
  from: string;
  to: string;
}

export function rangeParams(range: Range | null): string {
  if (!range) {
    return "";
  }
  const parts = [];
  if (range.from !== "") {
    parts.push(`from=${range.from}`);
  }
  if (range.to !== "") {
    parts.push(`to=${range.to}`);
  }
  return parts.length > 0 ? `&${parts.join("&")}` : "";
}

// Everything is a pure function of the file content, so responses are cached
// by URL and the whole cache is dropped when the file's mtime changes.
const cache = new Map<string, Promise<unknown>>();

export function clearApiCache(): void {
  cache.clear();
}

function get<T>(url: string): Promise<T> {
  const hit = cache.get(url);
  if (hit) {
    return hit as Promise<T>;
  }
  const request = fetch(url).then(async (res) => {
    if (!res.ok) {
      throw new Error(`${url}: ${res.status} ${await res.text()}`);
    }
    return res.json() as Promise<T>;
  });
  request.catch(() => cache.delete(url));
  cache.set(url, request);
  return request;
}

export interface VariantRow {
  activities: string[];
  count: number;
  example: string;
}

export interface VariantsResponse {
  objectType: string;
  objects: number;
  withEvents: number;
  totalVariants: number;
  variants: VariantRow[];
}

export interface DfgNode {
  activity: string;
  events: number;
  objects: number;
  starts: number;
  ends: number;
}

export interface DfgEdge {
  from: string;
  to: string;
  frequency: number;
  objects: number;
  medianSecs: number;
  meanSecs: number;
}

export interface Dfg {
  objectType: string;
  objects: number;
  withEvents: number;
  nodes: DfgNode[];
  edges: DfgEdge[];
}

export interface OcTypeCount {
  objectType: string;
  events: number;
  objects: number;
  starts: number;
  ends: number;
}

export interface OcActivity {
  activity: string;
  events: number;
  perType: OcTypeCount[];
}

export interface OcDfgEdge extends DfgEdge {
  objectType: string;
}

export interface OcDfg {
  objectTypes: string[];
  activities: OcActivity[];
  edges: OcDfgEdge[];
}

/// Stable categorical slot per object type: descending object count at load,
/// fixed for the session — color follows the entity, never its rank
/// (docs/design/design-system.md).
export function typeSlots(objectTypes: TypeCount[]): Map<string, number> {
  const ranked = [...objectTypes].sort(
    (a, b) => b.count - a.count || a.name.localeCompare(b.name),
  );
  return new Map(ranked.slice(0, 8).map((ty, i) => [ty.name, i + 1]));
}

export type ProcessTree =
  | { type: "activity"; label: string }
  | { type: "tau" }
  | { type: "sequence"; children: ProcessTree[] }
  | { type: "exclusive"; children: ProcessTree[] }
  | { type: "parallel"; children: ProcessTree[] }
  | { type: "loop"; children: ProcessTree[] };

export interface PetriNet {
  objectType: string;
  transitions: string[];
  places: { id: string; inputs: string[]; outputs: string[] }[];
  warnings: string[];
}

export interface HeuristicActivity {
  activity: string;
  frequency: number;
  starts: number;
  ends: number;
}

export interface HeuristicEdge {
  from: string;
  to: string;
  frequency: number;
  dependency: number;
}

export interface HeuristicsNet {
  objectType: string;
  objects: number;
  withEvents: number;
  activities: HeuristicActivity[];
  edges: HeuristicEdge[];
  coveredSuccessions: number;
  totalSuccessions: number;
}

export type Algo = "inductive" | "alpha" | "heuristics";

/// Discovery tuning; every value lands in the request URL, so results are
/// cached per parameter set and re-running a previous setting is instant.
export interface ModelParams {
  algo: Algo;
  /// inductive: 0..1 fraction of the strongest edge below which rare
  /// directly-follows edges are ignored
  noise: number;
  /// heuristics: 0..1 minimum dependency value
  dependency: number;
  /// heuristics: drop edges observed fewer times than this
  minEdge: number;
}

export const DEFAULT_MODEL_PARAMS: ModelParams = {
  algo: "inductive",
  noise: 0,
  dependency: 0.9,
  minEdge: 1,
};

export interface MisfitVariant {
  activities: string[];
  count: number;
  example: string;
}

export interface ReplayReport {
  objectType: string;
  traces: number;
  fitting: number;
  variants: number;
  fittingVariants: number;
  misfits: MisfitVariant[];
}

export type ModelResult =
  | { algo: "inductive"; tree: ProcessTree; replay: ReplayReport }
  | { algo: "alpha"; net: PetriNet; replay: ReplayReport }
  | { algo: "heuristics"; net: HeuristicsNet };

export const fetchSummary = (range: Range | null) =>
  get<Summary>(`/api/summary?_=1${rangeParams(range)}`);

export const fetchDfg = (objectType: string, range: Range | null) =>
  get<Dfg>(`/api/dfg?type=${encodeURIComponent(objectType)}${rangeParams(range)}`);

export const fetchOcDfg = (types: string[], range: Range | null) =>
  get<OcDfg>(`/api/ocdfg?types=${encodeURIComponent(types.join(","))}${rangeParams(range)}`);

export interface VariantLead {
  activities: string[];
  count: number;
  medianSecs: number;
  meanSecs: number;
  p90Secs: number;
}

export interface LeadTimeReport {
  objectType: string;
  measured: number;
  medianSecs: number;
  meanSecs: number;
  p90Secs: number;
  restMedianSecs: number;
  restCount: number;
  variants: VariantLead[];
  rework: { activity: string; traces: number; extraOccurrences: number }[];
}

export interface CaseSummary {
  objectId: string;
  activities: string[];
  events: number;
  start: string;
  end: string;
  leadSecs: number;
}

export interface CasesPage {
  total: number;
  offset: number;
  items: CaseSummary[];
}

export interface CaseDetail {
  objectId: string;
  items: EventRow[];
}

export type CaseFilter =
  | { kind: "variant"; activities: string[] }
  | { kind: "edge"; from: string; to: string };

export const fetchCases = (
  objectType: string,
  filter: CaseFilter | null,
  range: Range | null,
  offset: number,
  limit: number,
) => {
  let extra = "";
  if (filter?.kind === "variant") {
    extra = `&variant=${encodeURIComponent(filter.activities.join("\u001f"))}`;
  } else if (filter?.kind === "edge") {
    extra = `&edge=${encodeURIComponent(`${filter.from}\u001f${filter.to}`)}`;
  }
  return get<CasesPage>(
    `/api/cases?type=${encodeURIComponent(objectType)}${extra}${rangeParams(range)}&offset=${offset}&limit=${limit}`,
  );
};

export const fetchCase = (id: string, range: Range | null) =>
  get<CaseDetail>(`/api/case?id=${encodeURIComponent(id)}${rangeParams(range)}`);

export const fetchLeadTimes = (objectType: string, range: Range | null) =>
  get<LeadTimeReport>(
    `/api/leadtimes?type=${encodeURIComponent(objectType)}${rangeParams(range)}`,
  );

export const fetchModel = (objectType: string, params: ModelParams, range: Range | null) => {
  let tuning = "";
  if (params.algo === "inductive" && params.noise > 0) {
    tuning = `&noise=${params.noise}`;
  } else if (params.algo === "heuristics") {
    tuning = `&dependency=${params.dependency}&min_edge=${params.minEdge}`;
  }
  return get<ModelResult>(
    `/api/model?type=${encodeURIComponent(objectType)}&algo=${params.algo}${tuning}${rangeParams(range)}`,
  );
};

export const fetchVariants = (objectType: string, range: Range | null, limit = 50) =>
  get<VariantsResponse>(
    `/api/variants?type=${encodeURIComponent(objectType)}&limit=${limit}${rangeParams(range)}`,
  );

export const fetchEvents = (offset: number, limit: number, range: Range | null) =>
  get<EventsPage>(`/api/events?offset=${offset}&limit=${limit}${rangeParams(range)}`);

export interface Status {
  loaded: boolean;
  modified: string | null;
  dataDir: string;
}

export const fetchStatus = async (): Promise<Status> => {
  const res = await fetch("/api/status");
  if (!res.ok) {
    throw new Error(`/api/status: ${res.status}`);
  }
  return res.json() as Promise<Status>;
};

/// Fetch the official sample into the data directory and load it. Slow
/// (~35 MB download on first use) — callers show progress.
export const fetchSample = async (): Promise<Status> => {
  const res = await fetch("/api/sample", { method: "POST" });
  if (!res.ok) {
    throw new Error(`/api/sample: ${res.status} ${await res.text()}`);
  }
  return res.json() as Promise<Status>;
};

export interface LogEntry {
  name: string;
  size: number;
  modified: string;
  active: boolean;
}

export interface LogsResponse {
  dataDir: string;
  logs: LogEntry[];
  activeOutside: string | null;
}

// The listing reflects the directory right now — never cached.
export const fetchLogs = async (): Promise<LogsResponse> => {
  const res = await fetch("/api/logs");
  if (!res.ok) {
    throw new Error(`/api/logs: ${res.status} ${await res.text()}`);
  }
  return res.json() as Promise<LogsResponse>;
};

export const openLog = async (name: string): Promise<Status> => {
  const res = await fetch("/api/logs/open", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) {
    throw new Error(`/api/logs/open: ${res.status} ${await res.text()}`);
  }
  return res.json() as Promise<Status>;
};

export interface RunProgress {
  stage: string;
  done: number;
  total: number | null;
}

export interface RunSummary {
  events: number;
  objects: number;
}

export interface RunState {
  state: "running" | "succeeded" | "failed";
  started: string;
  finished: string | null;
  exitCode: number | null;
  stderrTail: string | null;
  progress: RunProgress | null;
  logs?: string[];
  summary: RunSummary | null;
}

export interface SourceView {
  name: string;
  command: string;
  args: string[];
  run: RunState | null;
}

async function sourcesRequest(url: string, init?: RequestInit): Promise<SourceView[]> {
  const res = await fetch(url, init);
  if (!res.ok) {
    throw new Error(`${url}: ${res.status} ${await res.text()}`);
  }
  return res.json() as Promise<SourceView[]>;
}

export const fetchSources = () => sourcesRequest("/api/sources");

export const saveSource = (name: string, command: string, args: string[]) =>
  sourcesRequest("/api/sources", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, command, args }),
  });

export const deleteSource = (name: string) =>
  sourcesRequest(`/api/sources/${encodeURIComponent(name)}`, { method: "DELETE" });

export const runSource = (name: string) =>
  sourcesRequest(`/api/sources/${encodeURIComponent(name)}/run`, { method: "POST" });

/// Split a command line into program + args, honoring single/double quotes.
export function splitCommandLine(line: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let started = false;
  for (const ch of line) {
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
    } else if (ch === " " || ch === "\t") {
      if (started) {
        parts.push(current);
        current = "";
        started = false;
      }
    } else {
      current += ch;
      started = true;
    }
  }
  if (started) {
    parts.push(current);
  }
  return parts;
}

/// Join program + args back into a display string, quoting where needed.
export function joinCommandLine(command: string, args: string[]): string {
  return [command, ...args]
    .map((part) => (part.includes(" ") || part === "" ? `"${part}"` : part))
    .join(" ");
}
