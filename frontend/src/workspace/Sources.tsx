import { useState } from "react";
import {
  deleteSource,
  runSource,
  saveSource,
  setSecret,
  splitCommandLine,
  type EnvValue,
  type SourceView,
} from "../api.ts";
import { useMessages, type Lang } from "../i18n.tsx";
import SourceRow from "./SourceRow.tsx";

export default function Sources({
  sources,
  lang,
  act,
}: {
  sources: SourceView[] | null;
  lang: Lang;
  act: (request: Promise<SourceView[]>) => void;
}) {
  const t = useMessages();
  const [newName, setNewName] = useState("");
  const [newCommand, setNewCommand] = useState("");

  const add = () => {
    const parts = splitCommandLine(newCommand);
    if (newName.trim() === "" || parts.length === 0) {
      return;
    }
    act(saveSource(newName.trim(), parts[0], parts.slice(1)));
    setNewName("");
    setNewCommand("");
  };

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>{t.sourcesPanel}</h2>
      </div>
      <p className="muted guide">{t.sourcesHint}</p>
      {sources === null ? (
        <div className="loading">{t.loading}</div>
      ) : (
        <>
          {sources.length > 0 ? (
            <table>
              <thead>
                <tr>
                  <th>{t.srcNameCol}</th>
                  <th>{t.srcCommandCol}</th>
                  <th>{t.srcStatusCol}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {sources.map((source) => (
                  <SourceRow
                    key={source.name}
                    source={source}
                    lang={lang}
                    onRun={() => act(runSource(source.name))}
                    onDelete={() => act(deleteSource(source.name))}
                  />
                ))}
              </tbody>
            </table>
          ) : (
            <p className="muted">{t.sourcesEmpty}</p>
          )}
          <div className="source-form">
            <input
              type="text"
              placeholder={t.srcNamePlaceholder}
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
            />
            <input
              type="text"
              className="source-command-input"
              placeholder={t.srcCommandPlaceholder}
              value={newCommand}
              onChange={(e) => setNewCommand(e.target.value)}
            />
            <button
              className="rerun-button"
              disabled={newName.trim() === "" || newCommand.trim() === ""}
              onClick={add}
            >
              {t.srcAddLabel}
            </button>
          </div>
          <p className="muted guide">{t.sourcesExactNote}</p>
          <BacklogPresetForm onAdd={act} />
        </>
      )}
    </div>
  );
}

/// A preset is sugar over the same source mechanism: it stores the API key
/// in the OS keychain and composes an `ocel-backlog pull` command + env —
/// never a separate code path (ADR 0004).
function BacklogPresetForm({ onAdd }: { onAdd: (request: Promise<SourceView[]>) => void }) {
  const t = useMessages();
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [projects, setProjects] = useState("");
  const [out, setOut] = useState("backlog.sqlite");
  const [command, setCommand] = useState("ocel-backlog");

  const ready =
    name.trim() !== "" &&
    baseUrl.trim() !== "" &&
    apiKey !== "" &&
    projects.trim() !== "" &&
    out.trim() !== "" &&
    command.trim() !== "";

  const add = () => {
    const sourceName = name.trim();
    const env: Record<string, EnvValue> = {
      BACKLOG_BASE_URL: { value: baseUrl.trim() },
      BACKLOG_API_KEY: { keyring: sourceName },
    };
    const args = ["pull", "--project", projects.trim(), "--out", out.trim()];
    onAdd(
      setSecret(sourceName, apiKey).then(() =>
        saveSource(sourceName, command.trim(), args, env),
      ),
    );
    setName("");
    setBaseUrl("");
    setApiKey("");
    setProjects("");
  };

  return (
    <details className="preset-form">
      <summary>{t.backlogPresetTitle}</summary>
      <p className="muted guide">{t.backlogPresetHint}</p>
      <div className="preset-grid">
        <input
          type="text"
          placeholder={t.srcNamePlaceholder}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <input
          type="text"
          placeholder="https://example.backlog.com"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
        />
        <input
          type="password"
          placeholder={t.backlogApiKeyPlaceholder}
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
        />
        <input
          type="text"
          placeholder={t.backlogProjectsPlaceholder}
          value={projects}
          onChange={(e) => setProjects(e.target.value)}
        />
        <input
          type="text"
          placeholder="backlog.sqlite"
          value={out}
          onChange={(e) => setOut(e.target.value)}
        />
        <input
          type="text"
          placeholder="ocel-backlog"
          value={command}
          onChange={(e) => setCommand(e.target.value)}
        />
        <button className="rerun-button" disabled={!ready} onClick={add}>
          {t.srcAddLabel}
        </button>
      </div>
    </details>
  );
}
