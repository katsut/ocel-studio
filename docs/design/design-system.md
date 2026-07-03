# ocel-studio design system

Right-sized for this stage: one document plus a CSS token layer. Components are
plain CSS classes in `frontend/src/styles.css`; every value below exists there
as a custom property. When the UI grows past this, revisit — not before.

Two governing decisions inherited from [ADR 0002](../adr/0002-education-first-ux.md):
**plain language first** (titles and guides are content, reviewed like copy) and
**conclusions before evidence** (insight → panel → raw data, top to bottom).

## 1. Color tokens (semantic)

| Token | Light | Dark | Role |
|---|---|---|---|
| `--bg` | `#f6f7f9` | `#10141b` | page plane |
| `--panel` | `#ffffff` | `#181e28` | surfaces (also the chart surface) |
| `--text` | `#1a1f27` | `#e6e9ef` | primary ink |
| `--muted` | `#667085` | `#8b94a7` | secondary ink, guides, axis text |
| `--border` | `#e4e7ec` | `#2a3242` | hairlines |
| `--accent` | `#4657d8` | `#8b97f8` | brand / interactive emphasis — **never a data series** |
| `--chip` | `#eef0fb` | `#232c42` | soft fills (chips, tree nodes, bar tracks) |

Status (fixed, never themed, never reused as series colors; always paired with
an icon or label — color never carries state alone):

| Token | Hex (both modes) | Role |
|---|---|---|
| `--status-good` | `#0ca30c` | valid / success |
| `--status-warning` | `#fab219` | warnings, violations panel |
| `--status-serious` | `#ec835a` | degraded |
| `--status-critical` | `#d03b3b` | errors |

## 2. Layout tokens

- Spacing scale: `--space-1..5` = 4 / 8 / 12 / 16 / 24 px. No off-scale margins.
- Radius: `--radius-s` 6, `--radius-m` 8, `--radius-l` 10 px (cards and panels are `l`, chips `s`–`m`).
- Type scale: 11 (chart annotations) / 12 (guides, chips) / 13 (controls, table body) / 14 (base) / 22 px (card values). System sans everywhere; `tabular-nums` only where columns must align.
- Elevation: one shadow, tooltips only (`--shadow-pop`).

## 3. Data visualization

Method: the dataviz procedure (form → color by job → validate → marks → hover →
accessibility). Parameters for this product:

### Categorical palette (fixed order — never cycled, never regenerated)

Validated with `validate_palette.js` against **our** surfaces
(`#ffffff` light, `#181e28` dark): both modes pass; light has three slots below
3:1 contrast (aqua, yellow, magenta) and dark sits in the CVD floor band —
**both are legal only with the relief rule: marks always carry direct labels or
an adjacent table.** Studio satisfies this everywhere (labels are mandatory UI).

| Slot | Token | Light | Dark |
|---|---|---|---|
| 1 | `--cat-1` | `#2a78d6` | `#3987e5` |
| 2 | `--cat-2` | `#1baf7a` | `#199e70` |
| 3 | `--cat-3` | `#eda100` | `#c98500` |
| 4 | `--cat-4` | `#008300` | `#008300` |
| 5 | `--cat-5` | `#4a3aa7` | `#9085e9` |
| 6 | `--cat-6` | `#e34948` | `#e66767` |
| 7 | `--cat-7` | `#e87ba4` | `#d55181` |
| 8 | `--cat-8` | `#eb6834` | `#d95926` |

**Slot assignment follows the entity, never its rank.** For the OC-DFG overlay,
object types take slots in descending object count *at log load* and keep them:
filtering or re-sorting must never repaint a type. A 9th type folds into "Other".

### Rules in force

- Single-series marks (variant share bars) use `--cat-1`, not `--accent`.
- One axis per chart; two measures = two charts.
- Sequential magnitude = one blue ramp light→dark; diverging = blue↔red with a
  gray midpoint (none in use yet).
- Text wears text tokens (`--text`/`--muted`), never the series color.
- Every multi-series view ships a legend; ≤ 4 series also get direct labels.

## 4. Component inventory

`header` (brand / file / controls) · `intro` (data self-introduction line) ·
`card` (stat tiles) · `panel` + `panel-head` + guide line (`muted`) ·
`table` (sticky-free, hairline rows) · `chip` (ids, activities) ·
share `bar` (track `--chip`, fill `--cat-1`) · `pager` · `panel-controls`
(select, range) · flow marks (`flow-node/edge/labels`, start ● / end ◉,
frequency-scaled stroke) · `flow-tip` (the one elevated element) ·
tree boxes (`tree-activity/group/op`) · `error` (status-critical banner) ·
`violations` (status-warning details).

## 5. Copy tone

- 言い切り (declarative), pasteable into a report: 「注文の 78% は3ステップで完了する」.
- Speak in medians; name the happy-path share first; size exceptions as count × delay.
- Insight sentences are deterministic templates in the i18n dictionaries — same
  data, same sentence. They are content: review as copy, not code.
