// Session lifecycle: acquire a display, drive a renderer, capture, tear down.
//
// This is the single place that guarantees the user's session is untouched:
// every backend starts from an environment with WAYLAND_DISPLAY and DISPLAY
// *removed*, and only a private display is added back.

import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { X11Backend } from './backends/x11.js'
import { WaylandBackend } from './backends/wayland.js'
import { WindowsBackend } from './backends/windows.js'
import { MacBackend } from './backends/macos.js'
import { createGear } from './gears.js'
import { inspectCapabilities } from './capabilities.js'
import { resolveAll, run } from './exec.js'

const BACKENDS = {
  x11: () => new X11Backend(),
  wayland: () => new WaylandBackend(),
  windows: () => new WindowsBackend(),
  macos: () => new MacBackend(),
}

const TOOL_NAMES = [
  'Xvfb',
  'import',
  'magick',
  'identify',
  'xwd',
  'xwininfo',
  'xdpyinfo',
  'xprop',
  'Xwayland',
  'waylandInfo',
  'chromium',
  'grim',
  'mutter',
  'sway',
  'swaymsg',
  'gamescope',
  'kwin_wayland',
  'niri',
  'podman',
  'docker',
  'qemu-system-x86_64',
]

/**
 * Toolkits that can silently attach to the *user's* compositor.
 *
 * Removing WAYLAND_DISPLAY is not enough on its own: libwayland then falls back
 * to `$XDG_RUNTIME_DIR/wayland-0`, which is usually exactly the session we are
 * trying to protect. GTK/Qt/SDL/Electron also pick their backend from these
 * variables before they ever look at DISPLAY. So each toolkit is pinned to X11
 * explicitly, and XDG_RUNTIME_DIR is rewritten to the session-private directory
 * (which contains no `wayland-0` socket to fall back to).
 */
const TOOLKIT_X11 = {
  GDK_BACKEND: 'x11',
  QT_QPA_PLATFORM: 'xcb',
  SDL_VIDEODRIVER: 'x11',
  ELECTRON_OZONE_PLATFORM_HINT: 'x11',
  CLUTTER_BACKEND: 'x11',
  XDG_SESSION_TYPE: 'x11',
}

/** Session variables that point at the user's live display. */
const LIVE_SESSION_VARS = [
  'DISPLAY',
  'WAYLAND_DISPLAY',
  'WAYLAND_SOCKET',
  'XAUTHORITY',
  // Not a display variable itself, but the *base* every Wayland client falls
  // back to when WAYLAND_DISPLAY is unset: libwayland would then connect to
  // $XDG_RUNTIME_DIR/wayland-0, i.e. the user's own compositor. Every backend
  // and gear re-points this at the session-private directory before spawning.
  'XDG_RUNTIME_DIR',
  'XDG_SESSION_TYPE',
  'XDG_CURRENT_DESKTOP',
  'DESKTOP_SESSION',
  'GDK_BACKEND',
  'QT_QPA_PLATFORM',
  'SDL_VIDEODRIVER',
  'ELECTRON_OZONE_PLATFORM_HINT',
  'CLUTTER_BACKEND',
]

/**
 * The scoped environment every renderer starts from. Stripping the live
 * session variables here is what stops an agent from screenshotting the
 * user's desktop.
 *
 * @param extra - Extra variables merged over the host environment first.
 * @param options.runtimeDir - Session-private XDG_RUNTIME_DIR to install.
 * @param options.pin - 'x11' forces every GUI toolkit onto the X11 backend.
 *   Omit when the display genuinely is a private Wayland compositor, or
 *   Wayland-native clients would be forced off it.
 */
export function privateBaseEnv(extra = {}, options = {}) {
  const env = { ...process.env, ...extra }
  for (const name of LIVE_SESSION_VARS) delete env[name]
  if (options.runtimeDir !== undefined) env.XDG_RUNTIME_DIR = options.runtimeDir
  if (options.pin === 'x11') Object.assign(env, TOOLKIT_X11)
  return env
}

/**
 * Cheap "has the renderer painted yet" check.
 *
 * A blank virtual display produces a PNG with a single distinct colour, so
 * counting unique colours is a reliable, rendering-agnostic paint signal.
 * Falls back to a byte-size heuristic when ImageMagick is unavailable.
 */
async function frameSignature(tools, ctx, path, env) {
  const identify = tools.identify ?? tools.magick
  if (identify !== undefined) {
    const args =
      tools.identify !== undefined
        ? [tools.identify, '-format', '%k', path]
        : [tools.magick, 'identify', '-format', '%k', path]
    try {
      const result = await run(ctx, args, { env, maxBytes: 4096 })
      const parsed = Number.parseInt(result.stdout.trim(), 10)
      if (Number.isFinite(parsed)) return { distinctColors: parsed, path }
    } catch {
      // fall through to the size heuristic
    }
  }
  try {
    const { statSync } = await import('node:fs')
    const bytes = statSync(path).size
    return { distinctColors: bytes > 4000 ? 2 : 1, path, bytes }
  } catch {
    return { distinctColors: 0, path }
  }
}

export class VirtualDisplaySession {
  constructor(ctx, options) {
    this.ctx = ctx
    this.options = options
    this.state = 'created'
    // `backend` is the backend *driver* (has start/capture/settle).
    // `display` is the live display struct the driver returned. Keeping them
    // distinct is what makes capture() able to call methods at all.
    this.backend = undefined
    this.display = undefined
    this.gear = undefined
    this.runtimeDir = options.runtimeDir
    this.captures = []
  }

  async acquire() {
    const { ctx, options } = this
    this.state = 'acquiring'
    mkdirSync(this.runtimeDir, { recursive: true, mode: 0o700 })

    const tools = await resolveAll(ctx, TOOL_NAMES)
    const backend = BACKENDS[options.platform]()
    // Display servers themselves must not inherit the user's live session, but
    // they are the thing that *creates* the private display — so they get the
    // scrubbed environment without a toolkit pin (a compositor that must nest
    // inside another one still needs to see that parent's WAYLAND_DISPLAY,
    // which the backend adds back deliberately).
    const env = privateBaseEnv(options.env)

    this.backend = backend
    this.display = await backend.start(ctx, {
      ...options,
      tools,
      env,
      runtimeDir: this.runtimeDir,
    })
    this.tools = tools

    this.gear = await createGear(options.gear).prepare(ctx, {
      env,
      displayEnv: this.display.displayEnv,
      runtimeDir: this.runtimeDir,
      runtime: tools.podman ?? tools.docker,
      qemu: tools['qemu-system-x86_64'],
      image: options.image,
      baseImage: options.baseImage,
      acceleration: options.acceleration,
      memory: options.memory,
      cpus: options.cpus,
      vncPort: options.vncPort,
    })

    this.state = 'ready'
    return this
  }

  /** Environment a renderer should inherit to land on the private display. */
  renderEnv() {
    return {
      ...privateBaseEnv(this.options.env, {
        runtimeDir: this.runtimeDir,
        pin: this.pinsToX11() ? 'x11' : undefined,
      }),
      ...this.display.displayEnv,
    }
  }

  /**
   * Whether renderers on this display must be pinned to the X11 backend.
   *
   * True for the X11 backend and for the Wayland backend's `xwayland` fallback
   * (whose display *is* an X server). A genuinely nested Wayland compositor
   * keeps the toolkit defaults, so Wayland-native clients can still connect.
   */
  pinsToX11() {
    const backend = this.display?.backend
    return backend === 'x11' || (backend === 'wayland' && this.display?.mode === 'xwayland')
  }

  /** Launch a renderer (a URL, a binary, or an argv) on the private display. */
  async launch(spec = {}) {
    const { ctx } = this
    this.assertReady()
    const argv = this.buildArgv(spec)
    if (argv.length === 0) return undefined

    const wrapped = this.gear.wrap(argv, { env: this.renderEnv(), cwd: spec.cwd })
    if (wrapped.mode === 'serial') return wrapped

    await this.gear.ensure?.()
    const handle = ctx.subprocess.spawn({
      argv: wrapped.argv,
      cwd: wrapped.cwd,
      env: wrapped.env,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: 1 << 20 },
        stderr: { maxBytes: 1 << 20 },
      },
      graceMs: 4000,
    })
    this.launched = handle
    return handle
  }

  /** Turn a high-level target into a concrete argv for the chosen platform. */
  buildArgv(spec) {
    if (Array.isArray(spec.argv)) return spec.argv
    const target = spec.url ?? spec.target ?? spec.command
    if (target === undefined) return []
    const chromium = this.tools?.chromium
    if (spec.kind === 'url' || /^https?:|^data:|^file:/.test(target)) {
      if (chromium === undefined) throw new Error('no browser is available to render this URL')
      return [
        chromium,
        '--no-sandbox',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-dev-shm-usage',
        // REQUIRED: without an explicit X11 ozone platform chromium selects
        // Wayland and creates no X window at all, so the capture stays black.
        '--ozone-platform=x11',
        `--user-data-dir=${join(this.runtimeDir, 'profile')}`,
        `--window-size=${this.options.width},${this.options.height}`,
        '--window-position=0,0',
        '--hide-scrollbars',
        ...(spec.browserArgs ?? []),
        target,
      ]
    }
    return [target, ...(spec.args ?? [])]
  }

  /** Produce a capture, waiting for the display to actually have content. */
  async capture(options = {}) {
    const { ctx } = this
    this.assertReady()
    const dest = options.destPath ?? join(this.runtimeDir, `capture-${Date.now()}.png`)

    await this.backend.settle(ctx, this.display, {
      settleMs: options.settleMs ?? this.options.settleMs,
      signal: options.signal,
    })

    // Wait for the renderer to actually paint.
    //
    // Chromium maps its X windows early but paints the page several seconds
    // later. Polling for *window existence* is therefore not enough: it exits
    // on the first iteration and grabs a frame that is still blank. Poll for
    // *pixel variety* instead (the frame must stop being a single flat colour),
    // and keep a separate patience budget purely for that.
    const deadline = Date.now() + (options.waitMs ?? 30000)
    const minPaintMs = options.minPaintMs ?? 2500
    const startedAt = Date.now()
    let windows = []
    let painted = false
    let lastSignature

    while (Date.now() < deadline) {
      windows = await this.backend.listWindows(ctx, this.display, {
        tools: this.tools,
        env: this.renderEnv(),
      })

      const probePath = join(this.runtimeDir, '.probe.png')
      try {
        await this.backend.capture(ctx, this.display, {
          destPath: probePath,
          tools: this.tools,
          env: this.renderEnv(),
          signal: options.signal,
        })
        lastSignature = await frameSignature(this.tools, ctx, probePath, this.renderEnv())
        if (lastSignature.distinctColors > 1) {
          painted = true
          break
        }
      } catch {
        // Capture can fail transiently while the server is still warming up.
      }

      // Even a "painted" flat page needs a floor, otherwise we can beat the
      // compositor to the very first frame.
      if (Date.now() - startedAt > minPaintMs && windows.length === 0) break
      await new Promise((r) => setTimeout(r, 500))
    }

    if (!painted) {
      this.windowWarning = windows.length === 0
        ? 'no mapped window appeared on the private display before capture'
        : `the frame stayed a single flat colour (${lastSignature?.distinctColors ?? 0} distinct colours)`
    }

    await this.backend.capture(ctx, this.display, {
      destPath: dest,
      tools: this.tools,
      env: this.renderEnv(),
      signal: options.signal,
    })

    this.captures.push(dest)
    return { path: dest, windows }
  }

  describe() {
    return {
      platform: this.options.platform,
      gear: this.options.gear,
      backend: this.display?.backend,
      mode: this.display?.mode,
      display: this.display?.display,
      waylandDisplay: this.display?.waylandDisplay,
      runtimeDir: this.runtimeDir,
      width: this.options.width,
      height: this.options.height,
      displayEnv: this.display?.displayEnv ?? {},
      sockets: this.display?.sockets ?? [],
      warning: this.windowWarning ?? this.display?.waylandNote,
    }
  }

  /**
   * How the user can look at this display themselves, right now.
   *
   * The plugin deliberately ships no streaming server: `capture` returns a
   * still frame. But an agent iterating on a GUI config ("why is my bar laid
   * out wrong?") is far more useful when the human can watch, so this reports
   * the exact commands that would attach a viewer to *this* session. Nothing is
   * executed — it is a recipe built from the live socket paths.
   */
  viewHints() {
    const env = this.display?.displayEnv ?? {}
    const exports = Object.entries(env)
      .map(([k, v]) => `${k}=${v}`)
      .join(' ')

    if (this.display?.backend === 'x11' || this.display?.mode === 'xwayland') {
      return {
        kind: 'x11',
        env,
        stillCapture: `${exports} import -window root shot.png`,
        liveViewer: `${exports} x11vnc -display ${this.display.display} -localhost -nopw -forever`,
        note: 'a still frame needs ImageMagick; a live viewer needs x11vnc',
      }
    }

    const captureTool = this.tools?.grim === undefined ? 'a screencopy client (grim)' : 'grim'
    return {
      kind: 'wayland',
      env,
      stillCapture: `${exports} ${captureTool} shot.png`,
      liveViewer: `${exports} wayvnc 127.0.0.1 5900`,
      note: 'Wayland viewing needs a screencopy-capable compositor; sway qualifies, mutter does not',
    }
  }

  assertReady() {
    if (this.state !== 'ready') throw new Error(`virtual display is not ready (state=${this.state})`)
  }

  async release() {
    if (this.state === 'released') return
    this.state = 'releasing'
    try {
      this.launched?.terminate()
      await this.launched?.waitForExit().catch(() => undefined)
    } catch {
      // ignore
    }
    try {
      await this.gear?.teardown()
    } catch {
      // ignore
    }
    try {
      await this.backend?.stop(this.ctx, this.display)
    } catch {
      // ignore
    }
    if (this.options.keepRuntimeDir !== true) {
      try {
        rmSync(this.runtimeDir, { recursive: true, force: true })
      } catch {
        // The sandbox may hold the directory; leaving it is harmless.
      }
    }
    this.state = 'released'
  }
}

export { inspectCapabilities }
