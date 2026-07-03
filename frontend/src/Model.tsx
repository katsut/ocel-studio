import { useEffect, useState } from "react";
import { fetchModel, type ProcessTree, type TypeCount } from "./api.ts";
import { useMessages } from "./i18n.tsx";

const OPERATOR: Record<string, string> = {
  sequence: "→",
  exclusive: "✕",
  parallel: "＋",
  loop: "↺",
};

function TreeNode({ tree }: { tree: ProcessTree }) {
  const t = useMessages();
  if (tree.type === "activity") {
    return <span className="tree-activity">{tree.label}</span>;
  }
  if (tree.type === "tau") {
    return (
      <span className="tree-tau" title={t.opTau}>
        τ
      </span>
    );
  }
  const horizontal = tree.type === "sequence";
  const opTitle: Record<string, string> = {
    sequence: t.opSequence,
    exclusive: t.opExclusive,
    parallel: t.opParallel,
    loop: t.opLoop,
  };
  return (
    <span className={`tree-group tree-${tree.type}`}>
      <span className="tree-op" title={opTitle[tree.type]}>
        {OPERATOR[tree.type]}
      </span>
      <span className={horizontal ? "tree-row" : "tree-col"}>
        {tree.children.map((child, i) => (
          <TreeNode key={i} tree={child} />
        ))}
      </span>
    </span>
  );
}

export default function ModelPanel({
  types,
  preferred,
  modified,
}: {
  types: TypeCount[];
  preferred: string;
  modified: string;
}) {
  const t = useMessages();
  const [selected, setSelected] = useState<string>("");
  const [model, setModel] = useState<{ forType: string; tree: ProcessTree } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fallback =
    preferred !== "" && types.some((ty) => ty.name === preferred)
      ? preferred
      : (types[0]?.name ?? "");
  const active =
    selected !== "" && types.some((ty) => ty.name === selected) ? selected : fallback;

  useEffect(() => {
    if (active === "") {
      return;
    }
    fetchModel(active)
      .then((tree) => {
        setModel({ forType: active, tree });
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
        <h2>{t.modelPanel}</h2>
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
      {model && model.forType === active ? (
        <div className="tree-scroll">
          <TreeNode tree={model.tree} />
        </div>
      ) : (
        <div className="loading">{t.loading}</div>
      )}
      <p className="muted guide">{t.modelHint}</p>
    </div>
  );
}
