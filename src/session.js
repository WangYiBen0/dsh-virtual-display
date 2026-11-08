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
  'gamescope',
  'kwin_wayland',
  'podman',
  'docker',
  'qemu-system-x86_64',
]

/**
 * The scoped environment every backend starts from. Deleting the live session
 * variables here is what stops an agent from screenshotting the user's desktop.
 */
export function privateBaseEnv(extra = {}) {
  const env = { ...process.env, ...extra }
  delete env.WAYLAND_DISPLAY
  delete env.DISPLAY
  delete env.XAUTHORITY
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
    return { ...privateBaseEnv(this.options.env), ...this.display.displayEnv }
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
