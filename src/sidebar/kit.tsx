// src/sidebar/kit.tsx — small shared hooks + presentational pieces used across
// the tool tabs.
import { useState } from "react";
import type { Dict } from "./i18n";
import type { Ctx } from "../lib/prompts";
import type { Table } from "../lib/appsheet";

// AppSheet field slots an expression can fill — where the formula goes.
// These are AppSheet's own technical names, kept untranslated.
export const USED_AS = [
  "App formula", "Initial value", "Valid_if", "Show_if",
  "Editable_if", "Required_if", "Security filter",
];

/** Runs an async text-producing task and tracks busy/error/output for a tab. */
export function useCompletion() {
  const [out, setOut] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  async function run(task: () => Promise<string>) {
    setBusy(true);
    setErr("");
    setOut("");
    try {
      setOut(await task());
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  }
  return { out, busy, err, run, setOut, setErr };
}

export function CopyBtn({ text, t }: { text: string; t: Dict }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="copybtn"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        } catch {
          /* clipboard blocked — ignore */
        }
      }}
    >
      {done ? t.copied : t.copy}
    </button>
  );
}

export function ResultCard({ title, text, t }: { title: string; text: string; t: Dict }) {
  if (!text) return null;
  return (
    <div className="card">
      <div className="card-head">
        <span className="dot" />
        <span className="ttl">{title}</span>
        <CopyBtn text={text} t={t} />
      </div>
      <pre>{text}</pre>
    </div>
  );
}

export function ContextFields({ ctx, set, t, tables }: { ctx: Ctx; set: (c: Ctx) => void; t: Dict; tables: Table[] }) {
  const cols = tables.find((tb) => tb.name === ctx.table)?.columns ?? [];
  return (
    <details className="ctx" open>
      <summary>{t.ctx} · <span className="hint" style={{ display: "inline" }}>{t.ctx_live}</span></summary>
      <div className="ctxgrid">
        <div className="field">
          <label>{t.ctx_table}</label>
          <select value={ctx.table ?? ""} onChange={(e) => set({ ...ctx, table: e.target.value, column: "" })}>
            <option value="">{t.ctx_pick}</option>
            {tables.map((tb) => <option key={tb.name} value={tb.name}>{tb.name}</option>)}
          </select>
        </div>
        <div className="field">
          <label>{t.ctx_column}</label>
          <select value={ctx.column ?? ""} disabled={!cols.length} onChange={(e) => set({ ...ctx, column: e.target.value })}>
            <option value="">{t.ctx_pick}</option>
            {cols.map((c) => <option key={c.name} value={c.name}>{c.name} · {c.type}</option>)}
          </select>
        </div>
        <div className="field">
          <label>{t.ctx_usedAs}</label>
          <select value={ctx.usedAs ?? ""} onChange={(e) => set({ ...ctx, usedAs: e.target.value })}>
            <option value="">{t.ctx_pick}</option>
            {USED_AS.map((u) => <option key={u} value={u}>{u}</option>)}
            <option value="Other">{t.ctx_other}</option>
          </select>
        </div>
      </div>
    </details>
  );
}

export function NeedKey({ show, t }: { show: boolean; t: Dict }) {
  if (!show) return null;
  return <p className="err">{t.needKey}</p>;
}
