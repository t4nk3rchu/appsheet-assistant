# AppSheet Copilot

An open-source, cross-browser (Firefox 142+ / Chrome) extension that adds an AI
assistant to the **AppSheet editor**. It drives the editor UI to apply
**structural** changes the AppSheet API can't — new columns, views, actions,
slices, format rules — from a validated JSON **changeset**, optionally generated
for you by an AI provider (bring your own key). Nothing is saved until you click
**Save** in AppSheet.

> Originally a port of *Assistant for AppSheet* by Hoadata —
> https://www.hocappsheet.online. This is an independent, from-scratch rebuild —
> it does not reuse the original project's name, icons, or store copy. Licensed
> under the MIT License (see [`LICENSE`](./LICENSE)).

## What it can change

It replays an ordered `{"changes":[…]}` changeset into the editor, validating
every name against the live app first. Supported ops:

- **Columns** — `set_column` (type, App formula, Valid If, Show/Editable/Require/Reset,
  Enum/EnumList base-type Ref, and any type-specific property) and `add_virtual_column`.
- **Table settings** — `set_table` (security filter, "are updates allowed").
- **Views** — `add_view`/`set_view` for all 11 view types, including:
  - **dashboards** (embed other views via `viewEntries`),
  - **charts** (`chartType` + `chartColumns`, filtered by chart type),
  - **table column show/hide** (`columnOrder` + `viewColumns`),
  - Sort by / Group by, and any other view property via the `properties` escape-hatch.
- **Slices** — `add_slice`/`set_slice` (Row filter condition).
- **Actions** — `add_action`/`set_action` (all action types incl. COMPOSITE/grouped,
  SET_COLUMN_VALUE assignments, REF_ACTION, navigation).
- **Format rules** — `add_format_rule`/`set_format_rule`.
- **Bots / Automation** — `add_bot` with a **data-change** event (`table`, `condition`,
  `dataChangeType`) or a **scheduled** event (frequency + time/day/week/timezone,
  optional **For Each Row In Table**), plus process steps:
  - **Run a task** — email (`to`/`cc`/`bcc`/`subject`/`body`, `Reply To`, `From` name,
    …), notification (title/body/deep-link), or webhook (url/verb/contentType/body/headers).
  - **Run a data action** — an existing action, or a custom run-action-on-rows.

**Idempotent re-runs.** Running the same changeset twice does not create duplicates:
`add_view` / `add_action` / `add_slice` / `add_format_rule` **upsert** (open the
existing same-named item and update it in place); `add_virtual_column` and `add_bot`
**skip** if the name already exists (use `set_column` to update a virtual column).

The full changeset format (per-op fields, examples) is documented in
[`instruction.md`](./instruction.md) in this repo (mirrored into the
[AppSheet Architect skill](https://github.com/t4nk3rchu/appsheet-architect)'s
`references/extension-changeset.md`).

## Icons

The icons in [`public/icons/`](./public/icons) (`icon48.png`, `icon128.png`) are a
magic-wand-and-sparkles mark on an AppSheet-green rounded square, generated from
an SVG (see the project's icon SVG). They live under `public/` because Vite copies
that directory verbatim into the build output root, so the manifest's relative
`icons/icon48.png` references resolve.

## Tech stack

- TypeScript
- [Vite](https://vitejs.dev/) + [`vite-plugin-web-extension`](https://github.com/aklinker1/vite-plugin-web-extension)
- React
- [`webextension-polyfill`](https://github.com/mozilla/webextension-polyfill) (all extension API access goes through `browser.*`)
- [`fflate`](https://github.com/101arrowz/fflate) for reading uploaded `.zip` skill packages (no `eval`)
- [Vitest](https://vitest.dev/) for unit tests
- [`web-ext`](https://github.com/mozilla/web-ext) for linting/packaging

## Building

One source tree, two targets, selected via the `TARGET` environment variable:

```bash
npm install

# Firefox (dev server / watch build via web-ext)
npm run dev

# Production builds
npm run build:firefox
npm run build:chrome

# Lint the built extension (Firefox output)
npm run lint:ext
```

> **Windows note:** the `dev`/`build:*` scripts set `TARGET` inline
> (`TARGET=firefox vite`), which works in POSIX shells (bash, zsh, Git Bash, WSL).
> On native `cmd.exe`/PowerShell, run them via **Git Bash**/WSL, or set the
> variable first (e.g. `$env:TARGET="firefox"; npx vite` in PowerShell).

## Testing

```bash
npm test          # vitest run
npx tsc --noEmit  # type-check
```

## Packaging for Firefox Add-ons (AMO)

```bash
npm run build:firefox
npx web-ext build -s dist -a web-ext-artifacts --overwrite-dest   # -> submittable zip
```

Because the code is bundled/minified, AMO requires source + build instructions on
review — point reviewers at this repo and the build steps above. The manifest
sets `strict_min_version: 142` (the floor for `data_collection_permissions` on
Firefox/Android) and declares that the optional AI feature transmits app structure
to the provider you configure.

## Providers

The extension supports four providers. Switch between them in Settings → Provider.

### Session providers (no API key)

These drive your **already-logged-in browser tab** — no API key required.

#### Claude (claude.ai session)

Uses your claude.ai subscription. Settings → Provider → **Claude** → Auth → **Sign in (claude.ai session)**.

- Optional: if you have the [AppSheet Architect skill](https://github.com/t4nk3rchu/appsheet-architect) installed on claude.ai, tick "I have the AppSheet Architect skill" and enter its name — the extension sends `/<skillName> <prompt>` instead of injecting the full spec each time.
- Without the skill: the extension injects the AppSheet schema primer on the first message of each app conversation and reuses it for the rest of the session.

#### Gemini (Gemini Gem session)

Uses a **Gem** you create on [gemini.google.com](https://gemini.google.com). The Gem holds the AppSheet instructions; the extension never re-injects them. Settings → Provider → **Gemini** → Auth → **Sign in (gemini.google.com Gem)** → paste the Gem URL.

1. Create a Gem at gemini.google.com with the [AppSheet Architect instructions](https://github.com/t4nk3rchu/appsheet-architect) as its system prompt.
2. Paste the Gem URL (e.g. `https://gemini.google.com/gem/<id>`) in Settings.

### Per-app sessions and the Link button

When using a session provider, each AppSheet app gets its own dedicated
conversation thread. The **Link** button (header, session mode only) connects
the current app:

1. Detects the open AppSheet editor app (ID + name + schema).
2. Finds or reuses an existing conversation for this app (stored by `provider:appId`).
3. Sends the schema once; all subsequent requests in that session skip re-priming.

App switches are detected automatically (browser tab activate / page load) — the
extension reconnects to the right conversation without pressing Link again, as long
as the browser tab with the session site is still open.

### API-key providers (bring your own key)

- **Google Gemini** (`:generateContent`) — key from [Google AI Studio](https://aistudio.google.com/app/apikey).
- **DeepSeek** (OpenAI-compatible `chat/completions`) — key from the [DeepSeek platform](https://platform.deepseek.com/).
- **Claude API** — Anthropic Messages API key from [console.anthropic.com](https://console.anthropic.com). Select Provider → Claude → Auth → API key.

Enter the key in Settings → API key.

### Local models (Ollama / LM Studio)

Each API provider's base URL is user-configurable. Point the DeepSeek adapter at any OpenAI-compatible local server:

- Ollama: `http://localhost:11434/v1`
- LM Studio: `http://localhost:1234/v1`

## Safety contract

The assistant never auto-saves. Every change is user-confirmed via an explicit
**Apply** click, and a config backup is written to `browser.storage.local` before
any write is applied. It edits **structure only** — never row data.

## License

MIT — see [`LICENSE`](./LICENSE).
