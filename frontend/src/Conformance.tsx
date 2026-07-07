import { useEffect, useState } from "react";
import {
  deleteRegisteredModel,
  fetchConformance,
  fetchRegisteredModels,
  type ConformanceReport,
  type Range,
  type RegisteredModel,
} from "./api.ts";
import { FitnessStrip } from "./Model.tsx";
import { useMessages, type Lang } from "./i18n.tsx";

function formatDate(iso: string, lang: Lang): string {
  return new Date(iso).toLocaleDateString(lang === "ja" ? "ja-JP" : "en-US");
}

export default function ConformancePanel({
  range,
  lang,
  onShowCases,
}: {
  range: Range | null;
  lang: Lang;
  onShowCases: (objectType: string, activities: string[]) => void;
}) {
  const t = useMessages();
  const [models, setModels] = useState<RegisteredModel[] | null>(null);
  const [reports, setReports] = useState<Record<string, ConformanceReport>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [checking, setChecking] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);

  useEffect(() => {
    fetchRegisteredModels()
      .then(setModels)
      .catch((err) => setListError(err instanceof Error ? err.message : String(err)));
  }, []);

  // A report answers "does this period follow the agreement?" — when the
  // period changes, yesterday's answer must not linger.
  useEffect(() => {
    setReports({});
    setErrors({});
  }, [range]);

  const check = (name: string) => {
    setChecking(name);
    setErrors((prev) => {
      const next = { ...prev };
      delete next[name];
      return next;
    });
    fetchConformance(name, range)
      .then((report) => setReports((prev) => ({ ...prev, [name]: report })))
      .catch((err) =>
        setErrors((prev) => ({
          ...prev,
          [name]: err instanceof Error ? err.message : String(err),
        })),
      )
      .finally(() => setChecking(null));
  };

  const remove = (name: string) => {
    deleteRegisteredModel(name)
      .then(setModels)
      .catch((err) => setListError(err instanceof Error ? err.message : String(err)));
  };

  const algoName = (algo: RegisteredModel["algo"]) =>
    algo === "inductive" ? t.algoInductive : algo === "powl" ? t.algoPowl : t.algoAlpha;

  return (
    <>
      <div className="panel">
        <h2>{t.conformancePanel}</h2>
        <p className="muted guide">{t.conformanceHint}</p>
        {listError ? <div className="error">{listError}</div> : null}
        {models === null ? (
          <div className="loading">{t.loading}</div>
        ) : models.length === 0 ? (
          <p className="muted">{t.conformanceEmpty}</p>
        ) : null}
      </div>
      {(models ?? []).map((m) => {
        const report = reports[m.name];
        const scopeText =
          m.scope.from || m.scope.to
            ? `${m.scope.from ?? ""} – ${m.scope.to ?? ""}`
            : t.scopeWholeLog;
        const snapshotPct =
          m.snapshot.fitness.traces > 0
            ? ((m.snapshot.fitness.fitting / m.snapshot.fitness.traces) * 100).toFixed(1)
            : "0";
        return (
          <div className="panel" key={m.name}>
            <div className="panel-head">
              <h2>{m.name}</h2>
              <span className="panel-controls">
                <button
                  className="rerun-button"
                  disabled={checking !== null}
                  onClick={() => check(m.name)}
                >
                  {checking === m.name ? t.checkingLabel : t.checkLabel}
                </button>
                <button className="link-button" onClick={() => remove(m.name)}>
                  {t.srcDeleteLabel}
                </button>
              </span>
            </div>
            <p className="muted">
              {m.objectType} · {algoName(m.algo)}
              {m.params.noise !== undefined
                ? ` · ${t.paramNoise} ${Math.round(m.params.noise * 100)}%`
                : ""}{" "}
              · {t.registeredAt(formatDate(m.createdAt, lang))} · {scopeText}
            </p>
            {m.note !== "" ? <p>{m.note}</p> : null}
            <p className="muted">
              {t.snapshotLine(
                m.snapshot.logFile,
                m.snapshot.events.toLocaleString(),
                m.snapshot.objects.toLocaleString(),
                m.snapshot.fitness.fitting.toLocaleString(),
                m.snapshot.fitness.traces.toLocaleString(),
                snapshotPct,
                (m.snapshot.precision * 100).toFixed(1),
              )}
            </p>
            {errors[m.name] ? <div className="error">{errors[m.name]}</div> : null}
            {report ? (
              <>
                <p
                  className={
                    report.replay.fitting === report.replay.traces ? "meta-ok" : "meta-warn"
                  }
                >
                  {report.replay.fitting === report.replay.traces
                    ? `✓ ${t.confOk}`
                    : `⚠ ${t.confDrift(
                        (report.replay.traces - report.replay.fitting).toLocaleString(),
                      )}`}
                </p>
                <FitnessStrip
                  replay={report.replay}
                  precision={report.precision}
                  onShowCases={(activities) => onShowCases(m.objectType, activities)}
                />
              </>
            ) : null}
          </div>
        );
      })}
    </>
  );
}
