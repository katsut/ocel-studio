import { useCallback, useEffect, useState } from "react";
import {
  fetchLogs,
  fetchSources,
  openLog,
  type LogsResponse,
  type SourceView,
} from "./api.ts";
import { type Lang } from "./i18n.tsx";
import FileList from "./workspace/FileList.tsx";
import PipelineDag from "./workspace/PipelineDag.tsx";
import RecipesSection from "./workspace/Recipes.tsx";
import Sources from "./workspace/Sources.tsx";

const SOURCES_POLL_MS = 2000;

export default function WorkspacePanel({
  lang,
  modified,
  onOpened,
}: {
  lang: Lang;
  modified: string;
  onOpened: () => void;
}) {
  const [listing, setListing] = useState<LogsResponse | null>(null);
  const [sources, setSources] = useState<SourceView[] | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refreshLogs = useCallback(() => {
    fetchLogs()
      .then((next) => {
        setListing(next);
        setError(null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  useEffect(() => {
    refreshLogs();
  }, [refreshLogs, modified]);

  // sources (and the files their runs produce) change outside the mtime
  // cycle, so poll both while this screen is visible
  useEffect(() => {
    const check = () => {
      fetchSources()
        .then(setSources)
        .catch((err) => setError(err instanceof Error ? err.message : String(err)));
    };
    check();
    const timer = setInterval(() => {
      check();
      refreshLogs();
    }, SOURCES_POLL_MS);
    return () => clearInterval(timer);
  }, [refreshLogs]);

  const open = (name: string) => {
    setOpening(name);
    openLog(name)
      .then(() => {
        setOpening(null);
        onOpened();
        refreshLogs();
      })
      .catch((err) => {
        setOpening(null);
        setError(err instanceof Error ? err.message : String(err));
      });
  };

  const act = (request: Promise<SourceView[]>) => {
    request
      .then((next) => {
        setSources(next);
        setError(null);
        refreshLogs();
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  };

  return (
    <>
      <FileList lang={lang} listing={listing} error={error} opening={opening} onOpen={open} />
      {listing && sources ? (
        <PipelineDag logs={listing.logs} sources={sources} onOpen={open} />
      ) : null}
      <Sources sources={sources} lang={lang} act={act} />
      {listing ? (
        <RecipesSection
          logs={listing.logs}
          activeLog={listing.logs.find((log) => log.active)?.name ?? null}
          onSourcesChanged={act}
        />
      ) : null}
    </>
  );
}
