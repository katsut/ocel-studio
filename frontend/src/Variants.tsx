import { useEffect, useState } from "react";
import { fetchVariants, type TypeCount, type VariantsResponse } from "./api.ts";
import { useMessages } from "./i18n.tsx";

export default function VariantsPanel({
  types,
  modified,
}: {
  types: TypeCount[];
  modified: string;
}) {
  const t = useMessages();
  const [selected, setSelected] = useState<string>("");
  const [report, setReport] = useState<VariantsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const active =
    selected !== "" && types.some((ty) => ty.name === selected)
      ? selected
      : (types[0]?.name ?? "");

  useEffect(() => {
    if (active === "") {
      return;
    }
    fetchVariants(active)
      .then((r) => {
        setReport(r);
        setError(null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [active, modified]);

  if (active === "") {
    return null;
  }
  return (
    <div className="panel">
      <div className="panel-head">
        <h2>{t.variantsPanel}</h2>
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
      {report && report.objectType === active ? (
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
                <th>{t.sequenceCol}</th>
              </tr>
            </thead>
            <tbody>
              {report.variants.map((variant) => {
                const share =
                  report.withEvents === 0 ? 0 : variant.count / report.withEvents;
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
