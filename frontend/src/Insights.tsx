import { useEffect, useState } from "react";
import {
  fetchDfg,
  fetchLeadTimes,
  fetchVariants,
  type Dfg,
  type LeadTimeReport,
  type Range,
  type VariantsResponse,
} from "./api.ts";
import { useMessages } from "./i18n.tsx";
import type { Screen } from "./App.tsx";

interface Card {
  key: string;
  title: string;
  figure: string;
  text: string;
  target: Screen;
}

function shortPath(activities: string[]): string {
  if (activities.length <= 5) {
    return activities.join(" → ");
  }
  return `${activities[0]} → … → ${activities[activities.length - 1]}`;
}

export default function Insights({
  objectType,
  range,
  modified,
  onNavigate,
}: {
  objectType: string;
  range: Range | null;
  modified: string;
  onNavigate: (screen: Screen) => void;
}) {
  const t = useMessages();
  const [variants, setVariants] = useState<VariantsResponse | null>(null);
  const [dfg, setDfg] = useState<Dfg | null>(null);
  const [leads, setLeads] = useState<LeadTimeReport | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      fetchVariants(objectType, range, 1),
      fetchDfg(objectType, range),
      fetchLeadTimes(objectType, range),
    ])
      .then(([v, d, l]) => {
        setVariants(v);
        setDfg(d);
        setLeads(l);
      })
      .catch(() => {
        setVariants(null);
        setDfg(null);
        setLeads(null);
      });
  }, [objectType, range, modified]);

  if (
    !variants ||
    !dfg ||
    variants.objectType !== objectType ||
    variants.withEvents === 0 ||
    variants.variants.length === 0
  ) {
    return null;
  }

  const top = variants.variants[0];
  const happyPct = ((top.count / variants.withEvents) * 100).toFixed(0);
  const cards: Card[] = [
    {
      key: "happy",
      title: t.insightHappyTitle,
      figure: `${happyPct}%`,
      text: t.insightHappy(
        objectType,
        happyPct,
        top.count.toLocaleString(),
        variants.withEvents.toLocaleString(),
        shortPath(top.activities),
      ),
      target: "paths",
    },
  ];

  const bottleneck = dfg.edges.reduce(
    (best, e) => (e.frequency * e.medianSecs > best.frequency * best.medianSecs ? e : best),
    dfg.edges[0],
  );
  if (bottleneck) {
    cards.push({
      key: "wait",
      title: t.insightWaitTitle,
      figure: t.duration(bottleneck.medianSecs),
      text:
        bottleneck.from === bottleneck.to
          ? t.insightWaitLoop(
              bottleneck.from,
              bottleneck.frequency.toLocaleString(),
              t.duration(bottleneck.medianSecs),
            )
          : t.insightWait(
              bottleneck.from,
              bottleneck.to,
              bottleneck.frequency.toLocaleString(),
              t.duration(bottleneck.medianSecs),
            ),
      target: "map",
    });
  }

  const happyLead = leads?.variants.find(
    (v) => v.activities.join("\u0000") === top.activities.join("\u0000"),
  );
  if (leads && happyLead && leads.restCount > 0 && leads.restMedianSecs > happyLead.medianSecs) {
    cards.push({
      key: "path",
      title: t.insightPathTitle,
      figure: `+${t.duration(leads.restMedianSecs - happyLead.medianSecs)}`,
      text: t.insightPath(
        t.duration(happyLead.medianSecs),
        t.duration(leads.restMedianSecs),
        t.duration(leads.restMedianSecs - happyLead.medianSecs),
      ),
      target: "paths",
    });
  }

  const exceptions = variants.withEvents - top.count;
  const exceptionPct = ((exceptions / variants.withEvents) * 100).toFixed(0);
  cards.push({
    key: "exception",
    title: t.insightExceptionTitle,
    figure: `${exceptionPct}%`,
    text: t.insightException(exceptionPct, exceptions.toLocaleString()),
    target: "paths",
  });

  const copy = (card: Card) => {
    void navigator.clipboard.writeText(card.text).then(() => {
      setCopied(card.key);
      setTimeout(() => setCopied(null), 1500);
    });
  };

  return (
    <div className="insights">
      {cards.map((card) => (
        <div
          key={card.key}
          className="insight-card"
          onClick={() => onNavigate(card.target)}
        >
          <div className="card-label">{card.title}</div>
          <div className="insight-figure">{card.figure}</div>
          <p>{card.text}</p>
          <button
            className="insight-copy"
            title={t.copyLabel}
            onClick={(e) => {
              e.stopPropagation();
              copy(card);
            }}
          >
            {copied === card.key ? "✓" : "⧉"}
          </button>
        </div>
      ))}
    </div>
  );
}
