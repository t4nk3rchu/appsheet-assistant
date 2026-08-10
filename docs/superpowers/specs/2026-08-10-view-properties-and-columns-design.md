# View section: full property control + column order

**Date:** 2026-08-10
**Scope:** Extend `add_view`/`set_view` so the extension can drive (A) any simple property of any view type via a generic escape-hatch, (B) a few composite per-type properties as first-class typed fields (hybrid), and (C) table-view column order (auto/manual, add/remove, reorder).

Build order: **A → B → C**, each committed separately. One spec, phased build.

## Live DOM facts (verified against ECT System 2.0 editor)

- VFE view panes use the same `.FormControl[data-label="…"]` + `.FormSection` / `.CollapseExpandButton` markup as the column editor. So `afSetPanelProp` (column-panel generic setter: dropdown/checkbox/switch/enum/expression/number/MUI-select + auto-expand collapsed sections) works directly on a view pane.
- Chart view: controls include `Chart type`, `Chart columns` (an `OrderedListControl`), `Chart colors`, `Trend line`, `Show legend`.
- Table view: `Column order` is an `EnumControl` with `data-value` `automatic | manual`. Manual reveals a widget with one checkbox per column (`MuiFormControlLabel` ×N) plus `Add` / `Remove` / `Edit` buttons. Rows have **no `draggable` attribute** — reorder is a JS-sort widget; **the drag handle appears on row hover** (per user), then pointer-drag.

## Component A — generic view property escape-hatch

- Reuse the existing `properties?: Record<string,string>` field for `add_view`/`set_view`.
- New helper `afVfeSetProp(pane, label, value)` — thin wrapper that calls `afSetPanelProp(pane, label, value)` (reused). Add a VFE-specific fallback only if a control kind isn't handled.
- `afFillView`: after the typed fields, loop `ch.properties` via the helper; collect per-label failures into `failed[]` like the other setters.
- Validation (`changeset.ts`): run `normProperties` for view ops (coerce to string, drop empties).
- Prompt (`prompts.ts`): document the view `properties` escape-hatch + a cheat-sheet of common labels per view type (Chart colors, Trend line, Show legend, Map/Calendar keys, Detail "Show ...", etc.). Instruct: use exact VFE labels; use typed fields where they exist.

## Component B — first-class typed fields (hybrid)

For composite controls `afSetPanelProp` can't drive:
- `chartType?: string` — the Chart type dropdown (validate against a known list; warn otherwise).
- `chartColumns?: string[]` — reuse `afVfeOrderedList` (MuiSelect per row). Warn on columns missing from the table.
- (Keep the first-class set minimal; everything else rides the escape-hatch.)

## Component C — table-view column order

New `Change` fields:
- `columnOrder?: "automatic" | "manual"` — sets the EnumControl.
- `viewColumns?: string[]` — the visible columns, in desired order. (New name; does NOT reuse format-rule `columns`.)

Apply (`afFillView`, table views):
1. Set `Column order` EnumControl to `columnOrder` (via `afVfeEnum` / `afVfeClickOption`). If `viewColumns` given and `columnOrder` unset, default to `manual`.
2. **Add/remove:** in manual mode, check the boxes for columns in `viewColumns`, uncheck the rest (drive the `MuiFormControlLabel` checkboxes; use `Add`/`Remove` buttons if that's the actual affordance — confirm during implementation).
3. **Reorder (spike-gated):** for each target position, hover the row to reveal its drag handle, then synthesize pointerdown → pointermove×N → pointerup to move it. Implement as `afReorderColumns`.

**Reorder is spike-gated.** Before building step 3, run a drag-synthesis spike on the live widget (hover-to-reveal-handle, then pointer drag). If it can't be driven reliably, ship steps 1–2 (auto/manual + add/remove) and defer reorder to a follow-up — do NOT block A/B/the rest of C. Log the deferral clearly.

Validation (`changeset.ts`, add_view/set_view):
- `columnOrder` ∈ {automatic, manual} else error.
- `viewColumns` must be array of strings; warn on names missing from the view's table.
- `chartType` string; `chartColumns` array; warn on unknown columns.

## Out of scope

- Non-table column reorder widgets beyond the shared pattern.
- Bulk view-type migrations.

## Risks

- Reorder drag synthesis (spike-gated, fallback defined above).
- `afSetPanelProp` reuse on VFE panes assumed from shared markup — confirm on first implementation; add a VFE fallback branch if a control kind slips through.
