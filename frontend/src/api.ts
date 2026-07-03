export interface TypeCount {
  name: string;
  count: number;
}

export interface Summary {
  path: string;
  modified: string;
  events: number;
  objects: number;
  eventTypes: TypeCount[];
  objectTypes: TypeCount[];
  timeRange: { start: string; end: string } | null;
  violations: string[];
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

async function get<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`${url}: ${res.status} ${await res.text()}`);
  }
  return res.json() as Promise<T>;
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

export const fetchSummary = () => get<Summary>("/api/summary");

export const fetchVariants = (objectType: string, limit = 50) =>
  get<VariantsResponse>(
    `/api/variants?type=${encodeURIComponent(objectType)}&limit=${limit}`,
  );

export const fetchEvents = (offset: number, limit: number) =>
  get<EventsPage>(`/api/events?offset=${offset}&limit=${limit}`);

export const fetchStatus = () => get<{ modified: string }>("/api/status");
