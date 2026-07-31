import { describe, it, expect } from "vitest";
import { validateSchema } from "../src/lib/schema-check";

describe("validateSchema", () => {
  it("errors when no app is loaded", () => {
    const issues = validateSchema({ appId: null, appName: null, appTemplate: null });
    expect(issues.some((i) => i.level === "error")).toBe(true);
  });
  it("warns on a table with no columns", () => {
    const schema = { appId: "A", appName: "n", appTemplate: { tables: [{ name: "Orders", columns: [] }] } };
    const issues = validateSchema(schema);
    expect(issues).toContainEqual({ level: "warn", message: 'Table "Orders" has no columns' });
  });
  it("returns empty for a healthy schema", () => {
    const schema = { appId: "A", appName: "n", appTemplate: { tables: [{ name: "Orders", columns: [{ name: "Id" }] }] } };
    expect(validateSchema(schema)).toEqual([]);
  });
});
