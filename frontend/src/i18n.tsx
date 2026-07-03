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
  dataIntro: (start: string, end: string, events: string, type: string, objects: string) => string;
  insightHappyTitle: string;
  insightHappy: (type: string, pct: string, count: string, total: string, path: string) => string;
  insightWaitTitle: string;
  insightWait: (from: string, to: string, freq: string, dur: string) => string;
  insightWaitLoop: (activity: string, freq: string, dur: string) => string;
  insightExceptionTitle: string;
  insightPathTitle: string;
  insightPath: (happy: string, rest: string, diff: string) => string;
  leadCol: string;
  insightException: (pct: string, count: string) => string;
  copyLabel: string;
  eventTypesHint: string;
  objectTypesHint: string;
  flowHint: string;
  variantsHint: string;
  eventsHint: string;
  flowPanel: string;
  detailLabel: string;
  edgesShown: (shown: number, total: number) => string;
  duration: (secs: number) => string;
  timesLabel: (n: string) => string;
  tipMoves: (n: string, pct: string) => string;
  tipWait: (median: string, mean: string) => string;
  tipObjects: (n: string) => string;
  tipLoopTitle: (activity: string) => string;
  tipNodeEvents: (events: string, objects: string) => string;
  tipNodeStartEnd: (starts: string, ends: string) => string;
  modelPanel: string;
  modelHint: string;
  opSequence: string;
  opExclusive: string;
  opParallel: string;
  opLoop: string;
  opTau: string;
  variantsPanel: string;
  objectTypeLabel: string;
  shareCol: string;
  sequenceCol: string;
  coverage: (withEvents: string, objects: string) => string;
  moreVariants: (shown: number, total: number) => string;
  themeTitle: string;
  langTitle: string;
  guidesTitle: string;
}

export const MESSAGES: Record<Lang, Messages> = {
  en: {
    events: "Events",
    objects: "Objects",
    timeRange: "Time range",
    validation: "Validation",
    valid: "well-formed OCEL",
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
    dataIntro: (start, end, events, type, objects) =>
      `Process discovery from ${events} recorded events (${start} – ${end}): how ${type} (${objects} objects) actually flowed — not how it was supposed to.`,
    insightHappyTitle: "Happy path",
    insightHappy: (type, pct, count, total, path) =>
      `${pct}% of ${type} (${count}/${total}) follow “${path}”.`,
    insightWaitTitle: "Biggest bottleneck",
    insightWait: (from, to, freq, dur) =>
      `The most time is lost between ${from} → ${to}: ${freq} moves × median ${dur}.`,
    insightWaitLoop: (activity, freq, dur) =>
      `The most time is lost repeating ${activity}: ${freq} repeats × median ${dur}.`,
    insightExceptionTitle: "Exceptions",
    insightPathTitle: "Path difference",
    insightPath: (happy, rest, diff) =>
      `The most common path takes a median ${happy}; every other path a median ${rest} (+${diff}, measured).`,
    leadCol: "Lead (median)",
    insightException: (pct, count) =>
      `${pct}% (${count} objects) take a path other than the most common one.`,
    copyLabel: "Copy this sentence",
    eventTypesHint: "The activities recorded in this log, and how often each happened.",
    objectTypesHint:
      "The entities flowing through the process. Every analysis below is per object type — one object's events form one trace.",
    flowHint:
      "The process map: how objects of this type move between activities. Thicker arrows = more frequent; each label shows how many times the move happened and ⏱ the median wait before the next step. Hover anything for details.",
    variantsHint:
      "The distinct paths taken. The top row is the most common way through the process.",
    eventsHint: "The raw events in time order.",
    flowPanel: "Flow",
    detailLabel: "Detail",
    edgesShown: (shown, total) =>
      `Showing the ${shown} strongest of ${total} paths — raise Detail to see more.`,
    duration: (secs) => {
      if (secs >= 86400) {
        return `${(secs / 86400).toFixed(1)} days`;
      }
      if (secs >= 3600) {
        return `${(secs / 3600).toFixed(1)} hrs`;
      }
      if (secs >= 60) {
        return `${Math.round(secs / 60)} min`;
      }
      return `${Math.round(secs)} sec`;
    },
    timesLabel: (n) => `${n} times`,
    tipMoves: (n, pct) => `Happened ${n} times (${pct} of all moves)`,
    tipWait: (median, mean) => `Wait before the next step: median ${median}, mean ${mean}`,
    tipObjects: (n) => `${n} objects took this path`,
    tipLoopTitle: (activity) => `${activity} repeats itself`,
    tipNodeEvents: (events, objects) => `Happened ${events} times across ${objects} objects`,
    tipNodeStartEnd: (starts, ends) => `Starts a trace ${starts}×, ends one ${ends}×`,
    modelPanel: "Model",
    modelHint:
      "Discovered with the basic inductive miner (sound by construction). How to read: → in this order · ✕ one of these · ＋ together, any order · ↺ repeats · τ nothing happens.",
    opSequence: "in this order",
    opExclusive: "one of these",
    opParallel: "together, in any order",
    opLoop: "repeats",
    opTau: "nothing happens (skip)",
    variantsPanel: "Variants",
    objectTypeLabel: "Object type",
    shareCol: "Share",
    sequenceCol: "Sequence",
    coverage: (withEvents, objects) => `${withEvents} of ${objects} objects have events`,
    moreVariants: (shown, total) => `showing top ${shown} of ${total} variants`,
    themeTitle: "Theme",
    langTitle: "Language",
    guidesTitle: "Reading guides",
  },
  ja: {
    events: "イベント",
    objects: "オブジェクト",
    timeRange: "期間",
    validation: "検証",
    valid: "OCEL形式OK",
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
    dataIntro: (start, end, events, type, objects) =>
      `${start}〜${end} の記録 ${events} イベントからの「プロセス発見」です — ${type}（${objects} 件）が「本来どう動くべきか」ではなく「実際どう動いたか」を映します。`,
    insightHappyTitle: "ハッピーパス",
    insightHappy: (type, pct, count, total, path) =>
      `${type} の ${pct}%（${count}/${total} 件）は「${path}」の順で完了する。`,
    insightWaitTitle: "最大のボトルネック",
    insightWait: (from, to, freq, dur) =>
      `最も時間が失われているのは ${from} → ${to} — ${freq}回 × 中央値 ${dur}。`,
    insightWaitLoop: (activity, freq, dur) =>
      `最も時間が失われているのは ${activity} の繰り返し — ${freq}回 × 中央値 ${dur}。`,
    insightExceptionTitle: "例外",
    insightPathTitle: "経路の差",
    insightPath: (happy, rest, diff) =>
      `最頻経路の実測リードタイムは中央値 ${happy}。それ以外の経路は ${rest}（+${diff}）。`,
    leadCol: "所要（中央値）",
    insightException: (pct, count) =>
      `${pct}%（${count} 件）は最頻経路以外を通る。`,
    copyLabel: "この文をコピー",
    eventTypesHint: "このログに記録されている活動と、それぞれの発生回数。",
    objectTypesHint:
      "プロセスを流れる実体。以下の分析はすべてこの型ごとに行われます — 1オブジェクトのイベント列が1トレースです。",
    flowHint:
      "プロセスマップ: この型のオブジェクトが活動間をどう移動したか。太い矢印ほど頻度が高く、ラベルは「移動した回数」と「⏱ 次の活動までの待ち時間（中央値）」。カーソルを合わせると詳しい説明が出ます。",
    variantsHint: "通り方のパターン一覧。上の行ほど多くのオブジェクトが同じ経路を通っています。",
    eventsHint: "時刻順の生イベント。",
    flowPanel: "プロセスの流れ",
    detailLabel: "詳細度",
    edgesShown: (shown, total) =>
      `全 ${total} 本のうち主要な ${shown} 本を表示中 — 詳細度を上げると増えます。`,
    duration: (secs) => {
      if (secs >= 86400) {
        return `${(secs / 86400).toFixed(1)}日`;
      }
      if (secs >= 3600) {
        return `${(secs / 3600).toFixed(1)}時間`;
      }
      if (secs >= 60) {
        return `${Math.round(secs / 60)}分`;
      }
      return `${Math.round(secs)}秒`;
    },
    timesLabel: (n) => `${n}回`,
    tipMoves: (n, pct) => `${n}回発生（全移動の ${pct}）`,
    tipWait: (median, mean) => `次の活動までの待ち: 中央値 ${median}・平均 ${mean}`,
    tipObjects: (n) => `${n} 個のオブジェクトがこの経路を通過`,
    tipLoopTitle: (activity) => `${activity} の繰り返し`,
    tipNodeEvents: (events, objects) => `${events}回発生・${objects} 個のオブジェクトが通過`,
    tipNodeStartEnd: (starts, ends) => `トレースの開始 ${starts}回・終了 ${ends}回`,
    modelPanel: "プロセスの構造",
    modelHint:
      "basic inductive miner による発見（構成上 sound）。読み方: → この順で進む ・ ✕ どれか1つ ・ ＋ 同時（順不同）・ ↺ 繰り返し ・ τ 何もしない。",
    opSequence: "この順で進む",
    opExclusive: "どれか1つ",
    opParallel: "同時（順不同）",
    opLoop: "繰り返し",
    opTau: "何もしない（スキップ）",
    variantsPanel: "よくある進み方",
    objectTypeLabel: "オブジェクトの種類",
    shareCol: "割合",
    sequenceCol: "シーケンス",
    coverage: (withEvents, objects) =>
      `${objects} オブジェクト中 ${withEvents} 件がイベントを持ちます`,
    moreVariants: (shown, total) => `全 ${total} バリアント中 上位 ${shown} 件を表示`,
    themeTitle: "テーマ",
    langTitle: "言語",
    guidesTitle: "読み方ガイド",
  },
};

const I18nContext = createContext<Messages>(MESSAGES.en);

export const I18nProvider = I18nContext.Provider;

export function useMessages(): Messages {
  return useContext(I18nContext);
}
