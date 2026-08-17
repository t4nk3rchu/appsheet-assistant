// src/content/autofill.ts — runs in the MAIN world (page context).
//
// Faithful TypeScript port of the decompiled extension's editor-automation
// engine (window.__hocAutoFillApi in reverse/content.pretty.js) plus the
// bridge's SFC "setFormatColumns" writer (reverse/bridge.pretty.js). It drives
// the live AppSheet editor DOM directly — clicking rows, injecting values into
// inputs and CodeMirror, flipping switches, and selecting <select> options —
// so it needs native access to window/document, React fiber props, and the
// page's CodeMirror instances. Because it lives in the MAIN world it uses NO
// chrome.*/browser.* APIs.
//
// Scope of this iteration (see task): only the "set_column",
// "add_format_rule" and "set_format_rule" ops are implemented. The original's
// view/action/virtual-column writers and the pause/cancel/onProgress
// machinery are intentionally left out. Everything else is preserved verbatim:
// the same selectors, event sequences, waits/timeouts, the readonly-attribute
// dance in afSetText, the Expression Assistant / CodeMirror flow in
// afSetExpression, and the React-fiber fallbacks in ttSetSelect and SFC.
import type { Change, FillResult } from "../lib/changeset";

/* ======================================================================
 * tt* primitives (source ~3923-4132)
 * ==================================================================== */

/** Case-insensitive string equality (source ttSame ~3923). */
function ttSame(t: unknown, e: unknown): boolean {
  return String(t || "").toLowerCase() === String(e || "").toLowerCase();
}

/** All rendered virtualized rows of the columns grid (source ttRows ~3926). */
function ttRows(t: Element | Document | null): HTMLElement[] {
  return Array.from(
    (t ?? document).querySelectorAll<HTMLElement>('.ReactVirtualized__Table__row[role="row"]'),
  );
}

/** The column name shown in a grid row (source ttRowName ~3933). */
function ttRowName(t: Element): string {
  return (
    (t.querySelector(".NameColumnControl")?.getAttribute("data-value") ||
      t.querySelector<HTMLInputElement>(".NameColumnControl input")?.value ||
      "") as string
  ).trim();
}

/** Currently-open table name, read from the editor chrome (source ttCurrentTable ~3945). */
function ttCurrentTable(): string {
  const t = Array.from(document.querySelectorAll("#appData p,p")).find((r) =>
    /^\s*Table:\s*/i.test((r.textContent || "").trim()),
  );
  if (t) return (t.textContent?.replace(/^\s*Table:\s*/i, "").trim() || "") as string;
  const c = document.querySelector('[data-path^="Data,Columns,"]');
  if (c) {
    const m = /^Data,Columns,(.+?)_Schema/.exec(c.getAttribute("data-path") || "");
    if (m) return m[1];
  }
  return "";
}

/** Synthesize a full pointer/mouse click sequence on an element (source ttClick ~3965). */
function ttClick(t: Element): void {
  ["pointerdown", "mousedown", "pointerup", "mouseup", "click"].forEach((e) =>
    t.dispatchEvent(new MouseEvent(e, { bubbles: true, cancelable: true, view: window })),
  );
}

/** Promise-based sleep (source ttSleep ~3972). */
function ttSleep(t: number): Promise<void> {
  return new Promise((e) => setTimeout(e, t));
}

/** The columns grid element (source ttFindGrid ~4016). */
function ttFindGrid(): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    '#appData .ReactVirtualized__Grid[aria-label="grid"],#appData .ReactVirtualized__Table__Grid,.ReactVirtualized__Grid[aria-label="grid"],.ReactVirtualized__Table__Grid',
  );
}

/** Open a table in the editor tree, waiting for the grid to swap (source ttOpenTable ~3975). */
async function ttOpenTable(t: string): Promise<boolean> {
  if (ttSame(ttCurrentTable(), t)) return true;
  const e = Array.from(
    document.querySelectorAll('#appData [role="treeitem"],[role="treeitem"],.MuiTreeItem-content'),
  ).find((r) => {
    const a = (r.getAttribute("aria-label") || r.textContent || "")
      .replace(/\s*\(\d+\)\s*$/, "")
      .replace(/\s+/g, " ")
      .trim();
    return ttSame(a, t);
  });
  if (!e) return false;
  // The select/expand onClick lives on .MuiTreeItem-content, NOT the root <li>.
  // The combined selector matches both, and .find() returns the root first;
  // synthetic events dispatched on the root bubble UP and never reach the
  // content's handler, so the table never switches. Confirmed on the live
  // editor: ttClick(root) is a no-op, content.click() switches. Click the
  // content node natively; keep synthetic ttClick as a harmless fallback.
  const content =
    (e.classList.contains("MuiTreeItem-content") ? e : e.querySelector(".MuiTreeItem-content")) || e;
  try {
    (content as HTMLElement).scrollIntoView({ block: "center", inline: "nearest" });
  } catch {
    /* ignore */
  }
  const g0 = ttFindGrid();
  const prev = g0 && ttRows(g0).length ? ttRowName(ttRows(g0)[0]) : "";
  (content as HTMLElement).click?.();
  ttClick(content);
  let w = 0;
  for (; w < 4000; ) {
    await ttSleep(90);
    w += 90; // was 150 while sleeping 90 — the budget expired ~40% early
    if (ttSame(ttCurrentTable(), t)) {
      await ttSleep(90);
      return true;
    }
    const g = ttFindGrid();
    if (g) {
      const rs = ttRows(g);
      const cur = rs.length ? ttRowName(rs[0]) : "";
      if (cur && cur !== prev) {
        await ttSleep(170);
        return true;
      }
    }
    // NO "w>=1200 && ttFindGrid()" early-true: that reported success on ANY
    // grid existing, so a failed switch silently degraded into ttFindRow
    // scrolling the wrong table forever. Success requires the TARGET table.
  }
  // Honest result: true only if the target actually opened (no "any grid" lie),
  // so callers surface a clear "couldn't open table" error instead of scrolling.
  return ttSame(ttCurrentTable(), t);
}

/** Find a grid row by column name, scrolling the virtualized list if needed (source ttFindRow ~4021). */
async function ttFindRow(t: string, e: number | undefined, r: HTMLElement): Promise<HTMLElement | null> {
  const byName = () => ttRows(r).find((n) => ttSame(ttRowName(n), t)) || null;
  const rowKeys = () => ttRows(r).map((n) => n.getAttribute("aria-rowindex") || "").join(",");
  let f = byName();
  if (f) return f;
  // Virtualized grid: only rows near scrollTop are in the DOM, and a scrolled-to
  // position isn't revisited — a row missed because it hadn't rendered yet is
  // lost for good. Everything here is MEASURED, not hardcoded, so it behaves the
  // same at any resolution / zoom / row height:
  //  - row height read from a live rendered row (not an assumed 34px);
  //  - step = (visibleRows - 2) rows, so consecutive windows overlap by 2 rows
  //    and no row can be skipped, whatever the viewport size;
  //  - settle by CONDITION (wait until the rendered rows actually change) rather
  //    than a blind delay;
  //  - stop at the real bottom (scrollTop stops advancing), no scrollHeight guess.
  const rowH = () => {
    const rows = ttRows(r);
    const h = rows.length ? Math.round(rows[0].getBoundingClientRect().height) : 0;
    return h > 0 ? h : 34; // fallback only if nothing is rendered yet
  };
  r.scrollTop = 0;
  r.dispatchEvent(new Event("scroll", { bubbles: true }));
  await ttSleep(60);
  let prevTop = -1;
  for (let guard = 0; guard < 600; guard++) {
    f = byName();
    if (f) {
      f.scrollIntoView && f.scrollIntoView({ block: "center" });
      await ttSleep(80);
      return byName() || f;
    }
    const top = r.scrollTop;
    if (top === prevTop) break; // clamped at the bottom — whole list scanned
    prevTop = top;
    const h = rowH();
    const visible = Math.max(1, Math.floor((r.clientHeight || 600) / h));
    const step = Math.max(1, visible - 2) * h;
    const before = rowKeys();
    r.scrollTop = top + step;
    r.dispatchEvent(new Event("scroll", { bubbles: true }));
    for (let w = 0; w < 12; w++) {
      await ttSleep(40);
      if (rowKeys() !== before) break; // rendered window changed — safe to read
    }
  }
  if (e) {
    const ix = ttRows(r).find((n) => Number(n.getAttribute("aria-rowindex")) === e);
    if (ix) return ix;
  }
  return byName();
}

/** Set a native <select>'s value + fire input/change/blur and a React onChange fallback (source ttSetSelect ~4047). */
function ttSetSelect(t: HTMLSelectElement, e: string): boolean {
  const r = Array.from(t.options).find((a) => ttSame(a.value, e) || ttSame(a.textContent, e));
  if (!r) return false;
  const a = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value");
  a && a.set ? a.set.call(t, r.value) : (t.value = r.value);
  t.dispatchEvent(new Event("input", { bubbles: true }));
  t.dispatchEvent(new Event("change", { bubbles: true }));
  t.dispatchEvent(new Event("blur", { bubbles: true }));
  try {
    const _k = Object.keys(t).find((x) => x.indexOf("__reactProps$") === 0);
    const _rp: any = _k ? (t as any)[_k] : null;
    if (_rp && typeof _rp.onChange === "function")
      _rp.onChange({
        target: t,
        currentTarget: t,
        type: "change",
        bubbles: true,
        preventDefault: () => {},
        stopPropagation: () => {},
        nativeEvent: {},
      });
  } catch {
    /* ignore */
  }
  return true;
}

/* ======================================================================
 * Column-editor field metadata (source ~8695-8725)
 * ==================================================================== */

const FIELD_LABEL: Record<string, string> = {
  appFormula: "App formula",
  initialValue: "Initial value",
  suggestedValues: "Suggested values",
  validIf: "Valid If",
  showIf: "Show?",
  editableIf: "Editable?",
  requireIf: "Require?",
  resetIf: "Reset on edit?",
  displayName: "Display name",
};

// field -> title of the collapsible section that holds it ("" = always visible)
const FIELD_SECTION: Record<string, string> = {
  appFormula: "Auto Compute",
  initialValue: "Auto Compute",
  suggestedValues: "Auto Compute",
  validIf: "Data Validity",
  requireIf: "Data Validity",
  editableIf: "Update Behavior",
  resetIf: "Update Behavior",
  displayName: "Display",
  showIf: "",
};

const EXPR_FIELDS = ["appFormula", "initialValue", "suggestedValues", "validIf", "displayName"];

/* ======================================================================
 * Writer primitives (source ~9195-9438)
 * ==================================================================== */

/** Set an <input>'s value with the readonly-attribute dance + input/change/blur (source afSetText ~9195). */
function afSetText(input: HTMLInputElement | null, value: string): boolean {
  if (!input) return false;
  const wasRO = input.hasAttribute("readonly");
  if (wasRO) input.removeAttribute("readonly");
  // Simulate a real click-in → type → click-out cycle. Some AppSheet fields
  // (e.g. the format-rule "Rule name") only COMMIT on a genuine focus→blur, and
  // React delegates focus/blur via the bubbling focusin/focusout events — the
  // plain "blur" event alone doesn't trigger the commit, so the value shows in
  // the box but reverts. Fire focusin first and focusout + native blur() last.
  input.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
  input.focus();
  const d = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
  if (d && d.set) d.set.call(input, value);
  else input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  try {
    input.blur();
  } catch {
    /* ignore */
  }
  input.dispatchEvent(new Event("blur", { bubbles: true }));
  input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  if (wasRO) input.setAttribute("readonly", "");
  return ttSame(
    String(input.value == null ? "" : input.value).replace(/^\s*=/, ""),
    String(value).replace(/^\s*=/, ""),
  );
}

/** Poll whether an input's value survived React reconciliation.
 *  The inline shortcut sets the DOM value, which passes an immediate check,
 *  but React re-renders and reverts it when the editor has validation errors.
 *  This function waits long enough for that revert to happen. */
async function afValueStuck(inputEl: HTMLInputElement, expected: string, polls = 3, interval = 150): Promise<boolean> {
  const norm = (s: string) => String(s ?? "").replace(/^\s*=/, "").trim().toLowerCase();
  const want = norm(expected);
  for (let i = 0; i < polls; i++) {
    await ttSleep(interval);
    if (norm(inputEl.value) !== want) return false;  // reverted — value didn't stick
  }
  return true;
}

// Set an AppSheet expression. The inline input is readonly + committed via the
// Expression Assistant modal, so: try inline first; if it does not stick, open
// the modal, inject into CodeMirror, then Save (source afSetExpression ~9217).
async function afSetExpression(inputEl: HTMLInputElement | null, value: string): Promise<boolean> {
  const v = String(value == null ? "" : value).replace(/^\s*=/, "");
  if (inputEl) {
    try {
      const wasRO = inputEl.hasAttribute("readonly");
      if (wasRO) inputEl.removeAttribute("readonly");
      const d = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
      if (d && d.set) d.set.call(inputEl, v);
      else inputEl.value = v;
      inputEl.dispatchEvent(new Event("input", { bubbles: true }));
      inputEl.dispatchEvent(new Event("change", { bubbles: true }));
      if (wasRO) inputEl.setAttribute("readonly", "");
      await ttSleep(90);
      if (ttSame(String(inputEl.value == null ? "" : inputEl.value).replace(/^\s*=/, ""), v)) {
        // The value appears set NOW, but React may revert it on the next
        // reconciliation if the editor has validation errors. Poll to confirm
        // the value actually survived before declaring success.
        if (await afValueStuck(inputEl, v)) return true;
        // Value was reverted — fall through to the Expression Assistant modal.
        console.warn("[HOC] afSetExpression: inline value reverted (editor errors?), falling back to modal");
      }
    } catch {
      /* ignore */
    }
  }
  if (inputEl) {
    ttClick(inputEl);
    inputEl.focus && inputEl.focus();
  }
  return afInjectExprModal(v, inputEl);
}

/** Inject an expression into the open (or opening) Expression Assistant modal
 *  via CodeMirror, then Save. Assumes something was just clicked to open it.
 *  Shared by afSetExpression (column/panel fields) and slice Row filter. */
async function afInjectExprModal(v: string, inputEl?: HTMLInputElement | null): Promise<boolean> {
  const dlg = await afWaitFor(".ExpressionControlModal", 3500);
  if (!dlg) return false;
  await ttSleep(170);
  let injected = false;
  const cm6 = dlg.querySelector<HTMLElement>(".cm-editor .cm-content");
  if (cm6 && cm6.offsetParent !== null) {
    try {
      cm6.focus();
      document.execCommand("selectAll", false, undefined);
      document.execCommand("delete", false, undefined);
      injected = document.execCommand("insertText", false, v);
    } catch {
      /* ignore */
    }
  }
  if (!injected) {
    const cmEl5: any = dlg.querySelector(".CodeMirror");
    if (cmEl5 && cmEl5.CodeMirror) {
      try {
        cmEl5.CodeMirror.setValue(v);
        cmEl5.CodeMirror.save && cmEl5.CodeMirror.save();
        injected = true;
      } catch {
        /* ignore */
      }
    }
    const ta =
      dlg.querySelector<HTMLTextAreaElement>(".CodeMirror textarea") ||
      dlg.querySelector<HTMLTextAreaElement>("textarea:not(.ExpressionInputHidden)");
    if (ta) {
      try {
        ta.focus();
      } catch {
        /* ignore */
      }
      try {
        document.execCommand("selectAll", false, undefined);
        ta.select && ta.select();
      } catch {
        /* ignore */
      }
      if (!injected) {
        try {
          const dt = new DataTransfer();
          dt.setData("text/plain", v);
          ta.dispatchEvent(
            new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }),
          );
          injected = true;
        } catch {
          /* ignore */
        }
      }
      if (!injected) {
        try {
          document.execCommand("selectAll", false, undefined);
          injected = document.execCommand("insertText", false, v);
        } catch {
          /* ignore */
        }
      }
    }
  }
  await ttSleep(170);
  const saveBtn =
    dlg.querySelector(".SaveExpressionButton") ||
    dlg.querySelector('button[aria-label="Save the expression"]') ||
    document.querySelector(".SaveExpressionButton");
  if (saveBtn) {
    ttClick(saveBtn);
    await ttSleep(500);
    // With a source input (column/panel fields) verify the value stuck; without
    // one (e.g. slice Row filter) fall back to whether the injection succeeded.
    if (!inputEl) return injected;
    try {
      const nv = String(inputEl.value != null ? inputEl.value : "").replace(/^\s*=/, "");
      return nv.length > 0;
    } catch {
      return true;
    }
  }
  const cancel = dlg.querySelector('button[aria-label="Cancel changes"]');
  if (cancel) ttClick(cancel);
  return injected;
}

/** Selector for a column editor panel (source afPanelSel ~9325). */
const afPanelSel = (t: string, c: string): string => '[data-path="Data,Columns,' + t + "_Schema," + c + '"]';

/** Poll for an element by selector until timeout (source afWaitFor ~9327). */
async function afWaitFor(sel: string, timeout?: number): Promise<Element | null> {
  const t0 = performance.now();
  for (;;) {
    const el = document.querySelector(sel);
    if (el) return el;
    if (performance.now() - t0 > (timeout || 6000)) return null;
    await ttSleep(120);
  }
}

/** Expand the collapsible section with the given h3 title (source afExpandSection ~9337). */
async function afExpandSection(panel: Element, title: string): Promise<boolean> {
  if (!title) return true;
  const secs = panel.querySelectorAll(".FormSection");
  for (const sec of secs) {
    const h = sec.querySelector(":scope > .CollapseExpandButton > h3");
    if (h && (h.textContent || "").trim() === title) {
      if (sec.classList.contains("Collapsed")) {
        const btn = sec.querySelector(":scope > .CollapseExpandButton");
        if (btn) {
          ttClick(btn);
          await ttSleep(130);
        }
      }
      return true;
    }
  }
  return false;
}

/** Wait for a FormControl to render by its data-label (source afWaitField ~9356). */
async function afWaitField(panel: Element, label: string, timeout?: number): Promise<Element | null> {
  const t0 = performance.now();
  for (;;) {
    const f = panel.querySelector('.FormControl[data-label="' + label + '"]');
    if (f) return f;
    if (performance.now() - t0 > (timeout || 3000)) return null;
    await ttSleep(120);
  }
}

/** Expand the field's section then wait for the field (source afReveal ~9366). */
async function afReveal(panel: Element, key: string): Promise<Element | null> {
  await afExpandSection(panel, FIELD_SECTION[key]);
  return await afWaitField(panel, FIELD_LABEL[key], 3000);
}

/** Set an expression field inside the column editor panel (source afSetExpr ~9370). */
async function afSetExpr(panel: Element, key: string, value: string): Promise<boolean> {
  const f = await afReveal(panel, key);
  if (!f) return false;
  const inp = f.querySelector<HTMLInputElement>(".ExpressionControl input, input.MuiOutlinedInput-input");
  if (!inp) return false;
  return await afSetExpression(inp, value);
}

const EXPR_INP_SEL = ".ExpressionControl input, input.MuiOutlinedInput-input, input.MuiInputBase-input";

/** Flip an ExpressionSwitchControl from simple/enum mode to expression (input)
 *  mode via its flask toggle, and return the expression input. The flask's
 *  React onClick only fires on a NATIVE .click() — ttClick's synthetic events
 *  aren't enough — and each click is a toggle, so clicking twice flips right
 *  back. Click once, poll; only fall back to synthetic if native didn't flip. */
async function afFlipToExpr(sw: Element): Promise<HTMLInputElement | null> {
  const find = () => sw.querySelector<HTMLInputElement>(EXPR_INP_SEL);
  let inp = find();
  if (inp) return inp;
  const flask = sw.querySelector<HTMLElement>(".SwitchToDynamic button");
  if (!flask) return null;
  const wait = async (): Promise<HTMLInputElement | null> => {
    const t0 = performance.now();
    for (;;) {
      const i = find();
      if (i) return i;
      if (performance.now() - t0 > 2500) return null;
      await ttSleep(120);
    }
  };
  flask.click();
  inp = await wait();
  if (!inp) {
    ttClick(flask);
    inp = await wait();
  }
  return inp;
}

/** Set a show/editable/require/reset switch inside the panel, boolean or dynamic expression (source afSetSwitch ~9379). */
async function afSetSwitch(panel: Element, key: string, value: string): Promise<boolean> {
  const f = await afReveal(panel, key);
  if (!f) return false;
  const sw = f.querySelector(".ExpressionSwitchControl");
  if (!sw) return false;
  const v = String(value).trim();
  if (v === "true" || v === "false") {
    const cb = sw.querySelector(".CheckboxControl");
    if (!cb) return false;
    const want = v === "true";
    if ((cb.getAttribute("data-value") === "true") !== want) {
      const clk = cb.querySelector<HTMLElement>("input[type=checkbox], .MuiIconButton-root") || (cb as HTMLElement);
      ttClick(clk);
      await ttSleep(170);
    }
    const now = sw.querySelector(".CheckboxControl");
    return (!!now && now.getAttribute("data-value") === "true") === want;
  }
  const inp = await afFlipToExpr(sw);
  if (!inp) return false;
  return await afSetExpression(inp, v);
}

/** Open the full column editor panel for a table/column, opening the table + row if needed (source afOpenEditor ~9409). */
async function afOpenEditor(table: string, column: string, rowIndex: number | undefined): Promise<Element | null> {
  let panel: Element | null = document.querySelector(afPanelSel(table, column));
  if (!panel) {
    if (!(await ttOpenTable(table))) return null;
    const grid = ttFindGrid();
    if (!grid) return null;
    const row = await ttFindRow(column, rowIndex, grid);
    if (!row) return null;
    let edit: HTMLElement | null = row.querySelector<HTMLElement>('button.simple[title="edit"]');
    if (!edit) {
      const ic = row.querySelector(".ColumnEditIcon");
      edit = ic && ic.closest("button");
    }
    if (!edit) return null;
    ttClick(edit);
    panel = await afWaitFor(afPanelSel(table, column), 6000);
    if (!panel) return null;
  }
  // wait for the form to finish rendering (at least 1 FormControl + 1 section header)
  const t0 = performance.now();
  while (performance.now() - t0 < 4000) {
    if (panel.querySelector(".FormControl[data-label]") && panel.querySelector(".CollapseExpandButton > h3")) break;
    await ttSleep(120);
  }
  return panel;
}

/** Set a native dropdown FormControl inside the open column editor panel, by
 *  label. Polls because dependent controls render progressively: "Base type"
 *  appears only when Type is Enum/EnumList; "Referenced table name" appears
 *  only when Base type is Ref. */
async function afPanelSetDropdown(panel: Element, label: string, value: string, timeout = 3000): Promise<boolean> {
  const t0 = performance.now();
  for (;;) {
    const sel = panel.querySelector<HTMLSelectElement>(`.FormControl[data-label="${label}"] select.dropdownSelect`);
    if (sel) return ttSetSelect(sel, value);
    if (performance.now() - t0 > timeout) return false;
    await ttSleep(120);
  }
}

/** Set the Ref target table. Plain type=Ref labels it "Source table"; an
 *  Enum/EnumList with base type Ref labels it "Referenced table name". Try both. */
async function afSetRefTable(panel: Element, table: string): Promise<boolean> {
  for (const label of ["Referenced table name", "Source table"]) {
    if (panel.querySelector(`.FormControl[data-label="${label}"] select.dropdownSelect`)) {
      return afPanelSetDropdown(panel, label, table);
    }
  }
  // Neither present yet — wait for whichever renders first.
  return (await afPanelSetDropdown(panel, "Referenced table name", table, 1500)) || (await afPanelSetDropdown(panel, "Source table", table, 1500));
}

/** Generic setter for ANY column-editor panel FormControl, by its data-label.
 *  Auto-detects the control kind so the AI can set type-specific properties
 *  (Max value, Decimal digits, Show as, Is a part of, Allow other values, Input
 *  mode, …) without us enumerating each type's fields. Expands collapsed
 *  sections if the control isn't visible yet. Returns false if not found or the
 *  control kind isn't one we drive (e.g. the OrderedList "Values" editor). */
async function afSetPanelProp(panel: Element, label: string, value: string): Promise<boolean> {
  let fc = panel.querySelector<HTMLElement>(`.FormControl[data-label="${label}"]`);
  if (!fc) {
    for (const sec of panel.querySelectorAll(".FormSection.Collapsed > .CollapseExpandButton")) ttClick(sec);
    await ttSleep(200);
    fc = panel.querySelector<HTMLElement>(`.FormControl[data-label="${label}"]`);
  }
  if (!fc) return false;
  const v = String(value);
  const sel = fc.querySelector<HTMLSelectElement>("select.dropdownSelect");
  if (sel) return ttSetSelect(sel, v);
  const cb = fc.querySelector(".CheckboxControl");
  if (cb && (v === "true" || v === "false")) {
    const isOn = cb.getAttribute("data-value") === "true" || cb.classList.contains("On");
    if (isOn !== (v === "true")) {
      ttClick(cb.querySelector<HTMLElement>("input[type=checkbox], .MuiButtonBase-root") || (cb as HTMLElement));
      await ttSleep(150);
    }
    return true;
  }
  // Toggle switch (e.g. NAVIGATE_URL "Launch External").
  const swCtrl = fc.querySelector(".SwitchControl");
  if (swCtrl && (v === "true" || v === "false")) {
    const isOn = swCtrl.getAttribute("data-value") === "true" || swCtrl.classList.contains("On");
    if (isOn !== (v === "true")) {
      ttClick(swCtrl.querySelector<HTMLElement>("input[type=checkbox], .MuiSwitch-switchBase, .MuiButtonBase-root") || (swCtrl as HTMLElement));
      await ttSleep(150);
    }
    return true;
  }
  // Numeric stepper (Maximum/Minimum value, Decimal/Numeric digits, step, and
  // Text/LongText/Name Maximum/Minimum length): .NumberControl with a plain
  // React-controlled <input> between − / + buttons. Set the input directly.
  const numCtrl = fc.querySelector(".NumberControl");
  if (numCtrl) {
    const ni = numCtrl.querySelector<HTMLInputElement>("input");
    return ni ? afSetText(ni, v) : false;
  }
  // Segmented buttons (e.g. LongText "Formatting" = Plain Text/Markdown/HTML,
  // "Image shape", …): an .EnumControl of .EnumOption[data-value] radio buttons.
  const enumCtrl = fc.querySelector(".EnumControl");
  if (enumCtrl) {
    if (enumCtrl.getAttribute("data-value") === v) return true;
    const opt = enumCtrl.querySelector<HTMLElement>(`.EnumOption[data-value="${v}"]`);
    if (!opt) return false;
    ttClick(opt);
    await ttSleep(120);
    return true;
  }
  // Image dropdown (e.g. Chart "Chart type", "Map type"): a grid of .ImageOption
  // buttons each labeled by .ImageOptionLabel. Match the label case-insensitively.
  const imgDd = fc.querySelector(".ImageDropdownControl");
  if (imgDd) {
    if (ttSame(imgDd.getAttribute("data-value"), v)) return true;
    const opt = Array.from(imgDd.querySelectorAll<HTMLElement>(".ImageOptions .ImageOption")).find((o) =>
      ttSame(o.querySelector(".ImageOptionLabel")?.textContent || "", v),
    );
    if (!opt) return false;
    ttClick(opt);
    await ttSleep(150);
    return true;
  }
  const esw = fc.querySelector(".ExpressionSwitchControl");
  if (esw) {
    const inp = await afFlipToExpr(esw);
    if (inp) return afSetExpression(inp, v);
  }
  const exprInp = fc.querySelector<HTMLInputElement>(EXPR_INP_SEL);
  if (exprInp) return afSetExpression(exprInp, v);
  const mui = fc.querySelector<HTMLElement>('.MuiSelect-select[role="button"]');
  if (mui) return afMuiSelectSet(mui, v);
  return false;
}

/** Set Enum/EnumList values via the "Values" OrderedList control in the column editor.
 *  Structure: .OrderedListControl > .ListItems (rows) + .ListAddItem button ("Add").
 *  Each row is a .ListItem with an input.MuiInputBase-input; the row's committed
 *  value lands on the parent .TextControl[data-value] only after a blur.
 *
 *  Flow (verified live against the editor): for each value — NATIVE click on Add
 *  (React's onClick ignores synthetic ttClick, same as the flask toggle), wait for
 *  the new row's input to appear at the END of .ListItems, then focus → native
 *  value setter → input/change → blur. The blur is what commits the value to the
 *  React model (data-value). Verify via data-value, not just input.value. */
async function afSetEnumValues(panel: Element, values: string[]): Promise<boolean> {
  if (!values || !values.length) return true;

  const ctrl = panel.querySelector<HTMLElement>('.FormControl[data-label="Values"]');
  if (!ctrl) return false;
  const orderedList = ctrl.querySelector<HTMLElement>(".OrderedListControl");
  if (!orderedList) return false;
  const listItems = orderedList.querySelector<HTMLElement>(".ListItems");
  const addBtn = orderedList.querySelector<HTMLButtonElement>("button.ListAddItem");
  if (!listItems || !addBtn) return false;

  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  const rowInputs = () =>
    Array.from(listItems.querySelectorAll<HTMLInputElement>("input.MuiInputBase-input, input[type=text]")).filter(
      (i) => i.offsetParent !== null,
    );

  let allOk = true;
  for (const val of values) {
    const trimmed = String(val).trim();
    if (!trimmed) continue;

    const before = rowInputs().length;
    addBtn.click(); // NATIVE click — synthetic ttClick does not trigger React onClick

    // Wait for a NEW row's input to appear at the END of the list.
    let input: HTMLInputElement | null = null;
    for (let i = 0; i < 25; i++) {
      const inputs = rowInputs();
      if (inputs.length > before) {
        input = inputs[inputs.length - 1];
        break;
      }
      await ttSleep(60);
    }
    if (!input) {
      allOk = false;
      continue;
    }

    // Focus → native setter → input/change → blur (blur commits to data-value).
    input.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    input.focus();
    if (setter) setter.call(input, trimmed);
    else input.value = trimmed;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    input.blur();
    input.dispatchEvent(new Event("blur", { bubbles: true }));
    input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    await ttSleep(200);

    // Verify against the COMMITTED value on the row's .TextControl[data-value].
    const row = input.closest<HTMLElement>(".ListItem");
    const committed = row?.querySelector(".TextControl")?.getAttribute("data-value") ?? "";
    if (!ttSame(committed.trim(), trimmed)) allOk = false;
  }

  return allOk;
}

/** Best-effort switch to the Data / UX / Behavior area of the editor (source afGotoSection ~9440). */
async function afGotoSection(kind: "data" | "ux" | "behavior"): Promise<boolean> {
  const present = {
    data: () => !!(document.querySelector("#appData") || ttFindGrid()),
    ux: () => !!document.querySelector("#PresentationPane"),
    behavior: () => !!document.querySelector("#BehaviorPane"),
  }[kind];
  if (present && present()) return true;
  const NAVLOC = {
    data: "Data,Columns",
    ux: "UX,Views",
    behavior: "Behavior,Actions",
  }[kind];
  let btn: Element | null = null;
  if (NAVLOC) {
    const item = document.querySelector('[data-navlocation="' + NAVLOC + '"]');
    if (item) btn = item.querySelector(".NavItemButton, button, a") || item;
  }
  if (!btn) {
    const KW =
      {
        data: ["data", "columns"],
        ux: ["ux", "views", "app"],
        behavior: ["behavior", "actions"],
      }[kind] || [];
    const norm = (s: unknown) =>
      String(s || "")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
    for (const el of document.querySelectorAll(
      '.NavItemButton, [role="tab"], nav button, nav a, [role="navigation"] button',
    )) {
      const label =
        norm(el.getAttribute("aria-label")) || norm(el.getAttribute("title")) || norm(el.textContent);
      if (label && KW.some((k) => label === k)) {
        btn = el;
        break;
      }
    }
  }
  if (!btn) return false;
  try {
    (btn as HTMLElement).scrollIntoView({ block: "center" });
  } catch {
    /* ignore */
  }
  ttClick(btn);
  for (let i = 0; i < 30; i++) {
    await ttSleep(90);
    if (present && present()) return true;
  }
  return !!(present && present());
}

/** Set a grid-cell switch (boolean or dynamic expression) (source afSetCellSwitch ~9495). */
async function afSetCellSwitch(cell: Element, value: string): Promise<boolean> {
  const sw = cell.querySelector(".ExpressionSwitchControl") || cell;
  const v = String(value).trim();
  if (v === "true" || v === "false") {
    const cb = sw.querySelector(".CheckboxControl");
    if (!cb) return false;
    const isOn = cb.getAttribute("data-value") === "true" || cb.classList.contains("On");
    if (isOn !== (v === "true")) {
      const clk = cb.querySelector<HTMLElement>("input[type=checkbox], .MuiIconButton-root") || (cb as HTMLElement);
      ttClick(clk);
      await ttSleep(150);
    }
    // Re-check: the toggle may not have persisted if the editor has errors.
    const now = sw.querySelector(".CheckboxControl");
    const isNow = now?.getAttribute("data-value") === "true" || now?.classList.contains("On");
    return isNow === (v === "true");
  }
  const inp = await afFlipToExpr(sw);
  if (!inp) return false;
  return await afSetExpression(inp, v);
}

/* ======================================================================
 * set_column op (source afFillSet ~9524)
 * ==================================================================== */

interface OpResult {
  ok: boolean;
  reason: string;
}

// New UI columns: fill directly into the grid cells (Type/Formula/Show?/
// Editable?/Require?/Initial Value/Display Name). Valid If / Suggested values /
// Reset have no grid cell -> open the column editor panel.
async function afFillSet(ch: Change): Promise<OpResult> {
  const chAny = ch as any;
  await afGotoSection("data");
  if (!(await ttOpenTable(ch.table!))) return { ok: false, reason: "Không mở được bảng " + ch.table };
  const grid = ttFindGrid();
  if (!grid) return { ok: false, reason: "Không thấy grid cột của " + ch.table };
  const row = await ttFindRow(ch.column!, chAny.rowIndex, grid);
  if (!row) return { ok: false, reason: "Không thấy cột " + ch.column + " trong " + ch.table };

  const failed: string[] = [];
  const cell = (ci: number) => row.querySelector('[aria-colindex="' + ci + '"]');

  if (ch.type) {
    const c2 = cell(2);
    const sel = c2 && c2.querySelector<HTMLSelectElement>("select.dropdownSelect");
    if (!(sel && ttSetSelect(sel, ch.type))) failed.push("type");
    await ttSleep(140);
  }

  const exprMap: Record<string, number> = { appFormula: 5, initialValue: 9, displayName: 10 };
  for (const k in exprMap) {
    if (chAny[k] == null || chAny[k] === "") continue;
    const c = cell(exprMap[k]);
    const inp = c && c.querySelector<HTMLInputElement>(".ExpressionControl input, input.MuiInputBase-input");
    if (!(inp && (await afSetExpression(inp, chAny[k])))) failed.push(k);
    await ttSleep(90);
  }

  const swMap: Record<string, number> = { showIf: 6, editableIf: 7, requireIf: 8 };
  for (const k in swMap) {
    if (chAny[k] == null || chAny[k] === "") continue;
    const c = cell(swMap[k]);
    if (!(c && (await afSetCellSwitch(c, chAny[k])))) failed.push(k);
    await ttSleep(90);
  }

  const panelFields = ["validIf", "suggestedValues", "resetIf"].filter(
    (k) => chAny[k] != null && chAny[k] !== "",
  );
  // Base type / Referenced table name / enum values live only in the column editor panel, and
  // appear progressively (Base type needs Type=Enum/EnumList; Referenced table
  // needs Base type=Ref). Type was already set via the grid above.
  const propEntries = ch.properties ? Object.entries(ch.properties) : [];
  const needsPanel = panelFields.length || ch.baseType || ch.referencedTable || ch.enumerationList || propEntries.length;
  if (needsPanel) {
    const panel = await afOpenEditor(
      ch.table!,
      ch.column!,
      Number(row.getAttribute("aria-rowindex")) || chAny.rowIndex,
    );
    if (panel) {
      await ttSleep(90);
      if (ch.baseType) {
        if (!(await afPanelSetDropdown(panel, "Base type", ch.baseType))) failed.push("baseType");
        await ttSleep(250); // Referenced table name re-renders in after Ref
      }
      if (ch.referencedTable) {
        if (!(await afSetRefTable(panel, ch.referencedTable))) failed.push("referencedTable");
        await ttSleep(200);
      }
      if (ch.enumerationList) {
        if (!(await afSetEnumValues(panel, ch.enumerationList))) failed.push("enumerationList");
        await ttSleep(250);
      }
      for (const k of panelFields) {
        const ok = EXPR_FIELDS.indexOf(k) >= 0 ? await afSetExpr(panel, k, chAny[k]) : await afSetSwitch(panel, k, chAny[k]);
        if (!ok) failed.push(k);
        await ttSleep(120);
      }
      for (const [label, val] of propEntries) {
        if (!(await afSetPanelProp(panel, label, String(val)))) failed.push(`prop:${label}`);
        await ttSleep(120);
      }
      const dn =
        panel.querySelector("button.CancelAction") ||
        document.querySelector(".ColumnControl.Open button.CancelAction");
      if (dn) {
        ttClick(dn);
        await ttSleep(200);
      }
    } else {
      panelFields.forEach((k) => failed.push(k + " (cần mở editor)"));
      if (ch.baseType) failed.push("baseType (cần mở editor)");
      if (ch.referencedTable) failed.push("referencedTable (cần mở editor)");
      if (ch.enumerationList) failed.push("enumerationList (cần mở editor)");
      propEntries.forEach(([label]) => failed.push(`prop:${label} (cần mở editor)`));
    }
  }

  return {
    ok: failed.length === 0,
    reason: failed.length ? "Field chưa vào (kiểm tay): " + failed.join(", ") : "Đã điền",
  };
}

/** Open the COLUMNS-PANEL header ⋮ overflow menu (the one above the columns grid
 *  for the open table — "Add virtual column / Table settings / Preview data / …")
 *  and click the item matching `itemRe`. This is NOT the data-tree row ⋮ ("View
 *  data source / Rename / Delete"), which has no Table settings.
 *
 *  The panel toolbar is RESPONSIVE: wide shows direct buttons (pass `directSel`
 *  to try one first), narrow (our sidebar open) collapses them into the ⋮. The ⋮
 *  leaves no aria-expanded trace, so we click header icon buttons (rightmost
 *  first — ⋮ sits there) until the target item appears, Escaping wrong menus. */
async function afColumnsPanelMenu(itemRe: RegExp, directSel?: string): Promise<boolean> {
  if (directSel) {
    const direct = document.querySelector<HTMLElement>(directSel);
    if (direct) {
      ttClick(direct);
      return true;
    }
  }
  const findItem = () =>
    Array.from(document.querySelectorAll<HTMLElement>('li[role="menuitem"], .MuiMenuItem-root')).find((li) =>
      itemRe.test((li.textContent || "").trim()),
    ) || null;

  const colsLabel = Array.from(document.querySelectorAll<HTMLElement>("*")).find(
    (e) => e.children.length === 0 && /^Columns:\s*\d+/i.test((e.textContent || "").trim()),
  );
  const header: Element =
    colsLabel?.closest(".MuiToolbar-root, header, .TableHeader") ||
    colsLabel?.parentElement?.parentElement ||
    document.querySelector("#appData") ||
    document.body;

  // Skip buttons whose click has side effects; the ⋮ itself has no aria-label.
  const SKIP = /slice|add new data|delete|deploy|undo|redo|share|help|account|mobile|tablet|desktop|refresh|reload/i;
  const triggers = Array.from(header.querySelectorAll<HTMLElement>("button.MuiIconButton-root"))
    .filter((b) => b.offsetParent !== null && !SKIP.test(b.getAttribute("aria-label") || ""))
    .reverse();

  for (const t of triggers) {
    ttClick(t);
    const t0 = performance.now();
    let it: HTMLElement | null = null;
    while (performance.now() - t0 < 800) {
      it = findItem();
      if (it) break;
      await ttSleep(90);
    }
    if (it) {
      ttClick(it);
      return true;
    }
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await ttSleep(120);
  }
  return false;
}

/** Trigger "Add virtual column" via the columns-panel ⋮ (direct "+" when wide). */
async function afClickAddVcol(): Promise<boolean> {
  return afColumnsPanelMenu(/^\s*add virtual column\s*$/i, 'button[title="Add virtual column"]');
}

/** Create a virtual column: Data → open table → "Add virtual column" → fill the
 *  freshly-opened column panel (name, type, formula, …) (source afFillAdd ~9602).
 *  A VC's whole purpose is its App formula, so appFormula is the key field. */
async function afFillAdd(ch: Change): Promise<OpResult> {
  await afGotoSection("data");
  if (!(await ttOpenTable(ch.table!))) return { ok: false, reason: "Không mở được bảng " + ch.table };
  if (!ttFindGrid()) return { ok: false, reason: "Không thấy grid cột" };
  // Wait for the columns panel to settle, then trigger Add virtual column
  // (direct button when wide, ⋮ overflow menu when narrow — our usual case).
  await afWaitFor('button[title="Add virtual column"], #appData .MuiIconButton-root', 6000);
  if (!(await afClickAddVcol())) return { ok: false, reason: "Không mở được Add virtual column (nút/menu)" };
  await ttSleep(500);
  const panel = document.querySelector(".ColumnControl.Open") || (await afWaitFor(".ColumnControl.Open, .ColumnControl", 5000));
  if (!panel) return { ok: false, reason: "Panel cột mới không mở" };

  const nameInp = panel.querySelector<HTMLInputElement>('[data-label="Column name"] input, .NameColumnControl input');
  if (!nameInp) return { ok: false, reason: "Không thấy ô Column name" };
  afSetText(nameInp, ch.name!);
  await ttSleep(200);

  const failed: string[] = [];
  // App formula FIRST: AppSheet auto-detects the column type from the formula's
  // output, and that auto-detect OVERWRITES the Type dropdown. So set the
  // formula, let it settle, THEN set our explicit Type (which must win).
  if (ch.appFormula && !(await afSetExpr(panel, "appFormula", ch.appFormula))) failed.push("appFormula");
  await ttSleep(350);
  const typeSel = panel.querySelector<HTMLSelectElement>('[data-label="Type"] select.dropdownSelect');
  if (typeSel && ch.type) {
    ttSetSelect(typeSel, ch.type);
    await ttSleep(250); // Type Details (Content type, Base type, …) re-render
  }

  // Enum/EnumList base type + referenced table (need Type set first).
  if (ch.baseType) {
    if (!(await afPanelSetDropdown(panel, "Base type", ch.baseType))) failed.push("baseType");
    await ttSleep(250);
  }
  if (ch.referencedTable) {
    if (!(await afSetRefTable(panel, ch.referencedTable))) failed.push("referencedTable");
    await ttSleep(200);
  }
  if (ch.enumerationList) {
    if (!(await afSetEnumValues(panel, ch.enumerationList))) failed.push("enumerationList");
    await ttSleep(250);
  }
  if (ch.validIf && !(await afSetExpr(panel, "validIf", ch.validIf))) failed.push("validIf");
  if (ch.showIf && !(await afSetSwitch(panel, "showIf", ch.showIf))) failed.push("showIf");
  if (ch.displayName && !(await afSetExpr(panel, "displayName", ch.displayName))) failed.push("displayName");
  if (ch.properties) {
    for (const [label, val] of Object.entries(ch.properties)) {
      if (!(await afSetPanelProp(panel, label, String(val)))) failed.push(`prop:${label}`);
      await ttSleep(120);
    }
  }

  // Commit the new column: click "Done" (class "button CancelAction", appears
  // once fields are filled). Without this the vc is never registered, and the
  // NEXT add_virtual_column op discards this uncommitted panel — so only the
  // last one survived. Poll for the button, then wait for the panel to close.
  const done = (await afWaitFor(".ColumnControl.Open button.CancelAction, .ColumnControl button.CancelAction", 4000)) as HTMLElement | null;
  if (done) {
    ttClick(done);
    await ttSleep(600);
  } else {
    failed.push("commit(Done)");
  }

  return {
    ok: failed.length === 0,
    reason: failed.length ? "Cột ảo đã tạo nhưng field chưa vào (kiểm tay): " + failed.join(", ") : "Đã tạo cột ảo",
  };
}

/* ======================================================================
 * Format-rule helpers + op (source ~9663-10505) — VFE (View/Format Editor) pane
 * ==================================================================== */

function afVfe(): Element | null {
  return document.querySelector(".VFESectionWrapper") || document.querySelector(".TabPane");
}

function afVfeCtrl(pane: Element | null, label: string): Element | null {
  return pane ? pane.querySelector('.FormControl[data-label="' + label + '"]') : null;
}

async function afVfeExpandSection(pane: Element | null, title: string): Promise<boolean> {
  if (!title || !pane) return true;
  for (const sec of pane.querySelectorAll(".FormSection")) {
    const h = sec.querySelector(":scope > .CollapseExpandButton > h3");
    if (h && (h.textContent || "").trim() === title) {
      if (sec.classList.contains("Collapsed")) {
        const btn = sec.querySelector(":scope > .CollapseExpandButton");
        if (btn) {
          ttClick(btn);
          await ttSleep(150);
        }
      }
      return true;
    }
  }
  return false;
}

function afVfeEnum(pane: Element | null, label: string, value: string): boolean {
  const c = afVfeCtrl(pane, label);
  const ctrl = c && c.querySelector(".EnumControl");
  if (!ctrl) return false;
  const btn = ctrl.querySelector('.EnumOption[data-value="' + value + '"]');
  if (!btn) return false;
  ttClick(btn);
  return true;
}

function afVfeDropdown(pane: Element | null, label: string, value: string): boolean {
  const c = afVfeCtrl(pane, label);
  const s = c && c.querySelector<HTMLSelectElement>("select.dropdownSelect");
  if (!s) return false;
  return ttSetSelect(s, value);
}

async function afVfeExpr(pane: Element | null, label: string, value: string): Promise<boolean> {
  const c = afVfeCtrl(pane, label);
  const inp =
    c && (c.querySelector<HTMLInputElement>(".ExpressionControl input") || c.querySelector<HTMLInputElement>("input.MuiInputBase-input"));
  if (!inp) return false;
  return await afSetExpression(inp, value);
}

async function afVfeSwitch(pane: Element | null, label: string, want: string): Promise<boolean> {
  const c = afVfeCtrl(pane, label);
  const sw = c && c.querySelector(".SwitchControl");
  if (!sw) return false;
  const isOn = sw.getAttribute("data-value") === "true" || sw.classList.contains("On");
  const wantOn = String(want) === "true";
  if (isOn !== wantOn) {
    const cb =
      sw.querySelector<HTMLElement>("input[type=checkbox], .MuiSwitch-switchBase, .MuiButtonBase-root") ||
      (sw as HTMLElement);
    ttClick(cb);
    await ttSleep(130);
  }
  return true;
}

async function afSetIconList(ctrl: Element | null, name: string): Promise<boolean> {
  if (!ctrl) return false;
  const nm = String(name || "")
    .trim()
    .replace(/^fa[srl]?\s+/i, "")
    .replace(/^fa-/i, "")
    .toLowerCase();
  if (!nm) return false;
  const search = ctrl.querySelector<HTMLInputElement>(".IconListSearch input");
  if (search) {
    afSetText(search, nm);
    try {
      search.dispatchEvent(new Event("input", { bubbles: true }));
    } catch {
      /* ignore */
    }
    await ttSleep(450);
  }
  const opt =
    ctrl.querySelector('.IconListOption[data-value$="fa-' + nm + '"]') ||
    ctrl.querySelector('.IconListOption[title^="' + nm + ' "]') ||
    ctrl.querySelector('.IconListOption[data-value*="' + nm + '"]') ||
    ctrl.querySelector(".IconListOptions .IconListOption");
  if (!opt) return false;
  try {
    (opt as HTMLElement).scrollIntoView({ block: "center" });
  } catch {
    /* ignore */
  }
  ttClick(opt);
  await ttSleep(170);
  return true;
}

/** Navigate to UX -> Format rules, confirming by the presence of the Add button.
 *  The editor is hash-routed (URL ...#UX.FormatRules), so setting the hash
 *  switches panes from ANY screen — far more robust than clicking a sub-nav that
 *  has no data-navlocation. Falls back to the section-click approach. */
async function afGotoFormatRules(): Promise<boolean> {
  const ADD = 'button[aria-label="Add Format Rule"]';
  if (document.querySelector(ADD)) return true;

  // Primary: hash routing.
  try {
    if (!/UX\.FormatRules/i.test(location.hash)) {
      location.hash = "UX.FormatRules";
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    }
  } catch {
    /* ignore */
  }
  if (await afWaitFor(ADD, 8000)) return true;

  // Fallback: go to UX, then click a "Format rules" sub-nav by text.
  await afGotoSection("ux");
  if (await afWaitFor(ADD, 1500)) return true;
  for (const el of document.querySelectorAll('[role="navigation"] *, .NavItemButton, a, button, .MuiTab-root, [role="tab"]')) {
    if (/format rules?/i.test((el.textContent || "").trim())) {
      ttClick(el);
      break;
    }
  }
  return !!(await afWaitFor(ADD, 6000));
}

function afFmtPane(): Element | null {
  const c = document.querySelector('.FormControl[data-path^="UX,FormatRules"]');
  return c ? c.closest(".VFESectionWrapper") || c.parentElement : null;
}

async function afWaitFmtPane(): Promise<Element | null> {
  const t0 = performance.now();
  for (;;) {
    const p = afFmtPane();
    if (p) return p;
    if (performance.now() - t0 > 6000) return null;
    await ttSleep(150);
  }
}

// Original delegated to the postMessage bridge (afBridge "setFormatColumns");
// in the MAIN world we call our own setFormatColumns directly (source afSetMultiSelect ~10306).
function afSetMultiSelect(_ctrl: Element | null, values: string[]): boolean {
  try {
    const r = setFormatColumns({ values });
    return !!(r && r.ok);
  } catch {
    return false;
  }
}

async function afSetColor(ctrl: Element | null, value: string): Promise<boolean> {
  const cc = ctrl && ctrl.querySelector(".ColorControl2");
  if (!cc) return false;
  const v = String(value || "").trim();
  if (!v) return false;
  if (/^[A-Za-z][A-Za-z0-9_]*$/.test(v)) {
    const b = cc.querySelector("button." + v);
    if (b) {
      ttClick(b);
      await ttSleep(120);
      return true;
    }
  }
  const inp =
    cc.querySelector<HTMLInputElement>("input.MuiInputBase-input") ||
    cc.querySelector<HTMLInputElement>('input[placeholder="custom"]');
  if (inp) return afSetText(inp, v);
  return false;
}

async function afOpenFormatRule(table: string | undefined, name: string): Promise<Element | null> {
  const root = document.querySelector("#PresentationPane");
  if (!root) return null;
  const norm = (x: unknown) =>
    String(x == null ? "" : x)
      .trim()
      .toLowerCase();
  if (table) {
    const grp = Array.prototype.find.call(
      root.querySelectorAll('li[role="treeitem"][aria-label]'),
      (li: Element) => norm(li.getAttribute("aria-label")) === norm(table),
    ) as Element | undefined;
    if (grp && grp.getAttribute("aria-expanded") === "false") {
      ttClick(grp.querySelector(".MuiTreeItem-content") || grp);
      await ttSleep(400);
    }
  }
  let target: Element | null = null;
  for (const li of root.querySelectorAll('li[role="treeitem"]:not([aria-label])')) {
    const txt = norm(li.textContent);
    if (txt === norm(name) || txt.indexOf(norm(name)) === 0) {
      target = li;
      break;
    }
  }
  if (!target) return null;
  ttClick(target.querySelector(".MuiTreeItem-content") || target);
  await ttSleep(500);
  return await afWaitFmtPane();
}

/** add_format_rule / set_format_rule op (source afFillFormatRule ~10365). */
async function afFillFormatRule(ch: Change): Promise<OpResult> {
  const chAny = ch as any;
  if (!(await afGotoFormatRules()))
    return { ok: false, reason: "Không mở được UX → Format rules. Hãy mở mục đó rồi chạy lại." };
  let pane: Element | null;
  if (ch.op === "set_format_rule") {
    pane = await afOpenFormatRule(ch.table, ch.rule!);
    if (!pane)
      return {
        ok: false,
        reason: "Không tìm thấy format rule " + ch.rule + " — kiểm tra tên trong UX → Format rules.",
      };
  } else {
    const addBtn = document.querySelector('button[aria-label="Add Format Rule"]');
    if (!addBtn) return { ok: false, reason: "Không thấy nút Add Format Rule." };
    ttClick(addBtn);
    const createBtn = await afWaitFor('[role="dialog"] button[aria-label="create new"]', 5000);
    if (!createBtn) return { ok: false, reason: "Không mở được hộp thoại Add Format Rule." };
    ttClick(createBtn);
    pane = await afWaitFmtPane();
    if (!pane) return { ok: false, reason: "Không mở được trình sửa Format Rule." };
    // Wait for the fresh rule's fields to actually render before filling — on
    // Firefox/Zen they lag the pane, which was silently dropping name/table.
    await afWaitFor('.FormControl[data-label="Rule name"] input', 6000);
    await ttSleep(250);
  }
  await ttSleep(120);
  const failed: string[] = [];

  // "For this data" FIRST: setting the table re-renders the pane (its column
  // list changes), which on Firefox/Zen would wipe a name set beforehand.
  // Verify by re-reading the selected option (retry — the fresh pane is racy).
  if (ch.table && ch.op === "add_format_rule") {
    const selSel = '.FormControl[data-label="For this data"] select.dropdownSelect';
    await afWaitFor(selSel, 5000);
    let ok = false;
    for (let i = 0; i < 4 && !ok; i++) {
      const s = document.querySelector<HTMLSelectElement>(selSel);
      if (s) {
        ttSetSelect(s, ch.table);
        await ttSleep(450);
        const cur = document.querySelector<HTMLSelectElement>(selSel);
        ok = !!cur && ttSame(cur.selectedOptions[0]?.textContent || cur.value, ch.table);
      }
      if (!ok) await ttSleep(300);
    }
    if (!ok) failed.push("table");
    pane = afFmtPane() || pane;
  }

  // Rule name AFTER the table re-render, and verify it persisted — right after
  // "create new" AppSheet re-applies the default name, reverting an early set.
  if (ch.name) {
    const nameSel = '.FormControl[data-label="Rule name"] input';
    await afWaitFor(nameSel, 5000);
    let ok = false;
    for (let i = 0; i < 5 && !ok; i++) {
      const inp = document.querySelector<HTMLInputElement>(nameSel);
      if (inp) {
        afSetText(inp, ch.name);
        await ttSleep(300);
        const cur = document.querySelector<HTMLInputElement>(nameSel);
        ok = !!cur && ttSame(cur.value, ch.name);
      }
      if (!ok) await ttSleep(300);
    }
    if (!ok) failed.push("name");
    pane = afFmtPane() || pane;
  }
  if (ch.condition) {
    if (!(await afVfeExpr(pane, "If this condition is true", ch.condition))) failed.push("condition");
    await ttSleep(130);
    pane = afFmtPane() || pane;
  }
  if (ch.icon) {
    const ic = afVfeCtrl(pane, "Icon");
    const il = ic && ic.querySelector(".IconListControl");
    if (!(il && (await afSetIconList(il, ch.icon)))) failed.push("icon");
    await ttSleep(160);
    pane = afFmtPane() || pane;
  }
  if (ch.highlightColor) {
    if (!(await afSetColor(afVfeCtrl(pane, "Highlight color"), ch.highlightColor))) failed.push("highlightColor");
    await ttSleep(120);
    pane = afFmtPane() || pane;
  }
  if (ch.textColor) {
    if (!(await afSetColor(afVfeCtrl(pane, "Text color"), ch.textColor))) failed.push("textColor");
    await ttSleep(120);
    pane = afFmtPane() || pane;
  }
  if (
    ch.bold != null ||
    ch.italic != null ||
    ch.underline != null ||
    ch.uppercase != null ||
    ch.strikethrough != null
  ) {
    await afVfeExpandSection(pane, "Text Format");
    const SW: Record<string, string> = {
      bold: "Bold",
      italic: "Italic",
      underline: "Underline",
      uppercase: "Uppercase",
      strikethrough: "Strikethrough",
    };
    for (const k in SW) {
      if (chAny[k] != null) {
        if (!(await afVfeSwitch(pane, SW[k], chAny[k]))) failed.push(k);
        await ttSleep(100);
        pane = afFmtPane() || pane;
      }
    }
  }
  if (ch.imageSize) {
    await afVfeExpandSection(pane, "Workflow template format");
    if (!afVfeEnum(pane, "Image format", ch.imageSize)) failed.push("imageSize");
    await ttSleep(110);
  }
  pane = afFmtPane() || pane;
  if (ch.columns && ch.columns.length) {
    const cc = afVfeCtrl(pane, "Format these columns and actions");
    if (!afSetMultiSelect(cc, ch.columns)) failed.push("columns");
    await ttSleep(160);
  }
  return {
    ok: failed.length === 0,
    reason: failed.length ? "Field chưa vào (kiểm tay): " + failed.join(", ") : "Đã tạo format rule",
  };
}

/* ======================================================================
 * ttApplyTypes port (source ttApplyTypes ~4078)
 * ==================================================================== */

/**
 * Set each column's Type in the columns grid for one table. Faithful port of
 * ttApplyTypes, adapted to the module's { column, type } input shape (the
 * original also carried apply/currentType/rowIndex fields supplied by its own
 * caller — here we treat every entry as a candidate and skip in-loop when the
 * grid's <select> already holds the wanted value, exactly as the original did).
 */
export async function applyTypes(
  table: string,
  cols: { column: string; type: string }[],
): Promise<{ applied: number; skipped: number; failed: number; details: { column: string; status: string }[] }> {
  const details: { column: string; status: string }[] = [];
  let applied = 0;
  let skipped = 0;
  let failed = 0;
  if (cols.length === 0) return { applied, skipped, failed, details };

  if (!(await ttOpenTable(table))) {
    for (const i of cols) {
      details.push({ column: i.column, status: 'Không mở được bảng "' + table + '" trong AppSheet' });
      failed++;
    }
    return { applied, skipped, failed, details };
  }
  const grid = ttFindGrid();
  if (!grid) {
    for (const i of cols) {
      details.push({ column: i.column, status: "Không tìm thấy grid Columns của AppSheet" });
      failed++;
    }
    return { applied, skipped, failed, details };
  }

  for (const i of cols) {
    const u = await ttFindRow(i.column, undefined, grid);
    if (!u) {
      details.push({ column: i.column, status: "Không thấy dòng cột trong grid" });
      failed++;
      continue;
    }
    const c = u.querySelector<HTMLSelectElement>('[aria-colindex="2"] select.dropdownSelect,select.dropdownSelect');
    if (!c) {
      details.push({ column: i.column, status: "Không thấy dropdown Type" });
      failed++;
      continue;
    }
    if (ttSame(c.value, i.type)) {
      skipped++;
      details.push({ column: i.column, status: "skipped" });
      continue;
    }
    if (ttSetSelect(c, i.type)) {
      applied++;
      details.push({ column: i.column, status: "applied" });
      await ttSleep(90);
    } else {
      failed++;
      details.push({ column: i.column, status: 'Type "' + i.type + '" không có trong dropdown AppSheet' });
    }
  }
  return { applied, skipped, failed, details };
}

/* ======================================================================
 * setFormatColumns — port of bridge SFC (source bridge.pretty.js SFC ~13)
 * ==================================================================== */

/** React fiber node shape: enough to walk up looking for an onChange handler. */
interface ReactFiberLike {
  memoizedProps?: ReactEventProps | null;
  return?: ReactFiberLike | null;
}
interface ReactEventProps {
  onChange?: (e: unknown) => void;
  onBlur?: (e: unknown) => void;
}

/**
 * Selects matching options in the "Format these columns and actions"
 * multiselect and fires the React onChange/onBlur handlers (found via the
 * node's internal __reactProps$/__reactFiber$ keys), falling back to native
 * change/blur DOM events. Synchronous. Port of bridge SFC.
 */
export function setFormatColumns(
  payload: { values?: string[] } | string[] | unknown,
): { ok: boolean; selected?: string[]; reason?: string; cands?: number } {
  try {
    const pl: any = payload;
    const values: unknown[] = (pl && pl.values) || pl || [];
    const cands = Array.prototype.slice.call(
      document.querySelectorAll(
        '.FormControl[data-label="Format these columns and actions"] select, .MultiselectControl select, select[multiple]',
      ),
    ) as HTMLSelectElement[];
    const sel: HTMLSelectElement | undefined = cands.filter((x) => x.offsetParent !== null)[0] || cands[0];
    if (!sel) return { ok: false, reason: "no select", cands: cands.length };

    // NOTE: the original's second regex is `/s*(action)s*$/` — a literal "s",
    // not `\s*` (whitespace). Preserved verbatim for exact parity with the
    // shipping extension (see also src/content/bridge.ts).
    const nrm = (v: unknown): string =>
      String(v == null ? "" : v)
        .toLowerCase()
        .trim()
        .replace(/^__action__/, "")
        .replace(/s*(action)s*$/, "");

    const want = values.map(nrm);
    let any = false;
    Array.prototype.forEach.call(sel.options, (o2: HTMLOptionElement) => {
      const hit = want.indexOf(nrm(o2.value)) >= 0 || want.indexOf(nrm(o2.textContent)) >= 0;
      o2.selected = hit;
      if (hit) any = true;
    });

    let props: ReactEventProps | null = null;
    const names = Object.getOwnPropertyNames(sel);
    const pk = names.find((n) => n.indexOf("__reactProps$") === 0);
    if (pk && (sel as any)[pk]) props = (sel as any)[pk] as ReactEventProps;
    if (!props || typeof props.onChange !== "function") {
      const fk = names.find((n) => n.indexOf("__reactFiber$") === 0);
      if (fk) {
        let f: ReactFiberLike | null | undefined = (sel as any)[fk] as ReactFiberLike | undefined;
        for (let i = 0; i < 6 && f; i++) {
          if (f.memoizedProps && typeof f.memoizedProps.onChange === "function") {
            props = f.memoizedProps;
            break;
          }
          f = f.return;
        }
      }
    }

    const mkev = (ty: string) => ({
      target: sel,
      currentTarget: sel,
      type: ty,
      bubbles: true,
      preventDefault: () => {},
      stopPropagation: () => {},
      persist: () => {},
      isDefaultPrevented: () => false,
      isPropagationStopped: () => false,
      nativeEvent: { target: sel },
    });

    const h = !!(props && typeof props.onChange === "function");
    if (h) {
      try {
        props!.onChange!(mkev("change"));
      } catch {
        /* ignore */
      }
    } else {
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    }
    if (props && typeof props.onBlur === "function") {
      try {
        props.onBlur(mkev("blur"));
      } catch {
        /* ignore */
      }
    }
    try {
      sel.dispatchEvent(new Event("blur", { bubbles: true }));
    } catch {
      /* ignore */
    }

    return {
      ok: any,
      selected: Array.prototype.map.call(sel.selectedOptions, (o2: HTMLOptionElement) => o2.value) as string[],
    };
  } catch (e) {
    return { ok: false, reason: String((e as any)?.message ?? e) };
  }
}

/* ======================================================================
 * Table settings (set_table) apply — navigation + field fill
 * ==================================================================== */

const SETTINGS_FIELD_SEL =
  '.FormControl[data-label="Security filter"], .FormControl[data-label="Are updates allowed?"]';

/** True if the table-settings dialog is already open with its fields rendered. */
function afSettingsDialogOpen(): Element | null {
  const dialog = document.querySelector(".MuiDialog-paper");
  return dialog && dialog.querySelector(SETTINGS_FIELD_SEL) ? dialog : null;
}

/** Navigate to table settings dialog: Data → find table → click "Table settings".
 *  Returns null on success, or a step-specific reason string on failure. */
async function afOpenTableSettings(tableName: string): Promise<string | null> {
  // Reuse an already-open settings dialog (e.g. a prior run left it open).
  if (afSettingsDialogOpen()) return null;

  if (!(await afGotoSection("data"))) return "không vào được mục Data";
  // OPEN the table in the columns editor first (shows "Table: <name>" + the
  // columns grid + the panel's ⋮). "Table settings" lives in that columns-panel
  // ⋮ menu — NOT the data-tree row ⋮ (which only has View data source / Rename /
  // Delete). ttOpenTable is the proven open-by-name used across the engine.
  if (!(await ttOpenTable(tableName))) return `không mở được bảng "${tableName}"`;
  await ttSleep(300);

  // Click "Table settings" from the columns-panel ⋮ overflow menu.
  if (!(await afColumnsPanelMenu(/^\s*table settings\s*$/i)))
    return `không thấy mục "Table settings" cho ${tableName}`;

  // Wait for the dialog + its Security-filter/UpdateMode control to render.
  const t0 = performance.now();
  for (;;) {
    if (afSettingsDialogOpen()) return null;
    if (performance.now() - t0 > 8000) return "dialog mở nhưng field settings không hiện (timeout)";
    await ttSleep(200);
  }
}

/** Confirm an expression landed by polling whether the control now holds ANY
 *  non-empty value. Exact matching is unreliable here: the committed value lands
 *  in the readonly inline input a beat after Save, AppSheet reformats it
 *  (spacing, and >= renders as ≥), and there can be a hidden input alongside the
 *  visible one. A non-empty value in any of the control's inputs is a solid
 *  "a filter is now set" signal; only a field that stays empty is a real
 *  failure. (This is why afSetExpression's eager inline read-back false-negatived.) */
async function afControlHasValue(label: string): Promise<boolean> {
  // Re-query the control FRESH each poll: setting the expression re-renders the
  // FormControl, so a reference captured beforehand goes stale (detached, empty)
  // while the value-bearing node is a new element in the DOM.
  const sel = `.MuiDialog-paper .FormControl[data-label="${label}"]`;
  for (let i = 0; i < 24; i++) {
    const ctrl = document.querySelector(sel);
    if (ctrl) {
      const inputs = Array.from(ctrl.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input, textarea"));
      if (inputs.some((el) => String(el.value || "").trim().length > 0)) return true;
      const cm = ctrl.querySelector(".cm-content, .CodeMirror-code");
      if (cm && String(cm.textContent || "").trim().length > 0) return true;
    }
    await ttSleep(130);
  }
  // Give-up diagnostic — makes a false-negative debuggable from the console.
  const ctrl = document.querySelector(sel);
  const dump = ctrl
    ? Array.from(ctrl.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input, textarea"))
        .map((el) => JSON.stringify(el.value))
        .join(" | ") || "(no inputs)"
    : "(control not found)";
  console.log(`[HOC] afControlHasValue("${label}") empty after poll; inputs=[${dump}]`);
  return false;
}

/** Set a table's security filter or update formula via the settings dialog. */
async function afFillTable(ch: Change): Promise<OpResult> {
  const tableName = ch.table || "";
  if (!tableName) return { ok: false, reason: "Thiếu tên bảng." };

  const openErr = await afOpenTableSettings(tableName);
  if (openErr) return { ok: false, reason: "Không mở được bảng settings: " + openErr };

  const failed: string[] = [];
  const dialog = document.querySelector(".MuiDialog-paper");
  if (!dialog) return { ok: false, reason: "Dialog settings không tìm thấy." };

  // Security filter (data filter) — a plain ExpressionControl input.
  if (ch.dataFilter) {
    const ctrl = dialog.querySelector('.FormControl[data-label="Security filter"]');
    (ctrl as HTMLElement | null)?.scrollIntoView({ block: "center" });
    await ttSleep(150);
    const inp = ctrl?.querySelector<HTMLInputElement>(".ExpressionControl input, input.MuiInputBase-input, input.MuiOutlinedInput-input");
    await afSetExpression(inp ?? null, ch.dataFilter);
    if (!(await afControlHasValue("Security filter"))) failed.push("dataFilter");
    await ttSleep(400);
  }

  // Are updates allowed (update formula) — an ExpressionSwitchControl in enum
  // ("Static") mode by default; click the flask to switch to expression mode
  // first, then inject the expression (same dance as afSetSwitch).
  if (ch.updateModeExpression) {
    const ctrl = dialog.querySelector('.FormControl[data-label="Are updates allowed?"]');
    (ctrl as HTMLElement | null)?.scrollIntoView({ block: "center" });
    await ttSleep(150);
    const sw = ctrl?.querySelector(".ExpressionSwitchControl");
    if (sw) {
      const inp = await afFlipToExpr(sw);
      await afSetExpression(inp, ch.updateModeExpression);
      if (!(await afControlHasValue("Are updates allowed?"))) failed.push("updateModeExpression");
    } else {
      failed.push("updateModeExpression");
    }
    await ttSleep(400);
  }

  // Save the dialog if we ATTEMPTED any field. The Expression Assistant's own
  // Save stages the value into the dialog's pending state; the dialog "Done" is
  // what persists it to the app model. This was previously gated on `anyFilled`
  // (derived from afSetExpression's inline read-back, which is unreliable for the
  // Security-filter field) — so a false-negative skipped Done and the change
  // reverted on reload. Click Done whenever a field was requested.
  const attempted = !!ch.dataFilter || !!ch.updateModeExpression;
  if (attempted) {
    const doneBtn = Array.from(dialog.querySelectorAll("button")).find((b) =>
      /^\s*done\s*$/i.test((b.textContent || "").trim())
    );
    if (doneBtn) {
      ttClick(doneBtn as HTMLElement);
      await ttSleep(500);
    }
  }

  return {
    ok: failed.length === 0,
    reason: failed.length ? "Field chưa vào (kiểm tay): " + failed.join(", ") : "Đã cập nhật bảng",
  };
}

/* ======================================================================
 * add_view / set_view apply — UX Views pane (source afFillView ~9827)
 * ==================================================================== */

function afVfeNameInput(): HTMLInputElement | null {
  const c = afVfeCtrl(afVfe(), "View name");
  return c ? c.querySelector<HTMLInputElement>("input") : null;
}

/** Navigate to UX → Views (the views LIST), confirming by the "Add View" button.
 *  afGotoSection("ux") only checks that #PresentationPane exists, so it no-ops on
 *  ANY UX sub-pane — including Format Rules, where "Add View" and the view tree
 *  aren't present. A changeset that runs a format-rule op before an add_view/
 *  set_view would then fail ("no Add View button" / view not found in tree). Hash
 *  routing (#UX.Views) lands on the Views list from any sub-pane, same trick as
 *  afGotoFormatRules. */
async function afGotoViews(): Promise<boolean> {
  const ADD = 'button[aria-label="Add View"]';
  if (document.querySelector(ADD)) return true;
  try {
    if (!/UX\.Views(\.|$)/i.test(location.hash)) {
      location.hash = "UX.Views";
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    }
  } catch {
    /* ignore */
  }
  if (await afWaitFor(ADD, 8000)) return true;
  // Fallback: the generic UX nav click.
  await afGotoSection("ux");
  return !!(await afWaitFor(ADD, 3000));
}

/** Open an existing view in the UX pane by clicking its tree item. */
async function afOpenView(name: string): Promise<Element | null> {
  const cur = afVfeNameInput();
  if (cur && ttSame(cur.value, name)) return afVfe();
  let target: Element | null = null;
  for (const el of document.querySelectorAll(".MuiTreeItem-content")) {
    const raw = (el.textContent || "").trim();
    if (/\(\d+\)\s*$/.test(raw)) continue; // skip group headers like "Primary (3)"
    if (ttSame(raw, name)) {
      target = el;
      break;
    }
  }
  if (!target) return null;
  try {
    (target as HTMLElement).scrollIntoView({ block: "center" });
  } catch {
    /* ignore */
  }
  ttClick(target);
  for (let i = 0; i < 40; i++) {
    await ttSleep(90);
    const inp = afVfeNameInput();
    if (inp && ttSame(inp.value, name)) return afVfe();
  }
  return afVfe();
}

/** Click "Add View" → "Create a new view" and wait for the fresh VFE pane. */
async function afCreateView(): Promise<Element | null> {
  const addBtn = document.querySelector('button[aria-label="Add View"]');
  if (!addBtn) return null;
  ttClick(addBtn);
  const dlg = await afWaitFor(".MuiDialog-paper", 5000);
  if (!dlg) return null;
  let createBtn: Element | null = dlg.querySelector('button[aria-label="create new"]');
  if (!createBtn) {
    for (const b of dlg.querySelectorAll("button")) {
      if (/create a new view/i.test(b.textContent || "")) {
        createBtn = b;
        break;
      }
    }
  }
  if (!createBtn) return null;
  ttClick(createBtn);
  for (let i = 0; i < 40; i++) {
    await ttSleep(90);
    const inp = afVfeNameInput();
    if (inp && /^New View/i.test(inp.value || "")) return afVfe();
  }
  return afVfe();
}

/** Click a segmented-button option (e.g. View type) by its data-value. */
function afVfeClickOption(pane: Element | null, controlSel: string, dataValue: string): boolean {
  const ctrl = pane && pane.querySelector(controlSel);
  if (!ctrl) return false;
  if (ctrl.getAttribute("data-value") === dataValue) return true;
  const btn = ctrl.querySelector('[data-value="' + dataValue + '"]');
  if (!btn) return false;
  ttClick(btn);
  return true;
}

/** Set a MUI <Select> dropdown (e.g. "For this data") by option text. */
/** Set a MUI <Select> given its `.MuiSelect-select[role=button]` element (source afMuiSelectSet ~9924). */
async function afMuiSelectSet(sel: Element | null, optionText: string): Promise<boolean> {
  if (!sel) return false;
  if (ttSame((sel.textContent || "").trim(), optionText)) return true;
  ttClick(sel);
  await ttSleep(200);
  const opts = Array.from(
    document.querySelectorAll(
      '.MuiPopover-root li[role="option"], .MuiMenu-list li, ul[role="listbox"] li, li[role="option"], .MuiMenuItem-root',
    ),
  );
  const opt =
    opts.find((o) => ttSame((o.textContent || "").trim(), optionText)) ||
    opts.find((o) => (o.getAttribute("data-value") || "") === optionText);
  if (!opt) {
    try {
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    } catch {
      /* ignore */
    }
    return false;
  }
  ttClick(opt);
  await ttSleep(150);
  return true;
}

async function afVfeMuiSelect(pane: Element | null, label: string, optionText: string): Promise<boolean> {
  const c = afVfeCtrl(pane, label);
  const sel = c && c.querySelector<HTMLElement>('.MuiSelect-select[role="button"]');
  return afMuiSelectSet(sel, optionText);
}

/** Populate an OrderedListControl (Sort by / Group by) with {column, order} rows.
 *  Each "Add" click appends a SortedListControl row = a MUI column select + an
 *  Ascending/Descending dropdown. Rebuilding from scratch would need removing
 *  existing rows; we only ADD, so set_view appends. Returns false if any row
 *  couldn't be set. */
async function afVfeOrderedList(pane: Element | null, label: string, items: { column: string; order?: string }[]): Promise<boolean> {
  const fc = afVfeCtrl(pane, label);
  const list = fc && fc.querySelector(".OrderedListControl");
  if (!list) return false;
  const rows = () => Array.from(list.querySelectorAll(".ListItems .ListItem"));
  const escape = () => {
    try {
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    } catch {
      /* ignore */
    }
  };
  let ok = true;
  for (const it of items) {
    if (!it.column) continue;
    const before = rows();
    const add = list.querySelector<HTMLElement>("button.ListAddItem");
    if (!add) {
      ok = false;
      break;
    }
    ttClick(add);
    // Wait for a genuinely NEW row (one not present before this Add click).
    let row: Element | undefined;
    for (let i = 0; i < 30; i++) {
      await ttSleep(90);
      row = rows().find((r) => !before.includes(r));
      if (row) break;
    }
    if (!row) {
      ok = false;
      continue;
    }
    const colSel = row.querySelector<HTMLElement>('.MuiSelect-select[role="button"]');
    const set = (await afMuiSelectSet(colSel, it.column)) && ttSame((colSel?.textContent || "").trim(), it.column);
    escape(); // ensure the column popover is closed before touching anything else
    await ttSleep(120);
    if (!set) {
      // Don't leave a wrong/default row behind — remove the row we just added.
      const rm = row.querySelector<HTMLElement>("button.ListRemoveItem");
      if (rm) {
        ttClick(rm);
        await ttSleep(120);
      }
      ok = false;
      continue;
    }
    if (it.order) {
      const dd = row.querySelector<HTMLSelectElement>(".DropdownControl select.dropdownSelect");
      if (dd) ttSetSelect(dd, it.order);
      await ttSleep(90);
    }
  }
  return ok;
}

/** Table view "Column order": set the Automatic|Manual EnumControl, then in
 *  manual mode check exactly the columns in `cols` (include) and uncheck the
 *  rest. Each column is a `.MuiFormControlLabel-root` with a checkbox; its label
 *  text is the column name. Reorder (drag) is handled separately (afReorderColumns).
 *  Verified live: the checkbox is the include toggle and it persists. */
async function afSetColumnOrder(pane: Element, mode: string | undefined, cols: string[] | undefined): Promise<boolean> {
  let fc = afVfeCtrl(pane, "Column order");
  if (!fc) return false;
  const wantManual = mode === "manual" || (!!cols && cols.length > 0 && mode !== "automatic");
  const ec = fc.querySelector(".EnumControl");
  if (ec) {
    const target = wantManual ? "manual" : mode || "automatic";
    if (ec.getAttribute("data-value") !== target) {
      const opt = ec.querySelector<HTMLElement>(`.EnumOption[data-value="${target}"]`);
      if (opt) {
        ttClick(opt);
        await ttSleep(300); // manual reveals the column list (re-renders the control)
      }
    }
  }
  if (!wantManual || !cols?.length) return true;
  // Re-query after the enum switch re-render.
  fc = afVfeCtrl(afVfe(), "Column order") || fc;
  const want = new Set(cols.map((c) => c.toLowerCase()));
  let ok = true;
  for (const lbl of Array.from(fc.querySelectorAll(".MuiFormControlLabel-root"))) {
    const name = (lbl.querySelector(".MuiFormControlLabel-label, .MuiTypography-root")?.textContent || lbl.textContent || "").trim();
    const cb = lbl.querySelector<HTMLInputElement>('input[type="checkbox"]');
    if (!cb || !name) continue;
    const shouldCheck = want.has(name.toLowerCase());
    if (cb.checked !== shouldCheck) {
      ttClick(cb);
      await ttSleep(120);
    }
    if (shouldCheck && !cb.checked) ok = false;
  }
  // ponytail: reorder deferred — the per-row drag handle is hover-gated and the
  // widget uses a JS sorter that needs real-time pointermove sequencing; a
  // synthesized drag corrupts its transient state (see the C3 spike in
  // docs/superpowers/specs/2026-08-10-view-properties-and-columns-design.md).
  // viewColumns currently controls WHICH columns show, not their order. To add
  // reorder: hover a row to reveal its handle, then drive a timed pointer drag.
  return ok;
}

/** Create or edit a UX view (source afFillView ~9827). */
async function afFillView(ch: Change): Promise<OpResult> {
  // Ensure the Views LIST is showing (not just "somewhere in UX") — a prior
  // format-rule op leaves the pane on Format Rules, where Add View / the view
  // tree don't exist.
  if (!(await afGotoViews())) return { ok: false, reason: "Không mở được UX → Views (không thấy nút Add View)." };
  let pane: Element | null;
  if (ch.op === "add_view") {
    pane = await afCreateView();
    if (!pane) return { ok: false, reason: "Không tạo được view mới (không thấy nút Add View / dialog)" };
    const nameInp = afVfeNameInput();
    if (nameInp && ch.name) {
      afSetText(nameInp, ch.name);
      await ttSleep(240);
    }
    pane = afVfe();
  } else {
    if (!ch.view) return { ok: false, reason: "set_view thiếu tên view." };
    pane = await afOpenView(ch.view);
    if (!pane) return { ok: false, reason: "Không mở được view " + ch.view };
  }
  await ttSleep(90);

  const failed: string[] = [];
  if (ch.table) {
    if (!(await afVfeMuiSelect(pane, "For this data", ch.table))) failed.push("table");
    await ttSleep(90);
    pane = afVfe();
  }
  if (ch.viewType) {
    if (!afVfeClickOption(pane, ".ViewTypeControl", ch.viewType)) failed.push("viewType");
    await ttSleep(170);
    pane = afVfe();
  }
  if (ch.viewEntries?.length) {
    // ponytail: "View entries" is an OrderedListControl (MuiSelect view picker +
    // .dropdownSelect size) — the exact shape afVfeOrderedList already drives for
    // Sort by/Group by. Map {view,size} → its {column,order} instead of a new engine.
    const items = ch.viewEntries.map((e) => ({ column: e.view, order: e.size }));
    if (!(await afVfeOrderedList(pane, "View entries", items))) failed.push("viewEntries");
    await ttSleep(90);
    pane = afVfe();
  }
  if (ch.chartType) {
    // Chart type is an ImageDropdownControl (visual grid), not a <select> —
    // afSetPanelProp handles that kind; keep afVfeDropdown as a fallback.
    const okCt = (await afSetPanelProp(pane as Element, "Chart type", ch.chartType)) || afVfeDropdown(pane, "Chart type", ch.chartType);
    if (!okCt) failed.push("chartType");
    await ttSleep(150);
    pane = afVfe();
  }
  if (ch.chartColumns?.length) {
    // Chart columns is an OrderedListControl (MuiSelect per row) — same shape as
    // Sort by / View entries, so afVfeOrderedList drives it.
    const items = ch.chartColumns.map((c) => ({ column: c }));
    if (!(await afVfeOrderedList(pane, "Chart columns", items))) failed.push("chartColumns");
    await ttSleep(90);
    pane = afVfe();
  }
  if (ch.position) {
    if (!afVfeEnum(pane, "Position", ch.position)) failed.push("position");
    await ttSleep(90);
  }
  if (ch.sortBy?.length) {
    if (!(await afVfeOrderedList(pane, "Sort by", ch.sortBy))) failed.push("sortBy");
    await ttSleep(90);
    pane = afVfe();
  }
  if (ch.groupBy?.length) {
    if (!(await afVfeOrderedList(pane, "Group by", ch.groupBy))) failed.push("groupBy");
    await ttSleep(90);
    pane = afVfe();
  }
  if (ch.groupAggregate) {
    await afVfeExpandSection(pane, "View Options");
    if (!afVfeDropdown(pane, "Group aggregate", ch.groupAggregate)) failed.push("groupAggregate");
    await ttSleep(90);
  }
  if (ch.columnOrder || ch.viewColumns?.length) {
    if (!(await afSetColumnOrder(pane as Element, ch.columnOrder, ch.viewColumns))) failed.push("columnOrder");
    await ttSleep(90);
    pane = afVfe();
  }
  if (ch.displayName || ch.showIf || ch.icon) await afVfeExpandSection(pane, "Display");
  if (ch.icon) {
    const ic = afVfeCtrl(pane, "Icon");
    const il = ic && ic.querySelector(".IconListControl");
    if (!(il && (await afSetIconList(il, ch.icon)))) failed.push("icon");
    await ttSleep(130);
  }
  if (ch.displayName) {
    const di = afVfeCtrl(pane, "Display name");
    const inp = di && (di.querySelector<HTMLInputElement>(".ChildControl input") || di.querySelector<HTMLInputElement>("input.MuiInputBase-input"));
    if (!(inp && afSetText(inp, ch.displayName))) failed.push("displayName");
    await ttSleep(90);
  }
  if (ch.showIf) {
    if (!(await afVfeExpr(pane, "Show if", ch.showIf))) failed.push("showIf");
    await ttSleep(90);
  }
  if (ch.properties) {
    // VFE view panes share the column-editor markup (.FormControl[data-label] +
    // .FormSection), so afSetPanelProp drives any simple view property by label —
    // one mechanism for every view type, no per-type code.
    for (const [label, val] of Object.entries(ch.properties)) {
      if (!(await afSetPanelProp(pane as Element, label, String(val)))) failed.push(`prop:${label}`);
      await ttSleep(120);
      pane = afVfe();
    }
  }

  return {
    ok: failed.length === 0,
    reason: failed.length ? "Field chưa vào (kiểm tay): " + failed.join(", ") : "Đã điền view",
  };
}

/* ======================================================================
 * add_slice / set_slice apply — Data → Slices pane (VFE-style)
 * ==================================================================== */

/** Open an existing slice by name via the hash route (#Data.Slices.<name>). */
async function afOpenSlice(name: string): Promise<Element | null> {
  try {
    location.hash = "Data.Slices." + encodeURIComponent(name);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  } catch {
    location.hash = "Data.Slices." + name;
  }
  const pane = await afWaitFor(".VFESectionWrapper, .TabPane", 5000);
  await ttSleep(250);
  return pane;
}

/** Set a slice's Row filter condition. The field is an Expression Assistant
 *  combobox: click its textarea → a suggestions popup with "Create a new
 *  expression" → clicking that opens the standard Expression modal (CodeMirror). */
async function afSliceRowFilter(pane: Element, value: string): Promise<boolean> {
  const fc = afVfeCtrl(pane, "Row filter condition");
  if (!fc) return false;
  // A slice that ALREADY has a filter (set_slice, or any re-render) shows the
  // standard readonly ExpressionControl input that commits via the Expression
  // Assistant modal — afSetExpression handles exactly that. The textarea combobox
  // ("Create a new expression") only appears for a BLANK filter. Previously this
  // only looked for the textarea, so set_slice returned false without applying
  // (the old value stayed, masking the failure). Prefer the input; fall back to
  // the combobox for the empty case.
  const inp = fc.querySelector<HTMLInputElement>(".ExpressionControl input, input.MuiInputBase-input, input.MuiOutlinedInput-input");
  if (inp) return afSetExpression(inp, value);
  const ta = fc.querySelector<HTMLTextAreaElement>("textarea");
  if (!ta) return false;
  ttClick(ta);
  try {
    ta.focus();
  } catch {
    /* ignore */
  }
  await ttSleep(350);
  let create: Element | undefined;
  const t0 = performance.now();
  while (performance.now() - t0 < 2500) {
    create = Array.from(document.querySelectorAll("div, li, button, span, a")).find(
      (e) => /^create a new expression$/i.test((e.textContent || "").trim()),
    );
    if (create) break;
    await ttSleep(120);
  }
  if (create) ttClick(create);
  return afInjectExprModal(value);
}

/** Create or edit a slice (Name + Source Table + Row filter condition). */
async function afFillSlice(ch: Change): Promise<OpResult> {
  await afGotoSection("data");
  await ttSleep(200);
  let pane: Element | null;
  if (ch.op === "add_slice") {
    // Each table row has its OWN "Add Slice" button → opens a table-scoped
    // dialog. Pick the one whose tree item matches the target table.
    const norm = (s: unknown) => String(s || "").trim().toLowerCase();
    let addBtn: HTMLElement | null = null;
    for (const b of document.querySelectorAll<HTMLElement>('button[aria-label="Add Slice to filter data"]')) {
      const ti = b.closest(".MuiTreeItem-root, [role='treeitem'], li");
      const label = ti?.querySelector(".MuiTreeItem-label") || ti;
      if (label && norm(label.textContent) === norm(ch.table)) {
        addBtn = b;
        break;
      }
    }
    if (!addBtn) return { ok: false, reason: `Không thấy nút Add Slice cho ${ch.table}` };
    ttClick(addBtn);
    const dlg = await afWaitFor(".MuiDialog-paper", 5000);
    if (!dlg) return { ok: false, reason: "Dialog Add Slice không mở" };
    await ttSleep(200);
    // The dialog lists suggestion slices + a "Create a new slice for <table>"
    // button that opens a blank slice editor.
    const createBtn = Array.from(dlg.querySelectorAll("button")).find((b) =>
      /^create a new slice/i.test((b.textContent || "").trim()),
    );
    if (!createBtn) return { ok: false, reason: 'Không thấy nút "Create a new slice"' };
    ttClick(createBtn as HTMLElement);
    pane = await afWaitFor(".VFESectionWrapper, .TabPane", 6000);
    if (!pane) return { ok: false, reason: "Slice editor không mở" };
    await ttSleep(250);
    if (ch.name) {
      const nameInp = afVfeCtrl(pane, "Slice Name")?.querySelector<HTMLInputElement>("input");
      if (nameInp) {
        afSetText(nameInp, ch.name);
        await ttSleep(200);
      }
    }
  } else {
    if (!ch.slice) return { ok: false, reason: "set_slice thiếu tên slice." };
    pane = await afOpenSlice(ch.slice);
    if (!pane) return { ok: false, reason: "Không mở được slice " + ch.slice };
  }
  await ttSleep(90);

  const failed: string[] = [];
  if (ch.table) {
    if (!(await afPanelSetDropdown(pane, "Source Table", ch.table))) failed.push("table");
    await ttSleep(150);
    pane = afVfe() || pane;
  }
  if (ch.rowFilter) {
    if (!(await afSliceRowFilter(pane, ch.rowFilter))) failed.push("rowFilter");
    await ttSleep(150);
  }

  return {
    ok: failed.length === 0,
    reason: failed.length ? "Field chưa vào (kiểm tay): " + failed.join(", ") : "Đã tạo slice",
  };
}

/* ======================================================================
 * add_action / set_action apply — Behavior pane (source afFillAction ~10100)
 * ==================================================================== */

// Action "Position" changeset values → the EnumOption data-value in the editor.
const AF_ACTION_POS: Record<string, string> = {
  Primary: "Display_Overlay",
  Prominent: "Display_Prominently",
  Inline: "Display_Inline",
  Hide: "Do_Not_Display",
};

function afActPane(): Element | null {
  const r = document.querySelector("#BehaviorPane");
  return (r && (r.querySelector(".VFESectionWrapper") || r.querySelector(".TabPane"))) || afVfe();
}

function afActNameInput(): HTMLInputElement | null {
  const c = afVfeCtrl(afActPane(), "Action name");
  return c ? c.querySelector<HTMLInputElement>("input") : null;
}

/** Create a new action for a table: each table row in Behavior has its own
 *  "Add Action" button (label like "PLANS (4)Add new") → opens the editor with
 *  a fresh "New Action" (a "Create a new action" dialog may appear first). */
async function afCreateAction(table: string): Promise<Element | null> {
  let addBtn: HTMLElement | null = null;
  for (const b of document.querySelectorAll<HTMLElement>('button[aria-label="Add Action"]')) {
    const ti = b.closest(".MuiTreeItem-root, [role='treeitem'], li");
    const label = (ti?.querySelector(".MuiTreeItem-label") || ti)?.textContent || "";
    const tableName = label.split(/\s*\(/)[0].trim(); // "PLANS (4)Add new" → "PLANS"
    if (ttSame(tableName, table)) {
      addBtn = b;
      break;
    }
  }
  if (!addBtn) return null;
  ttClick(addBtn);
  await ttSleep(300);
  const dlg = document.querySelector(".MuiDialog-paper");
  if (dlg) {
    const createBtn = Array.from(dlg.querySelectorAll("button")).find((b) => /create a new action/i.test(b.textContent || ""));
    if (createBtn) ttClick(createBtn as HTMLElement);
  }
  for (let i = 0; i < 45; i++) {
    await ttSleep(90);
    const inp = afActNameInput();
    if (inp && /^New Action/i.test(inp.value || "")) return afActPane();
  }
  return afActPane();
}

/** Open an existing action by name within the Behavior tree (source afOpenAction ~9992). */
async function afOpenAction(table: string | undefined, name: string): Promise<Element | null> {
  const cur = afActNameInput();
  if (cur && ttSame(cur.value, name)) return afActPane();
  let scope: Element | null = document.querySelector("#BehaviorPane");
  if (table) {
    for (const li of document.querySelectorAll("#BehaviorPane li[aria-label]")) {
      if (ttSame(li.getAttribute("aria-label"), table)) {
        scope = li;
        break;
      }
    }
  }
  let target: Element | null = null;
  for (const el of (scope || document).querySelectorAll(".MuiTreeItem-content")) {
    const raw = (el.textContent || "").trim();
    if (/\(\d+\)\s*$/.test(raw)) continue;
    if (ttSame(raw, name)) {
      target = el;
      break;
    }
  }
  if (!target) return null;
  try {
    (target as HTMLElement).scrollIntoView({ block: "center" });
  } catch {
    /* ignore */
  }
  ttClick(target);
  for (let i = 0; i < 40; i++) {
    await ttSleep(90);
    const inp = afActNameInput();
    if (inp && ttSame(inp.value, name)) return afActPane();
  }
  return afActPane();
}

/** SET_COLUMN_VALUE / ADD_RECORD_TO "Set these columns" list (source afFillAssignments ~10029). */
async function afFillAssignments(pane: Element, assignments: { column?: string; value?: string }[]): Promise<boolean> {
  const ctrl = afVfeCtrl(pane, "Set these columns");
  const list = ctrl?.querySelector(".ListItems");
  if (!list) return false;
  let okAll = true;
  for (let i = 0; i < assignments.length; i++) {
    let items = list.querySelectorAll(":scope > .ListItem");
    let guard = 0;
    while (items.length <= i && guard++ < 6) {
      const add = ctrl!.querySelector<HTMLElement>(".ListAddItem");
      if (!add) break;
      ttClick(add);
      await ttSleep(200);
      items = list.querySelectorAll(":scope > .ListItem");
    }
    const item = items[i];
    if (!item) {
      okAll = false;
      continue;
    }
    const a = assignments[i] || {};
    if (a.column) {
      const sel = item.querySelector<HTMLElement>('.MuiSelect-select[role="button"]');
      if (!(await afMuiSelectSet(sel, a.column))) okAll = false;
      await ttSleep(90);
    }
    if (a.value != null) {
      const inp = item.querySelector<HTMLInputElement>(".ExpressionControl input, input.MuiInputBase-input");
      if (!(inp && (await afSetExpression(inp, a.value)))) okAll = false;
      await ttSleep(130);
    }
  }
  return okAll;
}

/** COMPOSITE "Actions" ordered list of child action names (source afFillActionList ~10067). */
async function afFillActionList(pane: Element, names: string[]): Promise<boolean> {
  const ctrl = afVfeCtrl(pane, "Actions");
  const list = ctrl?.querySelector(".ListItems");
  if (!list) return false;
  let okAll = true;
  for (let i = 0; i < names.length; i++) {
    let items = list.querySelectorAll(":scope > .ListItem");
    let guard = 0;
    while (items.length <= i && guard++ < 8) {
      const add = ctrl!.querySelector<HTMLElement>(".ListAddItem");
      if (!add) break;
      ttClick(add);
      await ttSleep(220);
      items = list.querySelectorAll(":scope > .ListItem");
    }
    const item = items[i];
    if (!item) {
      okAll = false;
      continue;
    }
    const nsel = item.querySelector<HTMLSelectElement>("select.dropdownSelect");
    const msel = item.querySelector<HTMLElement>('.MuiSelect-select[role="button"]');
    if (nsel) {
      if (!ttSetSelect(nsel, names[i])) okAll = false;
    } else if (msel) {
      if (!(await afMuiSelectSet(msel, names[i]))) okAll = false;
    } else okAll = false;
    await ttSleep(120);
  }
  return okAll;
}

/** Create or edit a Behavior action (source afFillAction ~10100). */
async function afFillAction(ch: Change): Promise<OpResult> {
  await afGotoSection("behavior");
  let pane: Element | null;
  if (ch.op === "add_action") {
    pane = await afCreateAction(ch.table || "");
    if (!pane) return { ok: false, reason: "Không tạo được action mới (không thấy nút Add Action cho " + ch.table + ")" };
    const ni = afActNameInput();
    if (ni && ch.name) {
      afSetText(ni, ch.name);
      await ttSleep(240);
    }
    pane = afActPane();
  } else {
    if (!ch.action) return { ok: false, reason: "set_action thiếu tên action." };
    pane = await afOpenAction(ch.table, ch.action);
    if (!pane) return { ok: false, reason: "Không mở được action " + ch.action };
  }
  await ttSleep(90);
  if (!pane) return { ok: false, reason: "Action pane không tìm thấy." };

  const failed: string[] = [];
  const chAny = ch as any;
  if (ch.table) {
    if (!afVfeDropdown(pane, "For a record of this table", ch.table)) failed.push("table");
    await ttSleep(130);
    pane = afActPane()!;
  }
  if (ch.actionType) {
    if (!afVfeDropdown(pane, "Do this", ch.actionType)) failed.push("actionType");
    await ttSleep(200);
    pane = afActPane()!;
  }
  if (chAny.targetTable) {
    const okT =
      afVfeDropdown(pane, "Table to add to", chAny.targetTable) ||
      afVfeDropdown(pane, "Table to add the row to", chAny.targetTable) ||
      afVfeDropdown(pane, "To this table", chAny.targetTable);
    if (!okT) failed.push("targetTable");
    await ttSleep(250);
    pane = afActPane()!;
  }
  if (chAny.assignments && chAny.assignments.length) {
    if (!(await afFillAssignments(pane, chAny.assignments))) failed.push("assignments");
    await ttSleep(90);
    pane = afActPane()!;
  }
  if (ch.referencedTable) {
    if (!afVfeDropdown(pane, "Referenced Table", ch.referencedTable)) failed.push("referencedTable");
    await ttSleep(220);
    pane = afActPane()!;
  }
  if (chAny.referencedRows) {
    if (!(await afVfeExpr(pane, "Referenced Rows", chAny.referencedRows))) failed.push("referencedRows");
    await ttSleep(130);
    pane = afActPane()!;
  }
  if (chAny.referencedAction) {
    const rc = afVfeCtrl(pane, "Referenced Action");
    const rs = rc && rc.querySelector<HTMLElement>('.MuiSelect-select[role="button"]');
    if (!(rs && (await afMuiSelectSet(rs, chAny.referencedAction)))) failed.push("referencedAction");
    await ttSleep(130);
    pane = afActPane()!;
  }
  if (chAny.actions && chAny.actions.length) {
    if (!(await afFillActionList(pane, chAny.actions))) failed.push("actions");
    await ttSleep(90);
    pane = afActPane()!;
  }
  if (chAny.target) {
    if (!(await afVfeExpr(pane, "Target", chAny.target))) failed.push("target");
    await ttSleep(130);
    pane = afActPane()!;
  }
  // Type-specific extra properties (Desktop behavior, CSV file locale, Launch
  // External, To/Subject/Body/File for CALL/SMS/EMAIL/OPEN_FILE, …) via the same
  // generic panel setter used for column properties.
  if (ch.properties) {
    for (const [label, val] of Object.entries(ch.properties)) {
      if (!(await afSetPanelProp(pane, label, String(val)))) failed.push(`prop:${label}`);
      await ttSleep(120);
    }
    pane = afActPane()!;
  }
  if (ch.position) {
    if (!afVfeEnum(pane, "Position", AF_ACTION_POS[ch.position] || ch.position)) failed.push("position");
    await ttSleep(90);
  }
  if (ch.displayName || ch.icon) await afVfeExpandSection(pane, "Display");
  if (ch.displayName) {
    const di = afVfeCtrl(pane, "Display name");
    const inp = di && (di.querySelector<HTMLInputElement>(".ChildControl input") || di.querySelector<HTMLInputElement>("input.MuiInputBase-input"));
    if (!(inp && afSetText(inp, ch.displayName))) failed.push("displayName");
    await ttSleep(90);
  }
  if (ch.icon) {
    const ic = afVfeCtrl(pane, "Action icon");
    const il = ic && ic.querySelector(".IconListControl");
    if (!(il && (await afSetIconList(il, ch.icon)))) failed.push("icon");
    await ttSleep(130);
  }
  if (ch.condition || chAny.needsConfirmation || chAny.confirmationMessage) await afVfeExpandSection(pane, "Behavior");
  if (ch.condition) {
    if (!(await afVfeExpr(pane, "Only if this condition is true", ch.condition))) failed.push("condition");
    await ttSleep(90);
  }
  if (chAny.needsConfirmation) {
    if (!(await afVfeSwitch(pane, "Needs confirmation?", chAny.needsConfirmation))) failed.push("needsConfirmation");
    await ttSleep(90);
  }
  if (chAny.confirmationMessage) {
    const ci = afVfeCtrl(pane, "Confirmation Message");
    const inp = ci && (ci.querySelector<HTMLInputElement>(".ChildControl input") || ci.querySelector<HTMLInputElement>("input.MuiInputBase-input"));
    if (!(inp && afSetText(inp, chAny.confirmationMessage))) failed.push("confirmationMessage");
    await ttSleep(90);
  }

  return {
    ok: failed.length === 0,
    reason: failed.length ? "Field chưa vào (kiểm tay): " + failed.join(", ") : "Đã điền action",
  };
}

/* ======================================================================
 * editorReady + applyChanges dispatcher (source editorReady ~10557, afFill ~10507)
 * ==================================================================== */

/** True if the AppSheet editor DOM looks loaded (source editorReady ~10557). */
export function editorReady(): boolean {
  return !!(
    document.querySelector("[data-navlocation]") ||
    document.querySelector(".ReactVirtualized__Grid") ||
    document.querySelector(".EditorToolbar")
  );
}

/** Short human-readable label for a change (mirrors fillAll's label logic ~10611). */
function fillLabel(ch: Change): string {
  if (ch.op === "set_table") return "table " + (ch.table || "");
  if (ch.op === "add_virtual_column") return "vcol " + (ch.table || "") + "." + (ch.name || "");
  if (ch.op === "add_view" || ch.op === "set_view") return "view " + (ch.name || ch.view || "");
  if (ch.op === "add_slice" || ch.op === "set_slice") return "slice " + (ch.name || ch.slice || "");
  if (ch.op === "add_action" || ch.op === "set_action") return "action " + (ch.name || (ch as any).action || "");
  if (ch.op === "add_format_rule" || ch.op === "set_format_rule") return "format rule " + (ch.name || ch.rule || "");
  return (ch.table || "") + "." + (ch.column || "");
}

/**
 * Apply a validated changeset. Iterates in order; per change returns one
 * FillResult. Never throws — each change is caught individually and recorded as
 * level "error". Supports set_column, set_table, add_format_rule, set_format_rule.
 */
export async function applyChanges(changes: Change[]): Promise<FillResult[]> {
  const results: FillResult[] = [];
  for (let i = 0; i < changes.length; i++) {
    const ch = changes[i];
    const op = (ch as any).op as string;
    const label = fillLabel(ch);
    try {
      let r: OpResult;
      if (ch.op === "set_column") {
        r = await afFillSet(ch);
      } else if (ch.op === "add_virtual_column") {
        r = await afFillAdd(ch);
      } else if (ch.op === "set_table") {
        r = await afFillTable(ch);
      } else if (ch.op === "add_view" || ch.op === "set_view") {
        r = await afFillView(ch);
      } else if (ch.op === "add_slice" || ch.op === "set_slice") {
        r = await afFillSlice(ch);
      } else if (ch.op === "add_action" || ch.op === "set_action") {
        r = await afFillAction(ch);
      } else if (ch.op === "add_format_rule" || ch.op === "set_format_rule") {
        r = await afFillFormatRule(ch);
      } else {
        results.push({ index: i, op, label, level: "error", detail: "op not supported yet" });
        continue;
      }
      results.push({
        index: i,
        op,
        label,
        level: r.ok ? "ok" : "warn",
        detail: r.ok ? undefined : r.reason,
      });
    } catch (e) {
      results.push({
        index: i,
        op,
        label,
        level: "error",
        detail: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return results;
}
