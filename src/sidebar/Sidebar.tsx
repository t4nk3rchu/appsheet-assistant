// src/sidebar/Sidebar.tsx — sidebar shell: header (brand, language, theme,
// settings), the tool tab strip, the active tool, and a footer. Owns the
// settings/theme/language state and shares it down to the tabs.
import { useCallback, useEffect, useState } from "react";
import { getSettings, saveSettings, getSkills, saveSkills, type Settings } from "../lib/storage";
import { parseSkill, parseSkillZip, type Skill } from "../lib/skills";
import { getTables, type Table } from "../lib/appsheet";
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
        // claude.ai uses your logged-in session — no API key. Just sign in.
        <p className="hint">{t.set_claudeSignin}</p>
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
  useEffect(() => { getSkills().then(setSkills).catch(() => setSkills([])); }, []);
  const addSkills = (ns: Skill[]) => { setSkills((cur) => { const next = [...cur, ...ns]; saveSkills(next); return next; }); };
  const removeSkill = (i: number) => { setSkills((cur) => { const next = cur.filter((_, k) => k !== i); saveSkills(next); return next; }); };

  useEffect(() => {
    if (s) document.documentElement.dataset.theme = s.darkMode ? "dark" : "light";
  }, [s?.darkMode]);

  // Read the live table/column list, and REFRESH it whenever the sidebar regains
  // focus or becomes visible — the user may have added/renamed a table in the
  // editor since it was last read. (Previously fetched once on mount, so new
  // tables weren't seen until the sidebar was closed and reopened.)
  const refreshTables = useCallback(() => {
    getTables().then(setTables).catch(() => {});
  }, []);
  useEffect(() => {
    refreshTables();
    const onVis = () => { if (document.visibilityState === "visible") refreshTables(); };
    window.addEventListener("focus", refreshTables);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.removeEventListener("focus", refreshTables);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [refreshTables]);

  if (!s) return null;
  const t = dict(s.lang);
  // "claude" (claude.ai session) needs no API key — readiness is the live login,
  // checked at request time; treat it as ready so the tools are enabled.
  const hasKey = s.provider === "claude" || !!s.apiKeys[s.provider]?.trim();
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
        <button className="iconbtn" title={t.theme} onClick={() => patch({ darkMode: !s.darkMode })}>
          {s.darkMode ? "☀" : "☾"}
        </button>
        <button className="iconbtn" title={t.settings} aria-pressed={settingsOpen}
          onClick={() => setSettingsOpen((o) => !o)}>⚙</button>
      </header>

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
        <AskAI t={t} lang={s.lang} hasKey={hasKey} tables={tables} />
      ) : (
        <main className="body"><Active t={t} lang={s.lang} hasKey={hasKey} tables={tables} instructions={s.buildInstructions} skills={skills} provider={s.provider} /></main>
      )}

      <footer className="footer">{t.footer}</footer>
    </div>
  );
}
