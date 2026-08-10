# Dashboard creation — View entries

**Date:** 2026-08-10
**Scope:** MVP — populate a dashboard view's **View entries** (the list of existing views embedded in it).

## Problem

The autofill engine already supports `add_view`/`set_view` with `viewType: "dashboard"`, but only fills generic view fields (name, type, icon, …). A dashboard's defining content — its **View entries** — has no code path, so the extension creates an *empty* dashboard. Additionally, `add_view` validation requires `table`, but a dashboard view has no "For this data" binding.

## Live DOM (verified against the editor, view "DASHBOARD")

Dashboard view controls: `View name, View type, Position, View entries, Use tabs in mobile view, Interactive mode, Icon, Display name, Show if, Event Actions, App link, Descriptive comment`. **No "For this data".**

`View entries` is an `.OrderedListControl` → `.ListItems` → `.ListItem`, each row:
- `.MuiSelect-select[role="button"]` → the embedded **view name**
- `.DropdownControl select.dropdownSelect` → entry **size** (`Large|Wide|Tall|Small`)
- Add via `button.ListAddItem`; remove via `button.ListRemoveItem`

This is structurally identical to the Sort by / Group by control that `afVfeOrderedList` already drives (`{column, order}` = MuiSelect + `.dropdownSelect`).

## Changes

1. **`src/lib/changeset.ts`**
   - Add `viewEntries?: (string | { view: string; size?: "Large"|"Wide"|"Tall"|"Small" })[]` to `Change`. Normalize bare strings to `{ view }`; drop entries with empty `view`.
   - Relax `add_view`: require `table` only when `viewType !== "dashboard"`.
   - Validation is light (the validator has the table list, not the view list). Coerce shape only; unknown view names surface as apply-time warnings.

2. **`src/content/autofill.ts` — `afFillView`**
   - After `viewType` is set and the pane re-read, if `ch.viewEntries?.length`, fill them by reusing `afVfeOrderedList` against the "View entries" control: map `{ view, size }` → the `{ column, order }` shape the helper already handles. Mark the reuse with a `// ponytail:` comment. No new DOM code.

3. **`src/lib/prompts.ts`**
   - Document dashboards: omit `table`, provide `viewEntries` (existing view names, optional size). Update the `add_view`/`set_view` description lines.

4. **`tests/changeset.test.ts`**
   - One case: dashboard `add_view` with `viewEntries` and no `table` validates ok; `viewEntries` normalized to `{view}` objects.

## Out of scope (add when asked)

"Use tabs in mobile view" / "Interactive mode" toggles; reordering or removing existing entries (append-only, same as Sort by today).

## Residual risk

Only that `afMuiSelectSet` picks a view in the entries MuiSelect — structurally identical to the Sort-by column picker it already drives. Confirm against the live editor after coding.
