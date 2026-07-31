# AppSheet Copilot (Firefox)

An open-source, cross-browser (Firefox 128+ / Chrome) browser extension that
adds an AI assistant to the AppSheet editor: draft columns/views/actions,
check your app's schema, and back up your config before any suggested change
is applied.

> Originally a port of *Assistant for AppSheet* by Hoadata —
> https://www.hocappsheet.online. This is an independent, from-scratch
> rebuild — it does not reuse the original project's name, icons, or store
> copy. Licensed under the MIT License (see [`LICENSE`](./LICENSE)).

## Icons

The icons in [`public/icons/`](./public/icons) (`icon48.png`, `icon128.png`)
are **placeholders** — flat-color PNGs generated programmatically (a small
Node script using only the built-in `zlib` module), not artwork. They live
under `public/` because Vite's build copies that directory's contents
verbatim into the extension output root, which is what lets the manifest's
relative `icons/icon48.png` / `icons/icon128.png` references resolve.
**Replace them with real artwork before any public release / AMO
submission.**

## Tech stack

- TypeScript
- [Vite](https://vitejs.dev/) + [`vite-plugin-web-extension`](https://github.com/aklinker1/vite-plugin-web-extension)
- React
- [`webextension-polyfill`](https://github.com/mozilla/webextension-polyfill) (all extension API access goes through `browser.*`)
- [Vitest](https://vitest.dev/) for unit tests
- [`web-ext`](https://github.com/mozilla/web-ext) for linting/running

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
> (`TARGET=firefox vite`), which works out of the box in POSIX shells (bash,
> zsh, Git Bash, WSL). On native `cmd.exe`/PowerShell without a POSIX shell,
> these scripts will fail because `TARGET=firefox vite` isn't valid syntax
> there — **use Git Bash** (or WSL) to run them, or set the variable
> separately first (e.g. `$env:TARGET="firefox"; npx vite` in PowerShell) if
> you must stay in native PowerShell.

## Testing

```bash
npm test          # vitest run
npx tsc --noEmit  # type-check
```

## Providers

**v1 ships with two providers:**

- **Google Gemini** (`:generateContent`) — get an API key from
  [Google AI Studio](https://aistudio.google.com/app/apikey).
- **DeepSeek** (OpenAI-compatible `chat/completions`) — get an API key from
  the [DeepSeek platform](https://platform.deepseek.com/).

Enter the relevant API key(s) in the extension's options page. Other
providers (OpenAI, Anthropic, local-only presets, etc.) are **future work**
and not part of this v1 release.

### Local models (Ollama / LM Studio)

Each provider's base URL is user-configurable. Point the DeepSeek adapter's
base URL at any OpenAI-compatible local server to use it at no extra cost —
for example:

- Ollama: `http://localhost:11434/v1`
- LM Studio: `http://localhost:1234/v1`

## Safety contract

The assistant never auto-saves. Every suggested change to your AppSheet app
is user-confirmed via an explicit **Apply** click, and a config backup is
written to `browser.storage.local` before any write is applied.

## License

MIT — see [`LICENSE`](./LICENSE).
