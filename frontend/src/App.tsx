import { useCallback, useEffect, useState } from "react";
import {
  fetchEvents,
  fetchStatus,
  fetchSummary,
  type EventsPage,
  type Summary,
  type TypeCount,
} from "./api.ts";

const PAGE_SIZE = 50;
const POLL_MS = 2000;

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString();
}

function StatCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="card">
      <div className="card-label">{label}</div>
      <div className="card-value">{value}</div>
      {hint ? <div className="card-hint">{hint}</div> : null}
    </div>
  );
}

function TypeTable({ title, rows }: { title: string; rows: TypeCount[] }) {
  return (
    <div className="panel">
      <h2>{title}</h2>
      <table>
        <thead>
          <tr>
            <th>Type</th>
            <th className="num">Count</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.name}>
              <td>{row.name}</td>
              <td className="num">{row.count.toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const OBJECT_CHIP_LIMIT = 4;

function EventsPanel({ page, onPage }: { page: EventsPage; onPage: (offset: number) => void }) {
  const from = page.total === 0 ? 0 : page.offset + 1;
  const to = Math.min(page.offset + page.items.length, page.total);
  return (
    <div className="panel">
      <h2>Events</h2>
      <table>
        <thead>
          <tr>
            <th>Time</th>
            <th>Type</th>
            <th>ID</th>
            <th>Objects</th>
          </tr>
        </thead>
        <tbody>
          {page.items.map((event) => (
            <tr key={event.id}>
              <td className="mono">{formatTime(event.time)}</td>
              <td>{event.eventType}</td>
              <td className="mono">{event.id}</td>
              <td>
                {event.objects.slice(0, OBJECT_CHIP_LIMIT).map((obj) => (
                  <span className="chip" key={`${obj.id}:${obj.qualifier}`} title={obj.qualifier}>
                    {obj.id}
                  </span>
                ))}
                {event.objects.length > OBJECT_CHIP_LIMIT ? (
                  <span className="chip more">+{event.objects.length - OBJECT_CHIP_LIMIT}</span>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="pager">
        <button onClick={() => onPage(Math.max(0, page.offset - PAGE_SIZE))} disabled={page.offset === 0}>
          ← Prev
        </button>
        <span>
          {from.toLocaleString()}–{to.toLocaleString()} of {page.total.toLocaleString()}
        </span>
        <button onClick={() => onPage(page.offset + PAGE_SIZE)} disabled={to >= page.total}>
          Next →
        </button>
      </div>
    </div>
  );
}

export default function App() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [page, setPage] = useState<EventsPage | null>(null);
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (at: number) => {
    try {
      const [s, p] = await Promise.all([fetchSummary(), fetchEvents(at, PAGE_SIZE)]);
      setSummary(s);
      setPage(p);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh(offset);
  }, [refresh, offset]);

  useEffect(() => {
    const timer = setInterval(() => {
      fetchStatus()
        .then((status) => {
          if (summary && status.modified !== summary.modified) {
            void refresh(offset);
          }
        })
        .catch(() => setError("server unreachable"));
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [summary, offset, refresh]);

  if (error && !summary) {
    return <div className="error">{error}</div>;
  }
  if (!summary || !page) {
    return <div className="loading">loading…</div>;
  }

  const fileName = summary.path.split("/").pop() ?? summary.path;
  return (
    <>
      <header>
        <span className="brand">ocel-studio</span>
        <span className="file" title={summary.path}>
          {fileName}
        </span>
        <span className="modified">updated {formatTime(summary.modified)}</span>
      </header>
      {error ? <div className="error">{error}</div> : null}
      <main>
        <div className="cards">
          <StatCard label="Events" value={summary.events.toLocaleString()} />
          <StatCard label="Objects" value={summary.objects.toLocaleString()} />
          <StatCard
            label="Time range"
            value={summary.timeRange ? formatTime(summary.timeRange.start) : "—"}
            hint={summary.timeRange ? `→ ${formatTime(summary.timeRange.end)}` : undefined}
          />
          <StatCard
            label="Validation"
            value={summary.violations.length === 0 ? "valid" : `${summary.violations.length} violations`}
          />
        </div>
        {summary.violations.length > 0 ? (
          <details className="panel violations">
            <summary>Violations ({summary.violations.length})</summary>
            <ul>
              {summary.violations.map((violation) => (
                <li key={violation}>{violation}</li>
              ))}
            </ul>
          </details>
        ) : null}
        <div className="columns">
          <TypeTable title="Event types" rows={summary.eventTypes} />
          <TypeTable title="Object types" rows={summary.objectTypes} />
        </div>
        <EventsPanel page={page} onPage={setOffset} />
      </main>
    </>
  );
}
