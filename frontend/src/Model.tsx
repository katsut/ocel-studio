import { useEffect, useState } from "react";
import { fetchModel, type ProcessTree, type TypeCount } from "./api.ts";
import { useMessages } from "./i18n.tsx";

const OPERATOR: Record<string, string> = {
  sequence: "→",
  exclusive: "✕",
  parallel: "∧",
  loop: "↺",
};

function TreeNode({ tree }: { tree: ProcessTree }) {
  if (tree.type === "activity") {
    return <span className="tree-activity">{tree.label}</span>;
  }
  if (tree.type === "tau") {
    return <span className="tree-tau">τ</span>;
  }
  const horizontal = tree.type === "sequence";
  return (
    <span className={`tree-group tree-${tree.type}`}>
      <span className="tree-op" title={tree.type}>
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
  modified,
}: {
  types: TypeCount[];
  modified: string;
}) {
  const t = useMessages();
  const [selected, setSelected] = useState<string>("");
  const [model, setModel] = useState<{ forType: string; tree: ProcessTree } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const active =
    selected !== "" && types.some((ty) => ty.name === selected)
      ? selected
      : (types[0]?.name ?? "");

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
      <p className="muted">{t.modelHint}</p>
    </div>
  );
}
