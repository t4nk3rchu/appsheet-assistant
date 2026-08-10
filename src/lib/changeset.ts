// src/lib/changeset.ts — the structured "auto-fill changeset" the Build tab
// asks the AI to return, plus a validator that checks it against the live
// table/column list before anything is applied to the editor.
//
// Core scope (this iteration): set_column + add_format_rule + set_format_rule + set_table.
// Views/actions are a later pass.
import type { Table } from "./tables";
import { validateColumnProperties, validateActionProperties } from "./columnProps";

export type ChangeOp =
  | "set_column"
  | "add_virtual_column"
  | "add_format_rule"
  | "set_format_rule"
  | "set_table"
  | "add_view"
  | "set_view"
  | "add_slice"
  | "set_slice"
  | "add_action"
  | "set_action";

/** Valid AppSheet action types (source content.pretty.js ~8793). */
export const ACTION_TYPES = [
  "COPY_EDIT_ROW", "EDIT_RECORD", "EXPORT_VIEW", "NAVIGATE_DIFFERENT_APP", "NAVIGATE_APP",
  "IMPORT_FILE", "ADD_RECORD", "ADD_RECORD_TO", "DELETE_RECORD", "REF_ACTION",
  "SET_COLUMN_VALUE", "NAVIGATE_URL", "OPEN_FILE", "CALL", "SMS", "EMAIL", "COMPOSITE",
];
export const ACTION_POSITIONS = ["Primary", "Prominent", "Inline", "Hide"];

/** Canonicalize an action position, accepting AppSheet's UI labels + underscore
 *  forms the AI often emits (e.g. "Do not display" / "Display prominently"). */
export function canonicalActionPosition(p: string): string | null {
  const k = String(p).trim().toLowerCase().replace(/_/g, " ");
  const map: Record<string, string> = {
    primary: "Primary", "display overlay": "Primary",
    prominent: "Prominent", "display prominently": "Prominent",
    inline: "Inline", "display inline": "Inline",
    hide: "Hide", "do not display": "Hide", hidden: "Hide",
  };
  return map[k] ?? null;
}

/** One column=value assignment for SET_COLUMN_VALUE / ADD_RECORD_TO actions. */
export interface Assignment {
  column: string;
  value?: string;
}

/** Valid AppSheet view types + tab positions (source content.pretty.js ~8770). */
export const VIEW_TYPES = [
  "calendar", "deck", "table", "gallery", "detail", "map",
  "chart", "dashboard", "form", "onboarding", "card",
];
export const VIEW_POSITIONS = ["left most", "left", "center", "right", "right most", "menu", "ref"];

export interface Change {
  op: ChangeOp;
  table?: string;
  // set_column
  column?: string;
  type?: string;
  baseType?: string; // Enum/EnumList base (element) type, e.g. "Ref"
  referencedTable?: string; // when baseType/type is Ref: the table it points to
  // Escape-hatch: any type-specific column-editor property, keyed by its exact
  // panel data-label (e.g. {"Max value":"100","Show as":"Thermometer"}).
  properties?: Record<string, string>;
  appFormula?: string;
  initialValue?: string;
  suggestedValues?: string;
  validIf?: string;
  displayName?: string;
  showIf?: string;
  editableIf?: string;
  requireIf?: string;
  resetIf?: string;
  // format rule
  name?: string; // add_format_rule
  rule?: string; // set_format_rule
  condition?: string;
  columns?: string[];
  icon?: string;
  highlightColor?: string;
  textColor?: string;
  bold?: string;
  italic?: string;
  underline?: string;
  uppercase?: string;
  strikethrough?: string;
  imageSize?: string;
  // set_table
  dataFilter?: string; // row-level security filter
  updateModeExpression?: string; // "are updates allowed" formula
  // add_view / set_view
  view?: string; // set_view: existing view name
  viewType?: string;
  position?: string;
  groupAggregate?: string;
  sortBy?: ViewOrderItem[];
  groupBy?: ViewOrderItem[];
  viewEntries?: ViewEntry[]; // dashboard: existing views to embed
  chartType?: string; // chart view: Chart type dropdown
  chartColumns?: string[]; // chart view: Chart columns ordered list
  // add_slice / set_slice
  slice?: string; // set_slice: existing slice name
  rowFilter?: string; // Row filter condition (true/false expression)
  // add_action / set_action
  action?: string; // set_action: existing action name
  actionType?: string; // one of ACTION_TYPES
  targetTable?: string; // ADD_RECORD_TO destination table
  assignments?: Assignment[]; // SET_COLUMN_VALUE / ADD_RECORD_TO
  referencedRows?: string; // REF_ACTION row-set expression
  referencedAction?: string; // REF_ACTION action to run
  actions?: string[]; // COMPOSITE child action names
  target?: string; // NAVIGATE_APP/URL target expression
  needsConfirmation?: string; // "true"/"false"
  confirmationMessage?: string;
}

/** One row in a view's Sort by / Group by ordered list. */
export interface ViewOrderItem {
  column: string;
  order?: "Ascending" | "Descending";
}

/** Valid dashboard View-entry sizes (source: live editor "Select an option"). */
export const VIEW_ENTRY_SIZES = ["Large", "Wide", "Tall", "Small"];

/** One entry in a dashboard view's "View entries" list: an existing view to
 *  embed, with an optional layout size. */
export interface ViewEntry {
  view: string;
  size?: string;
}

export interface Issue {
  index: number;
  level: "error" | "warn";
  msg: string;
}

export interface ValidationResult {
  ok: boolean;
  issues: Issue[];
  normalized: Change[];
}

/** Outcome of applying one change to the editor (returned by the autofill engine). */
export interface FillResult {
  index: number;
  op: string;
  label: string;
  level: "ok" | "warn" | "error";
  detail?: string;
}

const EXPR_FIELDS = ["type", "appFormula", "initialValue", "suggestedValues", "validIf", "displayName"] as const;
const SWITCH_FIELDS = ["showIf", "editableIf", "requireIf", "resetIf"] as const;

/** Validate + normalize a changeset against the live tables. Hard errors drop
 *  the change; warnings keep it. normalized[] is what actually gets applied. */
export function validateChangeset(tables: Table[], changes: unknown): ValidationResult {
  const issues: Issue[] = [];
  const add = (index: number, level: Issue["level"], msg: string) => issues.push({ index, level, msg });

  if (!Array.isArray(changes)) {
    return { ok: false, issues: [{ index: -1, level: "error", msg: "Changeset thiếu mảng 'changes'." }], normalized: [] };
  }

  const tableNames = new Set(tables.map((t) => t.name));
  const colSet = (t: string) => new Set((tables.find((x) => x.name === t)?.columns ?? []).map((c) => c.name.toLowerCase()));
  const colType = (t: string, c: string) =>
    tables.find((x) => x.name === t)?.columns.find((x) => x.name.toLowerCase() === String(c).toLowerCase())?.type;
  const norm: Change[] = [];

  // Normalize the free-form `properties` map: must be a plain object; coerce
  // each value to a non-empty string, drop the rest. Labels aren't checked
  // against the DOM (the apply engine warns per-label if one doesn't match).
  const normProperties = (ch: any, i: number) => {
    if (ch.properties == null) return;
    if (typeof ch.properties !== "object" || Array.isArray(ch.properties)) {
      add(i, "error", "'properties' phải là object {label: value}.");
      delete ch.properties;
      return;
    }
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(ch.properties)) {
      if (v == null || v === "") continue;
      out[k] = String(v);
    }
    if (Object.keys(out).length) ch.properties = out;
    else delete ch.properties;
  };

  changes.forEach((raw: any, i: number) => {
    const ch: Change = { ...raw };

    if (ch.op === "add_virtual_column") {
      if (!ch.table) return add(i, "error", "add_virtual_column thiếu 'table'.");
      if (tableNames.size && !tableNames.has(ch.table)) return add(i, "error", `Bảng không tồn tại: ${ch.table}`);
      if (!ch.name) return add(i, "error", "add_virtual_column thiếu 'name'.");
      if (/\s/.test(ch.name)) return add(i, "error", `Tên cột ảo không được có khoảng trắng: ${ch.name}`);
      if (colSet(ch.table).has(String(ch.name).toLowerCase())) return add(i, "error", `Cột đã tồn tại: ${ch.table}.${ch.name}`);
      if (!ch.type) return add(i, "error", "add_virtual_column thiếu 'type'.");
      if (!ch.appFormula) add(i, "warn", "cột ảo không có 'appFormula' — sẽ rỗng.");
      if (ch.referencedTable && tableNames.size && !tableNames.has(ch.referencedTable))
        add(i, "error", `referencedTable không tồn tại: ${ch.referencedTable}`);
      for (const f of ["appFormula", "validIf", "displayName", "showIf", "baseType", "referencedTable"] as const) {
        const v = (ch as any)[f];
        if (v == null || v === "") delete (ch as any)[f];
        else if (typeof v !== "string") add(i, "error", `Field '${f}' phải là chuỗi.`);
      }
      normProperties(ch, i);
      if (ch.properties) validateColumnProperties(ch.type, ch.properties).forEach((m) => add(i, "warn", m));
      norm.push(ch);
      return;
    }

    if (ch.op === "set_table") {
      if (!ch.table) return add(i, "error", "set_table thiếu 'table'.");
      if (tableNames.size && !tableNames.has(ch.table)) return add(i, "error", `Bảng không tồn tại: ${ch.table}`);
      if (ch.dataFilter != null && typeof ch.dataFilter !== "string") add(i, "error", "'dataFilter' phải là chuỗi.");
      if (ch.updateModeExpression != null && typeof ch.updateModeExpression !== "string")
        add(i, "error", "'updateModeExpression' phải là chuỗi.");
      // drop empty fields
      if (!ch.dataFilter) delete ch.dataFilter;
      if (!ch.updateModeExpression) delete ch.updateModeExpression;
      norm.push(ch);
      return;
    }

    if (ch.op === "add_action" || ch.op === "set_action") {
      if (ch.op === "add_action") {
        if (!ch.name) return add(i, "error", "add_action thiếu 'name'.");
        if (!ch.table) return add(i, "error", "add_action thiếu 'table'.");
        if (!ch.actionType) return add(i, "error", "add_action thiếu 'actionType'.");
      } else if (!ch.action) {
        return add(i, "error", "set_action thiếu 'action' (tên action cần sửa).");
      }
      if (ch.table && tableNames.size && !tableNames.has(ch.table)) return add(i, "error", `Bảng không tồn tại: ${ch.table}`);
      if (ch.actionType && ACTION_TYPES.indexOf(String(ch.actionType)) < 0) return add(i, "error", `actionType không hợp lệ: ${ch.actionType}`);
      if (ch.position) {
        const canon = canonicalActionPosition(ch.position);
        if (!canon) return add(i, "error", `position không hợp lệ: ${ch.position} (Primary|Prominent|Inline|Hide)`);
        ch.position = canon;
      }
      if (ch.assignments != null && !Array.isArray(ch.assignments)) return add(i, "error", "'assignments' phải là mảng [{column,value}].");
      if (ch.actions != null && !Array.isArray(ch.actions)) return add(i, "error", "'actions' phải là mảng tên action (COMPOSITE).");
      if (ch.targetTable && tableNames.size && !tableNames.has(ch.targetTable)) return add(i, "error", `targetTable không tồn tại: ${ch.targetTable}`);
      if (ch.referencedTable && tableNames.size && !tableNames.has(ch.referencedTable)) return add(i, "error", `referencedTable không tồn tại: ${ch.referencedTable}`);
      // drop empty string fields
      for (const f of ["actionType", "targetTable", "referencedTable", "referencedRows", "referencedAction", "target", "condition", "displayName", "icon", "position", "needsConfirmation", "confirmationMessage"] as const) {
        if (!(ch as any)[f]) delete (ch as any)[f];
      }
      normProperties(ch, i);
      if (ch.properties) validateActionProperties(ch.actionType, ch.properties).forEach((m) => add(i, "warn", m));
      norm.push(ch);
      return;
    }

    if (ch.op === "add_slice" || ch.op === "set_slice") {
      if (ch.op === "add_slice") {
        if (!ch.name) return add(i, "error", "add_slice thiếu 'name'.");
        if (!ch.table) return add(i, "error", "add_slice thiếu 'table' (Source Table).");
      } else if (!ch.slice) {
        return add(i, "error", "set_slice thiếu 'slice' (tên slice cần sửa).");
      }
      if (ch.table && tableNames.size && !tableNames.has(ch.table)) return add(i, "error", `Bảng không tồn tại: ${ch.table}`);
      if (!ch.rowFilter) delete ch.rowFilter;
      else if (typeof ch.rowFilter !== "string") add(i, "error", "'rowFilter' phải là chuỗi.");
      norm.push(ch);
      return;
    }

    if (ch.op === "add_view" || ch.op === "set_view") {
      if (ch.op === "add_view") {
        if (!ch.name) return add(i, "error", "add_view thiếu 'name'.");
        if (!ch.viewType) return add(i, "error", "add_view thiếu 'viewType'.");
        // Dashboards have no "For this data" binding — table is only required
        // for the other view types.
        if (!ch.table && ch.viewType !== "dashboard") return add(i, "error", "add_view thiếu 'table' (For this data).");
      } else if (!ch.view) {
        return add(i, "error", "set_view thiếu 'view' (tên view cần sửa).");
      }
      if (ch.table && tableNames.size && !tableNames.has(ch.table)) return add(i, "error", `Bảng không tồn tại: ${ch.table}`);
      if (ch.viewType && VIEW_TYPES.indexOf(String(ch.viewType)) < 0) return add(i, "error", `viewType không hợp lệ: ${ch.viewType}`);
      if (ch.position && VIEW_POSITIONS.indexOf(String(ch.position)) < 0) return add(i, "error", `position không hợp lệ: ${ch.position}`);
      for (const f of ["showIf", "displayName", "groupAggregate", "icon"] as const) {
        const v = (ch as any)[f];
        if (v == null || v === "") delete (ch as any)[f];
        else if (typeof v !== "string") add(i, "error", `Field '${f}' phải là chuỗi.`);
      }
      // Sort by / Group by: arrays of {column, order?}. Normalize order to
      // Ascending/Descending; warn (not block) on columns missing from the table.
      const cs = ch.table && tableNames.has(ch.table) ? colSet(ch.table) : null;
      for (const f of ["sortBy", "groupBy"] as const) {
        const v = (ch as any)[f];
        if (v == null) continue;
        if (!Array.isArray(v)) {
          add(i, "error", `'${f}' phải là mảng {column, order}.`);
          continue;
        }
        const rows: ViewOrderItem[] = [];
        v.forEach((raw2: any) => {
          const col = String(raw2?.column ?? "").trim();
          if (!col) return add(i, "error", `'${f}': item thiếu 'column'.`);
          if (cs && !cs.has(col.toLowerCase())) add(i, "warn", `${f}: cột không có trong ${ch.table}: ${col}`);
          const o = String(raw2?.order ?? "").trim().toLowerCase();
          rows.push(o.startsWith("desc") ? { column: col, order: "Descending" } : o ? { column: col, order: "Ascending" } : { column: col });
        });
        if (rows.length) (ch as any)[f] = rows;
        else delete (ch as any)[f];
      }
      // View entries (dashboard): array of view names or {view, size}. Normalize
      // bare strings to {view}; drop empties. View names aren't checked here (the
      // validator has the table list, not the view list) — the apply engine warns
      // per entry that couldn't be selected.
      if (ch.viewEntries == null) {
        // nothing
      } else if (!Array.isArray(ch.viewEntries)) {
        add(i, "error", "'viewEntries' phải là mảng tên view hoặc {view, size}.");
        delete ch.viewEntries;
      } else {
        const entries: ViewEntry[] = [];
        (ch.viewEntries as any[]).forEach((raw2) => {
          const view = String((typeof raw2 === "string" ? raw2 : raw2?.view) ?? "").trim();
          if (!view) return add(i, "error", "'viewEntries': entry thiếu 'view'.");
          const size = String(raw2?.size ?? "").trim();
          if (size && VIEW_ENTRY_SIZES.indexOf(size) < 0) add(i, "warn", `viewEntries: size không hợp lệ: ${size} (${VIEW_ENTRY_SIZES.join("|")})`);
          entries.push(size && VIEW_ENTRY_SIZES.indexOf(size) >= 0 ? { view, size } : { view });
        });
        if (entries.length) ch.viewEntries = entries;
        else delete ch.viewEntries;
      }
      // Chart view typed fields.
      if (ch.chartType != null && typeof ch.chartType !== "string") add(i, "error", "'chartType' phải là chuỗi.");
      if (!ch.chartType) delete ch.chartType;
      if (ch.chartColumns != null) {
        if (!Array.isArray(ch.chartColumns)) {
          add(i, "error", "'chartColumns' phải là mảng tên cột.");
          delete ch.chartColumns;
        } else {
          const cs2 = ch.table && tableNames.has(ch.table) ? colSet(ch.table) : null;
          ch.chartColumns.forEach((cn) => {
            if (cs2 && !cs2.has(String(cn).toLowerCase())) add(i, "warn", `chartColumns: cột không có trong ${ch.table}: ${cn}`);
          });
        }
      }
      normProperties(ch, i);
      norm.push(ch);
      return;
    }

    if (ch.op === "add_format_rule" || ch.op === "set_format_rule") {
      if (ch.op === "add_format_rule") {
        if (!ch.name) return add(i, "error", "add_format_rule thiếu 'name'.");
        if (!ch.table) return add(i, "error", "add_format_rule thiếu 'table'.");
      } else if (!ch.rule) {
        return add(i, "error", "set_format_rule thiếu 'rule'.");
      }
      if (ch.table && tableNames.size && !tableNames.has(ch.table)) return add(i, "error", `Bảng không tồn tại: ${ch.table}`);
      if (ch.columns != null && !Array.isArray(ch.columns)) return add(i, "error", "'columns' phải là mảng tên cột.");
      if (Array.isArray(ch.columns) && ch.table && tableNames.has(ch.table)) {
        const cs = colSet(ch.table);
        ch.columns.forEach((cn) => {
          const v = String(cn ?? "");
          if (v.startsWith("__action__")) return;
          if (!cs.has(v.toLowerCase())) add(i, "warn", `columns: cột không có trong ${ch.table}: ${v}`);
        });
      }
      norm.push(ch);
      return;
    }

    if (ch.op !== "set_column") return add(i, "error", `op không hỗ trợ: ${ch.op}`);
    if (!ch.table) return add(i, "error", "set_column thiếu 'table'.");
    if (tableNames.size && !tableNames.has(ch.table)) return add(i, "error", `Bảng không tồn tại: ${ch.table}`);
    if (!ch.column) return add(i, "error", "set_column thiếu 'column'.");
    if (!colSet(ch.table).has(String(ch.column).toLowerCase()))
      return add(i, "error", `Cột không tồn tại: ${ch.table}.${ch.column}`);

    for (const f of [...EXPR_FIELDS, ...SWITCH_FIELDS]) {
      const v = (ch as any)[f];
      if (v == null || v === "") delete (ch as any)[f];
      else if (typeof v !== "string") add(i, "error", `Field '${f}' phải là chuỗi.`);
    }
    // Enum/EnumList base type + its referenced table (Ref-typed values).
    if (!ch.baseType) delete ch.baseType;
    else if (typeof ch.baseType !== "string") add(i, "error", "'baseType' phải là chuỗi.");
    if (!ch.referencedTable) delete ch.referencedTable;
    else if (typeof ch.referencedTable !== "string") add(i, "error", "'referencedTable' phải là chuỗi.");
    else if (tableNames.size && !tableNames.has(ch.referencedTable)) add(i, "error", `referencedTable không tồn tại: ${ch.referencedTable}`);
    normProperties(ch, i);
    if (ch.properties) validateColumnProperties(ch.type || colType(ch.table!, ch.column!), ch.properties).forEach((m) => add(i, "warn", m));
    norm.push(ch);
  });

  return { ok: !issues.some((x) => x.level === "error"), issues, normalized: norm };
}

/** Short human-readable line for the review list. */
export function summarize(ch: Change): string {
  if (ch.op === "set_column") {
    const bits = EXPR_FIELDS.concat(SWITCH_FIELDS as any).filter((f) => (ch as any)[f]);
    return `set_column  ${ch.table}.${ch.column}${bits.length ? "  (" + bits.join(", ") + ")" : ""}`;
  }
  if (ch.op === "set_table") {
    const bits = [];
    if (ch.dataFilter) bits.push("security filter");
    if (ch.updateModeExpression) bits.push("updates formula");
    return `set_table  ${ch.table}${bits.length ? "  (" + bits.join(", ") + ")" : ""}`;
  }
  if (ch.op === "add_virtual_column") return `add_virtual_column  ${ch.table}.${ch.name} (${ch.type})`;
  if (ch.op === "add_slice") return `add_slice  "${ch.name}" @ ${ch.table}${ch.rowFilter ? "  (filter)" : ""}`;
  if (ch.op === "set_slice") return `set_slice  "${ch.slice}"`;
  if (ch.op === "add_action") return `add_action  "${ch.name}" (${ch.actionType}) @ ${ch.table}`;
  if (ch.op === "set_action") return `set_action  "${ch.action}"`;
  if (ch.op === "add_view") {
    const where = ch.table ? ` @ ${ch.table}` : ch.viewEntries?.length ? `  (${ch.viewEntries.length} entries)` : "";
    return `add_view  "${ch.name}" (${ch.viewType})${where}`;
  }
  if (ch.op === "set_view") return `set_view  "${ch.view}"`;
  if (ch.op === "add_format_rule") return `add_format_rule  "${ch.name}" @ ${ch.table}`;
  return `set_format_rule  "${ch.rule}"`;
}
