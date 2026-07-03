import { useEffect, useState } from "react";
import {
  fetchLeadTimes,
  fetchVariants,
  type LeadTimeReport,
  type VariantsResponse,
} from "./api.ts";
import { useMessages } from "./i18n.tsx";

export default function VariantsPanel({
  objectType,
  modified,
  onShowCases,
}: {
  objectType: string;
  modified: string;
  onShowCases: (activities: string[]) => void;
}) {
  const t = useMessages();
  const [report, setReport] = useState<VariantsResponse | null>(null);
  const [leads, setLeads] = useState<LeadTimeReport | null>(null);
  const [error, setError] = useState<string | null>(null);


  useEffect(() => {
    if (objectType === "") {
      return;
    }
    Promise.all([fetchVariants(objectType), fetchLeadTimes(objectType)])
      .then(([r, l]) => {
        setReport(r);
        setLeads(l);
        setError(null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [objectType, modified]);

    return (
    <div className="panel">
      <div className="panel-head">
        <h2>{t.variantsPanel}</h2>
      </div>
      <p className="muted guide">{t.variantsHint}</p>
      {error ? <div className="error">{error}</div> : null}
      {report && report.objectType === objectType ? (
        <>
          <p className="muted">
            {t.coverage(
              report.withEvents.toLocaleString(),
              report.objects.toLocaleString(),
            )}
          </p>
          <table>
            <thead>
              <tr>
                <th className="num">{t.countCol}</th>
                <th>{t.shareCol}</th>
                <th className="num">{t.leadCol}</th>
                <th>{t.sequenceCol}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {report.variants.map((variant) => {
                const share =
                  report.withEvents === 0 ? 0 : variant.count / report.withEvents;
                const lead = leads?.variants.find(
                  (v) => v.activities.join("\u0000") === variant.activities.join("\u0000"),
                );
                return (
                  <tr key={variant.activities.join("→")}>
                    <td className="num">{variant.count.toLocaleString()}</td>
                    <td className="share">
                      <div className="bar">
                        <div
                          className="bar-fill"
                          style={{ width: `${Math.max(share * 100, 1)}%` }}
                        />
                      </div>
                      <span>{(share * 100).toFixed(1)}%</span>
                    </td>
                    <td className="num">{lead ? t.duration(lead.medianSecs) : "—"}</td>
                    <td>
                      <button
                        className="link-button"
                        onClick={() => onShowCases(variant.activities)}
                      >
                        {t.showCases} →
                      </button>
                    </td>
                    <td>
                      {variant.activities.map((activity, i) => (
                        <span key={`${activity}-${i}`}>
                          {i > 0 ? <span className="arrow"> → </span> : null}
                          <span className="chip">{activity}</span>
                        </span>
                      ))}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {report.totalVariants > report.variants.length ? (
            <p className="muted">
              {t.moreVariants(report.variants.length, report.totalVariants)}
            </p>
          ) : null}
        </>
      ) : (
        <div className="loading">{t.loading}</div>
      )}
    </div>
  );
}
