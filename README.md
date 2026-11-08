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

`src/session.js` builds the child environment from `privateBaseEnv()`, which **deletes
`DISPLAY`, `WAYLAND_DISPLAY`, and `XAUTHORITY`**. Every renderer is launched against the allocated
display only. A caller cannot reach your session even by passing an explicit `argv`.

## Requirements

Verified against:

- **X11** — `Xvfb` + ImageMagick `import`
- **Wayland** — nested compositor, falling back to `xwayland` mode
- **Windows** — PowerShell + .NET GDI+ `CopyFromScreen`
- **macOS** — `screencapture -x -o -l <windowId>`

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
src/exec.js               executable resolution with a nix-store path map
src/backends/             x11, wayland, windows, macos
```

## Tests

```sh
node .scratch/smoke.mjs          # engine E2E, stub subprocess
node .scratch/manager-test.mjs   # manager E2E: inspect/start/capture/stop/dispose
```

Both assert on real captured pixels, not just exit codes.

## License

MIT
