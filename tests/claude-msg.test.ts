import { describe, it, expect } from "vitest";
import { extractChangesetJson, hashSchema, decideTurn, buildClaudeMessage } from "../src/lib/claude-msg";

describe("extractChangesetJson", () => {
  it("returns clean JSON unchanged", () => {
    expect(extractChangesetJson('{"changes":[]}')).toBe('{"changes":[]}');
  });
  it("strips ```json fences", () => {
    expect(extractChangesetJson('```json\n{"changes":[]}\n```')).toBe('{"changes":[]}');
  });
  it("pulls the object out of surrounding prose", () => {
    expect(extractChangesetJson('Sure! Here you go:\n{"changes":[{"op":"x"}]}\nHope that helps'))
      .toBe('{"changes":[{"op":"x"}]}');
  });
  it("returns null when there is no object", () => {
    expect(extractChangesetJson("no json here")).toBeNull();
  });
});

describe("hashSchema", () => {
  const a = [{ name: "T", columns: [{ name: "c", type: "Text" }] }] as any;
  const b = [{ name: "T", columns: [{ name: "c", type: "Number" }] }] as any;
  it("is stable for the same input", () => {
    expect(hashSchema(a)).toBe(hashSchema(a));
  });
  it("changes when a column type changes", () => {
    expect(hashSchema(a)).not.toBe(hashSchema(b));
  });
});

describe("decideTurn", () => {
  it("first turn: not already primed, schema counts as changed", () => {
    const r = decideTurn(null, "h1", 1);
    expect(r.primed).toBe(false);
    expect(r.schemaChanged).toBe(true);
    expect(r.next).toEqual({ primed: true, schemaHash: "h1", tabId: 1 });
  });
  it("second turn, same tab, same schema: primed, no schema change", () => {
    const r = decideTurn({ primed: true, schemaHash: "h1", tabId: 1 }, "h1", 1);
    expect(r.primed).toBe(true);
    expect(r.schemaChanged).toBe(false);
  });
  it("second turn, same tab, changed schema: primed, schema changed", () => {
    const r = decideTurn({ primed: true, schemaHash: "h1", tabId: 1 }, "h2", 1);
    expect(r.primed).toBe(true);
    expect(r.schemaChanged).toBe(true);
    expect(r.next.schemaHash).toBe("h2");
  });
  it("same schema but a different tab id: not primed (spec must be re-sent)", () => {
    const r = decideTurn({ primed: true, schemaHash: "h1", tabId: 1 }, "h1", 2);
    expect(r.primed).toBe(false);
    expect(r.next).toEqual({ primed: true, schemaHash: "h1", tabId: 2 });
  });
});

describe("buildClaudeMessage", () => {
  const base = { skillName: "appsheet-architect", system: "SPEC+RULES", ask: "add a bot", schemaText: "SCHEMA" };
  it("primer, first turn: includes the full spec + schema + ask", () => {
    const m = buildClaudeMessage({ ...base, mode: "primer", alreadyPrimed: false, schemaChanged: true });
    expect(m).toContain("SPEC+RULES");
    expect(m).toContain("SCHEMA");
    expect(m).toContain("add a bot");
  });
  it("primer, later turn, unchanged schema: no spec, no schema, just the ask", () => {
    const m = buildClaudeMessage({ ...base, mode: "primer", alreadyPrimed: true, schemaChanged: false });
    expect(m).not.toContain("SPEC+RULES");
    expect(m).not.toContain("SCHEMA");
    expect(m).toContain("add a bot");
  });
  it("account mode: triggers the skill by name, no full spec", () => {
    const m = buildClaudeMessage({ ...base, mode: "account", alreadyPrimed: false, schemaChanged: true });
    expect(m).toContain("appsheet-architect");
    expect(m).not.toContain("SPEC+RULES");
    expect(m).toContain("SCHEMA");
    expect(m).toContain("add a bot");
  });
  it("account mode, unchanged schema: no spec, no schema, just the skill trigger + ask", () => {
    const m = buildClaudeMessage({ ...base, mode: "account", alreadyPrimed: true, schemaChanged: false });
    expect(m).not.toContain("SPEC+RULES");
    expect(m).not.toContain("SCHEMA");
    expect(m).toContain("appsheet-architect");
    expect(m).toContain("add a bot");
  });
});
