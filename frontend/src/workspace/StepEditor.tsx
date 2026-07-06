import { type RecipeStep } from "../api.ts";
import { useMessages } from "../i18n.tsx";

type StepKind =
  | "dropEventTypes"
  | "keepEventTypes"
  | "dropEventsWhere"
  | "renameEventTypes"
  | "timeWindow"
  | "keepObjectTypes"
  | "mapObjectIds"
  | "dropObjectsWithoutEvents";

const STEP_KINDS: StepKind[] = [
  "dropEventTypes",
  "keepEventTypes",
  "dropEventsWhere",
  "renameEventTypes",
  "timeWindow",
  "keepObjectTypes",
  "mapObjectIds",
  "dropObjectsWithoutEvents",
];

export function stepKind(step: RecipeStep): StepKind {
  if (typeof step === "string") {
    return step;
  }
  return Object.keys(step)[0] as StepKind;
}

export function emptyStep(kind: StepKind): RecipeStep {
  switch (kind) {
    case "dropEventTypes":
      return { dropEventTypes: [] };
    case "keepEventTypes":
      return { keepEventTypes: [] };
    case "dropEventsWhere":
      return { dropEventsWhere: {} };
    case "renameEventTypes":
      return { renameEventTypes: {} };
    case "timeWindow":
      return { timeWindow: {} };
    case "keepObjectTypes":
      return { keepObjectTypes: [] };
    case "mapObjectIds":
      return { mapObjectIds: { aliases: {} } };
    case "dropObjectsWithoutEvents":
      return "dropObjectsWithoutEvents";
  }
}

const splitList = (raw: string): string[] =>
  raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");

/// "old=new" pairs, comma separated.
const splitRenames = (raw: string): Record<string, string> => {
  const renames: Record<string, string> = {};
  for (const pair of splitList(raw)) {
    const eq = pair.indexOf("=");
    if (eq > 0) {
      renames[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
    }
  }
  return renames;
};

export function StepEditor({
  step,
  onChange,
  onRemove,
}: {
  step: RecipeStep;
  onChange: (next: RecipeStep) => void;
  onRemove: () => void;
}) {
  const t = useMessages();
  const kind = stepKind(step);
  return (
    <div className="step-row">
      <select
        value={kind}
        onChange={(e) => onChange(emptyStep(e.target.value as StepKind))}
      >
        {STEP_KINDS.map((k) => (
          <option key={k} value={k}>
            {t.stepNames[k]}
          </option>
        ))}
      </select>
      {kind === "dropEventTypes" || kind === "keepEventTypes" || kind === "keepObjectTypes" ? (
        <input
          type="text"
          className="step-wide"
          placeholder={t.stepTypesPlaceholder}
          defaultValue={(Object.values(step)[0] as string[]).join(", ")}
          onBlur={(e) => onChange({ [kind]: splitList(e.target.value) } as RecipeStep)}
        />
      ) : kind === "renameEventTypes" ? (
        <input
          type="text"
          className="step-wide"
          placeholder={t.stepRenamePlaceholder}
          defaultValue={Object.entries((step as { renameEventTypes: Record<string, string> }).renameEventTypes)
            .map(([from, to]) => `${from}=${to}`)
            .join(", ")}
          onBlur={(e) => onChange({ renameEventTypes: splitRenames(e.target.value) })}
        />
      ) : kind === "mapObjectIds" ? (
        <input
          type="text"
          className="step-wide"
          placeholder={t.stepAliasPlaceholder}
          defaultValue={Object.entries(
            (step as { mapObjectIds: { aliases: Record<string, string> } }).mapObjectIds.aliases,
          )
            .map(([from, to]) => `${from}=${to}`)
            .join(", ")}
          onBlur={(e) => onChange({ mapObjectIds: { aliases: splitRenames(e.target.value) } })}
        />
      ) : kind === "timeWindow" ? (
        (() => {
          const window = (step as { timeWindow: { from?: string; to?: string } }).timeWindow;
          return (
            <>
              <input
                type="date"
                value={window.from ?? ""}
                onChange={(e) =>
                  onChange({ timeWindow: { ...window, from: e.target.value || undefined } })
                }
              />
              <input
                type="date"
                value={window.to ?? ""}
                onChange={(e) =>
                  onChange({ timeWindow: { ...window, to: e.target.value || undefined } })
                }
              />
            </>
          );
        })()
      ) : kind === "dropEventsWhere" ? (
        (() => {
          const p = (step as { dropEventsWhere: Record<string, string | number | undefined> })
            .dropEventsWhere;
          const set = (key: string, value: string) =>
            onChange({
              dropEventsWhere: { ...p, [key]: value === "" ? undefined : value },
            } as RecipeStep);
          return (
            <>
              <input
                type="text"
                placeholder={t.predEventType}
                defaultValue={(p.eventType as string) ?? ""}
                onBlur={(e) => set("eventType", e.target.value)}
              />
              <input
                type="text"
                placeholder={t.predAttr}
                defaultValue={(p.attr as string) ?? ""}
                onBlur={(e) => set("attr", e.target.value)}
              />
              <input
                type="text"
                className="step-wide"
                placeholder={t.predMatches}
                defaultValue={(p.matches as string) ?? ""}
                onBlur={(e) => set("matches", e.target.value)}
              />
            </>
          );
        })()
      ) : null}
      <button className="link-button" onClick={onRemove}>
        ×
      </button>
    </div>
  );
}

export function stepSummary(step: RecipeStep): string {
  const kind = stepKind(step);
  if (typeof step === "string") {
    return kind;
  }
  const value = Object.values(step)[0];
  if (Array.isArray(value)) {
    return `${kind} (${value.length})`;
  }
  if (kind === "renameEventTypes") {
    return `${kind} (${Object.keys(value as object).length})`;
  }
  if (kind === "mapObjectIds") {
    return `${kind} (${Object.keys((value as { aliases: object }).aliases).length})`;
  }
  return kind;
}
