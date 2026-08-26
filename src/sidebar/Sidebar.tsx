// src/sidebar/Sidebar.tsx — sidebar shell: header (brand, language, theme,
// settings), the tool tab strip, the active tool, and a footer. Owns the
// settings/theme/language state and shares it down to the tabs.
import { useCallback, useEffect, useRef, useState } from "react";
import browser from "webextension-polyfill";
import { getSettings, saveSettings, getSkills, saveSkills, type Settings } from "../lib/storage";
import { parseSkill, parseSkillZip, type Skill } from "../lib/skills";
import { getTables, getSchema, type Table } from "../lib/appsheet";
import { primeApp } from "../lib/claude-gen";
import { PROVIDERS } from "../lib/providers";
import { dict } from "./i18n";
import type { Dict } from "./i18n";
import { BuildApp, Formula, Explain, Fix, AskAI, SetType, About } from "./tabs";

const TABS = [
  { id: "build", label: "tab_build", C: BuildApp },
  { id: "formula", label: "tab_formula", C: Formula },
  { id: "explain", label: "tab_explain", C: Explain },
  { id: "fix", label: "tab_fix", C: Fix },
  { id: "ask", label: "tab_ask", C: AskAI },
  { id: "types", label: "tab_types", C: SetType },
  { id: "contact", label: "tab_contact", C: About },
] as const;

function useSettings(): [Settings | null, (p: Partial<Settings>) => void] {
  const [s, setS] = useState<Settings | null>(null);
  useEffect(() => { getSettings().then(setS); }, []);
  const patch = (p: Partial<Settings>) => {
    setS((prev) => (prev ? { ...prev, ...p } : prev));
    saveSettings(p);
  };
  return [s, patch];
}

// Claude auth: session (claude.ai sign-in + live status) or Anthropic API key.
function ClaudeAuthFields({ s, patch, t }: { s: Settings; patch: (p: Partial<Settings>) => void; t: Dict }) {
  const [status, setStatus] = useState<"unknown" | "in" | "out" | "checking">("unknown");
  const check = useCallback(async () => {
    setStatus("checking");
    try {
      const res: any = await browser.runtime.sendMessage({ __hoc: "claude-status" });
      setStatus(res?.signedIn ? "in" : "out");
    } catch {
      setStatus("unknown");
    }
  }, []);
  useEffect(() => { if (s.claudeAuthMode === "session") check(); }, [s.claudeAuthMode, check]);
  const signin = async () => {
    await browser.runtime.sendMessage({ __hoc: "claude-signin" });
    setTimeout(check, 1500);
  };
  const statusText = status === "in" ? t.set_status_in : status === "out" ? t.set_status_out
    : status === "checking" ? t.set_status_checking : t.set_status_unknown;
  return (
    <>
      <div className="field">
        <label>{t.set_claudeMode}</label>
        <select value={s.claudeAuthMode} onChange={(e) => patch({ claudeAuthMode: e.target.value as any })}>
          <option value="session">{t.set_claudeMode_session}</option>
          <option value="api">{t.set_claudeMode_api}</option>
        </select>
      </div>
      {s.claudeAuthMode === "session" ? (
        <>
          <div className="field">
            <div className="row" style={{ gap: 6, alignItems: "center" }}>
              <button className="btn" onClick={signin}>{t.set_signin}</button>
              <button className="btn" onClick={check} disabled={status === "checking"}>{t.set_status_check}</button>
              <span className={`status status-${status}`}>{statusText}</span>
            </div>
            <span className="hint">{t.set_claudeSignin}</span>
          </div>
          <label className="row" style={{ gap: 6 }}>
            <input type="checkbox"
              checked={s.claudeSkillSource === "account"}
              onChange={(e) => patch({ claudeSkillSource: e.target.checked ? "account" : "primer" })} />
            {t.set_claudeHasSkill}
          </label>
          {s.claudeSkillSource === "account" && (
            <div className="field" style={{ marginTop: 4 }}>
              <label>{t.set_skillName}</label>
              <input type="text" value={s.claudeSkillName}
                onChange={(e) => patch({ claudeSkillName: e.target.value })} />
            </div>
          )}
        </>
      ) : (
        <>
          <div className="field">
            <label>{t.set_apiKey}</label>
            <input type="password" value={s.apiKeys.claude ?? ""}
              onChange={(e) => patch({ apiKeys: { ...s.apiKeys, claude: e.target.value } })} />
          </div>
          <div className="field">
            <label>{t.set_baseUrl}</label>
            <input type="text" value={s.baseUrls.claude ?? ""}
              onChange={(e) => patch({ baseUrls: { ...s.baseUrls, claude: e.target.value } })} />
          </div>
        </>
      )}
    </>
  );
}

function SettingsPanel({ s, patch, t, skills, onAddSkills, onRemoveSkill }: {
  s: Settings; patch: (p: Partial<Settings>) => void; t: Dict;
  skills: Skill[]; onAddSkills: (ns: Skill[]) => void; onRemoveSkill: (i: number) => void;
}) {
  return (
    <>
      <h2 className="tooltitle">{t.settings}</h2>
      <div className="field">
        <label>{t.set_provider}</label>
        <select value={s.provider} onChange={(e) => patch({ provider: e.target.value as any })}>
          {Object.values(PROVIDERS).map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
          <option value="claude">Claude (claude.ai)</option>
        </select>
      </div>
      {s.provider === "claude" ? (
        <ClaudeAuthFields s={s} patch={patch} t={t} />
      ) : (
        <>
          <div className="field">
            <label>{t.set_apiKey}</label>
            <input type="password" value={s.apiKeys[s.provider] ?? ""}
              onChange={(e) => patch({ apiKeys: { ...s.apiKeys, [s.provider]: e.target.value } })} />
          </div>
          <div className="field">
            <label>{t.set_baseUrl}</label>
            <input type="text" value={s.baseUrls[s.provider] ?? ""}
              onChange={(e) => patch({ baseUrls: { ...s.baseUrls, [s.provider]: e.target.value } })} />
          </div>
        </>
      )}
      <label className="row" style={{ gap: 6 }}>
        <input type="checkbox" checked={s.darkMode} onChange={(e) => patch({ darkMode: e.target.checked })} />
        {t.set_dark}
      </label>
      <div className="field">
        <label>{t.set_instructions}</label>
        <textarea rows={6} value={s.buildInstructions} placeholder={t.set_instructions_ph}
          onChange={(e) => patch({ buildInstructions: e.target.value })} />
        <span className="hint">{t.set_instructions_hint}</span>
      </div>
      <div className="field">
        <label>{t.set_skills}</label>
        <span className="hint">{t.set_skills_hint}</span>
        <input type="file" accept=".skill,.md,.markdown,.txt,.zip" multiple
          onChange={async (e) => {
            const files = Array.from(e.target.files || []);
            const parsed = await Promise.all(
              files.map(async (f) =>
                /\.zip$/i.test(f.name) ? parseSkillZip(f.name, await f.arrayBuffer()) : parseSkill(f.name, await f.text()),
              ),
            );
            if (parsed.length) onAddSkills(parsed);
            e.currentTarget.value = "";
          }} />
        {skills.length > 0 && (
          <ul className="skilllist">
            {skills.map((sk, i) => (
              <li key={i}>
                <div>
                  <strong>{sk.name}</strong>
                  <div className="hint">{sk.description || t.set_skills_nodesc}</div>
                </div>
                <button className="iconbtn" title={t.set_skills_remove} onClick={() => onRemoveSkill(i)}>✕</button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

export function Sidebar() {
  const [s, patch] = useSettings();
  const [active, setActive] = useState<(typeof TABS)[number]["id"]>("build");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [tables, setTables] = useState<Table[]>([]);
  const [skills, setSkills] = useState<Skill[]>([]);
  // Per-app Claude session state.
  const [appId, setAppId] = useState<string | null>(null);
  const [appName, setAppName] = useState<string | null>(null);
  const [schemaState, setSchemaState] = useState<"idle" | "checking" | "ok" | "err">("idle");
  const [schemaErr, setSchemaErr] = useState("");
  const lastAppIdRef = useRef<string | null>(null);
  // Lifted Ask AI chat history (survives tab switches).
  const [chatMsgs, setChatMsgs] = useState<import("../lib/prompts").ChatTurn[]>([]);

  useEffect(() => { getSkills().then(setSkills).catch(() => setSkills([])); }, []);
  const addSkills = (ns: Skill[]) => { setSkills((cur) => { const next = [...cur, ...ns]; saveSkills(next); return next; }); };
  const removeSkill = (i: number) => { setSkills((cur) => { const next = cur.filter((_, k) => k !== i); saveSkills(next); return next; }); };

  useEffect(() => {
    if (s) document.documentElement.dataset.theme = s.darkMode ? "dark" : "light";
  }, [s?.darkMode]);

  // Read tables and detect app changes on focus/visibility.
  const refreshTables = useCallback(() => {
    getTables().then(setTables).catch(() => {});
    getSchema().then(({ appId: newId, appName: newName }) => {
      if (!newId || newId === lastAppIdRef.current) return;
      lastAppIdRef.current = newId;
      setAppId(newId);
      setAppName(newName);
      if (s?.provider === "claude" && s?.claudeAuthMode === "session") {
        browser.runtime.sendMessage({ __hoc: "claude-switch-app", appId: newId })
          .then((res: any) => setSchemaState(res?.hasSession ? "ok" : "idle"))
          .catch(() => setSchemaState("idle"));
      }
    }).catch(() => {});
  }, [s?.provider, s?.claudeAuthMode]);

  useEffect(() => {
    refreshTables();
    const onVis = () => { if (document.visibilityState === "visible") refreshTables(); };
    const onTabUpdated = (_: number, info: browser.Tabs.OnUpdatedChangeInfoType) => {
      if (info.status === "complete") refreshTables();
    };
    window.addEventListener("focus", refreshTables);
    document.addEventListener("visibilitychange", onVis);
    browser.tabs.onActivated.addListener(refreshTables);
    browser.tabs.onUpdated.addListener(onTabUpdated);
    return () => {
      window.removeEventListener("focus", refreshTables);
      document.removeEventListener("visibilitychange", onVis);
      browser.tabs.onActivated.removeListener(refreshTables);
      browser.tabs.onUpdated.removeListener(onTabUpdated);
    };
  }, [refreshTables]);

  // Link this app to Claude: find/create a dedicated conversation, send schema.
  const checkSchema = useCallback(async () => {
    setSchemaState("checking");
    setSchemaErr("");
    try {
      const [live, schema] = await Promise.all([
        getTables().catch(() => [] as Table[]),
        getSchema().catch(() => ({ appId: null, appName: null, appTemplate: null })),
      ]);
      if (live.length) setTables(live);
      if (schema.appId) {
        lastAppIdRef.current = schema.appId;
        setAppId(schema.appId);
        setAppName(schema.appName);
      }
      if (s && s.provider === "claude" && s.claudeAuthMode === "session") {
        if (!live.length || !schema.appId) throw new Error("Open the AppSheet editor first.");
        // Only prime if no existing session — avoids opening a new tab unnecessarily.
        const switchRes: any = await browser.runtime.sendMessage({
          __hoc: "claude-switch-app", appId: schema.appId!,
        }).catch(() => null);
        if (!switchRes?.hasSession) {
          await primeApp(schema.appId!, schema.appName ?? schema.appId!, live);
        }
      }
      setSchemaState("ok");
    } catch (e: any) {
      setSchemaErr(String(e?.message ?? e));
      setSchemaState("err");
    }
  }, [s]);

  if (!s) return null;
  const t = dict(s.lang);
  const isClaudeSession = s.provider === "claude" && s.claudeAuthMode === "session";
  const hasKey = s.provider === "claude"
    ? (isClaudeSession ? schemaState === "ok" : !!s.apiKeys.claude?.trim())
    : !!s.apiKeys[s.provider]?.trim();
  const Active = TABS.find((x) => x.id === active)!.C;
  const showChat = active === "ask" && !settingsOpen;

  return (
    <div className="app">
      <header className="hdr">
        <span className="mark" aria-hidden="true"><i /><i /><i /><i /></span>
        <span className="brand">{t.appName}</span>
        <div className="seg" role="group" aria-label={t.language}>
          <button className={s.lang === "vi" ? "on" : ""} onClick={() => patch({ lang: "vi" })}>VI</button>
          <button className={s.lang === "en" ? "on" : ""} onClick={() => patch({ lang: "en" })}>EN</button>
        </div>
        {isClaudeSession && (
          <button
            className={`schema-btn schema-${schemaState}`}
            title={schemaState === "err" ? schemaErr : t.hdr_schema_title}
            disabled={schemaState === "checking"}
            onClick={checkSchema}
          >
            {schemaState === "checking" ? "…" : t.hdr_schema}
          </button>
        )}
        <button className="iconbtn" title={t.theme} onClick={() => patch({ darkMode: !s.darkMode })}>
          {s.darkMode ? "☀" : "☾"}
        </button>
        <button className="iconbtn" title={t.settings} aria-pressed={settingsOpen}
          onClick={() => setSettingsOpen((o) => !o)}>⚙</button>
      </header>

      {isClaudeSession && appName && (
        <div className="app-strip" title={appId ?? ""}>
          {schemaState === "ok" ? "✓ " : ""}{appName}
        </div>
      )}

      <nav className="tabs">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            className={`tab ${!settingsOpen && active === tab.id ? "active" : ""}`}
            onClick={() => { setSettingsOpen(false); setActive(tab.id); refreshTables(); }}
          >
            {t[tab.label]}
          </button>
        ))}
      </nav>

      {settingsOpen ? (
        <main className="body"><SettingsPanel s={s} patch={patch} t={t} skills={skills} onAddSkills={addSkills} onRemoveSkill={removeSkill} /></main>
      ) : showChat ? (
        <AskAI t={t} lang={s.lang} hasKey={hasKey} tables={tables} chatMsgs={chatMsgs} setChatMsgs={setChatMsgs} />
      ) : (
        <main className="body"><Active t={t} lang={s.lang} hasKey={hasKey} tables={tables} instructions={s.buildInstructions} skills={skills} provider={s.provider} /></main>
      )}

      <footer className="footer">{t.footer}</footer>
    </div>
  );
}
