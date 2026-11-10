# AGENTS.md — dsh-virtual-display

Guidance for AI agents working in this repository.

## What this project is

`dsh-virtual-display` is a [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (Cordis) plugin that exposes a single tool, `virtual_display`. The tool lets an agent render and capture a real UI on a **private** display so it never opens windows on or screenshots the user’s live desktop session.

Core value: answer “what does this actually look like?” without stealing focus or interrupting the human.

## Repository layout

```
index.js                  Plugin entry: exports name, inject, Config (schemastery), apply()
cordis.patch.yml          Bundle patch inserted into a DSH profile
package.json              ESM package; dsh.bundle.patch points to cordis.patch.yml
icon.svg                  Plugin icon
locale/
  en.json, zh.json        Plugin metadata (title/description) for the DSH UI
src/
  tool.js                 virtual_display tool definition + VirtualDisplayManager
  session.js              VirtualDisplaySession lifecycle; private env; paint-polling capture
  capabilities.js         Host probing (inspect), platform/gear selection, support assertions
  gears.js                Isolation gears: direct / container / vm
  display-number.js       X display allocation (:90–:199) with socket + lock checks
  exec.js                 Command resolution (PATH + known fallbacks), run/collect/spawn helpers
  backends/
    x11.js                Xvfb backend (private X server)
    wayland.js            Nested private compositor or xwayland fallback to X11
    windows.js            PowerShell + .NET GDI+ CopyFromScreen
    macos.js              screencapture (-l <windowId> when known)
docs/
  ENVIRONMENT-PROBE.md    Verified host probe notes (flags, paths, symptoms)
.scratch/                 Local experiments/tests (smoke.mjs, manager-test.mjs, logs); not package output
```

## Architecture (mental model)

Two orthogonal axes compose at runtime:

- **Platform** (`x11 | wayland | windows | macos`): what display stack to target.
- **Gear** (`direct | container | vm`): where the renderer runs.
  - `direct`: host stack, but on a private display.
  - `container`: disposable podman/docker container.
  - `vm`: disposable qemu VM with a qcow2 overlay over a base image.

`VirtualDisplayManager` (in `src/tool.js`) owns live sessions and serializes actions (`inspect | start | capture | stop`). `VirtualDisplaySession` (in `src/session.js`) acquires a backend display, prepares a gear, launches a renderer, and captures frames.

## Safety model (do not break this)

The plugin’s primary guarantee is **never touching the user’s live session**.

- `privateBaseEnv()` in `src/session.js` deletes `DISPLAY`, `WAYLAND_DISPLAY`, and `XAUTHORITY` from the child environment. Every renderer is launched only against the allocated private display.
- Backends/launch paths must keep this invariant. Do not pass through live-session display variables, even when accepting explicit `argv`.
- `inspect` reports the live session variables it deliberately avoided; keep that transparency.

## Important implementation notes

- **Plugin config**: `Config` in `index.js` must be a `@deepseek-ai/schemastery` (standard-schema) instance, not a bare JSON Schema literal — the loader validates via `Config['~standard'].validate(...)`.
- **Xvfb argv**: screen geometry is a single token like `800x600x24` (see `src/backends/x11.js`).
- **Chromium on headless/GPU-less hosts**: pass `--ozone-platform=x11` when rendering URLs under X11/Xvfb; otherwise Chromium may select Wayland ozone and create no X window (capture stays black). See `docs/ENVIRONMENT-PROBE.md`.
- **Paint detection**: `session.capture()` polls for pixel variety (distinct colors > 1), not just window existence — Chromium can map windows before painting.
- **Capture result**: `VirtualDisplayManager.capture()` saves the PNG via the attachment store (`ctx.attachments.saveImage`) when available so it renders inline; it still works without an attachment store (file on disk).
- **Numeric bounds in tool schema**: harness value-schema DSL lacks `minimum/maximum`; bounds are documented in descriptions and enforced by `clampNumber()` in `src/tool.js`.
- **Command resolution**: `src/exec.js` resolves executables via harness `subprocess.resolveExecutable`, PATH scan, then `KNOWN` fallbacks. Prefer this over hardcoding paths.

## Development & testing

```sh
# Engine E2E (stub subprocess)
node .scratch/smoke.mjs

# Manager E2E: inspect/start/capture/stop/dispose (asserts on real pixels)
node .scratch/manager-test.mjs
```

Tests live under `.scratch/` in this checkout; they assert on real captured pixels/behavior, not just exit codes. When changing capture, backend, or lifecycle logic, run the relevant scratch tests if the host has the required tools (Xvfb/ImageMagick/chromium).

## Editing guidelines

- Keep changes minimal and consistent with the existing ESM/Node style (no framework churn).
- Preserve the private-display isolation invariant and the tool’s action/parameter semantics (external contract for agents).
- When adding host-specific behavior, make it observable via `inspect`/warnings rather than silent.
- Update `README.md`, `README.zh.md`, and `docs/ENVIRONMENT-PROBE.md` when user-facing behavior or verified host facts change.
- `package.json` `files` controls what ships; include new runtime assets there if needed.

## Commit conventions

All commits MUST follow [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/).

Format:

```
<type>(<optional scope>): <description>

[optional body]

[optional footer(s)]
```

Rules:

- **type** is lowercase and one of: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`.
- **scope** is optional, lowercase, and names the touched area (e.g. `tool`, `session`, `backends`, `gears`, `locale`).
- **description** is imperative, lowercase, no trailing period, ≤ 72 chars.
- Body explains *why*, not *what*; wrap at 72 chars. Use footers for `BREAKING CHANGE:`, `Refs:`, `Closes:`.
- A breaking change is `feat!:` / `fix!:` or a `BREAKING CHANGE:` footer.
- One logical change per commit; do not mix formatting-only churn with behavior changes.
- Never commit `.scratch/`, `node_modules/`, captures, or other local artifacts.

Examples:

```
feat(backends): add xwayland fallback for GPU-less hosts
fix(session): poll pixel variety instead of window existence
docs: document container gear runtime requirements
chore(deps): bump @deepseek-ai/dsh-tools
```

## License

MIT (see `LICENSE`). Copyright (c) 2026 Ran XiangLei.
