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

The full changeset format (per-op fields, examples) is documented in the
[AppSheet Architect skill](https://github.com/t4nk3rchu/appsheet-architect)'s
`references/extension-changeset.md`.

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

**v1 ships with two providers (bring your own key):**

- **Google Gemini** (`:generateContent`) — key from [Google AI Studio](https://aistudio.google.com/app/apikey).
- **DeepSeek** (OpenAI-compatible `chat/completions`) — key from the [DeepSeek platform](https://platform.deepseek.com/).

Enter the key(s) in the extension's options page.

### Local models (Ollama / LM Studio)

Each provider's base URL is user-configurable. Point the DeepSeek adapter's base
URL at any OpenAI-compatible local server:

- Ollama: `http://localhost:11434/v1`
- LM Studio: `http://localhost:1234/v1`

## Safety contract

The assistant never auto-saves. Every change is user-confirmed via an explicit
**Apply** click, and a config backup is written to `browser.storage.local` before
any write is applied. It edits **structure only** — never row data.

## License

MIT — see [`LICENSE`](./LICENSE).
