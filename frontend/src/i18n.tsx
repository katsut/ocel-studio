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
  intro: string;
  eventTypesHint: string;
  objectTypesHint: string;
  flowHint: string;
  variantsHint: string;
  eventsHint: string;
  flowPanel: string;
  detailLabel: string;
  edgesShown: (shown: number, total: number) => string;
  modelPanel: string;
  modelHint: string;
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
    intro:
      "This is your event log as a process: what happened, to which objects, in what order. Pick an object type in the panels below to follow its lifecycle.",
    eventTypesHint: "The activities recorded in this log, and how often each happened.",
    objectTypesHint:
      "The entities flowing through the process. Every analysis below is per object type — one object's events form one trace.",
    flowHint:
      "The process map: how objects of this type move between activities. Thicker edges = more frequent; labels show frequency and the median gap.",
    variantsHint:
      "The distinct paths taken. The top row is the most common way through the process.",
    eventsHint: "The raw events in time order.",
    flowPanel: "Flow",
    detailLabel: "Detail",
    edgesShown: (shown, total) =>
      `Showing the ${shown} strongest of ${total} paths — raise Detail to see more.`,
    modelPanel: "Model",
    modelHint:
      "Discovered with the basic inductive miner (sound by construction): → sequence, ✕ choice, ∧ parallel, ↺ loop, τ silent.",
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
    eventTypes: "活動の種類",
    objectTypes: "オブジェクトの種類",
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
    intro:
      "イベントログをプロセスとして表示しています — 何が・どのオブジェクトに・どの順で起きたか。下の各パネルでオブジェクト型を選ぶと、その型のライフサイクルを追えます。",
    eventTypesHint: "このログに記録されている活動と、それぞれの発生回数。",
    objectTypesHint:
      "プロセスを流れる実体。以下の分析はすべてこの型ごとに行われます — 1オブジェクトのイベント列が1トレースです。",
    flowHint:
      "プロセスマップ: この型のオブジェクトが活動間をどう移動したか。太い矢印ほど頻度が高く、ラベルは回数と所要時間の中央値。",
    variantsHint: "通り方のパターン一覧。上の行ほど多くのオブジェクトが同じ経路を通っています。",
    eventsHint: "時刻順の生イベント。",
    flowPanel: "プロセスの流れ",
    detailLabel: "詳細度",
    edgesShown: (shown, total) =>
      `全 ${total} 本のうち主要な ${shown} 本を表示中 — 詳細度を上げると増えます。`,
    modelPanel: "プロセスの構造",
    modelHint:
      "basic inductive miner による発見（構成上 sound）: → 順次、✕ 排他、∧ 並行、↺ ループ、τ 無音。",
    variantsPanel: "よくある進み方",
    objectTypeLabel: "オブジェクトの種類",
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
