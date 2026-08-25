// src/popup/App.tsx — settings form, reused both as the options page and
// inside the sidebar (see src/sidebar/Sidebar.tsx).
import { useEffect, useState } from "react";
import browser from "webextension-polyfill";
import { getSettings, saveSettings, type Settings } from "../lib/storage";
import { PROVIDERS } from "../lib/providers";

export function App() {
  const [s, setS] = useState<Settings | null>(null);
  useEffect(() => { getSettings().then(setS); }, []);
  if (!s) return null;
  const patch = (p: Partial<Settings>) => { const next = { ...s, ...p }; setS(next); saveSettings(p); };

  return (
    <div style={{ padding: 16, font: "14px Roboto, sans-serif" }}>
      <label>Provider{" "}
        <select value={s.provider} onChange={(e) => patch({ provider: e.target.value as any })}>
          {Object.values(PROVIDERS).map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
          <option value="claude">Claude (claude.ai)</option>
        </select>
      </label>
      {s.provider === "claude" ? (
        <>
          <label>Claude auth{" "}
            <select value={s.claudeAuthMode} onChange={(e) => patch({ claudeAuthMode: e.target.value as any })}>
              <option value="session">Sign in (claude.ai session)</option>
              <option value="api">API key (Anthropic)</option>
            </select>
          </label>
          {s.claudeAuthMode === "session" ? (
            <p style={{ fontSize: 12, opacity: 0.7 }}>
              Uses your logged-in claude.ai session — no API key.{" "}
              <button type="button" onClick={() => browser.runtime.sendMessage({ __hoc: "claude-signin" })}>
                Sign in to claude.ai
              </button>
            </p>
          ) : (
            <label>Anthropic API key{" "}
              <input type="password" value={s.apiKeys.claude ?? ""}
                onChange={(e) => patch({ apiKeys: { ...s.apiKeys, claude: e.target.value } })} />
            </label>
          )}
        </>
      ) : (
        <>
          <label>API key{" "}
            <input type="password" value={s.apiKeys[s.provider] ?? ""}
              onChange={(e) => patch({ apiKeys: { ...s.apiKeys, [s.provider]: e.target.value } })} />
          </label>
          <label>Base URL (optional - e.g. local Ollama){" "}
            <input value={s.baseUrls[s.provider] ?? ""}
              onChange={(e) => patch({ baseUrls: { ...s.baseUrls, [s.provider]: e.target.value } })} />
          </label>
        </>
      )}
      <label>Claude skill source{" "}
        <select value={s.claudeSkillSource} onChange={(e) => patch({ claudeSkillSource: e.target.value as any })}>
          <option value="primer">Inject spec (no setup)</option>
          <option value="account">Uploaded skill (by name)</option>
        </select>
      </label>
      {s.claudeSkillSource === "account" && (
        <label>Skill name{" "}
          <input value={s.claudeSkillName}
            onChange={(e) => patch({ claudeSkillName: e.target.value })} />
        </label>
      )}
      <label>
        <input type="checkbox" checked={s.darkMode}
          onChange={(e) => patch({ darkMode: e.target.checked })} /> Dark mode
      </label>
      <p style={{ fontSize: 12, opacity: 0.7, marginTop: 12 }}>
        Originally a port of "Assistant for AppSheet" by Hoadata.
      </p>
    </div>
  );
}
