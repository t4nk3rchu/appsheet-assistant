// src/manifest.ts
type Target = "firefox" | "chrome";

export function buildManifest(target: Target) {
  const base: any = {
    manifest_version: 3,
    name: target === "firefox" ? "AppSheet Copilot (Firefox)" : "AppSheet Copilot",
    version: "1.0.0",
    description: "AI assistant for the AppSheet editor: build columns/views/actions, check schema, back up config.",
    icons: { "48": "icons/icon48.png", "128": "icons/icon128.png" },
    // No default_popup: clicking the toolbar icon toggles the sidebar / side
    // panel instead (wired in src/background/index.ts).
    action: { default_title: "AppSheet Assistant", default_icon: { "48": "icons/icon48.png" } },
    options_ui: { page: "src/popup/index.html", open_in_tab: true },
    permissions: ["storage"],
    host_permissions: [
      "https://www.appsheet.com/*",
      "https://generativelanguage.googleapis.com/*",
      "https://api.deepseek.com/*",
    ],
    content_scripts: [
      {
        matches: ["https://www.appsheet.com/template/*", "https://www.appsheet.com/Template/*"],
        js: ["src/content/index.ts"],
        run_at: "document_idle",
      },
      {
        matches: ["https://www.appsheet.com/template/*", "https://www.appsheet.com/Template/*"],
        js: ["src/content/bridge.ts"],
        world: "MAIN",
        run_at: "document_idle",
      },
    ],
    web_accessible_resources: [
      { resources: ["icons/*"], matches: ["https://www.appsheet.com/*"] },
    ],
  };

  if (target === "firefox") {
    base.sidebar_action = {
      default_title: "AppSheet Assistant",
      default_panel: "src/sidebar/index.html",
      default_icon: { "48": "icons/icon48.png" },
    };
    // Firefox-native sidebar toggle shortcut — no page-level key interception.
    base.commands = {
      _execute_sidebar_action: {
        suggested_key: { default: "Alt+A" },
        description: "Toggle the AppSheet Assistant sidebar",
      },
    };
    base.background = { scripts: ["src/background/index.ts"] };
    base.browser_specific_settings = {
      gecko: {
        id: "appsheet-copilot@gimasys.com",
        strict_min_version: "128.0",
        // Data-collection disclosure (Firefox 140+). The AI-generation feature
        // (optional, BYOK) transmits the open app's structure + your prompt to
        // the AI provider you configure. Everything else stays on-device.
        // NOTE: verify this matches your intended disclosure in the AMO form.
        data_collection_permissions: { required: ["websiteContent"] },
      },
    };
  } else {
    base.side_panel = { default_path: "src/sidebar/index.html" };
    base.permissions.push("sidePanel");
    base.background = { service_worker: "src/background/index.ts" };
  }
  return base;
}
