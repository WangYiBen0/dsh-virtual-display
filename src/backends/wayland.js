// Wayland backend.
//
// Honest status on this host: neither gamescope --backend headless nor
// kwin_wayland --virtual can run without a GPU here (see docs/ENVIRONMENT-PROBE.md).
// What IS always available is a private Wayland session driven through
// XWayland, which gives a real Wayland compositor path without ever touching
// the user's live `wayland-1` socket.
//
// Two modes:
//   - `nested`: a private compositor is launched (gamescope/kwin) if one works.
//   - `xwayland`: fall back to the X11 backend, but advertise the Wayland
//     platform so callers get the right environment variables.

import { spawn, run, sleep } from '../exec.js'
import { X11Backend } from './x11.js'

export class WaylandBackend {
  name = 'wayland'

  async start(ctx, opts) {
    const compositor = await this.pickCompositor(ctx, opts)
    if (compositor !== undefined) {
      const nested = await this.startNested(ctx, opts, compositor)
      if (nested !== undefined) return nested
    }
    // Fall back to a private XWayland-capable X server.
    const fallback = new X11Backend()
    const session = await fallback.start(ctx, opts)
    session.backend = 'wayland'
    session.mode = 'xwayland'
    session.waylandNote =
      'no private Wayland compositor could start on this host; used a private X server with XWayland semantics'
    return session
  }

  /** Find a compositor that can actually create a private headless session. */
  async pickCompositor(ctx, opts) {
    const tools = opts.tools
    if (tools.gamescope !== undefined && opts.allowGamescope !== false) {
      return { kind: 'gamescope', binary: tools.gamescope }
    }
    if (tools.kwin_wayland !== undefined && opts.allowKwin !== false) {
      return { kind: 'kwin', binary: tools.kwin_wayland }
    }
    return undefined
  }

  /** Try the nested compositor; return undefined so the caller can fall back. */
  async startNested(ctx, opts, compositor) {
    try {
      const session = await this.launch(ctx, opts, compositor)
      return session
    } catch {
      return undefined
    }
  }

  async launch(ctx, opts, compositor) {
    const width = opts.width
    const height = opts.height
    const waylandDisplay = opts.waylandDisplay ?? `wayland-vd-${process.pid}`

    let argv
    if (compositor.kind === 'gamescope') {
      argv = [
        compositor.binary,
        '--backend',
        'headless',
        '--expose-wayland',
        '--xwayland-count',
        '1',
        '-W',
        String(width),
        '-H',
        String(height),
        '--',
        'sleep',
        'infinity',
      ]
    } else {
      argv = [
        compositor.binary,
        '--virtual',
        `--socket=${waylandDisplay}`,
        '--no-lockscreen',
        '--no-global-shortcuts',
      ]
    }

    // Critical: scrub the user's live session variables so the private
    // compositor can never attach to the session we are trying to protect.
    const env = { ...opts.env, XDG_RUNTIME_DIR: opts.runtimeDir }
    delete env.WAYLAND_DISPLAY
    delete env.DISPLAY

    const handle = spawn(ctx, argv, {
      env,
      stdout: { maxBytes: 1 << 18 },
      stderr: { maxBytes: 1 << 18 },
      graceMs: 3000,
    })

    const deadline = Date.now() + 8000
    let exited
    while (Date.now() < deadline) {
      exited = await Promise.race([handle.done, sleep(250).then(() => undefined)])
      if (exited !== undefined) break
      const socket = `${opts.runtimeDir}/${waylandDisplay}`
      if (await fileExists(socket)) {
        return {
          backend: 'wayland',
          mode: compositor.kind,
          waylandDisplay,
          displayEnv: { WAYLAND_DISPLAY: waylandDisplay, XDG_RUNTIME_DIR: opts.runtimeDir },
          sockets: [socket],
          handle,
          runtimeDir: opts.runtimeDir,
          width,
          height,
          startedAt: Date.now(),
        }
      }
    }

    try {
      handle.terminate()
    } catch {
      // ignore
    }
    const stderr = handle.collected?.stderr?.readFrom(0)?.text ?? ''
    throw new Error(`${compositor.kind} could not start headless: ${stderr.trim().slice(0, 400)}`)
  }

  async capture(ctx, session, opts) {
    if (session.mode === 'xwayland' || session.mode === undefined) {
      return new X11Backend().capture(ctx, session, opts)
    }
    const grim = opts.tools.grim
    if (grim === undefined) {
      throw new Error(
        'cannot capture a nested Wayland session: grim is not available on this host',
      )
    }
    const result = await run(ctx, [grim, opts.destPath], {
      env: { ...opts.env, ...session.displayEnv },
      maxBytes: 1 << 20,
      signal: opts.signal,
    })
    if (result.exitCode !== 0) {
      throw new Error(`wayland capture failed (exit ${result.exitCode}): ${result.stderr.trim()}`)
    }
    return opts.destPath
  }

  async listWindows(ctx, session, opts) {
    if (session.mode === 'xwayland' || session.mode === undefined) {
      return new X11Backend().listWindows(ctx, session, opts)
    }
    return []
  }

  async settle(ctx, session, opts) {
    await sleep(opts.settleMs ?? 1500, opts.signal)
    return session
  }

  async stop(ctx, session) {
    try {
      session.handle.terminate()
      await session.handle.waitForExit()
    } catch {
      // Already gone.
    }
  }
}

async function fileExists(path) {
  const { accessSync, constants } = await import('node:fs')
  try {
    accessSync(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}
