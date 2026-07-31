// tests/changeset.test.ts — the changeset validator that gates what gets
// applied to the editor.
import { describe, it, expect } from "vitest";
import { validateChangeset, summarize } from "../src/lib/changeset";
import type { Table } from "../src/lib/tables";

const tables: Table[] = [
  { name: "VĂN_BẢN", columns: [{ name: "id", type: "Text" }, { name: "trạng_thái", type: "Enum" }] },
];

describe("validateChangeset", () => {
  it("accepts a valid set_column and strips empty fields", () => {
    const r = validateChangeset(tables, [
      { op: "set_column", table: "VĂN_BẢN", column: "trạng_thái", appFormula: '"x"', validIf: "" },
    ]);
    expect(r.ok).toBe(true);
    expect(r.normalized).toHaveLength(1);
    expect(r.normalized[0]).not.toHaveProperty("validIf"); // empty dropped
    expect(r.normalized[0].appFormula).toBe('"x"');
  });

  it("accepts Enum base-type Ref and validates referencedTable exists", () => {
    const ok = validateChangeset(tables, [
      { op: "set_column", table: "VĂN_BẢN", column: "trạng_thái", type: "Enum", baseType: "Ref", referencedTable: "VĂN_BẢN" },
    ]);
    expect(ok.ok).toBe(true);
    expect(ok.normalized[0].baseType).toBe("Ref");

    const bad = validateChangeset(tables, [
      { op: "set_column", table: "VĂN_BẢN", column: "trạng_thái", type: "Enum", baseType: "Ref", referencedTable: "NOPE" },
    ]);
    expect(bad.ok).toBe(false);
    expect(bad.issues.some((i) => i.level === "error" && i.msg.includes("referencedTable"))).toBe(true);
  });

  it("normalizes the properties escape-hatch (coerce to string, drop empties)", () => {
    const r = validateChangeset(tables, [
      { op: "set_column", table: "VĂN_BẢN", column: "id", properties: { "Maximum value": 100, "Show as": "Thermometer", "Min": "" } },
    ]);
    expect(r.ok).toBe(true);
    expect(r.normalized[0].properties).toEqual({ "Maximum value": "100", "Show as": "Thermometer" });

    const bad = validateChangeset(tables, [
      { op: "set_column", table: "VĂN_BẢN", column: "id", properties: ["nope"] as any },
    ]);
    expect(bad.ok).toBe(false);
  });

  it("warns when a property doesn't fit the column's type (catalog-grounded)", () => {
    const r = validateChangeset(tables, [
      // add_virtual_column type Number: "Maximum value" ok; "Formatting" is not a Number prop
      { op: "add_virtual_column", table: "VĂN_BẢN", name: "vc", type: "Number", appFormula: "1",
        properties: { "Maximum value": "100", "Formatting": "HTML" } },
      // LongText "Formatting" must be one of the listed enum values
      { op: "add_virtual_column", table: "VĂN_BẢN", name: "vc2", type: "LongText", appFormula: "1",
        properties: { "Formatting": "Bogus" } },
    ]);
    expect(r.ok).toBe(true); // property mismatches are warnings, not errors
    expect(r.issues.some((x) => x.level === "warn" && x.msg.includes("Formatting") && x.msg.includes("Number"))).toBe(true);
    expect(r.issues.some((x) => x.level === "warn" && x.msg.includes("Plain Text"))).toBe(true);
  });

  it("errors on missing/unknown table or column", () => {
    const r = validateChangeset(tables, [
      { op: "set_column", table: "NOPE", column: "x" },
      { op: "set_column", table: "VĂN_BẢN" }, // no column
      { op: "set_column", table: "VĂN_BẢN", column: "ghost" },
    ]);
    expect(r.ok).toBe(false);
    expect(r.normalized).toHaveLength(0);
    expect(r.issues.filter((i) => i.level === "error")).toHaveLength(3);
  });

  it("accepts format rules and warns on unknown format columns", () => {
    const r = validateChangeset(tables, [
      { op: "add_format_rule", name: "R1", table: "VĂN_BẢN", columns: ["trạng_thái", "__action__Foo", "ghost"] },
      { op: "set_format_rule", rule: "Existing" },
    ]);
    expect(r.ok).toBe(true); // warnings don't block
    expect(r.normalized).toHaveLength(2);
    expect(r.issues.some((i) => i.level === "warn" && i.msg.includes("ghost"))).toBe(true);
  });

  it("accepts a valid add_view and validates its enums", () => {
    const r = validateChangeset(tables, [
      { op: "add_view", name: "My List", table: "VĂN_BẢN", viewType: "table", position: "menu", icon: "list" },
    ]);
    expect(r.ok).toBe(true);
    expect(r.normalized).toHaveLength(1);
  });

  it("errors on add_view missing viewType and on bad viewType/position", () => {
    const r = validateChangeset(tables, [
      { op: "add_view", name: "V", table: "VĂN_BẢN" }, // no viewType
      { op: "add_view", name: "V2", table: "VĂN_BẢN", viewType: "grid" }, // invalid type
      { op: "add_view", name: "V3", table: "VĂN_BẢN", viewType: "deck", position: "top" }, // invalid position
      { op: "set_view" }, // no view name
    ]);
    expect(r.ok).toBe(false);
    expect(r.issues.filter((i) => i.level === "error").length).toBeGreaterThanOrEqual(4);
  });

  it("normalizes view sortBy/groupBy order and warns on unknown columns", () => {
    const r = validateChangeset(tables, [
      {
        op: "set_view",
        view: "V",
        table: "VĂN_BẢN",
        sortBy: [{ column: "trạng_thái", order: "desc" }, { column: "id" }],
        groupBy: [{ column: "ghost" }],
      },
    ]);
    expect(r.ok).toBe(true); // column warning doesn't block
    const ch = r.normalized[0];
    expect(ch.sortBy).toEqual([{ column: "trạng_thái", order: "Descending" }, { column: "id" }]);
    expect(r.issues.some((i) => i.level === "warn" && i.msg.includes("ghost"))).toBe(true);
  });

  it("errors when sortBy is not an array or item lacks a column", () => {
    const r = validateChangeset(tables, [
      { op: "set_view", view: "V", sortBy: "id" as any },
      { op: "set_view", view: "V2", table: "VĂN_BẢN", groupBy: [{ order: "Ascending" } as any] },
    ]);
    expect(r.ok).toBe(false);
    expect(r.issues.filter((i) => i.level === "error").length).toBeGreaterThanOrEqual(2);
  });

  it("accepts add_virtual_column and enforces name/type rules", () => {
    const ok = validateChangeset(tables, [
      { op: "add_virtual_column", table: "VĂN_BẢN", name: "tong_tien", type: "Number", appFormula: "1+1" },
    ]);
    expect(ok.ok).toBe(true);
    expect(ok.normalized[0].name).toBe("tong_tien");

    const bad = validateChangeset(tables, [
      { op: "add_virtual_column", table: "VĂN_BẢN", name: "has space", type: "Number" }, // space
      { op: "add_virtual_column", table: "VĂN_BẢN", name: "id", type: "Text" }, // duplicate of existing col
      { op: "add_virtual_column", table: "VĂN_BẢN", name: "x" }, // no type
    ]);
    expect(bad.ok).toBe(false);
    expect(bad.issues.filter((i) => i.level === "error").length).toBeGreaterThanOrEqual(3);
  });

  it("accepts add_slice and requires name+table", () => {
    const ok = validateChangeset(tables, [
      { op: "add_slice", name: "Active", table: "VĂN_BẢN", rowFilter: '[trạng_thái]="active"' },
    ]);
    expect(ok.ok).toBe(true);
    expect(ok.normalized[0].rowFilter).toBe('[trạng_thái]="active"');

    const bad = validateChangeset(tables, [
      { op: "add_slice", name: "X" }, // no table
      { op: "set_slice" }, // no slice name
    ]);
    expect(bad.ok).toBe(false);
    expect(bad.issues.filter((i) => i.level === "error").length).toBeGreaterThanOrEqual(2);
  });

  it("accepts add_action and enforces name/table/actionType + valid type", () => {
    const ok = validateChangeset(tables, [
      { op: "add_action", name: "Mark Active", table: "VĂN_BẢN", actionType: "SET_COLUMN_VALUE",
        assignments: [{ column: "trạng_thái", value: '"active"' }], position: "Inline" },
    ]);
    expect(ok.ok).toBe(true);
    const bad = validateChangeset(tables, [
      { op: "add_action", name: "A", table: "VĂN_BẢN" }, // no actionType
      { op: "add_action", name: "B", table: "VĂN_BẢN", actionType: "BOGUS" }, // invalid type
      { op: "set_action" }, // no action name
    ]);
    expect(bad.ok).toBe(false);
    expect(bad.issues.filter((i) => i.level === "error").length).toBeGreaterThanOrEqual(3);
  });

  it("canonicalizes AppSheet action-position labels (Do not display → Hide)", () => {
    const r = validateChangeset(tables, [
      { op: "add_action", name: "Del", table: "VĂN_BẢN", actionType: "DELETE_RECORD", position: "Do not display" },
      { op: "add_action", name: "Big", table: "VĂN_BẢN", actionType: "EDIT_RECORD", position: "Display prominently" },
    ]);
    expect(r.ok).toBe(true);
    expect(r.normalized[0].position).toBe("Hide");
    expect(r.normalized[1].position).toBe("Prominent");
  });

  it("grounds action properties against the action type (catalog)", () => {
    const r = validateChangeset(tables, [
      // EMAIL "To"/"Subject" valid; "Launch External" belongs to NAVIGATE_URL not EMAIL
      { op: "add_action", name: "Notify", table: "VĂN_BẢN", actionType: "EMAIL",
        properties: { To: '"a@b.com"', Subject: '"Hi"', "Launch External": "true" } },
    ]);
    expect(r.ok).toBe(true); // warnings only
    expect(r.issues.some((x) => x.level === "warn" && x.msg.includes("Launch External") && x.msg.includes("EMAIL"))).toBe(true);
  });

  it("rejects genuinely unsupported ops", () => {
    const r = validateChangeset(tables, [{ op: "delete_everything" as any, table: "VĂN_BẢN" }]);
    expect(r.ok).toBe(false);
    expect(r.normalized).toHaveLength(0);
  });

  it("summarize is human-readable", () => {
    expect(summarize({ op: "set_column", table: "VĂN_BẢN", column: "trạng_thái", appFormula: "x" })).toContain("VĂN_BẢN.trạng_thái");
  });
});
