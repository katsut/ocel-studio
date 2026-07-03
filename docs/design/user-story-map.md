# User story map

Primary persona: the **business analyst** improving a process without process
mining expertise. Secondary: the process owner (reads results), the data
engineer (connects sources).

## Backbone

```
connect → grasp → dig → verify → share → monitor
```

| Backbone | User stories | Status |
|---|---|---|
| **Connect** | open a log · connect a source and keep it synced · try a sample | file via CLI only ▲ |
| **Grasp** | what is this data, at a glance · the three answers (insights) · the overall flow | ✅ mostly done |
| **Dig** | *show me the cases on this path* · *who went through this edge* · narrow by period · switch object type without losing my question | ❌ **missing entirely** |
| **Verify** | every claim lands on counts and real examples · read one case's timeline | ❌ no case view |
| **Share** | copy the sentence · export a view | copy only ▲ |
| **Monitor** | scheduled sync · change detection | ❌ platform side |

## Diagnosis (2026-07-03)

Only **grasp** is complete. The **dig → verify loop — the thing that makes a
studio a studio — does not exist.** The single scrolling page is a symptom;
the cause is that there is nowhere to drill *to*. This drove ADR 0003.

## Release slices

- **Skeleton (shipped)**: open file, summary, map, variants, model, raw events,
  insight cards, copy, live reload.
- **v1 — the ad-hoc loop**: global context (type / period / selection), variant
  → its cases, edge → its cases, one case's timeline, activity filtering.
- **v2 — platform**: connect UI (connector orchestration), workspace of logs,
  bundled sample, monitoring.
