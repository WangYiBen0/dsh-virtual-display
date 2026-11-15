# dsh-virtual-display

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that gives the agent a
**private display** to render, drive, and screenshot on, so it never has to grab your desktop.

Three capabilities, each usable on its own:

- **A private display** — boot it, render into it, capture real pixels.
- **Synthetic input** — type, click, and scroll into what was rendered, so an agent can operate a
  GUI instead of only photographing it.
- **A live panel** — watch the display from the composer, and click into it yourself.
- **Silent audio** — each session's sound goes to its own sink, never to your speakers.

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
| `input` | Inject text, key chords, clicks, moves, and scrolls into a session |
| `view` | Report the exact commands a human can run to watch this session live |
| `stop` | Tear a session down |

Plus `platform` (`x11` / `wayland` / `windows` / `macos`), `gear` (`direct` / `container` / `vm`),
`width`, `height`, `target`, `args`, `argv`, `input`, `captureAfter`, `waitMs`, `settleMs`,
`capturePath`, and `keep`.

Reuse a `sessionId` across several `capture` calls when iterating on one window; each `start`
allocates a fresh display.

### Driving the display

`input` accepts one event at a time:

```jsonc
{ "kind": "text",   "text": "hello" }          // type
{ "kind": "key",    "key": "ctrl+c" }          // a key or chord
{ "kind": "click",  "x": 131, "y": 180 }       // left/middle/right
{ "kind": "scroll", "direction": "down", "amount": 3 }
```

Coordinates are **display pixels**, the same space a `capture` image uses — read a position off a
frame and click it, no rescaling. `captureAfter: true` returns a fresh frame in the same call.

Underneath: `xdotool` (XTEST) on X11, `wtype` + `wlrctl` on Wayland, PowerShell on Windows,
`osascript` on macOS. Two quirks are handled because they silently break injection otherwise:

- Without a window manager nothing holds focus, so keys go to the root window and vanish. The
  injector focuses the top window (X11) or asks sway to focus its child (Wayland) first.
- `wtype` installs its virtual-keyboard keymap asynchronously but starts typing immediately, so
  **every** invocation loses its first character unless given `-s`. That delay is required for
  correctness, not tuning.

Pointer injection on a headless wlroots compositor is a known limitation: the seat reports
`capabilities: 0` and exposes no pointer device, so clicks do not register there. Keyboard works,
because `wtype` creates its own virtual keyboard.

### The live panel

A composer-dock decoration polls one PNG from `/virtual-display/frame` and posts clicks back to
`/virtual-display/input`. Clicking the frame sends a click at that point, rescaled by
`naturalWidth/clientWidth` so it lands where you clicked even when the frame is displayed smaller
than the display it came from.

The routes live on the harness's own web server, so the panel shares the origin the page already
trusts and no extra port is opened. Set `webPanel: false` to not register them at all.

### Silent audio

Each session creates a PipeWire null sink (`dsh-vd-<id>`) and routes its renderer into it, so audio
is mixed into a device nobody hears. `audio: inherit` restores audible playback; on a host without
PipeWire the session reports `mode: unavailable` rather than failing to start.

Measured here, not assumed: `PIPEWIRE_NODE` is what actually routes a stream; `PULSE_SINK` was
ignored by `pw-play`, which linked straight to the real speakers. Both are set, but only the former
carries the behaviour. The plugin also **verifies the sink exists** before claiming isolation —
`pw-cli` exits 0 while creating nothing, and an earlier build duly reported isolated audio that was
still audible.

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
node .scratch/smoke.mjs             # X11 E2E: Xvfb -> chromium -> real pixels
node .scratch/wayland-test.mjs      # Wayland E2E: headless compositor -> grim -> real pixels
node .scratch/input-test.mjs        # X11 E2E: type + click reach a real page
node .scratch/wayland-input-test.mjs # Wayland E2E: wtype reaches a real page
node .scratch/panel-test.mjs        # panel routes over a real HTTP listener
node .scratch/audio-test.mjs        # audio lands in the session sink, not the speakers
node .scratch/view-test.mjs         # `view` recipes point at the private session, not yours
node .scratch/manager-test.mjs      # manager E2E: inspect/start/capture/stop/dispose
node .scratch/safety-test.mjs       # env scrubbing: no live display can be reached
```

Each asserts on real captured pixels, real HTTP responses, real PipeWire links, or real environment
properties — never merely on an exit code. That distinction is not pedantry: `pw-cli` exits 0 while
creating nothing, so an exit-code test would have reported working audio isolation that did not
exist.

`safety-test.mjs` needs nothing installed and is the cheapest regression guard for the plugin's core
promise.

**Audio tests must never make noise.** They play only digitally silent (all-zero) PCM, so a routing
regression stays inaudible instead of beeping at whoever is sitting at the machine. Do not add an
audible tone to a test.

## License

MIT

## Gear notes

| Gear | Support | Why it may not work in your environment |
|------|---------|--------------------------------------|
| `direct` | ✅ Supported | Uses the host's own compositor. Works on any system with a compositor (Xvfb, niri, etc.). |
| `container` | ✅ Supported | Requires podman or docker to start a container with a writable runtime directory. Your `/run/user/1001` is **read‑only**, so the container runtime directory cannot be created. You can try: <br>• `export XDG_RUNTIME_DIR=/tmp/xdg-runtime` (set a writable path before starting) <br>• or use a dedicated user with a writable `/run/user/<uid>` |
| `vm` | ❌ Not supported | Requires `/dev/kvm` (or qemu‑tcg) and a qcow2 overlay. This host has no `/dev/kvm` and no qemu binaries configured for this profile. The VM gear is therefore marked **supported** but **unusable** on this host. |

If you need a VM‑style display, you can instead use `container` with a custom writable runtime directory or use a remote VM and point `virtual_display` at its X11/Wayland socket via the `target` argument.
