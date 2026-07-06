import { useCallback, useEffect, useState } from "react";
import {
  deleteRecipe,
  fetchRecipes,
  previewTransform,
  saveRecipe,
  saveSource,
  type LogEntry,
  type Recipe,
  type RecipeView,
  type SourceView,
  type TransformPreview,
} from "../api.ts";
import { useMessages } from "../i18n.tsx";
import { emptyStep, StepEditor, stepKind, stepSummary } from "./StepEditor.tsx";

export default function RecipesSection({
  logs,
  activeLog,
  onSourcesChanged,
}: {
  logs: LogEntry[];
  activeLog: string | null;
  onSourcesChanged: (request: Promise<SourceView[]>) => void;
}) {
  const t = useMessages();
  const [recipes, setRecipes] = useState<RecipeView[] | null>(null);
  const [editing, setEditing] = useState<Recipe | null>(null);
  const [preview, setPreview] = useState<TransformPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sourcify, setSourcify] = useState<{ recipe: RecipeView; input: string; output: string } | null>(null);

  const refresh = useCallback(() => {
    fetchRecipes()
      .then((next) => {
        setRecipes(next);
        setError(null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const act = (request: Promise<RecipeView[]>) => {
    request
      .then((next) => {
        setRecipes(next);
        setError(null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  };

  const runPreview = (recipe: Recipe) => {
    setPreviewing(true);
    previewTransform(recipe)
      .then((result) => {
        setPreview(result);
        setError(null);
        setPreviewing(false);
      })
      .catch((err) => {
        setPreview(null);
        setPreviewing(false);
        setError(err instanceof Error ? err.message : String(err));
      });
  };

  const registerSource = () => {
    if (!sourcify) {
      return;
    }
    const { recipe, input, output } = sourcify;
    onSourcesChanged(
      saveSource(
        recipe.name,
        "ocel-transform",
        ["--in", input, "--recipe", recipe.file, "--out", output],
        undefined,
        { input, output },
      ),
    );
    setSourcify(null);
  };

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>{t.recipesPanel}</h2>
      </div>
      <p className="muted guide">{t.recipesHint}</p>
      {error ? <div className="error">{error}</div> : null}
      {recipes === null ? (
        <div className="loading">{t.loading}</div>
      ) : recipes.length > 0 ? (
        <table>
          <thead>
            <tr>
              <th>{t.srcNameCol}</th>
              <th>{t.recipeStepsCol}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {recipes.map((recipe) => (
              <tr key={recipe.name}>
                <td className="mono">{recipe.name}</td>
                <td className="muted">{recipe.steps.map(stepSummary).join(" → ")}</td>
                <td className="num">
                  <button
                    className="link-button"
                    onClick={() => {
                      setEditing({ name: recipe.name, steps: recipe.steps });
                      setPreview(null);
                    }}
                  >
                    {t.recipeEditLabel}
                  </button>{" "}
                  <button
                    className="link-button"
                    onClick={() =>
                      setSourcify({
                        recipe,
                        input: activeLog ?? logs[0]?.name ?? "",
                        output: `${(activeLog ?? "log").replace(/\.[^.]+$/, "")}.${recipe.name}.sqlite`,
                      })
                    }
                  >
                    {t.recipeSourceLabel}
                  </button>{" "}
                  <button className="link-button" onClick={() => act(deleteRecipe(recipe.name))}>
                    {t.srcDeleteLabel}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="muted">{t.recipesEmpty}</p>
      )}
      {sourcify ? (
        <div className="source-form">
          <span className="mono">{sourcify.recipe.name}</span>
          <select
            value={sourcify.input}
            onChange={(e) => setSourcify({ ...sourcify, input: e.target.value })}
          >
            {logs.map((log) => (
              <option key={log.name} value={log.name}>
                {log.name}
              </option>
            ))}
          </select>
          <span className="muted">→</span>
          <input
            type="text"
            className="source-command-input"
            value={sourcify.output}
            onChange={(e) => setSourcify({ ...sourcify, output: e.target.value })}
          />
          <button
            className="rerun-button"
            disabled={sourcify.input === "" || sourcify.output.trim() === ""}
            onClick={registerSource}
          >
            {t.recipeRegisterLabel}
          </button>
          <button className="link-button" onClick={() => setSourcify(null)}>
            {t.closeLabel}
          </button>
        </div>
      ) : null}
      {editing === null ? (
        <button
          className="rerun-button"
          onClick={() => {
            setEditing({ name: "", steps: [] });
            setPreview(null);
          }}
        >
          {t.recipeNewLabel}
        </button>
      ) : (
        <div className="recipe-editor">
          <div className="source-form">
            <input
              type="text"
              placeholder={t.srcNamePlaceholder}
              value={editing.name}
              onChange={(e) => setEditing({ ...editing, name: e.target.value })}
            />
            <button
              className="link-button"
              onClick={() =>
                setEditing({ ...editing, steps: [...editing.steps, emptyStep("dropEventTypes")] })
              }
            >
              {t.recipeAddStep}
            </button>
          </div>
          {editing.steps.map((step, index) => (
            <StepEditor
              // eslint-disable-next-line react/no-array-index-key
              key={`${stepKind(step)}-${index}`}
              step={step}
              onChange={(next) => {
                const steps = [...editing.steps];
                steps[index] = next;
                setEditing({ ...editing, steps });
              }}
              onRemove={() =>
                setEditing({ ...editing, steps: editing.steps.filter((_, i) => i !== index) })
              }
            />
          ))}
          <div className="source-form">
            <button
              className="rerun-button"
              disabled={previewing || editing.steps.length === 0}
              onClick={() => runPreview(editing)}
            >
              {previewing ? t.loading : t.recipePreviewLabel}
            </button>
            <button
              className="rerun-button"
              disabled={editing.name.trim() === "" || editing.steps.length === 0}
              onClick={() => {
                act(saveRecipe(editing));
                setEditing(null);
              }}
            >
              {t.recipeSaveLabel}
            </button>
            <button
              className="link-button"
              onClick={() => {
                setEditing(null);
                setPreview(null);
              }}
            >
              {t.closeLabel}
            </button>
          </div>
          <p className="muted guide">{t.recipePreviewNote}</p>
        </div>
      )}
      {preview ? (
        <div className="recipe-preview">
          <table>
            <thead>
              <tr>
                <th>{t.recipeStepCol}</th>
                <th className="num">{t.events}</th>
                <th className="num">{t.objects}</th>
                <th className="num">{t.recipeDroppedCol}</th>
              </tr>
            </thead>
            <tbody>
              {preview.steps.map((step, index) => (
                <tr key={`${step.step}-${index}`}>
                  <td className="mono">{step.step}</td>
                  <td className="num">
                    {step.eventsBefore.toLocaleString()} → {step.eventsAfter.toLocaleString()}
                  </td>
                  <td className="num">
                    {step.objectsBefore.toLocaleString()} → {step.objectsAfter.toLocaleString()}
                  </td>
                  <td className="num">{step.droppedTotal.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {preview.steps
            .filter((step) => step.droppedEvents.length > 0)
            .map((step, index) => (
              <details key={`${step.step}-drop-${index}`} className="misfits">
                <summary>{t.recipeDroppedHeader(step.step, step.droppedTotal.toLocaleString())}</summary>
                <table>
                  <tbody>
                    {step.droppedEvents.map((event) => (
                      <tr key={event.id}>
                        <td className="mono">{event.eventType}</td>
                        <td>{new Date(event.time).toLocaleString()}</td>
                        <td className="dropped-attrs">
                          {event.attributes.map(([name, value]) => `${name}: ${value}`).join(" · ")}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </details>
            ))}
        </div>
      ) : null}
    </div>
  );
}
