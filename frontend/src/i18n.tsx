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
  opSequence: string;
  opExclusive: string;
  opParallel: string;
  opLoop: string;
  opTau: string;
  algoLabel: string;
  algoInductive: string;
  algoHeuristics: string;
  algoAlpha: string;
  algoInductiveDesc: string;
  algoHeuristicsDesc: string;
  algoAlphaDesc: string;
  modelHintInductive: string;
  modelHintHeuristics: string;
  modelHintAlpha: string;
  paramNoise: string;
  paramNoiseHint: string;
  paramDependency: string;
  paramDependencyHint: string;
  paramMinEdge: string;
  rerunLabel: string;
  modelWarnings: string;
  depLabel: (dep: string) => string;
  heuristicsEdgeCount: (n: number) => string;
  variantsPanel: string;
  objectTypeLabel: string;
  shareCol: string;
  sequenceCol: string;
  coverage: (withEvents: string, objects: string) => string;
  moreVariants: (shown: number, total: number) => string;
  themeTitle: string;
  langTitle: string;
  guidesTitle: string;
  rangeTitle: string;
  rangeNote: string;
  navOverview: string;
  navCases: string;
  casesPanel: string;
  casesHint: string;
  caseStartCol: string;
  caseStepsCol: string;
  showCases: string;
  filterVariant: (path: string) => string;
  filterEdge: (from: string, to: string) => string;
  selectionHint: string;
  closeLabel: string;
  clearFilter: string;
  backToCases: string;
  caseTimelineHint: string;
  navMap: string;
  navPaths: string;
  navModel: string;
  navData: string;
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
    opSequence: "in this order",
    opExclusive: "one of these",
    opParallel: "together, in any order",
    opLoop: "repeats",
    opTau: "nothing happens (skip)",
    algoLabel: "Method",
    algoInductive: "Inductive",
    algoHeuristics: "Heuristics",
    algoAlpha: "Alpha",
    algoInductiveDesc:
      "Builds a structure tree that can replay every trace — the safe default.",
    algoHeuristicsDesc:
      "Draws only the connections the log rarely contradicts — best for messy logs.",
    algoAlphaDesc:
      "The 2004 textbook algorithm, shown as a Petri net — for learning, not for noisy data.",
    modelHintInductive:
      "Sound by construction. How to read: → in this order · ✕ one of these · ＋ together, any order · ↺ repeats · τ nothing happens.",
    modelHintHeuristics:
      "Each arrow shows how often it happened and how strongly the log believes in its direction (dependency, up to 1). Not a replayable model — a map of reliable connections.",
    modelHintAlpha:
      "○ is a state (place), boxes are activities (transitions). Honest about its limits: no self-loops, no noise tolerance, at most 20 activities.",
    paramNoise: "Ignore rare flows",
    paramNoiseHint:
      "0% keeps every observed flow. Raising it lets the miner skip infrequent edges so the mainstream structure stands out.",
    paramDependency: "Connection strictness",
    paramDependencyHint:
      "An arrow is kept when the dependency measure reaches this value. Lower it to see more (weaker) connections.",
    paramMinEdge: "Seen at least",
    rerunLabel: "Recompute",
    modelWarnings: "Limits hit on this log",
    depLabel: (dep) => `dependency ${dep}`,
    heuristicsEdgeCount: (n) => `${n} connections kept`,
    variantsPanel: "Variants",
    objectTypeLabel: "Object type",
    shareCol: "Share",
    sequenceCol: "Sequence",
    coverage: (withEvents, objects) => `${withEvents} of ${objects} objects have events`,
    moreVariants: (shown, total) => `showing top ${shown} of ${total} variants`,
    themeTitle: "Theme",
    langTitle: "Language",
    guidesTitle: "Reading guides",
    rangeTitle: "Period",
    rangeNote: "Filtering by period recomputes every screen over the events inside it; cases that span the boundary appear cut.",
    navOverview: "Overview",
    navCases: "Cases",
    casesPanel: "Cases",
    casesHint: "Every row is one real object. Click it to read its full timeline.",
    caseStartCol: "Started",
    caseStepsCol: "Steps",
    showCases: "Cases",
    filterVariant: (path) => `Path: ${path}`,
    filterEdge: (from, to) => `Move: ${from} → ${to}`,
    selectionHint: "Click an activity or an arrow for its numbers.",
    closeLabel: "Close",
    clearFilter: "Clear the filter",
    backToCases: "Back to the list",
    caseTimelineHint:
      "What happened to this one object, in order. Chips are the other objects involved in each event.",
    navMap: "Map",
    navPaths: "Paths",
    navModel: "Model",
    navData: "Data",
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
    opSequence: "この順で進む",
    opExclusive: "どれか1つ",
    opParallel: "同時（順不同）",
    opLoop: "繰り返し",
    opTau: "何もしない（スキップ）",
    algoLabel: "見つけ方",
    algoInductive: "インダクティブ",
    algoHeuristics: "ヒューリスティック",
    algoAlpha: "アルファ",
    algoInductiveDesc:
      "すべてのトレースを再生できる構造の木を作ります。迷ったらこれ。",
    algoHeuristicsDesc:
      "ログがほとんど矛盾しないつながりだけを描きます。乱れたログに強い。",
    algoAlphaDesc:
      "2004年の教科書アルゴリズム。ペトリネットで表示します（学習用。ノイズには弱い）。",
    modelHintInductive:
      "構成上必ず筋が通る（sound）モデル。読み方: → この順で進む ・ ✕ どれか1つ ・ ＋ 同時（順不同）・ ↺ 繰り返し ・ τ 何もしない。",
    modelHintHeuristics:
      "矢印には回数と、ログがその向きをどれだけ信じているか（依存度・最大1）が付きます。再生可能なモデルではなく、確かなつながりの地図です。",
    modelHintAlpha:
      "○ は状態（プレース）、箱は活動（トランジション）。限界に正直: 自己ループ不可・ノイズ耐性なし・活動20個まで。",
    paramNoise: "まれな流れを無視",
    paramNoiseHint:
      "0% は観測された流れをすべて説明します。上げるほど、まれな移動を飛ばして主流の構造を浮かび上がらせます。",
    paramDependency: "つながりの確かさ",
    paramDependencyHint:
      "依存度がこの値以上の矢印だけを残します。下げると弱いつながりも見えます。",
    paramMinEdge: "最低回数",
    rerunLabel: "再計算",
    modelWarnings: "このログで当たった限界",
    depLabel: (dep) => `依存度 ${dep}`,
    heuristicsEdgeCount: (n) => `${n} 本のつながりを表示`,
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
    rangeTitle: "期間",
    rangeNote: "期間で絞ると、その期間内のイベントだけで全画面を再計算します。期間をまたぐケースは途中扱いになります。",
    navOverview: "概要",
    navCases: "ケース",
    casesPanel: "ケース",
    casesHint: "1行が実在の1オブジェクト。クリックするとタイムラインを読めます。",
    caseStartCol: "開始",
    caseStepsCol: "ステップ",
    showCases: "ケース",
    filterVariant: (path) => `経路: ${path}`,
    filterEdge: (from, to) => `移動: ${from} → ${to}`,
    selectionHint: "活動や矢印をクリックすると数字が見られます。",
    closeLabel: "閉じる",
    clearFilter: "絞り込みを解除",
    backToCases: "一覧へ戻る",
    caseTimelineHint:
      "この1オブジェクトに起きたことを時系列で。チップは各イベントに関わった他のオブジェクト。",
    navMap: "マップ",
    navPaths: "経路",
    navModel: "モデル",
    navData: "データ",
  },
};

const I18nContext = createContext<Messages>(MESSAGES.en);

export const I18nProvider = I18nContext.Provider;

export function useMessages(): Messages {
  return useContext(I18nContext);
}
