# View Property Control + Column Order Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the extension drive any simple property of any AppSheet view type (generic escape-hatch), a few composite per-type properties as typed fields, and table-view column order (auto/manual + add/remove + reorder).

**Architecture:** Extend the existing `add_view`/`set_view` path. Validation/normalization lives in `src/lib/changeset.ts` (pure, unit-tested with vitest). DOM application lives in `src/content/autofill.ts` `afFillView` (MAIN world, verified live via zen-mcp — this file has no unit tests, matching the existing codebase). Reuse existing primitives: `afSetPanelProp` (generic control setter), `afVfeOrderedList` (ordered MuiSelect lists), `afVfeEnum`/`afVfeClickOption` (segmented enums).

**Tech Stack:** TypeScript, Vite (`TARGET=firefox npx vite build`), Vitest, Firefox MV3 extension, zen-mcp for live editor verification.

## Global Constraints

- Build on Windows via Bash: `TARGET=firefox npx vite build` (the `build:firefox` npm script fails under cmd.exe). Typecheck: `npx tsc --noEmit` (check `${PIPESTATUS[0]}`).
- Bump `HOC_BUILD` in `src/content/bridge.ts` before each live re-test; verify `window.__hocBuild` in the page after reload.
- `autofill.ts` runs in MAIN world — no `chrome.*`/`browser.*`.
- Do NOT reuse the format-rule `columns` field for view columns — use `viewColumns`.
- Vietnamese failure strings match existing style (e.g. `"Field chưa vào (kiểm tay): "`).
- Commit after each task. Never push unless asked.

---

## Phase A — generic view property escape-hatch

### Task A1: Validate `properties` on view ops

**Files:**
- Modify: `src/lib/changeset.ts` (add_view/set_view block, ~line 262-301)
- Test: `tests/changeset.test.ts`

**Interfaces:**
- Consumes: existing `normProperties(ch, i)` helper, `Change.properties?: Record<string,string>` (already declared).
- Produces: view changes carry a normalized `properties` map.

- [ ] **Step 1: Write the failing test**

```ts
it("normalizes properties on a view op and drops empties", () => {
  const r = validateChangeset(tables, [
    { op: "set_view", view: "V", properties: { "Show legend": "true", "Trend line": "", "Chart colors": "Rainbow" } },
  ]);
  expect(r.ok).toBe(true);
  expect(r.normalized[0].properties).toEqual({ "Show legend": "true", "Chart colors": "Rainbow" });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/changeset.test.ts -t "normalizes properties on a view op"`
Expected: FAIL (properties passes through unnormalized or undefined-handling differs).

- [ ] **Step 3: Add `normProperties(ch, i)` to the add_view/set_view branch**

In the `if (ch.op === "add_view" || ch.op === "set_view")` block, immediately before `norm.push(ch); return;`, add:

```ts
      normProperties(ch, i);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/changeset.test.ts -t "normalizes properties on a view op"`
Expected: PASS

- [ ] **Step 5: Run full suite + typecheck**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all pass, tsc exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/lib/changeset.ts tests/changeset.test.ts
git commit -m "feat(view): normalize properties escape-hatch on add_view/set_view"
```

### Task A2: Apply view properties + prompt docs

**Files:**
- Modify: `src/content/autofill.ts` (`afFillView`, add near the end before the return)
- Modify: `src/lib/prompts.ts` (view rules + schema)
- Modify: `src/content/bridge.ts` (bump `HOC_BUILD`)

**Interfaces:**
- Consumes: `afSetPanelProp(panel: Element, label: string, value: string): Promise<boolean>` (exists), `afVfe()`.
- Produces: view `properties` applied; `failed` entries `prop:<label>` on failure.

- [ ] **Step 1: Add the properties loop in `afFillView`**

After the `showIf` block and before the final `return`, insert:

```ts
  if (ch.properties) {
    for (const [label, val] of Object.entries(ch.properties)) {
      // VFE panes share the column-editor markup, so afSetPanelProp drives them.
      if (!(await afSetPanelProp(pane as Element, label, String(val)))) failed.push(`prop:${label}`);
      await ttSleep(120);
      pane = afVfe();
    }
  }
```

- [ ] **Step 2: Document the escape-hatch in prompts.ts**

In the add_view rule line, append:

```
For ANY other view property not listed above, use "properties" keyed by the EXACT VFE label (e.g. {"Show legend":"true","Trend line":"true","Chart colors":"Rainbow"}). Use typed fields where they exist; use properties for the rest.
```

Add to the JSON schema block (near the view fields):

```
      "properties": { "Exact View-editor Label": "value" },
```

- [ ] **Step 3: Bump build marker + build**

Edit `src/content/bridge.ts`: bump `HOC_BUILD` (e.g. `"2026-08-10d"`).
Run: `TARGET=firefox npx vite build`
Expected: `All steps completed.`

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit` — expected exit 0.

- [ ] **Step 5: Live verify (zen-mcp)**

Reload extension (about:debugging → Reload — needs user click), hard-reload editor tab, confirm `window.__hocBuild`. Open a chart view; run `applyChanges` with `{op:"set_view", view:"<chart view>", properties:{"Show legend":"true"}}`; confirm the Show legend switch flipped via `zen_evaluate`.

- [ ] **Step 6: Commit**

```bash
git add src/content/autofill.ts src/lib/prompts.ts src/content/bridge.ts
git commit -m "feat(view): apply generic properties escape-hatch via afSetPanelProp"
```

---

## Phase B — typed fields for composite controls

### Task B1: Validate `chartType` / `chartColumns`

**Files:**
- Modify: `src/lib/changeset.ts` (Change interface + add_view/set_view validation)
- Test: `tests/changeset.test.ts`

**Interfaces:**
- Produces: `Change.chartType?: string`, `Change.chartColumns?: string[]`.

- [ ] **Step 1: Add fields to the `Change` interface**

Under the `// add_view / set_view` fields:

```ts
  chartType?: string;      // Chart type dropdown (chart views)
  chartColumns?: string[]; // Chart columns ordered list (chart views)
```

- [ ] **Step 2: Write the failing test**

```ts
it("validates chartColumns array and warns on unknown chart columns", () => {
  const r = validateChangeset(tables, [
    { op: "set_view", view: "V", table: "VĂN_BẢN", chartType: "pie", chartColumns: ["id", "ghost"] },
  ]);
  expect(r.ok).toBe(true);
  expect(r.normalized[0].chartColumns).toEqual(["id", "ghost"]);
  expect(r.issues.some((i) => i.level === "warn" && i.msg.includes("ghost"))).toBe(true);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/changeset.test.ts -t "validates chartColumns"`
Expected: FAIL.

- [ ] **Step 4: Add validation in the add_view/set_view block**

Before `normProperties(ch, i)`:

```ts
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
```

- [ ] **Step 5: Run test + full suite + typecheck**

Run: `npx vitest run tests/changeset.test.ts -t "validates chartColumns" && npx vitest run && npx tsc --noEmit`
Expected: PASS, tsc exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/lib/changeset.ts tests/changeset.test.ts
git commit -m "feat(view): validate chartType/chartColumns typed fields"
```

### Task B2: Apply `chartType` / `chartColumns` + prompt

**Files:**
- Modify: `src/content/autofill.ts` (`afFillView`)
- Modify: `src/lib/prompts.ts`
- Modify: `src/content/bridge.ts` (bump `HOC_BUILD`)

**Interfaces:**
- Consumes: `afVfeDropdown(pane, label, value): boolean`, `afVfeOrderedList(pane, label, items): Promise<boolean>`.

- [ ] **Step 1: Apply chartType/chartColumns in `afFillView`**

After the `viewType` block (so the chart controls exist), add:

```ts
  if (ch.chartType) {
    if (!afVfeDropdown(pane, "Chart type", ch.chartType)) failed.push("chartType");
    await ttSleep(150);
    pane = afVfe();
  }
  if (ch.chartColumns?.length) {
    const items = ch.chartColumns.map((c) => ({ column: c }));
    if (!(await afVfeOrderedList(pane, "Chart columns", items))) failed.push("chartColumns");
    await ttSleep(90);
    pane = afVfe();
  }
```

- [ ] **Step 2: Document in prompts.ts**

Add to the schema block:

```
      "chartType": "chart view: pie|bar|line|... (see AppSheet)",
      "chartColumns": ["existing_col", "..."],
```

Add a rule line: `- CHART views: set "chartType" and "chartColumns" (ordered). Other chart props (Chart colors, Trend line, Show legend) go in "properties".`

- [ ] **Step 3: Bump marker + build + typecheck**

Run: bump `HOC_BUILD`, `TARGET=firefox npx vite build`, `npx tsc --noEmit`.
Expected: build completed, tsc exit 0.

- [ ] **Step 4: Live verify**

On a chart view, `applyChanges` `{op:"set_view", view:"<chart>", chartType:"pie", chartColumns:["<col>"]}`; confirm dropdown + list via `zen_evaluate`.

- [ ] **Step 5: Commit**

```bash
git add src/content/autofill.ts src/lib/prompts.ts src/content/bridge.ts
git commit -m "feat(view): apply chartType + chartColumns"
```

---

## Phase C — table-view column order

### Task C1: Validate `columnOrder` / `viewColumns`

**Files:**
- Modify: `src/lib/changeset.ts`
- Test: `tests/changeset.test.ts`

**Interfaces:**
- Produces: `Change.columnOrder?: "automatic" | "manual"`, `Change.viewColumns?: string[]`.

- [ ] **Step 1: Add fields to `Change`**

```ts
  columnOrder?: "automatic" | "manual"; // table view Column order mode
  viewColumns?: string[];               // table view: visible columns in order
```

- [ ] **Step 2: Write the failing test**

```ts
it("validates columnOrder enum and viewColumns, warns unknown columns", () => {
  const ok = validateChangeset(tables, [
    { op: "set_view", view: "V", table: "VĂN_BẢN", columnOrder: "manual", viewColumns: ["id", "ghost"] },
  ]);
  expect(ok.ok).toBe(true);
  expect(ok.normalized[0].viewColumns).toEqual(["id", "ghost"]);
  expect(ok.issues.some((i) => i.level === "warn" && i.msg.includes("ghost"))).toBe(true);
  const bad = validateChangeset(tables, [
    { op: "set_view", view: "V", columnOrder: "sideways" as any },
  ]);
  expect(bad.ok).toBe(false);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/changeset.test.ts -t "validates columnOrder"`
Expected: FAIL.

- [ ] **Step 4: Add validation in the add_view/set_view block**

```ts
      if (ch.columnOrder != null && ch.columnOrder !== "automatic" && ch.columnOrder !== "manual")
        add(i, "error", `columnOrder không hợp lệ: ${ch.columnOrder} (automatic|manual)`);
      if (!ch.columnOrder) delete ch.columnOrder;
      if (ch.viewColumns != null) {
        if (!Array.isArray(ch.viewColumns)) {
          add(i, "error", "'viewColumns' phải là mảng tên cột.");
          delete ch.viewColumns;
        } else {
          const cs3 = ch.table && tableNames.has(ch.table) ? colSet(ch.table) : null;
          ch.viewColumns.forEach((cn) => {
            if (cs3 && !cs3.has(String(cn).toLowerCase())) add(i, "warn", `viewColumns: cột không có trong ${ch.table}: ${cn}`);
          });
        }
      }
```

- [ ] **Step 5: Run test + full suite + typecheck**

Run: `npx vitest run tests/changeset.test.ts -t "validates columnOrder" && npx vitest run && npx tsc --noEmit`
Expected: PASS, tsc exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/lib/changeset.ts tests/changeset.test.ts
git commit -m "feat(view): validate columnOrder/viewColumns"
```

### Task C2: Apply column order mode + add/remove

**Files:**
- Modify: `src/content/autofill.ts` (`afFillView` + new `afSetColumnOrder` helper)
- Modify: `src/lib/prompts.ts`
- Modify: `src/content/bridge.ts` (bump `HOC_BUILD`)

**Interfaces:**
- Consumes: `afVfeCtrl(pane,label)`, `afVfeEnum(pane,label,value)`, `ttClick`, `ttSleep`, `ttSame`.
- Produces: `afSetColumnOrder(pane: Element, mode: string | undefined, cols: string[] | undefined): Promise<boolean>`.

- [ ] **Step 1: Live-map the manual widget (zen-mcp) BEFORE coding**

On a table view, switch `Column order` to manual and dump one column row: how a column is identified (label text of each `MuiFormControlLabel`), how the checkbox toggles (`input[type=checkbox]` state / `.CheckboxControl` data-value), and what `Add`/`Remove` buttons do. Record exact selectors. (The widget: EnumControl `automatic|manual`; manual reveals `MuiFormControlLabel` per column + Add/Remove/Edit buttons.)

- [ ] **Step 2: Write `afSetColumnOrder` (mode + check/uncheck)**

Using the selectors confirmed in Step 1 (example shape — adjust to findings):

```ts
/** Table view "Column order": set automatic|manual, then in manual mode
 *  check exactly the columns in `cols` (add/remove). Reorder is separate. */
async function afSetColumnOrder(pane: Element, mode: string | undefined, cols: string[] | undefined): Promise<boolean> {
  const fc = afVfeCtrl(pane, "Column order");
  if (!fc) return false;
  const wantManual = mode === "manual" || (!!cols && cols.length > 0 && mode !== "automatic");
  const ec = fc.querySelector(".EnumControl");
  if (ec) {
    const target = wantManual ? "manual" : (mode || "automatic");
    if (ec.getAttribute("data-value") !== target) {
      const opt = ec.querySelector<HTMLElement>(`.EnumOption[data-value="${target}"]`);
      if (opt) { ttClick(opt); await ttSleep(200); }
    }
  }
  if (!wantManual || !cols?.length) return true;
  const want = new Set(cols.map((c) => c.toLowerCase()));
  let ok = true;
  for (const lbl of Array.from(fc.querySelectorAll(".MuiFormControlLabel-root"))) {
    const name = (lbl.querySelector(".MuiTypography-root")?.textContent || lbl.textContent || "").trim();
    const cb = lbl.querySelector<HTMLInputElement>('input[type="checkbox"]');
    if (!cb) continue;
    const shouldCheck = want.has(name.toLowerCase());
    if (cb.checked !== shouldCheck) { ttClick(cb); await ttSleep(120); }
    if (shouldCheck && !cb.checked) ok = false;
  }
  return ok;
}
```

- [ ] **Step 3: Wire into `afFillView`**

After sortBy/groupBy, add:

```ts
  if (ch.columnOrder || ch.viewColumns?.length) {
    if (!(await afSetColumnOrder(pane as Element, ch.columnOrder, ch.viewColumns))) failed.push("columnOrder");
    await ttSleep(90);
    pane = afVfe();
  }
```

- [ ] **Step 4: Document in prompts.ts**

Add schema: `"columnOrder": "automatic|manual", "viewColumns": ["col_in_order", "..."],`
Rule: `- TABLE views: "columnOrder" automatic|manual; with "viewColumns" (ordered visible columns) it switches to manual and shows exactly those columns.`

- [ ] **Step 5: Bump marker + build + typecheck + live verify**

Build, reload, `applyChanges` `{op:"set_view", view:"<table view>", columnOrder:"manual", viewColumns:["id","..."]}`; confirm the checked set matches via `zen_evaluate`.

- [ ] **Step 6: Commit**

```bash
git add src/content/autofill.ts src/lib/prompts.ts src/content/bridge.ts
git commit -m "feat(view): column order mode + add/remove columns"
```

### Task C3: Reorder columns (spike-gated) — DEFERRED

**Outcome (2026-08-10):** Spike ran; reorder NOT shipped. The per-row drag handle is hover-gated, and the widget uses a JS sorter that needs real-time `pointermove` sequencing — a synthesized (synchronous) drag corrupts the widget's transient state instead of reordering. Per the decision gate + pre-authorized fallback, C1/C2 shipped and reorder is a follow-up. Hook point marked with `// ponytail:` in `afSetColumnOrder`. A future attempt: hover row → reveal handle → timed multi-step pointer drag (likely needs rAF-spaced moves across the drag).


**Files:**
- Modify: `src/content/autofill.ts` (new `afReorderColumns`, called from `afSetColumnOrder`)
- Modify: `src/content/bridge.ts` (bump `HOC_BUILD`)

**Interfaces:**
- Produces: `afReorderColumns(fc: Element, order: string[]): Promise<boolean>`.

- [ ] **Step 1: Reorder SPIKE (zen-mcp, no commit)**

On the manual widget: hover a column row (`dispatchEvent` `pointerover`/`mouseover`/`mouseenter`) to reveal its drag handle; then synthesize `pointerdown` on the handle → several `pointermove` toward the target row's Y → `pointerup`. Verify via `zen_evaluate` that the row order changed. Try both `pointer*` and HTML5 `drag*` event sets. **Decision gate:** if neither reliably reorders after reasonable effort, STOP — ship Tasks C1/C2 only, add `// ponytail: reorder deferred — drag synthesis unreliable, see spec` where reorder would hook in, and note the deferral to the user. Skip remaining steps.

- [ ] **Step 2: Implement `afReorderColumns` from the spike findings**

Only if the spike succeeded. Insert-sort the rows into `order` using the confirmed hover→drag sequence. Call it at the end of `afSetColumnOrder` when `wantManual && cols?.length`:

```ts
  if (ok && cols.length > 1) ok = await afReorderColumns(fc, cols);
```

(Body written from the exact events/selectors the spike proved — hover to reveal handle, pointerdown/move/up. No placeholder: the spike produces the concrete sequence before this step is written.)

- [ ] **Step 3: Bump marker + build + typecheck + live verify**

Build, reload, `applyChanges` with a `viewColumns` order differing from current; confirm final row order matches via `zen_evaluate`.

- [ ] **Step 4: Commit**

```bash
git add src/content/autofill.ts src/content/bridge.ts
git commit -m "feat(view): reorder table columns via hover-drag in manual mode"
```

---

## Self-Review

- **Spec coverage:** A (escape-hatch) → A1/A2. B (chartType/chartColumns typed) → B1/B2. C (columnOrder/viewColumns, add/remove, reorder) → C1/C2/C3. Reorder spike-gate + fallback → C3 Step 1. All spec sections covered.
- **Type consistency:** `afSetColumnOrder(pane, mode, cols)`, `afReorderColumns(fc, order)`, fields `chartType`/`chartColumns`/`columnOrder`/`viewColumns` consistent across tasks. `properties` reuses the existing field/normalizer.
- **Placeholders:** none except C3 Step 2, which is deliberately spike-derived (the exact drag sequence can't be written before the spike proves the mechanism — the gate makes this explicit, not a hidden TODO).
