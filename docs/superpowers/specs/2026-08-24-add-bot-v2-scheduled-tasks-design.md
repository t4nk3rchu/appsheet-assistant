# add_bot v2 + idempotent re-runs — design (as-built)

Extends the v1 [add_bot spec](./2026-08-20-add-bot-op-design.md). v1 shipped
data-change events + `run_a_data_action` steps (existing / custom modes). v2 is
the "Out (later)" list from v1, now **implemented and verified live on
VisiconDemo**, plus repo-wide idempotency. This doc is the as-built record.

## What shipped since v1

1. **Scheduled events** (`eventType: "scheduled"`).
2. **Run-a-task steps** — email / notification / webhook.
3. **Email CC/BCC + Reply To / From / PreHeader.**
4. **For-Each-Row** on scheduled events (enables data-action steps on a schedule).
5. **`dataChangeType` as an array** subset of Adds/Deletes/Updates (v1 was a string).
6. **Idempotent re-runs** across every add_* op (not bot-specific).

Still **out**: `set_bot` (in-place bot edit — matching/updating existing
events + steps). `add_bot` re-run is skip-if-exists (see §6).

## 1. Scheduled events (`src/lib/changeset.ts`, `afFillBot` + `afSetSchedule`)

`eventType`: `"data_change"` (default) | `"scheduled"`. Scheduled omits `table`;
requires `frequency` ∈ `Hourly | Daily | Weekly | Monthly | Monthly by week`.
Frequency-specific: Hourly→`minuteOfHour` (0–59); Daily→`time`; Weekly→
`daysOfWeek` (Sun..Sat) + `time`; Monthly→`dayOfMonth` (1–31) + `time`;
Monthly by week→`weekOfMonth` (`1st|2nd|3rd|4th|last`) + `daysOfWeek` + `time`.
Optional `timeZone` = **substring** of a native-`<select>` option label
("SE Asia" / "GMT+07"; a city like "Bangkok" is NOT in the list). No start/end
date exists in AppSheet. `dataChangeType` ignored for scheduled.

Engine notes (selectors resolved live):
- Event source MuiSelect → "Scheduled" swaps the Table control for the Schedule
  radiogroup + sub-fields.
- **Day-of-week toggles re-render on each click** → re-query fresh every toggle;
  filter by `/^[SMTWF]$/` (letters repeat), single native click, additions-first.
- Time zone is a native `select.dropdownSelect` (not MUI) → `ttSetSelectContains`.

## 2. Run-a-task steps (`afFillTaskStep`)

Step gains `task`: `"email" | "notification" | "webhook"` (presence ⇒ "Run a
task"). A fresh step already defaults to "Run a task", so **don't flip the step
type**; select the task tile (`.CardSelectControl[role="radio"]`, single native
click — double-fire reverts).
- **email**: `to` + `subject` + `body`; §3 for cc/bcc/reply-to.
- **notification**: `to`, `title`, `body`, `deepLink`; turn "Use default content?"
  OFF to reveal Title/Body.
- **webhook**: `url` (required), `verb`, `contentType`, `body`, `headers`.
  `contentType` = AppSheet option VALUES (`JSON|CSV|FORM_URL_ENCODED|HTML|PDF|
  XLSX|XML|ICS_CALENDAR`), MIME aliases normalized in changeset.ts; default JSON
  skipped (false-failure guard).

Scalar fields driven by generic `afSetPanelProp(document.documentElement, label,
val)`; `taskProps` escape-hatch for any field by exact label. Subject/Body are
readonly `<textarea>`s that open the Expression Assistant (afSetExpression
handles `HTMLTextAreaElement`).

## 3. Email CC/BCC + Reply To / From / PreHeader

`cc` / `bcc`: `string | string[]`, email only, normalized to `string[]`, stripped
on non-email tasks. Same OrderedList/expression path as `to` (`afFillExprList`) —
a value with `()`/`[]` flips the row's flask to expression mode.
- CC/BCC/Reply To live in the collapsed **"Other email parameters"** section →
  `afExpandFor` / `afSetPanelProp` expand a section when the control is
  present-but-hidden (`offsetParent === null`), not only when absent.
- Reply To / Customize "From" name / PreHeader via `taskProps` (exact labels).
  Fixes: single-quote selector wrapper for labels containing `"`; skip the
  EnumControl branch when it's an expression/normal flask toggle; `afSetText`
  also fires the React fiber `onChange` so controlled `DynamicExpressionControl`
  inputs don't revert; `exprInp` branch restricted to `[readonly]` so editable
  inputs use `afSetText`.

## 4. For-Each-Row (`afSetForEachRow`)

`forEachRow: { table, condition? }` on the add_bot. Required for a
`run_a_data_action` step on a **scheduled** event. Enables the
"For Each Row In Table" SwitchControl (click the inner `input.MuiSwitch-input`
specifically — a comma-list selector returns the wrapper first) → sets Table +
Filter Condition.

## 5. dataChangeType as array

Canonical form = non-empty subset of `["Adds","Deletes","Updates"]` (default all
three). Legacy string aliases ("Adds and updates" / "All changes" / …) accepted
on input, normalized to the array; empty array or unknown = hard error. Control
is a `role="listbox"` of three `.CardSelectControl[role="option"]` cards; toggle
mismatches **additions-first** so it never passes through zero-selected
(AppSheet requires ≥1). Single native `card.click()` (double-fire reverts).

## 6. Idempotent re-runs (all add_* ops, not just bots)

Re-applying a changeset must not duplicate.
- **Upsert** (open existing same-named item, update in place, else create):
  `add_view` / `add_action` / `add_slice` / `add_format_rule` — reuse the
  `afOpenView` / `afOpenAction` / `afOpenSlice` / `afOpenFormatRule` helpers from
  the set_* paths.
  - `afOpenAction` must **expand a collapsed table tree group** before searching
    (children aren't in the DOM otherwise) — this was the real duplicate-action
    bug. `add_slice` verifies the opened pane's Slice Name matches (afOpenSlice
    hash-routes → could return a stale pane).
- **Skip-if-exists**: `add_virtual_column` (a vcol IS a grid column — use
  set_column to update its formula/type) and `add_bot` (full in-place bot edit
  deferred; re-running would duplicate the whole automation + event + steps).

## Two-stage combobox (carried from v1, generalized)

Both "Configure event" and "Add a step" are **two-stage**: clicking the trigger
only REVEALS a `textarea[aria-label="Table Slice Name"]` combobox; clicking THAT
opens the "Create a new X" popup. The Configure-event button also DETACHES on the
native click (React swaps it for the combobox), so a synthetic follow-up lands on
a dead node — shared `afSuggestCombo`/`afWaitSuggestCombo` handles both.

## Testing

- Unit: `tests/changeset.test.ts` — scheduled normalization (days/weekOfMonth,
  bad frequency/minute/day), task-step normalization (`to`→array, drop
  data-action fields, webhook url required, unknown task), cc/bcc normalize +
  strip on non-email, scheduled data-action requires forEachRow. 64 tests.
- Engine: verified live on VisiconDemo via zen-mcp — scheduled email (days +
  timezone + cc/bcc expression-mode + reply-to), notification, webhook
  (contentType), scheduled For-Each-Row data action, and re-run-no-duplicate for
  view/action/slice/format-rule/vcol.

## Docs

- `src/lib/prompts.ts` — add_bot in the op enum; scheduled/tasks/cc-bcc rules;
  idempotency rule; corrected timeZone example.
- `instruction.md` (repo root) — full add_bot section + idempotency note.
- `appsheet-architect` skill `references/extension-changeset.md` — mirrored.

## zen-mcp gotcha (for future live probing)

`zen_evaluate` with a block-body IIFE (`(() => { … return x })()`) silently
yields `null` on any throw. Use a bare expression or expression-bodied arrow
`(() => expr)()` + `JSON.stringify(...)`.
