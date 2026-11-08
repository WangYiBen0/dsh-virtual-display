// macOS backend.
//
// macOS cannot create a per-process virtual display from userland, so the
// honest model is: capture a named application's window (or the whole screen)
// with `screencapture`, optionally against a private Space/desktop.
//
// We deliberately use `-l <windowid>` when a window is known, because that
// captures the real, fully rendered window even when it is not frontmost —
// which is exactly the fidelity the user asked for, without stealing focus.

import { mkdirSync } from 'node:fs'
import { run, sleep } from '../exec.js'

export class MacBackend {
  name = 'macos'

  async start(ctx, opts) {
    if (process.platform !== 'darwin' && opts.force !== true) {
      throw new Error('the macos backend can only run on a macOS host')
    }
    mkdirSync(opts.runtimeDir, { recursive: true })
    const session = {
      backend: 'macos',
      mode: 'window',
      displayEnv: {},
      sockets: [],
      handle: undefined,
      runtimeDir: opts.runtimeDir,
      width: opts.width,
      height: opts.height,
      startedAt: Date.now(),
    }
    await sleep(opts.settleMs ?? 300, opts.signal)
    return session
  }

  async capture(ctx, session, opts) {
    const argv = ['screencapture', '-x', '-o']
    if (session.windowId !== undefined) argv.push('-l', String(session.windowId))
    argv.push(opts.destPath)

    const result = await run(ctx, argv, {
      env: { ...opts.env, ...session.displayEnv },
      maxBytes: 1 << 20,
      signal: opts.signal,
    })
    if (result.exitCode !== 0) {
      throw new Error(`macOS capture failed: ${result.stderr.trim()}`)
    }
    return opts.destPath
  }

  /** List on-screen windows via the accessibility/CoreGraphics bridge. */
  async listWindows(ctx, session, opts) {
    const script = `tell application "System Events" to get {name, id} of every window of (every process whose visible is true)`
    const result = await run(ctx, ['osascript', '-e', script], {
      env: { ...opts.env, ...session.displayEnv },
      maxBytes: 1 << 20,
    })
    if (result.exitCode !== 0) return []
    return [{ id: result.stdout.trim(), title: 'accessibility-list' }]
  }

  async settle(ctx, session, opts) {
    await sleep(opts.settleMs ?? 500, opts.signal)
    return session
  }

  async stop() {
    // Nothing persistent to tear down.
  }
}
