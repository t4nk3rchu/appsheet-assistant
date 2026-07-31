// tests/tables.test.ts — the DataSchemas filter that distinguishes real data
// tables from bot/process schemas (shapes taken from a live currentApp() dump).
import { describe, it, expect } from "vitest";
import { extractTables } from "../src/lib/tables";

describe("extractTables", () => {
  const schemas = [
    { Name: "VĂN_BẢN_Schema", AutoSchemaFrom: "VĂN_BẢN", ComponentId: "KYWE", AutomationPurpose: 0,
      Attributes: [{ Name: "id", Type: "Text" }, { Name: "trạng_thái", Type: "Enum" }] },
    { Name: "GIAI_ĐOẠN_Schema", AutoSchemaFrom: "GIAI_ĐOẠN", ComponentId: "KB2H", AutomationPurpose: 0,
      Attributes: [{ Name: "id", Type: "Text" }] },
    // system table — real schema but name starts with "_"
    { Name: "_Per User Settings_Schema", AutoSchemaFrom: "_Per User Settings", ComponentId: "K2I6", AutomationPurpose: 0,
      Attributes: [{ Name: "_RowNumber", Type: "Number" }] },
    // bot process state table
    { Name: "Process X Process Table_Schema", AutoSchemaFrom: null, ComponentId: null, AutomationPurpose: 1,
      Attributes: [{ Name: "Instance Id", Type: "Text" }] },
    // bot step output
    { Name: "Step Y Output_Schema", AutoSchemaFrom: null, ComponentId: null, AutomationPurpose: 2,
      Attributes: [{ Name: "z", Type: "Text" }] },
  ];

  it("keeps real user tables, drops bot schemas and system tables", () => {
    const tables = extractTables(schemas);
    expect(tables.map((t) => t.name)).toEqual(["VĂN_BẢN", "GIAI_ĐOẠN"]);
  });

  it("carries column name + AppSheet type", () => {
    const vb = extractTables(schemas)[0];
    expect(vb.columns).toEqual([{ name: "id", type: "Text" }, { name: "trạng_thái", type: "Enum" }]);
  });

  it("tolerates missing/empty input", () => {
    expect(extractTables([])).toEqual([]);
    expect(extractTables(undefined as any)).toEqual([]);
  });

  it("captures Enum values: defined list, then observed data as fallback", () => {
    const s = [
      { Name: "T_Schema", AutoSchemaFrom: "T", ComponentId: "K", AutomationPurpose: 0, Attributes: [
        // defined list via MetaData
        { Name: "status", Type: "Enum", MetaData: { EnumValues: ["active", "eol", "deprecated"] } },
        // no defined list → fall back to observed data
        { Name: "region", Type: "Enum", InternalQualifier: { ColumnStats: { MostFrequentValues: ["north", "south"] } } },
        // non-enum → no values
        { Name: "id", Type: "Text" },
      ] },
    ];
    const cols = extractTables(s)[0].columns;
    expect(cols.find((c) => c.name === "status")?.values).toEqual(["active", "eol", "deprecated"]);
    expect(cols.find((c) => c.name === "region")?.values).toEqual(["north", "south"]);
    expect(cols.find((c) => c.name === "id")?.values).toBeUndefined();
  });
});
