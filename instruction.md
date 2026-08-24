# AppSheet Assistant — Changeset JSON spec & usage

This extension applies **structural** changes to an AppSheet app by driving the
editor UI (DOM automation), something the AppSheet API cannot do. You describe
the changes as a **strict-JSON changeset**; the extension validates it against
the live schema, then replays it into the editor. **Nothing is saved until the
user clicks Save in the AppSheet editor.**

This document lets another agent produce a changeset that the extension accepts.

---

## Output contract

Return **one** JSON object, no markdown fences, no prose:

```json
{ "changes": [ { "op": "...", "...": "..." } ] }
```

- `changes` is an ordered array; ops apply top-to-bottom (create dependencies first).
- Use table/column/view/action names **exactly** as they exist in the app schema — never invent, shorten, pluralize, or re-case them. If a needed name is missing, return `{"changes": []}`.
- Expression fields are raw AppSheet expressions with `[Column]` refs; **do not** prefix with `=`.
- Text literals inside expressions/displayName must be double-quoted (AppSheet parses `/ - * + ( ) , < > =` as operators).
- Switch fields (`showIf`/`editableIf`/`requireIf`/`resetIf`) are `"true"`, `"false"`, or a boolean expression string.
- NEVER create virtual columns implicitly — use `add_virtual_column` only when the user explicitly wants a new computed column; otherwise set an App formula on an existing column via `set_column`.

---

## Ops & fields

### `set_column` — edit an existing column
Required: `table`, `column` (must exist). Optional:
`type`, `baseType`, `referencedTable`, `properties`, `appFormula`, `initialValue`, `suggestedValues`, `validIf`, `displayName`, `showIf`, `editableIf`, `requireIf`, `resetIf`.
- **Ref**: `type:"Ref"` + `referencedTable:"OtherTable"`.
- **Enum/EnumList of Refs**: `type:"Enum"` (or `"EnumList"`) + `baseType:"Ref"` + `referencedTable`. Filter selectable rows with `validIf`, e.g. `SELECT(SKUS[sku_id], [status]="active")`.

### `add_virtual_column` — new computed column
Required: `table`, `name` (no spaces, unique in table), `type`. Should set `appFormula` (its whole purpose). Optional: `validIf`, `showIf`, `displayName`, `baseType`, `referencedTable`, `properties`.
- The app auto-detects Type from the formula, so the engine sets the formula first then the explicit Type — you just supply both.

### `set_table` — table-level settings
Required: `table`. Optional: `dataFilter` (row-level security filter), `updateModeExpression` ("are updates allowed" — `TRUE` = editable, `FALSE` = read-only).

### `add_view` / `set_view`
`add_view` requires `name`, `viewType`, and `table` — **except dashboards** (which have no "For this data", so omit `table`). `set_view` requires `view` (existing name). Optional: `position`, `groupAggregate`, `showIf`, `displayName`, `icon`, `sortBy`, `groupBy`, plus the view-type-specific fields below and the `properties` escape-hatch.
- `viewType`: `table | deck | gallery | detail | map | calendar | chart | dashboard | form | onboarding | card`
- `position`: `left most | left | center | right | right most | menu | ref`
- `sortBy`/`groupBy`: array of `{ "column": "col", "order": "Ascending" | "Descending" }` (default Ascending). On `set_view` these **append**.

**Dashboard** (`viewType:"dashboard"`) — a container of other views. Omit `table`. Set its embedded views with:
- `viewEntries`: array of `{ "view": "ExistingViewName", "size": "Large" | "Wide" | "Tall" | "Small" }` (or bare `"ViewName"` strings). Create any child views earlier in the same `changes` array. On `set_view`, entries **append**.

**Chart** (`viewType:"chart"`):
- `chartType`: **exact** AppSheet label — `Histogram | Horizontal Histogram | PieChart | DonutChart | Aggregate PieChart | Aggregate DonutChart | Col Series | Col Series [Stack] | Col Series [Line] | Row Series | Row Series [Stack] | Row Series [Line] | Scatter Plot` (not "pie"/"bar").
- `chartColumns`: array of column names to plot. **AppSheet filters this picker by chart type** — pick compatible column types or the entry is dropped: Histogram/Horizontal Histogram = **categorical** (Enum/Text/Ref/Date/Yes-No; counts occurrences); PieChart/DonutChart/Col Series/Row Series/Scatter Plot = **Number** (Number/Decimal/Price/Percent); Aggregate Pie/Donut = group a categorical column. E.g. a PieChart needs a numeric column — an Enum won't appear in its picker.
- Other chart props (`Chart colors`, `Trend line`, `Show legend`) → `properties`.

**Table** (`viewType:"table"`), which columns show:
- `columnOrder`: `"automatic" | "manual"`.
- `viewColumns`: array of existing column names to show (implies `manual`; only the listed columns are shown, the rest hidden). *Reordering is not yet supported — the array order does not change display order.*

**Any view property** (any view type) not covered above → use `properties` (see below): map `Map column`; calendar `Start date`/`End date`/`Description`; deck `Primary header`/`Secondary header`/`Summary column`/`Main image`; gallery `Image size`; etc.

### `add_slice` / `set_slice`
`add_slice` requires `table`, `name`. `set_slice` requires `slice` (existing name). Optional: `rowFilter` (true/false expression selecting rows to keep, e.g. `[list_price] < 1000000`).

### `add_action` / `set_action`
`add_action` requires `table`, `name`, `actionType`. `set_action` requires `action` (existing name). Optional: `position`, `displayName`, `icon`, `condition` (Only-if-this-condition-is-true), `needsConfirmation` (`"true"`/`"false"`), `confirmationMessage`, `properties`, and per-type fields:
- `actionType`: `COPY_EDIT_ROW | EDIT_RECORD | EXPORT_VIEW | NAVIGATE_DIFFERENT_APP | NAVIGATE_APP | IMPORT_FILE | ADD_RECORD | ADD_RECORD_TO | DELETE_RECORD | REF_ACTION | SET_COLUMN_VALUE | NAVIGATE_URL | OPEN_FILE | CALL | SMS | EMAIL | COMPOSITE`
- `position`: `Primary | Prominent | Inline | Hide` (AppSheet labels "Display prominently"/"Do not display"/… are also accepted).
- **SET_COLUMN_VALUE / ADD_RECORD_TO** → `assignments: [{ "column": "c", "value": "expr" }]`. ADD_RECORD_TO also needs `targetTable` (assignments then target that table's columns; `[_THISROW]` = source row).
- **REF_ACTION** → `referencedTable` + `referencedAction` (existing action on it) + optional `referencedRows` (row-set expression).
- **COMPOSITE** (grouped) → `actions: ["ChildActionName", ...]` — the child actions must exist (create them earlier in the same `changes` array).
- **NAVIGATE_APP** → `target: "LINKTOVIEW(\"ViewName\")"` (or `LINKTOROW(...)`); **NAVIGATE_URL** → `target` = URL expression.
- **CALL/SMS/EMAIL/OPEN_FILE** → use `properties` (labels `To`, `Message`, `Subject`, `Body`, `File`).

### `add_format_rule` / `set_format_rule`
`add_format_rule` requires `table`, `name`. `set_format_rule` requires `rule` (existing name). Optional: `condition`, `columns` (array of column names and/or `"__action__ActionName"`), `icon`, `highlightColor`, `textColor`, `bold`/`italic`/`underline`/`uppercase`/`strikethrough` (`"true"`/`"false"`), `imageSize`.

### `add_bot` — Automation bot (event + process steps)
Creates a bot in **Automation → Bots** with an **event** and one or more **process steps**. Required: `name` (bot name), `steps` (non-empty array). The event kind is `eventType`: `"data_change"` (default) or `"scheduled"`.

Shared optional fields (both event kinds):
- `eventName` — the event's display name (default is an auto "New event N").
- `condition` — a true/false expression; the process runs only when it's true (e.g. `[trạng_thái_duyệt] = "Đã Duyệt"`).
- `bypassSecurity` — `true`/`false` ("Bypass security filters?" toggle).

**Data-change event** (`eventType` omitted or `"data_change"`) — also requires `table` (the event's table/slice). Optional:
- `dataChangeType` — which changes fire the event: an **array** subset of `["Adds", "Deletes", "Updates"]` (e.g. `["Adds", "Updates"]`). Omit for the default (all three). A legacy string alias (`"Adds and updates"`, `"Deletes only"`, `"All changes"`, …) is also accepted and normalized to the array; an unknown value or empty array is a hard error.

**Scheduled event** (`eventType: "scheduled"`) — **no `table`**. Requires `frequency`, one of `Hourly | Daily | Weekly | Monthly | Monthly by week`. Frequency-specific fields:
- `Hourly` → `minuteOfHour` (0–59).
- `Daily` → `time` (e.g. `"2:30 pm"`).
- `Weekly` → `daysOfWeek` (array of `Sun`…`Sat`) + `time`.
- `Monthly` → `dayOfMonth` (1–31) + `time`.
- `Monthly by week` → `weekOfMonth` (`1st`|`2nd`|`3rd`|`4th`|`last`) + `daysOfWeek` + `time`.
- Optional `timeZone` — a **substring** of a Time-zone dropdown label (e.g. `"GMT+07"` or `"SE Asia"`; the +07 option is "(GMT+07:00) SE Asia Standard Time"). AppSheet's scheduled event has **no start/end date**; any omitted field keeps AppSheet's default. `dataChangeType` is ignored for scheduled. For a scheduled data-action step, enable For-Each-Row via `forEachRow` (see the step section).

**Steps** come in two kinds (each also takes an optional `name` display label):

**Run a task** — set `task`: `"email"` | `"notification"` | `"webhook"`. This is the natural pairing for scheduled bots (send mail / notify / call a webhook on a schedule).
- `email`: `to` (recipient expression or array of them), optional `cc` / `bcc` (same form as `to`; email only), `subject`, `body`. More email fields via `taskProps` (exact labels): `Reply To`, `Customize "From" name`, `PreHeader`.
- `notification`: `to`, `title`, `body`, optional `deepLink`.
- `webhook`: `url` (required), optional `verb` (`GET`/`POST`/…), `contentType` (AppSheet values: `JSON` (default) | `CSV` | `FORM_URL_ENCODED` | `HTML` | `PDF` | `XLSX` | `XML` | `ICS_CALENDAR` — MIME aliases like `application/json` are accepted), `body`, `headers`.
- Any other task field → `taskProps`: `{ "<exact editor label>": "value" }`.

**Run a data action** — no `task`:
- **Existing action** — `action` = the name of an action **that already exists on the bot's table**. Nothing else needed. Create it earlier with `add_action` if it doesn't exist yet.
- **Custom run-on-rows** — `custom: "run_action_on_rows"` + `action` + `table` (Referenced Table) + `rows` (Referenced rows expression).
- On a **scheduled** event, a run-a-data-action step **requires** the event to enable For-Each-Row: set `forEachRow`: `{ "table": "T", "condition": "<filter expr>" }` on the `add_bot`.

To use add-row/delete/set-value/grouped behavior in a bot, create the action first via `add_action`, then reference it by name (existing mode) — put those `add_action` ops **before** the `add_bot`.

```json
{ "changes": [
  { "op": "add_bot", "name": "Duyệt & cập nhật kho", "table": "PHIẾU_KHO",
    "eventName": "Khi phiếu được duyệt", "condition": "[trạng_thái_duyệt] = \"Đã Duyệt\"",
    "dataChangeType": ["Adds", "Updates"],
    "steps": [
      { "type": "run_a_data_action", "action": "Duyệt phiếu", "name": "Bước duyệt" },
      { "type": "run_a_data_action", "custom": "run_action_on_rows", "action": "R_VẬT_TƯ",
        "table": "VẬT_TƯ", "rows": "[Related CHI_TIẾT_PHIẾU_KHOs][ref_vật_tư]", "name": "Cập nhật vật tư" }
    ] }
] }
```

Scheduled bot — email every Monday & Wednesday at 8:00 am (Run a task):
```json
{ "changes": [
  { "op": "add_bot", "name": "Nhắc kiểm kho", "eventType": "scheduled",
    "eventName": "Đầu tuần", "frequency": "Weekly",
    "daysOfWeek": ["Mon", "Wed"], "time": "8:00 am", "timeZone": "SE Asia",
    "steps": [
      { "task": "email", "to": "USEREMAIL()", "subject": "Nhắc kiểm kho",
        "body": "Vui lòng kiểm kho hôm nay.", "name": "Gửi email" }
    ] }
] }
```

Scheduled bot — daily data action over filtered rows (needs `forEachRow`):
```json
{ "changes": [
  { "op": "add_bot", "name": "Đóng phiếu quá hạn", "eventType": "scheduled",
    "frequency": "Daily", "time": "1:00 am",
    "forEachRow": { "table": "PHIẾU_KHO", "condition": "[trạng_thái] = \"Chờ\"" },
    "steps": [ { "action": "Đóng phiếu", "name": "Đóng" } ] }
] }
```

---

## `properties` — type-specific fields (columns, actions & views)

`properties` is an object keyed by the field's **exact label** in the editor. Use it for anything without a dedicated field above — on `set_column`/`add_virtual_column`, `add_action`/`set_action`, **and `add_view`/`set_view`**. The engine auto-detects the control kind (dropdown, checkbox/switch → `"true"`/`"false"`, number, segmented buttons, expression, MUI dropdown, and image-grid dropdowns like Chart type / Map type / card Layout). Set `viewType` first so the right controls exist. Common labels:

- **Number/Decimal/Price/Percent**: `Maximum value`, `Minimum value`, `Increase/decrease step`, `Numeric digits`, `Decimal digits`, `Show thousands separator`(true/false), `Display mode`(Auto|Standard|Range|Label). Price also `Currency symbol`.
- **Text/LongText/Name**: `Maximum length`, `Minimum length`. LongText/Name also `Formatting`(Plain Text|Markdown|HTML).
- **Enum/EnumList**: `Allow other values`(true/false), `Input mode`(Auto|Buttons|Stack|Dropdown). (Use `baseType`/`referencedTable` fields for base type & ref table, not `properties`.)
- **Ref**: `Is a part of?`(true/false), `Input mode`(Auto|Buttons|Dropdown).
- **Date/DateTime/Time**: `Use long date format`, `Ignore seconds`, `Minimum date`, `Maximum date` (true/false or value).
- **Image/File/Drawing/Signature/Thumbnail**: `Image/File folder path` (expr); Image also `Allow drawing on images`.
- **Actions**: EDIT_RECORD `Desktop behavior`; EXPORT_VIEW/IMPORT_FILE `CSV file locale`; NAVIGATE_URL `Launch External`(true/false).
- **Views** (labels vary by `viewType`): chart `Chart colors`, `Trend line`(true/false), `Show legend`(true/false); map `Map column`(location col), `Map type`; calendar `Start date`, `End date`, `Description`, `Category`, `Default View`; deck `Primary header`, `Secondary header`, `Summary column`, `Main image`, `Image shape`; gallery `Image size`; table `Enable QuickEdit (beta)`(true/false), `Column width`; card `Layout`.

Only emit labels valid for that column/action/view type; a wrong label is warned and skipped. Column-picker labels (map/calendar/deck) take an **existing column name**; the column must be the right type (e.g. map `Map column` needs an Address/LatLong column, calendar `Start date` a Date/DateTime column).

---

## Examples

Ref-to-active-SKUs on an existing column:
```json
{ "changes": [ { "op": "set_column", "table": "PRICE_LISTS", "column": "sku_id",
  "type": "Enum", "baseType": "Ref", "referencedTable": "SKUS",
  "validIf": "SELECT(SKUS[sku_id], [lifecycle_status] = \"active\")" } ] }
```

Grouped action (children first, then COMPOSITE):
```json
{ "changes": [
  { "op": "add_action", "table": "PLANS", "name": "_Mark_Active", "actionType": "SET_COLUMN_VALUE",
    "position": "Hide", "icon": "minus", "assignments": [{ "column": "status", "value": "\"active\"" }] },
  { "op": "add_action", "table": "PLANS", "name": "_Mark_EOL", "actionType": "SET_COLUMN_VALUE",
    "position": "Hide", "icon": "minus", "assignments": [{ "column": "status", "value": "\"eol\"" }] },
  { "op": "add_action", "table": "PLANS", "name": "Lifecycle_Batch", "actionType": "COMPOSITE",
    "position": "Prominent", "icon": "layer-group", "actions": ["_Mark_Active", "_Mark_EOL"] }
] }
```

Chart + dashboard (child view first, then the dashboard that embeds it):
```json
{ "changes": [
  { "op": "add_view", "name": "Revenue_Pie", "table": "ORDERS", "viewType": "chart", "icon": "chart-pie",
    "chartType": "PieChart", "chartColumns": ["total_amount"], "properties": { "Show legend": "true" } },
  { "op": "add_view", "name": "Ops_Dashboard", "viewType": "dashboard", "position": "menu", "icon": "th-large",
    "viewEntries": [ { "view": "Revenue_Pie", "size": "Large" }, { "view": "Orders_Table", "size": "Tall" } ] }
] }
```

Table view showing only chosen columns:
```json
{ "changes": [ { "op": "set_view", "view": "Suppliers", "columnOrder": "manual",
  "viewColumns": ["id", "name", "status"], "properties": { "Enable QuickEdit (beta)": "true" } } ] }
```

---

## Using the extension (for the human operator)

1. Open the AppSheet **editor** tab (`appsheet.com/template/...`), then open the assistant sidebar (toolbar icon / Alt+A on Firefox).
2. Go to the **Dựng App / Build App** tab.
3. Either type a request and click **Tạo/Generate** (the AI fills the JSON box), **or** paste a changeset directly into the always-visible **Changeset JSON** box.
4. The box is editable; the **Changes · N** plan and any warnings revalidate live as you type.
5. Click **Kiểm tra schema / Check** to sanity-check table/column names against the live app.
6. Click **Dựng ngay (N) / Apply** — the engine drives the editor to make the N changes.
7. **Click Save in the AppSheet editor** to persist. The extension never auto-saves.

Settings (⚙): AI provider + API key (BYOK: Gemini or DeepSeek); **Build App conventions** (always-on house rules injected into every generation); **Skills** (upload `.skill`/`.md` files or a `.zip` package — the AI reads each skill's description and applies matching ones).

Notes & limits:
- **Idempotent re-runs.** Applying the same changeset twice does not duplicate: `add_view`/`add_action`/`add_slice`/`add_format_rule` **upsert** (open the existing same-named item and update it in place); `add_virtual_column` and `add_bot` **skip** if the name already exists. To update an existing item, use the matching `set_*` op (`set_column` for a virtual column).
- Structural changes only replay into the editor DOM; **the user must Save**. Row data is out of scope.
- `sortBy`/`groupBy`/`viewEntries` **append** on `set_view` (they don't replace existing rows).
- **Not yet supported:** table column **reordering** (`viewColumns` shows/hides only, order unchanged); slice columns/update-mode default to "all". CALL/SMS/EMAIL/OPEN_FILE fields work via `properties`.
- **Chart columns are filtered by chart type** — a column of the wrong type (e.g. an Enum in a PieChart) won't be selectable and is dropped. Match the type: categorical for Histogram, Number for Pie/Donut/Series/Scatter.
- Names are validated against the live schema; unknown names are hard errors (the change is dropped). Property-label/enum-value/chart-column mismatches are non-blocking warnings.
