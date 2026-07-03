# ADR 0003: Screen-per-question information architecture

- **Date:** 2026-07-03
- **Status:** Accepted
- **Supersedes:** the single-page dashboard layout (implicitly established by
  the first vertical slices)

## Context

The owner's verdict on the one-page dashboard: it is a static report, not an
ad-hoc analysis studio. The user story map (`../design/user-story-map.md`)
locates the cause: the **dig → verify loop is missing** — there is no case
view to drill into, no global context to carry a question across views, and
therefore nothing to navigate *to*. Polishing the single page cannot fix an
information architecture problem.

## Decisions

### 1. One screen answers one question

Sidebar navigation replaces the scroll:

| Screen | The question it answers |
|---|---|
| **Overview** | what is this process, in short? (data intro + insight cards linking onward + type stats) |
| **Map** | how does it flow, where does it stall? (full-screen flow; selecting an edge/node opens a side panel with stats and "the N cases through this edge → Cases") |
| **Paths** | which ways does it run, what differs? (variants with share and lead time; selecting one lists its cases) |
| **Cases** *(new)* | what did one real instance look like? (filterable case list; one object's event timeline with related objects) |
| **Model** | what is the structure? (inductive miner tree; alpha Petri net later, with its warnings) |
| **Data** | the raw material (events and objects tables) |

### 2. Context is global and carried across screens

Object type, time range (later), and the current selection (variant / edge)
live in the header, not in per-panel selectors. Switching screens keeps the
question. This carried context is what makes the tool a studio rather than a
report.

### 3. Every number lands on real cases within two clicks

Insight card → Paths (variant pre-selected) → its cases → one case's
timeline. Claims are always two clicks from evidence — the dig → verify loop
is the product's teaching instrument (extends ADR 0002).

## Build plan

- **P1 skeleton**: sidebar + screen split + the global object-type selector
  (per-panel selectors removed). Mostly a re-homing of existing panels.
- **P2 cases**: `/api/cases` (filtered list) + `/api/case/:id` (timeline) +
  the paths → cases link.
- **P3 map selection panel**: edge/node selection with stats + cases link.
- **P4 global time filter.**
- README screenshot only after the redesign has a face worth showing.

## Consequences

- The insight cards' scroll-to-panel behaviour becomes navigate-to-screen.
- The reading guides and hover layers (ADR 0002) carry over per screen.
- `/api/cases` needs case-level pagination and filters; ocel-mine stays
  computation-only (filtering by variant/edge is a lookup over existing
  results, not new mining).
