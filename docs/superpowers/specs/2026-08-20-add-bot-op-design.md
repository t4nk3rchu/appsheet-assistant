# add_bot changeset op — design (v1)

## Goal

Add an `add_bot` op to the changeset engine so a changeset can create an AppSheet
Automation **bot**: a data-change **event** plus a **process** of one or more
"Run a data action" steps that each reference an **existing** action.

## Scope (v1)

In:
- Event source = **Data change** only (Adds/Updates/Deletes/All), on a table or slice, with an optional condition and a "Bypass security filters?" toggle.
- Process steps of one task type: **`run_a_data_action`**. Each step is one of two **modes**:
  - **`existing`** (default) — the step's action dropdown ("Custom action" → …) is set to an **already-created action by name**. Only the name is needed; the action must belong to the **bot's event table** (the dropdown lists only that table's actions). This is the general path: any action type (add row / delete / set values / grouped / ref) is created earlier via `add_action`, then picked here.
  - **`custom`** — build a Custom action inline; v1 supports the **`run_action_on_rows`** custom type only (Referenced Table + Referenced rows + Referenced Action). This is the config shown in the reference screenshot.
- Multiple steps per bot.
- **Create only** (`add_bot`). No `set_bot` (edit) yet.

Out (later):
- Other event sources (schedule, webhook, app/chat).
- Other step task types (send email/notification/SMS, call a webhook, call a process, branch, wait, return values).
- **Inline** action creation inside a step (would duplicate the whole `add_action` engine). To get add-row / delete / set-value / grouped / run-on-rows behavior, the changeset creates those actions with `add_action` first, then the bot references them.

## Op schema (`Change`, `src/lib/changeset.ts`)

```jsonc
{
  "op": "add_bot",
  "name": "Cập nhật tồn",              // required — bot name
  "table": "PHIẾU_KHO",                // required — event table/slice (must exist)
  "dataChangeType": "All changes",     // optional — one of: Adds only | Updates only | Deletes only | Adds and updates | All changes. Default: All changes
  "condition": "[trạng_thái_duyệt]=\"Đã Duyệt\"", // optional — event Condition expression
  "bypassSecurity": false,             // optional — "Bypass security filters?" toggle (default false)
  "steps": [                           // required — non-empty array
    // Mode "existing" (default): pick an already-created action from the step's dropdown.
    // Only the action NAME is needed — the action must belong to the bot's event
    // table (`table` above); its behaviour/target/rows are already defined by the
    // add_action that created it. No other fields.
    {
      "type": "run_a_data_action",     // optional — defaults to "run_a_data_action"; other value = error in v1
      "action": "R_VẬT_TƯ",            // required — name of an EXISTING action on the bot's table
      "name":   "Cập nhật vật tư"      // optional — step display name
    },
    // Mode "custom" run_action_on_rows: build the inline custom action (screenshot).
    {
      "type": "run_a_data_action",
      "custom": "run_action_on_rows",  // presence of `custom` = custom mode; v1 only supports this value
      "action": "R_VẬT_TƯ",            // required — the Referenced Action to run on each row
      "table":  "VẬT_TƯ",             // Referenced Table
      "rows":   "[Related CHI_TIẾT_PHIẾU_KHOs][ref_vật_tư]", // Referenced rows expression
      "name":   "Cập nhật vật tư"
    }
  ]
}
```

Step-mode discriminator: **`custom`** absent → `existing` mode — pick `action` from the step's dropdown; the action must exist on the bot's event `table`; `table`/`rows` are not used (ignored if present). `custom: "run_action_on_rows"` → custom mode — inline Referenced Table/rows/Action. `action` is required in both modes and names an existing action.

## Validation (`validateChangeset`)

- `name` required, string. `table` required and must be in `tableNames` (else error).
- `dataChangeType` optional; warn (not block) if not one of the allowed set.
- `condition` optional; must be a string if present (`'condition' phải là chuỗi`).
- `bypassSecurity` optional; boolean.
- `steps` must be a non-empty array (`add_bot cần ít nhất 1 step`).
  - each `step.type` (if present) must equal `run_a_data_action` (else `step.type không hỗ trợ: <v> (chỉ 'run_a_data_action')`); default it to `run_a_data_action`.
  - `step.custom` optional; if present must equal `run_action_on_rows` (else `step.custom không hỗ trợ: <v> (chỉ 'run_action_on_rows')`). Absent ⇒ `existing` mode.
  - `step.action` required, string (an existing action name — the dropdown pick in `existing` mode, the Referenced Action in `custom` mode).
  - `existing` mode: `table`/`rows` are not used — drop them silently (the action already carries its config, and it must live on the bot's event `table`).
  - `custom` mode: `step.table` optional (warn if set and missing from `tableNames`); `step.rows` optional, string if present.
  - `step.name` optional; string if present.
- Summary line: `add_bot  "<name>" @ <table>  (<n> steps)`.

## Engine (`afFillBot`, `src/content/autofill.ts`)

Reuses existing primitives: `afMuiSelectSet`, `afSetExpression`, `ttSetSelect`, `afSetText`, `afWaitFor`, `afSetPanelProp`, the "Create a new X" dialog pattern, and hash routing.

1. `afGotoBots()` — set `location.hash = "Automation.Bots"` + fire `hashchange`, wait for the "Create a new automation" button (mirrors `afGotoFormatRules`/`afGotoViews`).
2. Click **Create a new automation** → wait `.MuiDialog-paper` → click **Create a new bot** → wait for the fresh bot canvas ("Configure event" / "Add a step").
3. Set **bot name** via the editable title/name input.
4. **Configure event** (data change): ensure the event card exists (click "Configure event" if needed), select it, then set Event source = Change, `Table` (select), `Data change type`, `Condition` (`afSetExpression`), `Bypass security filters?` toggle.
5. **Per step**: click **Add a step** → choose the "Run a data action" task type. Then by mode:
   - **`existing`**: set the step's **action dropdown** (the "Custom action" MuiSelect) to `step.action` via `afMuiSelectSet` — the dropdown already lists the bot table's actions; nothing else to set.
   - **`custom` = run_action_on_rows**: select the **"Run action on rows"** task-type button in the right-pane toolbar (keep "Custom action"), then set `Referenced Table` (`afMuiSelectSet`), `Referenced Action` = `step.action` (`afMuiSelectSet`), `Referenced rows` (`afSetExpression`).
   - Set optional step name in both.
6. Verify each field; return `OpResult { ok, reason }` with a `failed[]` list — the same honest-reporting pattern as every other op (no false success).

Wire `add_bot` into the `applyChanges` op dispatcher and the `summarize` helper.

## Selectors to resolve at implementation (probe live via zen-mcp on VisiconDemo)

These are selector-level, resolved iteratively against the live editor (as with every prior op) — not design risks:
- Bot-name input (the editable "New Bot" title vs a field).
- Event-source control kind and whether a fresh data-change event needs an explicit pick or defaults to Change.
- "Data change type" control kind (dropdown vs enum/multiselect) and exact option labels.
- Step-type picker: exact label/where "Run a data action" lives (direct vs a menu, possibly responsive like the vcol ⋮ menu).
- The step's **action dropdown** (shows "Custom action") — its control kind, and how existing actions are listed (scoped by Referenced Table?).
- The right-pane **task-type toolbar** buttons ("Add new rows", "Delete row", "Set row values", "Run action on rows", "Grouped actions") — selectors for selecting "Run action on rows" in custom mode.
- Referenced Table default behavior when omitted.

## Error handling / reporting

- Missing bot-creation controls → `{ ok:false, reason: "..." }` with a specific Vietnamese message, consistent with existing ops.
- Per-field failures accumulate in `failed[]`; `ok = failed.length === 0`; reason lists what to check by hand.

## Ordering & known limitations

- **Ordering**: any action referenced by a step must be created **earlier** in the same changeset (`add_action`) or already exist.
- **New-action registration lag**: a brand-new action created in the same changeset may not appear in the bot step's "Referenced Action" picker until the app is Saved (same class as the "new virtual column not in a view's sort/group picker" limitation). Workaround: create actions, Save in the editor, then run the `add_bot` op; or accept that such a step may land in `failed[]` and re-run after Save.
- Referenced action must operate on the Referenced Table.

## Testing

- Unit: add cases to `tests/changeset.test.ts` for `add_bot` validation — required `name`/`table`/`steps`, empty-steps error, bad `step.type`, bad `step.custom`, non-string `condition`/`rows`, unknown-table warnings, summary line.
- Engine: DOM automation isn't unit-tested (codebase convention); verify live on VisiconDemo via zen-mcp with **two** changesets so both step modes are exercised:
  1. **existing** mode — a data-change bot whose step picks an already-created action from the dropdown.
  2. **custom** mode — a data-change bot whose step is a `run_action_on_rows` custom action (Referenced Table/rows/Action).
  Confirm each field lands and the bot persists after Save.

## Docs

- `src/lib/prompts.ts` — add the `add_bot` op spec for the AI (schema, the "create actions first, then reference" rule, step.type note).
- `D:\Claude\EcoTech\instruction.md` — extension changeset spec.
- appsheet-architect skill `references/extension-changeset.md` — mirror.
