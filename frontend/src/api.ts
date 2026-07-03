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

export type ProcessTree =
  | { type: "activity"; label: string }
  | { type: "tau" }
  | { type: "sequence"; children: ProcessTree[] }
  | { type: "exclusive"; children: ProcessTree[] }
  | { type: "parallel"; children: ProcessTree[] }
  | { type: "loop"; children: ProcessTree[] };

export const fetchSummary = (range: Range | null) =>
  get<Summary>(`/api/summary?_=1${rangeParams(range)}`);

export const fetchDfg = (objectType: string, range: Range | null) =>
  get<Dfg>(`/api/dfg?type=${encodeURIComponent(objectType)}${rangeParams(range)}`);

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

export const fetchModel = (objectType: string, range: Range | null) =>
  get<ProcessTree>(`/api/model?type=${encodeURIComponent(objectType)}${rangeParams(range)}`);

export const fetchVariants = (objectType: string, range: Range | null, limit = 50) =>
  get<VariantsResponse>(
    `/api/variants?type=${encodeURIComponent(objectType)}&limit=${limit}${rangeParams(range)}`,
  );

export const fetchEvents = (offset: number, limit: number, range: Range | null) =>
  get<EventsPage>(`/api/events?offset=${offset}&limit=${limit}${rangeParams(range)}`);

export const fetchStatus = async (): Promise<{ modified: string }> => {
  const res = await fetch("/api/status");
  if (!res.ok) {
    throw new Error(`/api/status: ${res.status}`);
  }
  return res.json() as Promise<{ modified: string }>;
};
