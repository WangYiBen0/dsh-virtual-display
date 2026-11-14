# dsh-virtual-display

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that gives the agent a
**private display** to render and screenshot on, so it never has to grab your desktop.

## Why

When an agent needs to see what a window *actually* looks like, the obvious move is to screenshot
your screen — or worse, open a window on your live `wayland-1` session and capture that. Both steal
your focus and interrupt whatever you were doing.

This plugin provides one tool, `virtual_display`, that boots a display nobody else is using,
renders into it, and returns the frame as an image attachment. Your session is never touched.

## The tool

| `action` | What it does |
|---|---|
| `inspect` | Report which platforms and gears actually work **on this host**, before committing to one |
| `start` | Boot a display, optionally launching a page or program. Returns a session id |
| `capture` | Render an image from a session, returned as a viewable attachment |
| `view` | Report the exact commands a human can run to watch this session live |
| `stop` | Tear a session down |

Plus `platform` (`x11` / `wayland` / `windows` / `macos`), `gear` (`direct` / `container` / `vm`),
`width`, `height`, `target`, `args`, `argv`, `waitMs`, `settleMs`, `capturePath`, and `keep`.

Reuse a `sessionId` across several `capture` calls when iterating on one window; each `start`
allocates a fresh display.

## Isolation gears

| Gear | Mechanism |
|---|---|
| `direct` | Renders on this host's own stack, but on a private display |
| `container` | Runs the renderer in a disposable podman/docker container |
| `vm` | Boots a disposable qcow2 overlay via qemu |

`inspect` probes the host and returns `platforms` / `gears` support plus the live session it
deliberately avoided — so a caller can see, up front, that `vm` is unavailable on a machine with no
`/dev/kvm`.

### How the live session is walled off

`src/session.js` builds every child environment from `privateBaseEnv()`, and a renderer can only
reach the allocated display. Three things are needed, and the plugin does all three:

1. **Drop the live pointers.** `DISPLAY`, `WAYLAND_DISPLAY`, `WAYLAND_SOCKET`, `XAUTHORITY`,
   `XDG_SESSION_TYPE`, `XDG_CURRENT_DESKTOP`, and `DESKTOP_SESSION` are deleted.
2. **Kill the fallback.** Deleting `WAYLAND_DISPLAY` is *not* enough on its own: libwayland then
   connects to `$XDG_RUNTIME_DIR/wayland-0`, which is usually your compositor. `XDG_RUNTIME_DIR` is
   therefore rewritten to the session-private directory, which contains no `wayland-0` to find.
3. **Pin the toolkits.** GTK, Qt, SDL, and Electron each pick a backend from their own variable
   before they ever look at `DISPLAY`, so `GDK_BACKEND=x11`, `QT_QPA_PLATFORM=xcb`,
   `SDL_VIDEODRIVER=x11`, `ELECTRON_OZONE_PLATFORM_HINT=x11`, and `CLUTTER_BACKEND=x11` are set —
   except on a genuine nested Wayland compositor, where clients must stay on Wayland.

A caller cannot reach your session even by passing an explicit `argv`. `.scratch/safety-test.mjs`
asserts all three properties, including that a caller-supplied `DISPLAY` cannot smuggle it back in.

## Requirements

Verified against:

- **X11** — `Xvfb` + ImageMagick `import`
- **Wayland** — a headless compositor (`sway`, then `mutter`, then `gamescope`/`kwin_wayland`),
  falling back to `xwayland` mode when none can start
- **Windows** — PowerShell + .NET GDI+ `CopyFromScreen`
- **macOS** — `screencapture -x -o -l <windowId>`

Executables are resolved through the harness, then `PATH`, then the profile binaries, then the Nix
store — matched by **package name**, never by a store hash. Earlier revisions baked absolute
`/nix/store/…` paths from one probe; every hash had since been garbage-collected, so the fallbacks
silently resolved to nothing. `inspect` reports `driver` for each platform so a wrong resolution is
visible rather than mysterious.

Wayland capture needs a compositor that implements `wlr-screencopy`. **sway qualifies; mutter does
not** — mutter starts fine headless on a GPU-less host (it logs *"Created surfaceless renderer
without GPU"*) but grim against it fails with *"compositor doesn't support the screen capture
protocol"*. sway is therefore tried first. Neither `gamescope --backend headless` nor
`kwin_wayland --virtual` works without a GPU here; they are kept as later attempts, and the
Xwayland fallback keeps the platform usable regardless.

On hosts without a GPU, chromium may auto-select its Wayland ozone backend and never create an X
window. This plugin passes `--ozone-platform=x11` explicitly; see
[docs/ENVIRONMENT-PROBE.md](docs/ENVIRONMENT-PROBE.md) for the full probe and the
`drm_render_node_path_finder.cc:40` symptom that identifies it.

## Install

```sh
dsh plugin install /absolute/path/to/dsh-virtual-display
```

Then configure under `runtimeRoot` / `defaultWidth` / `defaultHeight` if the defaults don't suit.

## Layout

```
index.js                  plugin entry: name, inject, Config, apply
cordis.patch.yml          bundle patch inserted into the profile
src/tool.js               the virtual_display tool + VirtualDisplayManager
src/session.js            session lifecycle, private env, paint-polling capture
src/capabilities.js       host probing, platform/gear selection
src/gears.js              direct / container / vm
src/display-number.js     display allocation (:90-:199) with socket + lock checks
src/exec.js               executable resolution (harness -> PATH -> profile -> nix name match)
src/backends/             x11, wayland, windows, macos
```

## Tests

```sh
node .scratch/smoke.mjs          # X11 E2E: Xvfb -> chromium -> real pixels
node .scratch/wayland-test.mjs   # Wayland E2E: headless compositor -> grim -> real pixels
node .scratch/view-test.mjs      # `view` recipes point at the private session, not yours
node .scratch/manager-test.mjs   # manager E2E: inspect/start/capture/stop/dispose
node .scratch/safety-test.mjs    # env scrubbing: no live display can be reached
```

Each asserts on real captured pixels or real environment properties, not just exit codes.
`safety-test.mjs` needs nothing installed and is the cheapest regression guard for the plugin's
core promise.

## License

MIT

## Gear notes

| Gear | Support | Why it may not work in your environment |
|------|---------|--------------------------------------|
| `direct` | ✅ Supported | Uses the host's own compositor. Works on any system with a compositor (Xvfb, niri, etc.). |
| `container` | ✅ Supported | Requires podman or docker to start a container with a writable runtime directory. Your `/run/user/1001` is **read‑only**, so the container runtime directory cannot be created. You can try: <br>• `export XDG_RUNTIME_DIR=/tmp/xdg-runtime` (set a writable path before starting) <br>• or use a dedicated user with a writable `/run/user/<uid>` |
| `vm` | ❌ Not supported | Requires `/dev/kvm` (or qemu‑tcg) and a qcow2 overlay. This host has no `/dev/kvm` and no qemu binaries configured for this profile. The VM gear is therefore marked **supported** but **unusable** on this host. |

If you need a VM‑style display, you can instead use `container` with a custom writable runtime directory or use a remote VM and point `virtual_display` at its X11/Wayland socket via the `target` argument.
