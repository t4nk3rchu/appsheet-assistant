// src/sidebar/tabs.tsx — the seven tool panels. Each builds a prompt and runs
// it through the shared completion flow; only Build App touches the live app
// (and only via an explicit Apply, after backing up the schema).
import { useState, useRef, useEffect } from "react";
import type { Dict } from "./i18n";
import { useCompletion, ResultCard, ContextFields, NeedKey } from "./kit";
import { complete } from "../lib/ai";
import { getSchema, getTables, applyChangeset, applyTypes, editorReady, type Table } from "../lib/appsheet";
import { validateSchema, type Issue } from "../lib/schema-check";
import { validateChangeset, summarize, type ValidationResult, type FillResult } from "../lib/changeset";
import {
  changesetPrompt, formulaPrompt, explainPrompt, fixPrompt, typesPrompt, askPrompt,
  buildSchemaContext,
  type Ctx, type Lang, type ChatTurn,
} from "../lib/prompts";
import type { Skill } from "../lib/skills";
import { askClaude } from "../lib/claude-client";
import { getSettings } from "../lib/storage";

interface TabProps {
  t: Dict;
  lang: Lang;
  hasKey: boolean;
  tables: Table[];
  instructions?: string; // user's persistent Build App conventions
  skills?: Skill[]; // user-uploaded skills the AI auto-triggers by description
  provider?: string; // selected provider; "claude" routes generation via claude.ai
}

const emptyCtx: Ctx = { table: "", column: "", usedAs: "" };

/* ---------- Build App ----------
   AI returns a STRICT-JSON changeset → validate against the live tables →
   review N changes → "Dựng ngay" drives the editor (autofill engine) → the
   user clicks Save in the editor. Backup is taken before any write. */
export function BuildApp({ t, lang, hasKey, tables, instructions, skills, provider }: TabProps) {
  const [ask, setAsk] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [parseErr, setParseErr] = useState("");
  const [validation, setValidation] = useState<ValidationResult | null>(null);
  const [applying, setApplying] = useState(false);
  const [results, setResults] = useState<FillResult[] | null>(null);
  const [checking, setChecking] = useState(false);
  const [askingClaude, setAskingClaude] = useState(false);
  const [issues, setIssues] = useState<Issue[] | null>(null);
  const [rawJson, setRawJson] = useState(""); // the editable changeset JSON (AI fills, user edits)
  const [tbls, setTbls] = useState<Table[]>([]); // tables used for validation (fetched at generate)
  const chips = [t.build_chip1, t.build_chip2, t.build_chip3, t.build_chip4];

  // Parse + validate the JSON in the textarea against the live tables. Called
  // after generate (AI-filled) and on every manual edit so "Dựng ngay (N)" and
  // the issue list track what's actually in the box.
  function validateText(text: string, useTbls: Table[]) {
    setParseErr("");
    setResults(null);
    if (!text.trim()) { setValidation(null); return; }
    let raw = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/, "").trim();
    const a = raw.indexOf("{"), b = raw.lastIndexOf("}");
    if (a >= 0 && b > a) raw = raw.slice(a, b + 1);
    let parsed: any;
    try { parsed = JSON.parse(raw); } catch { setValidation(null); setParseErr(t.build_parseErr); return; }
    setValidation(validateChangeset(useTbls, parsed?.changes));
  }

  function reset() { setErr(""); setParseErr(""); setValidation(null); setResults(null); setIssues(null); }

  async function generate() {
    reset();
    setBusy(true);
    try {
      // Fetch tables fresh so the prompt always has the real schema and the
      // validator can catch bad names — the mount-time list may be empty/stale.
      const live = await getTables().catch(() => [] as Table[]);
      const use = live.length ? live : tables;
      setTbls(use);
      if (!use.length) { setErr(t.build_editorNotReady); return; }
      const { system, prompt } = changesetPrompt(ask, use, lang, instructions, skills);
      let raw = (await complete(system, prompt)).trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/, "").trim();
      const a = raw.indexOf("{"), b = raw.lastIndexOf("}");
      if (a >= 0 && b > a) raw = raw.slice(a, b + 1);
      // Pretty-print so the textarea is readable, then validate what we filled.
      let pretty = raw;
      try { pretty = JSON.stringify(JSON.parse(raw), null, 2); } catch { /* leave raw for the user to fix */ }
      setRawJson(pretty);
      validateText(pretty, use);
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  }

  async function askViaClaude() {
    reset();
    setAskingClaude(true);
    try {
      const live = await getTables().catch(() => [] as Table[]);
      const use = live.length ? live : tables;
      setTbls(use);
      if (!use.length) { setErr(t.build_editorNotReady); return; }
      const { system, prompt } = changesetPrompt(ask, use, lang, instructions, skills);
      const schemaText = buildSchemaContext(use);
      const s = await getSettings();
      let raw = (await askClaude(system, prompt, schemaText, use, s.claudeSkillSource, s.claudeSkillName)).trim();
      const a = raw.indexOf("{"), b = raw.lastIndexOf("}");
      if (a >= 0 && b > a) raw = raw.slice(a, b + 1);
      let pretty = raw;
      try { pretty = JSON.stringify(JSON.parse(raw), null, 2); } catch { /* leave raw */ }
      setRawJson(pretty);
      validateText(pretty, use);
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setAskingClaude(false);
    }
  }

  async function apply() {
    const changes = validation?.normalized ?? [];
    if (!changes.length) return;
    setApplying(true);
    setErr("");
    setResults(null);
    try {
      if (!(await editorReady())) { setErr(t.build_editorNotReady); return; }
      setResults(await applyChangeset(changes, Date.now()));
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setApplying(false);
    }
  }

  async function check() {
    setChecking(true);
    setErr("");
    try {
      setIssues(validateSchema(await getSchema()));
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setChecking(false);
    }
  }

  const n = validation?.normalized.length ?? 0;

  return (
    <>
      <div className="field">
        <textarea value={ask} onChange={(e) => setAsk(e.target.value)} placeholder={t.build_ph} rows={3} />
      </div>
      <div className="chips">
        {chips.map((ch) => <button key={ch} className="chip" onClick={() => setAsk(ch)}>{ch}</button>)}
      </div>
      <div className="row">
        {provider === "claude" ? (
          <button className="btn btn-primary" disabled={askingClaude || !ask.trim()} onClick={askViaClaude}>
            {askingClaude ? t.build_askingClaude : t.build_askClaude}
          </button>
        ) : (
          <button className="btn btn-primary" disabled={busy || !ask.trim() || !hasKey} onClick={generate}>
            {busy ? t.generating : t.generate}
          </button>
        )}
        <button className="btn" disabled={checking} onClick={check}>
          {checking ? t.build_checking : t.build_check}
        </button>
      </div>
      <p className="hint">{provider === "claude" ? t.build_claudeHint : t.build_hint}</p>
      <p className="hint">{t.build_claudeHint}</p>
      <NeedKey show={!hasKey} t={t} />
      {err && <p className="err">{err}</p>}

      <div className="field">
        <label>{t.build_json}</label>
        <textarea className="code" value={rawJson} rows={12} placeholder={t.build_json_ph}
          onChange={(e) => { setRawJson(e.target.value); validateText(e.target.value, tbls.length ? tbls : tables); }} />
        <span className="hint">{t.build_json_hint}</span>
      </div>
      {parseErr && <p className="err">{parseErr}</p>}

      {issues && (
        <ul className="issues">
          {issues.length === 0
            ? <li className="issue ok">{t.build_noIssues}</li>
            : issues.map((iss, i) => <li key={i} className={`issue ${iss.level}`}>{iss.message}</li>)}
        </ul>
      )}

      {validation && (
        <>
          {validation.issues.length > 0 && (
            <ul className="issues">
              {validation.issues.map((iss, i) => <li key={i} className={`issue ${iss.level}`}>{iss.msg}</li>)}
            </ul>
          )}
          {n === 0 ? (
            <p className="hint">{t.build_noChanges}</p>
          ) : (
            <>
              <div className="card">
                <div className="card-head"><span className="dot" /><span className="ttl">{t.build_planTitle} · {n}</span></div>
                <pre>{validation.normalized.map(summarize).join("\n")}</pre>
              </div>
              <div className="row">
                <button className="btn btn-primary" disabled={applying} onClick={apply}>
                  {applying ? t.build_applying : `${t.build_apply} (${n})`}
                </button>
              </div>
              <p className="hint">{t.build_applyHint}</p>
            </>
          )}
        </>
      )}

      {results && (
        <>
          <ul className="issues">
            {results.map((r, i) => (
              <li key={i} className={`issue ${r.level}`}>{r.label}{r.detail ? " — " + r.detail : ""}</li>
            ))}
          </ul>
          <p className="hint">{t.build_saveReminder}</p>
        </>
      )}
    </>
  );
}

/* ---------- Formula ---------- */
export function Formula({ t, lang, hasKey, tables }: TabProps) {
  const [desc, setDesc] = useState("");
  const [cur, setCur] = useState("");
  const [ctx, setCtx] = useState<Ctx>(emptyCtx);
  const c = useCompletion();
  const go = () => { const { system, prompt } = formulaPrompt(desc, cur, ctx, lang); c.run(() => complete(system, prompt)); };
  return (
    <>
      <div className="field">
        <label>{t.formula_desc}</label>
        <textarea value={desc} onChange={(e) => setDesc(e.target.value)} placeholder={t.formula_desc_ph} rows={3} />
      </div>
      <div className="field">
        <label>{t.formula_current}</label>
        <textarea className="code" value={cur} onChange={(e) => setCur(e.target.value)} placeholder={t.formula_current_ph} rows={2} />
      </div>
      <ContextFields ctx={ctx} set={setCtx} t={t} tables={tables} />
      <div className="row">
        <button className="btn btn-primary" disabled={c.busy || !desc.trim() || !hasKey} onClick={go}>
          {c.busy ? t.generating : t.formula_btn}
        </button>
      </div>
      <NeedKey show={!hasKey} t={t} />
      {c.err && <p className="err">{c.err}</p>}
      <ResultCard title={t.result} text={c.out} t={t} />
    </>
  );
}

/* ---------- Explain ---------- */
export function Explain({ t, lang, hasKey, tables }: TabProps) {
  const [expr, setExpr] = useState("");
  const [ctx, setCtx] = useState<Ctx>(emptyCtx);
  const c = useCompletion();
  const go = () => { const { system, prompt } = explainPrompt(expr, ctx, lang); c.run(() => complete(system, prompt)); };
  return (
    <>
      <div className="field">
        <label>{t.explain_expr}</label>
        <textarea className="code" value={expr} onChange={(e) => setExpr(e.target.value)} placeholder={t.explain_ph} rows={4} />
      </div>
      <ContextFields ctx={ctx} set={setCtx} t={t} tables={tables} />
      <div className="row">
        <button className="btn btn-primary" disabled={c.busy || !expr.trim() || !hasKey} onClick={go}>
          {c.busy ? t.generating : t.explain_btn}
        </button>
      </div>
      <NeedKey show={!hasKey} t={t} />
      {c.err && <p className="err">{c.err}</p>}
      <ResultCard title={t.result} text={c.out} t={t} />
    </>
  );
}

/* ---------- Fix ---------- */
export function Fix({ t, lang, hasKey, tables }: TabProps) {
  const [expr, setExpr] = useState("");
  const [errMsg, setErrMsg] = useState("");
  const [intended, setIntended] = useState("");
  const [ctx, setCtx] = useState<Ctx>(emptyCtx);
  const c = useCompletion();
  const go = () => { const { system, prompt } = fixPrompt(expr, errMsg, intended, ctx, lang); c.run(() => complete(system, prompt)); };
  return (
    <>
      <div className="field">
        <label>{t.fix_expr}</label>
        <textarea className="code" value={expr} onChange={(e) => setExpr(e.target.value)} rows={3} />
      </div>
      <div className="field">
        <label>{t.fix_err}</label>
        <input type="text" value={errMsg} onChange={(e) => setErrMsg(e.target.value)} placeholder={t.fix_err_ph} />
      </div>
      <div className="field">
        <label>{t.fix_intended}</label>
        <input type="text" value={intended} onChange={(e) => setIntended(e.target.value)} placeholder={t.fix_intended_ph} />
      </div>
      <ContextFields ctx={ctx} set={setCtx} t={t} tables={tables} />
      <div className="row">
        <button className="btn btn-primary" disabled={c.busy || !expr.trim() || !hasKey} onClick={go}>
          {c.busy ? t.generating : t.fix_btn}
        </button>
      </div>
      <NeedKey show={!hasKey} t={t} />
      {c.err && <p className="err">{c.err}</p>}
      <ResultCard title={t.result} text={c.out} t={t} />
    </>
  );
}

/* ---------- Set Type ---------- */
export function SetType({ t, lang, hasKey, tables }: TabProps) {
  const [table, setTable] = useState("");
  const [cols, setCols] = useState("");
  const [applying, setApplying] = useState(false);
  const [applyMsg, setApplyMsg] = useState("");
  const c = useCompletion();
  const go = () => { const { system, prompt } = typesPrompt(table, cols, lang); c.run(() => complete(system, prompt)); };
  function fillFrom(name: string) {
    setTable(name);
    setApplyMsg("");
    const tb = tables.find((x) => x.name === name);
    // Prefill "name : CurrentType" — this textarea is the editable source of
    // truth for Apply: edit a type here, then Apply writes it to the editor.
    if (tb) setCols(tb.columns.map((c) => `${c.name} : ${c.type}`).join("\n"));
  }
  // Parse "column : Type" lines into the pairs the engine expects.
  const parsed = cols
    .split("\n")
    .map((l) => { const i = l.indexOf(":"); return i < 0 ? null : { column: l.slice(0, i).trim(), type: l.slice(i + 1).trim() }; })
    .filter((x): x is { column: string; type: string } => !!x && !!x.column && !!x.type);

  async function apply() {
    if (!table || !parsed.length) return;
    setApplying(true);
    setApplyMsg("");
    try {
      const r = await applyTypes(table, parsed);
      setApplyMsg(`✓ ${r?.applied ?? 0} · skip ${r?.skipped ?? 0} · fail ${r?.failed ?? 0}`);
    } catch (e: any) {
      setApplyMsg(String(e?.message ?? e));
    } finally {
      setApplying(false);
    }
  }

  return (
    <>
      <div className="field">
        <label>{t.types_table}</label>
        {tables.length ? (
          <select value={table} onChange={(e) => fillFrom(e.target.value)}>
            <option value="">{t.types_fill}</option>
            {tables.map((tb) => <option key={tb.name} value={tb.name}>{tb.name}</option>)}
          </select>
        ) : (
          <input type="text" value={table} onChange={(e) => setTable(e.target.value)} />
        )}
      </div>
      <div className="field">
        <label>{t.types_cols}</label>
        <textarea className="code" value={cols} onChange={(e) => setCols(e.target.value)} placeholder={t.types_cols_ph} rows={6} />
      </div>
      <div className="row">
        <button className="btn btn-primary" disabled={c.busy || !cols.trim() || !hasKey} onClick={go}>
          {c.busy ? t.generating : t.types_btn}
        </button>
        <button className="btn" disabled={applying || !table || !parsed.length} onClick={apply}>
          {applying ? t.types_applying : t.types_apply}
        </button>
      </div>
      <p className="hint">{t.types_applyHint}</p>
      <NeedKey show={!hasKey} t={t} />
      {applyMsg && <p className="hint">{applyMsg}</p>}
      {c.err && <p className="err">{c.err}</p>}
      <ResultCard title={t.result} text={c.out} t={t} />
    </>
  );
}

/* ---------- Ask AI (chat) ---------- */
export function AskAI({ t, lang, hasKey }: TabProps) {
  const [msgs, setMsgs] = useState<ChatTurn[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => { endRef.current?.scrollIntoView({ block: "end" }); }, [msgs, busy]);

  async function send() {
    const text = input.trim();
    if (!text || busy) return;
    const history = [...msgs, { role: "user", text } as ChatTurn];
    setMsgs(history);
    setInput("");
    setBusy(true);
    try {
      const { system, prompt } = askPrompt(history, lang);
      const answer = await complete(system, prompt);
      setMsgs([...history, { role: "assistant", text: answer }]);
    } catch (e: any) {
      setMsgs([...history, { role: "assistant", text: String(e?.message ?? e) }]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
      <div className="chat">
        {msgs.length === 0 && <div className="empty">{t.ask_empty}</div>}
        {msgs.map((m, i) => <div key={i} className={`msg ${m.role === "user" ? "user" : "ai"}`}>{m.text}</div>)}
        {busy && <div className="msg ai">{t.generating}</div>}
        <div ref={endRef} />
      </div>
      <div className="chatbar">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
          placeholder={t.ask_ph}
          rows={1}
        />
        <button className="btn btn-primary" disabled={busy || !input.trim() || !hasKey} onClick={send}>{t.ask_send}</button>
      </div>
    </div>
  );
}

/* ---------- About ---------- */
export function About({ t }: TabProps) {
  return (
    <div className="about">
      <p>{t.about_lead}</p>
      <p>{t.about_credit}</p>
      <p>
        <a href="https://chromewebstore.google.com/search/Assistant%20for%20AppSheet" target="_blank" rel="noreferrer noopener">
          {t.about_original} ↗
        </a>
      </p>
      <p className="hint">{t.about_license}</p>
    </div>
  );
}
