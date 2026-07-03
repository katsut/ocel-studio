# ADR 0002: Education-first, insight-first UX

- **Date:** 2026-07-03
- **Status:** Accepted

## Context

Process mining is expert territory; ocel-studio's users are not process mining
experts — they are business analysts and engineers who want answers about their
own processes. The product principle set by the owner: **making the difficult
easy is what UX is; otherwise it is not a product.** A screen must explain
itself and lead with conclusions, not raw data.

A panel discussion (UX, business analyst, process mining consultant, PM,
frontend) reviewed the current dashboard and settled the following.

## Decisions

### 1. Keep the panel structure, add the question each panel answers

Practitioners live in three views (map, variants, cases), which the current
layout already mirrors. Panels stay; each gets its guiding question as a
subtitle ("Where does the work flow?", "How long do things wait?").

### 2. Insight lines are the teaching instrument — no onboarding tour

Every analysis panel opens with one deterministic, template-generated sentence
in plain language, computed from ocel-mine's numbers: the most common path and
its share, the biggest bottleneck edge with its median wait, the share of
objects passing a rework loop. No LLM: same data, same sentence — that
predictability is what teaches. Tours are rejected (seen once, forgotten);
learning happens in the loop *insight sentence → drill into the evidence*.

The deeper aim: the sentences model the analyst's thinking patterns — speak in
medians, start from the happy-path share, weigh exceptions by count × delay.

### 3. Progressive disclosure of terminology, three layers

Plain-language titles (layer 1, shipped) → one-line reading guides
(layer 2, shipped) → expandable "in detail" with the expert terms (layer 3,
planned). No tooltip scatter.

### 4. Dense graphs: backbone default + detail slider + coverage note

The flow view defaults to the backbone (strongest in/out edge per activity)
with a slider adding edges by frequency (shipped). Add a coverage note —
"the visible paths cover N% of all transitions" — so users can judge the
cut instead of trusting it blindly.

### 5. Default to the most case-like object type

Not the most frequent type: the type whose traces look most like cases
(median trace length in a workable band, high share of objects with events).
On the reference Order Management log this picks `orders`, not `items`.

### 6. The empty state is the first teacher

When no file is open, offer a bundled sample log so the first five minutes
demonstrate every panel with real numbers.

## Priorities (owner-facing order)

1. Insight lines (core of the product, differentiator)
2. Case-like default object type
3. Coverage note on the flow filter
4. Expandable evidence ("why this number?")
5. Insight-to-panel highlight linking (later)

## Consequences

- Insight templates live in the i18n dictionaries (ja/en) as functions of
  ocel-mine results; they must stay deterministic.
- Panel subtitles and guides are content, not chrome: they are reviewed like
  copy, not like code comments.
