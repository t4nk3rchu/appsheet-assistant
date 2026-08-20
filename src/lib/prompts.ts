// src/lib/prompts.ts — system+user prompt builders for each assistant tool.
// Kept provider-agnostic; the background worker maps { system, prompt } onto
// whichever provider is configured.
import type { Table } from "./tables";
import { renderColumnTypeProps, renderActionTypeProps } from "./columnProps";
import { renderSkillsForPrompt, type Skill } from "./skills";

export type Lang = "vi" | "en";

export interface Ctx {
  table?: string;
  column?: string;
  usedAs?: string;
}

const respondIn = (lang: Lang) =>
  lang === "vi" ? "Trả lời bằng tiếng Việt." : "Respond in English.";

function ctxLines(ctx: Ctx): string[] {
  const out: string[] = [];
  if (ctx.table) out.push(`Table: ${ctx.table}`);
  if (ctx.column) out.push(`Column: ${ctx.column}`);
  if (ctx.usedAs) out.push(`Used as: ${ctx.usedAs}`);
  return out;
}

export function formulaPrompt(desc: string, current: string, ctx: Ctx, lang: Lang) {
  const system =
    "You are an expert AppSheet expression author. Return ONE valid AppSheet expression that fulfils the request, " +
    "using correct AppSheet syntax (functions like IF, IFS, SELECT, ANY, LOOKUP, CONCATENATE, TEXT, and refs like " +
    "[Column] / [_THISROW].[Column]). Put the expression on its own line first, then at most one short line explaining it. " +
    respondIn(lang);
  const parts = [`Describe the expression needed: ${desc}`];
  if (current.trim()) parts.push(`Improve this existing expression: ${current}`);
  parts.push(...ctxLines(ctx));
  return { system, prompt: parts.join("\n") };
}

export function explainPrompt(expr: string, ctx: Ctx, lang: Lang) {
  const system =
    "You are an AppSheet expert. Explain the given AppSheet expression in plain language: what it returns, " +
    "step by step, and any edge cases or gotchas. Be concise. " + respondIn(lang);
  const parts = [`Explain this expression:\n${expr}`, ...ctxLines(ctx)];
  return { system, prompt: parts.join("\n") };
}

export function fixPrompt(expr: string, errorMsg: string, intended: string, ctx: Ctx, lang: Lang) {
  const system =
    "You are an AppSheet expert. Fix the broken AppSheet expression. Return the corrected expression on its own line " +
    "first, then a short explanation of what was wrong and what you changed. " + respondIn(lang);
  const parts = [`Broken expression:\n${expr}`];
  if (errorMsg.trim()) parts.push(`Error message: ${errorMsg}`);
  if (intended.trim()) parts.push(`It should: ${intended}`);
  parts.push(...ctxLines(ctx));
  return { system, prompt: parts.join("\n") };
}

export function typesPrompt(table: string, columns: string, lang: Lang) {
  const system =
    "You are an AppSheet schema expert. For each column name, infer the best AppSheet column Type " +
    "(Text, LongText, Number, Decimal, Price, Percent, Date, DateTime, Time, Duration, Enum, EnumList, Ref, " +
    "Yes/No, Address, LatLong, Email, Phone, Url, Image, File, Color, Signature). Follow AppSheet conventions: " +
    "an 'id'/'key' column is the key (Text), '*_id' or '*_ref' is a Ref, price/amount/tien is Price or Number, " +
    "date/time columns map to Date/DateTime/Time, repeated small value sets are Enum. " +
    "Return one line per column as `column → Type — short reason`. " + respondIn(lang);
  const prompt = `${table.trim() ? `Table: ${table}\n` : ""}Columns:\n${columns}`;
  return { system, prompt };
}

export interface ChatTurn {
  role: "user" | "assistant";
  text: string;
}

/** Compact schema listing for the Build changeset prompt. Enum/EnumList columns
 *  include their fixed values so the AI writes conditions against real values
 *  (e.g. [lifecycle_status]="active") instead of inventing them. */
export function buildSchemaContext(tables: Table[]): string {
  const lines = tables.map((t) => {
    const cols = t.columns
      .map((c) => (c.values?.length ? `${c.name}:${c.type}(${c.values.join("|")})` : `${c.name}:${c.type}`))
      .join(", ");
    return `- ${t.name}: ${cols}`;
  });
  let out = "## App schema (tables → columns:type; Enum values in parentheses)\n" + lines.join("\n");
  if (out.length > 14000) out = out.slice(0, 14000) + "\n…(truncated)";
  return out;
}

/**
 * The Build App changeset prompt — the AI returns STRICT JSON the autofill
 * engine applies. Trimmed to the ops the engine supports this iteration:
 * set_column, add_format_rule, set_format_rule. (Views/actions are a later pass.)
 * Ported/condensed from the original extension's hocChangesetPrompt.
 */
export function changesetPrompt(userAsk: string, tables: Table[], lang: Lang, instructions?: string, skills?: Skill[]) {
  const L = lang === "vi" ? "Vietnamese" : "English";
  const houseRules = instructions && instructions.trim()
    ? `\n## App conventions (user-provided — follow these; they OVERRIDE defaults where they conflict)\n${instructions.trim()}\n`
    : "";
  const skillsBlock = renderSkillsForPrompt(skills || []);
  const system = `You generate an AppSheet auto-fill changeset as STRICT JSON.${houseRules}${skillsBlock}

## Output (MUST follow exactly)
Return ONLY a single JSON object. No markdown fences, no prose, no comments. Shape:
{
  "changes": [
    {
      "op": "set_column" | "add_virtual_column" | "add_format_rule" | "set_format_rule" | "set_table" | "add_view" | "set_view" | "add_slice" | "set_slice" | "add_action" | "set_action",
      "table": "ExistingTableName",
      "column": "existing_column_name (set_column)",
      "view": "ExistingViewName (set_view)",
      "slice": "ExistingSliceName (set_slice)",
      "rowFilter": "true/false AppSheet expression — rows to keep in the slice (add_slice/set_slice)",
      "action": "ExistingActionName (set_action)",
      "actionType": "COPY_EDIT_ROW|EDIT_RECORD|ADD_RECORD|ADD_RECORD_TO|DELETE_RECORD|SET_COLUMN_VALUE|REF_ACTION|NAVIGATE_APP|NAVIGATE_URL|COMPOSITE|... (action)",
      "targetTable": "table a row is added to (ADD_RECORD_TO)",
      "assignments": [{ "column": "col", "value": "AppSheet expression" }],
      "referencedRows": "row-set expression (REF_ACTION)", "referencedAction": "existing action name on referencedTable (REF_ACTION)",
      "actions": ["ChildActionName", "..."], "target": "LINKTOVIEW(...)/URL expression (NAVIGATE_APP/URL)",
      "needsConfirmation": "true|false", "confirmationMessage": "quoted text",
      "viewType": "table|deck|gallery|detail|map|calendar|chart|dashboard|form|onboarding|card (view)",
      "position": "left most|left|center|right|right most|menu|ref (view)",
      "groupAggregate": "aggregate for grouped views (view)",
      "sortBy": [{ "column": "existing_col", "order": "Ascending|Descending" }],
      "groupBy": [{ "column": "existing_col", "order": "Ascending|Descending" }],
      "viewEntries": [{ "view": "ExistingViewName", "size": "Large|Wide|Tall|Small" }],
      "chartType": "chart view, EXACT label: Histogram|Horizontal Histogram|PieChart|DonutChart|Aggregate PieChart|Aggregate DonutChart|Col Series|Col Series [Stack]|Col Series [Line]|Row Series|Row Series [Stack]|Row Series [Line]|Scatter Plot",
      "chartColumns": ["existing_col", "..."],
      "columnOrder": "automatic|manual (table view)",
      "viewColumns": ["col_in_display_order", "..."],
      "type": "Text|Number|Decimal|Ref|Enum|EnumList|Date|DateTime|Yes/No|Price|Percent|...",
      "baseType": "Enum/EnumList base type, e.g. Ref (set_column)",
      "referencedTable": "existing table the Ref points to (set_column, when type/baseType is Ref)",
      "enumerationList": ["value1", "value2", "..."] + "(Enum/EnumList with Text base type)",
      "properties": { "Exact Column-editor Label": "value" },
      "appFormula": "AppSheet expression", "initialValue": "AppSheet expression",
      "suggestedValues": "AppSheet expression", "validIf": "AppSheet expression",
      "displayName": "expression or quoted text",
      "showIf": "true|false|expression", "editableIf": "true|false|expression",
      "requireIf": "true|false|expression", "resetIf": "true|false|expression",
      "name": "new format-rule name (add_format_rule)", "rule": "existing rule name (set_format_rule)",
      "condition": "AppSheet expression (If this condition is true)",
      "columns": ["col_to_format", "__action__ActionName"],
      "highlightColor": "red|orange|yellow|green|cyan|blue|purple|pink|themeMainColor|#RRGGBB",
      "textColor": "same options", "bold": "true|false", "italic": "true|false",
      "underline": "true|false", "uppercase": "true|false", "strikethrough": "true|false",
      "imageSize": "Large|Medium|Small|Tiny|Text",
      "icon": "FontAwesome solid name WITHOUT prefix, e.g. shopping-cart",
      "dataFilter": "AppSheet expression for row-level security (set_table)",
      "updateModeExpression": "AppSheet expression for 'are updates allowed' (set_table)"
    }
  ]
}

## Rules
- op "set_column" requires "table" and an EXISTING "column". Optional: appFormula, initialValue, suggestedValues, validIf, type, baseType, referencedTable, enumerationList, displayName, showIf, editableIf, requireIf, resetIf.
- TYPE-SPECIFIC PROPERTIES: use "properties" — an object keyed by the property's EXACT label. ONLY use labels listed for the column's type in the catalog below; never invent a label. Values: string for numbers/text, "true"/"false" for (true/false) props, or one of the listed options for enum props. For a Ref target table use the "referencedTable" field (NOT properties); for Enum/EnumList base type use "baseType" + optionally "enumerationList" for the Text-base values. Works with set_column and add_virtual_column.

## Column type-specific properties (per type — use labels VERBATIM)
${renderColumnTypeProps()}

## Action type-specific properties (add_action/set_action "properties" — use labels VERBATIM)
${renderActionTypeProps()}
- REF TYPES: a plain reference to another table = type "Ref" + "referencedTable". An Enum/EnumList whose values reference another table = type "Enum" (or "EnumList" for multi-select) + baseType "Ref" + "referencedTable". To restrict which rows are selectable (e.g. only active ones), add "validIf" like SELECT(OtherTable[key], [status]="active"). Prefer Enum/EnumList+baseType Ref when the user explicitly asks for an Enum/dropdown of refs; use plain Ref otherwise.
- op "add_virtual_column" creates a NEW virtual (computed) column. Requires "table", "name" (no spaces, unique in the table), "type". Should include "appFormula" (its computed value — the whole point of a VC). Optional: baseType, referencedTable, validIf, showIf, displayName. Use this ONLY when the user explicitly wants a new derived/computed column; to change an EXISTING column, use set_column instead.
- op "add_format_rule" requires "table" + "name". Optional: condition, columns (names and/or "__action__ActionName"), icon, highlightColor, textColor, bold/italic/underline/uppercase/strikethrough, imageSize.
- op "set_format_rule" requires "rule" (its current name); optional fields same as add_format_rule.
- op "set_table" sets table-level properties. Requires "table" (existing table name). Optional: "dataFilter" (row-level security filter — returns rows the user can see), "updateModeExpression" (formula — if TRUE, user can update rows; if FALSE, read-only).
- op "add_view" creates a UX view; requires "name", "viewType", and "table" — EXCEPT dashboards (viewType "dashboard") which have no "For this data" binding, so OMIT "table" for them. Optional: position, groupAggregate, showIf, displayName, icon. For a view, "showIf" is its Show-if formula and "displayName" its Display name. Always pick a fitting "icon".
- op "set_view" edits an existing view; requires "view" (its current name). Optional: table, viewType, position, groupAggregate, showIf, displayName, icon.
- VIEW PROPERTIES ESCAPE-HATCH: for ANY other view property (any view type) not covered by a field above, use "properties" — an object keyed by the property's EXACT VFE label as shown in the view editor (e.g. {"Show legend":"true","Trend line":"true","Chart colors":"Rainbow","Map view column":"location"}). Values: string for text/dropdowns, "true"/"false" for switches, or one of the listed options for enums. Set "viewType" first so the right controls exist. Use typed fields where they exist; use "properties" for everything else.
- CHART views: set "chartType" (use one of the EXACT labels listed in the schema — e.g. "PieChart", "Col Series", not "pie"/"column") and "chartColumns" (ordered list of columns to plot). Other chart props (Chart colors, Trend line, Show legend) go in "properties".
- CHART COLUMN TYPES: AppSheet filters "chartColumns" by chart type — only compatible columns are selectable, so pick columns of the right type or the entry is silently dropped. Histogram/Horizontal Histogram = CATEGORICAL columns (Enum/Text/Ref/Date/Yes-No; they count occurrences). PieChart/DonutChart/Col Series/Row Series/Scatter Plot = NUMBER columns (Number/Decimal/Price/Percent). Aggregate PieChart/DonutChart group a categorical column. Never put an Enum/Text column in a PieChart — it won't appear in the picker.
- TABLE views, which columns show: "columnOrder" automatic|manual, and "viewColumns" = the EXISTING columns to show. Providing "viewColumns" implies manual; only the listed columns are shown, the rest hidden. (Column reordering is not yet supported — the order in "viewColumns" does not change display order.)
- DASHBOARD views: viewType "dashboard", NO "table". Put the views it shows in "viewEntries" — an ordered list of EXISTING view names (each an object {view, size?} where size is Large|Wide|Tall|Small). Create those child views earlier in the changes list if they don't exist yet. On set_view, viewEntries APPEND (they don't replace existing entries).
- op "add_action" creates a Behavior action; requires "table", "name", "actionType". Optional: position (Primary|Prominent|Inline|Hide), displayName, icon, condition (Only-if-this-condition-is-true), needsConfirmation, confirmationMessage. For SET_COLUMN_VALUE use "assignments" [{column,value}]. For ADD_RECORD_TO set "targetTable" + "assignments" (columns of targetTable; [_THISROW] refers to the source row). For REF_ACTION set "referencedTable" + "referencedAction" (existing action on it) + optional "referencedRows". For COMPOSITE set "actions" (ordered list of EXISTING action names on the same table — create them earlier in the changes list). For NAVIGATE_APP set "target" to LINKTOVIEW("ViewName")/LINKTOROW(...); NAVIGATE_URL "target" = URL expression. For any OTHER type-specific action field (Launch External, CSV file locale, Desktop behavior, and CALL/SMS/EMAIL/OPEN_FILE fields To/Message/Subject/Body/File) use "properties" keyed by the EXACT label from the action-type catalog below.
- op "set_action" edits an existing action; requires "action" (its current name); optional table + any add_action field.
- op "add_slice" creates a slice (a filtered subset of a table); requires "table" (Source Table) + "name". Optional: "rowFilter" (a true/false expression selecting which rows the slice keeps, e.g. [status]="active"). op "set_slice" edits an existing slice; requires "slice" (its current name); optional table, rowFilter.
- op "add_bot" creates an Automation bot with a DATA-CHANGE event and one or more process steps. Requires "table" (the event table/slice) + "name" (bot name) + "steps" (non-empty array). Optional: "condition" (event runs only when true), "dataChangeType" (Adds only|Updates only|Deletes only|Adds and updates|All changes; default All changes), "bypassSecurity" (true/false). Each step runs a data action ("type":"run_a_data_action") in ONE of two modes: (a) EXISTING action — set "action" to the name of an existing action ON THE BOT'S TABLE (create it earlier with add_action); nothing else needed. (b) CUSTOM run-on-rows — set "custom":"run_action_on_rows" + "action" (the action to run) + "table" (Referenced Table) + "rows" (Referenced rows expression, the set of rows to run on). To use action types add-row/delete/set-value/grouped in a bot, create them via add_action first, then reference by name (mode a). Order: put add_action changes BEFORE the add_bot that references them.
- "sortBy"/"groupBy" (view): arrays of {column, order} where order is "Ascending" or "Descending" (default Ascending). Use EXISTING column names from the view's table. On set_view these APPEND rows (they don't replace existing ones).
- Use table/column names EXACTLY as written in the schema below — do not shorten, pluralize, singularize, or change case (e.g. if the schema says "SKUS", never write "SKU"). NEVER invent names. If a needed name is missing, return {"changes": []}.
- ENUM VALUES: when a column shows values in parentheses e.g. lifecycle_status:Enum(active|eol|deprecated), use those EXACT values in conditions/expressions (e.g. [lifecycle_status] = "active"). NEVER invent enum values. A column with no parentheses has no fixed list.
- Expression fields are raw AppSheet expressions with [Column] refs. Do NOT start them with "=".
- Switch fields (showIf/editableIf/requireIf/resetIf) must be "true", "false", or a boolean expression string.
- TEXT LITERALS must be wrapped in double quotes (AppSheet parses / - * + ( ) , < > = as operators). Quote displayName text, literal strings inside expressions, etc. Do NOT quote real expressions/[column] refs.
- Only include fields the user asked to set; omit empty fields.
- Wrap SELECT(...) in SORT(...) when order matters.

${buildSchemaContext(tables)}

Output JSON only. The user writes in ${L}.`;
  return { system, prompt: userAsk };
}

export function askPrompt(history: ChatTurn[], lang: Lang) {
  const system =
    "You are a helpful, practical AppSheet expert. Answer questions about building AppSheet apps: expressions, " +
    "slices, security filters, actions, automation/bots, views and UX. Prefer concrete examples. Be concise. " +
    respondIn(lang);
  const prompt = history.map((t) => `${t.role === "user" ? "User" : "Assistant"}: ${t.text}`).join("\n");
  return { system, prompt };
}
