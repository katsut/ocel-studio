import { useEffect, useState } from "react";
import { fetchModel, type ProcessTree } from "./api.ts";
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
  objectType,
  modified,
}: {
  objectType: string;
  modified: string;
}) {
  const t = useMessages();
  const [model, setModel] = useState<{ forType: string; tree: ProcessTree } | null>(null);
  const [error, setError] = useState<string | null>(null);


  useEffect(() => {
    if (objectType === "") {
      return;
    }
    fetchModel(objectType)
      .then((tree) => {
        setModel({ forType: objectType, tree });
        setError(null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [objectType, modified]);

    return (
    <div className="panel">
      <div className="panel-head">
        <h2>{t.modelPanel}</h2>
      </div>
      {error ? <div className="error">{error}</div> : null}
      {model && model.forType === objectType ? (
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
