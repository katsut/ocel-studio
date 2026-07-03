import { createContext, useContext } from "react";

export type Lang = "en" | "ja";

export interface Messages {
  events: string;
  objects: string;
  timeRange: string;
  validation: string;
  valid: string;
  violations: (n: number) => string;
  eventTypes: string;
  objectTypes: string;
  typeCol: string;
  countCol: string;
  eventsPanel: string;
  timeCol: string;
  idCol: string;
  objectsCol: string;
  prev: string;
  next: string;
  rangeOf: (from: string, to: string, total: string) => string;
  updated: (time: string) => string;
  loading: string;
  serverUnreachable: string;
  flowPanel: string;
  variantsPanel: string;
  objectTypeLabel: string;
  shareCol: string;
  sequenceCol: string;
  coverage: (withEvents: string, objects: string) => string;
  moreVariants: (shown: number, total: number) => string;
  themeTitle: string;
  langTitle: string;
}

export const MESSAGES: Record<Lang, Messages> = {
  en: {
    events: "Events",
    objects: "Objects",
    timeRange: "Time range",
    validation: "Validation",
    valid: "valid",
    violations: (n) => `${n} violations`,
    eventTypes: "Event types",
    objectTypes: "Object types",
    typeCol: "Type",
    countCol: "Count",
    eventsPanel: "Events",
    timeCol: "Time",
    idCol: "ID",
    objectsCol: "Objects",
    prev: "← Prev",
    next: "Next →",
    rangeOf: (from, to, total) => `${from}–${to} of ${total}`,
    updated: (time) => `updated ${time}`,
    loading: "loading…",
    serverUnreachable: "server unreachable",
    flowPanel: "Flow",
    variantsPanel: "Variants",
    objectTypeLabel: "Object type",
    shareCol: "Share",
    sequenceCol: "Sequence",
    coverage: (withEvents, objects) => `${withEvents} of ${objects} objects have events`,
    moreVariants: (shown, total) => `showing top ${shown} of ${total} variants`,
    themeTitle: "Theme",
    langTitle: "Language",
  },
  ja: {
    events: "イベント",
    objects: "オブジェクト",
    timeRange: "期間",
    validation: "検証",
    valid: "適合",
    violations: (n) => `違反 ${n} 件`,
    eventTypes: "イベント型",
    objectTypes: "オブジェクト型",
    typeCol: "型",
    countCol: "件数",
    eventsPanel: "イベント",
    timeCol: "時刻",
    idCol: "ID",
    objectsCol: "オブジェクト",
    prev: "← 前へ",
    next: "次へ →",
    rangeOf: (from, to, total) => `${total} 件中 ${from}–${to}`,
    updated: (time) => `更新 ${time}`,
    loading: "読み込み中…",
    serverUnreachable: "サーバに接続できません",
    flowPanel: "フロー",
    variantsPanel: "バリアント",
    objectTypeLabel: "オブジェクト型",
    shareCol: "割合",
    sequenceCol: "シーケンス",
    coverage: (withEvents, objects) =>
      `${objects} オブジェクト中 ${withEvents} 件がイベントを持ちます`,
    moreVariants: (shown, total) => `全 ${total} バリアント中 上位 ${shown} 件を表示`,
    themeTitle: "テーマ",
    langTitle: "言語",
  },
};

const I18nContext = createContext<Messages>(MESSAGES.en);

export const I18nProvider = I18nContext.Provider;

export function useMessages(): Messages {
  return useContext(I18nContext);
}
