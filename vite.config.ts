// vite.config.ts
import { defineConfig } from "vite";
import webExtension from "vite-plugin-web-extension";
import { buildManifest } from "./src/manifest";

const target = (process.env.TARGET as "firefox" | "chrome") ?? "firefox";

export default defineConfig({
  plugins: [
    webExtension({
      manifest: () => buildManifest(target),
      browser: target,
      // `target` is required by installed vite-plugin-web-extension@4.5.1's WebExtConfig
      // type (web-ext-option-types' RunOptions declares it non-optional, value-or-undefined).
      // Left undefined so `web-ext run` still auto-detects; only added to satisfy `tsc`.
      webExtConfig: { startUrl: ["https://www.appsheet.com/"], target: undefined },
    }),
  ],
});
