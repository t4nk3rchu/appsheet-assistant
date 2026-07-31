// src/lib/tables.ts — pure extraction of the app's real data tables from
// currentApp().appTemplate.AppData.DataSchemas. Kept pure (no window/DOM) so
// it's unit-testable; the bridge just feeds it the live DataSchemas array.

export interface Column {
  name: string;
  type: string; // AppSheet type: Text, Ref, Enum, DateTime, Number, ...
  values?: string[]; // fixed Enum/EnumList values, when the column defines a list
}

export interface Table {
  name: string;
  columns: Column[];
}

// Enum/EnumList values, in priority order:
//  1. the defined list — attr.MetaData.EnumValues (already parsed), or
//     attr.TypeAuxData (a JSON string carrying EnumValues);
//  2. for auto-from-data enums with no defined list, the values actually seen
//     in the data — attr.InternalQualifier.ColumnStats.MostFrequentValues.
// So the AI writes conditions against real values instead of inventing them.
function enumValues(a: any): string[] {
  const md = a?.MetaData;
  if (md && Array.isArray(md.EnumValues) && md.EnumValues.length) return md.EnumValues.map(String);
  if (typeof a?.TypeAuxData === "string") {
    try {
      const p = JSON.parse(a.TypeAuxData);
      if (Array.isArray(p?.EnumValues) && p.EnumValues.length) return p.EnumValues.map(String);
    } catch {
      /* not JSON — ignore */
    }
  }
  const seen = a?.InternalQualifier?.ColumnStats?.MostFrequentValues;
  if (Array.isArray(seen)) return seen.map(String).filter(Boolean);
  return [];
}

/**
 * DataSchemas holds one schema per data table AND one per bot/process output.
 * A real data table has a non-null ComponentId and AutomationPurpose 0; bot
 * schemas have ComponentId null and AutomationPurpose 1 (process state) or 2
 * (step output). AutoSchemaFrom carries the clean table name. System tables
 * (name starts with "_", e.g. "_Per User Settings") are dropped to match the
 * user-facing table list in the editor.
 */
export function extractTables(schemas: any[]): Table[] {
  return (schemas || [])
    .filter((s) => s && s.ComponentId != null && !s.AutomationPurpose)
    .map((s) => ({
      name: s.AutoSchemaFrom || String(s.Name || "").replace(/_Schema$/, ""),
      columns: Array.isArray(s.Attributes)
        ? s.Attributes
            .filter((a: any) => a && a.Name)
            .map((a: any) => {
              const type = (a.Type as string) || "Text";
              const col: Column = { name: a.Name as string, type };
              if (type === "Enum" || type === "EnumList") {
                const vals = enumValues(a);
                if (vals.length) col.values = vals.slice(0, 40); // cap to keep prompt context lean
              }
              return col;
            })
        : [],
    }))
    .filter((t) => t.name && !t.name.startsWith("_") && t.columns.length > 0);
}
