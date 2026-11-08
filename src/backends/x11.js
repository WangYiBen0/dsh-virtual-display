// X11 backend: a private Xvfb display.
//
// Verified on this host: Xvfb :N -screen 0 WxHx24 -nolisten tcp -noreset
// creates /tmp/.X11-unix/XN, reports 24-plane TrueColor, root window IsViewable.
//
// IMPORTANT capture lesson: an EMPTY Xvfb root captures as solid black, which
// looks identical to a broken capture. We therefore only ever report a capture
// as valid once the display actually has a mapped, non-trivial window.

import { mkdirSync } from 'node:fs'
import { spawn, run, sleep } from '../exec.js'
import { allocateDisplayNumber } from '../display-number.js'

// Xvfb wants the screen geometry as a single argv token ("800x600x24"), not as
// three separate tokens — passing them separately makes the server exit with
// "Unrecognized option: -screen 0 800x600x24".
const XVFB_ARGS = {
  screen: (w, h, depth) => `${w}x${h}x${depth}`,
  extra: ['-nolisten', 'tcp', '-noreset'],
}

export class X11Backend {
  name = 'x11'

  async start(ctx, opts) {
    const tools = opts.tools
    if (tools.Xvfb === undefined) throw new Error('Xvfb is not available on this host')

    const display = opts.display ?? (await allocateDisplayNumber(ctx))
    const dimension = `${opts.width}x${opts.height}x${opts.depth ?? 24}`

    mkdirSync(opts.runtimeDir, { recursive: true, mode: 0o700 })

    const handle = spawn(
      ctx,
      [
        tools.Xvfb,
        `:${display}`,
        '-screen',
        '0',
        XVFB_ARGS.screen(opts.width, opts.height, opts.depth ?? 24),
        ...XVFB_ARGS.extra,
      ],
      {
        env: { ...opts.env, XDG_RUNTIME_DIR: opts.runtimeDir },
        stdout: { maxBytes: 1 << 18 },
        stderr: { maxBytes: 1 << 18 },
        graceMs: 5000,
      },
    )

    const session = {
      backend: 'x11',
      display,
      displayEnv: { DISPLAY: `:${display}` },
      sockets: [`/tmp/.X11-unix/X${display}`],
      handle,
      runtimeDir: opts.runtimeDir,
      width: opts.width,
      height: opts.height,
      startedAt: Date.now(),
    }

    await this.waitReady(ctx, session, opts)
    return session
  }

  /** Poll xdpyinfo until the server answers, or fail with its stderr. */
  async waitReady(ctx, session, opts) {
    const deadline = Date.now() + (opts.readyTimeoutMs ?? 20000)
    let lastError
    while (Date.now() < deadline) {
      if (session.handle.done !== undefined) {
        const exited = await Promise.race([session.handle.done, sleep(0).then(() => undefined)])
        if (exited !== undefined && exited.exitCode !== 0) {
          const stderr = session.handle.collected?.stderr?.readFrom(0)?.text ?? ''
          throw new Error(`Xvfb failed to start (exit ${exited.exitCode}): ${stderr.trim()}`)
        }
      }
      try {
        const probe = await run(
          ctx,
          [opts.tools.xdpyinfo ?? 'xdpyinfo'],
          {
            env: { ...opts.env, ...session.displayEnv },
            maxBytes: 1 << 20,
          },
        )
        if (probe.exitCode === 0 && probe.stdout.includes('dimensions:')) return
        lastError = probe.stderr.trim()
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error)
      }
      await sleep(250)
    }
    throw new Error(`Xvfb on :${session.display} did not become ready: ${lastError ?? 'timeout'}`)
  }

  /**
   * Capture the root window to `destPath`.
   * `import` is the verified tool here; xwd is a fallback.
   */
  async capture(ctx, session, opts) {
    const env = { ...opts.env, ...session.displayEnv }
    const base = opts.tools.import ?? opts.tools.magick
    if (base === undefined) throw new Error('ImageMagick is not available for X11 capture')

    const args =
      opts.tools.import !== undefined
        ? [opts.tools.import, '-display', `:${session.display}`, '-window', 'root', opts.destPath]
        : [opts.tools.magick, 'import', '-display', `:${session.display}`, '-window', 'root', opts.destPath]

    const result = await run(ctx, args, { env, maxBytes: 1 << 20, signal: opts.signal })
    if (result.exitCode !== 0) {
      throw new Error(`X11 capture failed (exit ${result.exitCode}): ${result.stderr.trim()}`)
    }
    return opts.destPath
  }

  /** Enumerate mapped top-level windows, used to prove the display has content. */
  async listWindows(ctx, session, opts) {
    const binary = opts.tools.xwininfo
    if (binary === undefined) return []
    const result = await run(ctx, [binary, '-root', '-tree'], {
      env: { ...opts.env, ...session.displayEnv },
      maxBytes: 1 << 20,
    })
    if (result.exitCode !== 0) return []
    const windows = []
    for (const line of result.stdout.split('\n')) {
      const match = /^\s+(0x[0-9a-f]+)\s+"?([^"]*)"?:?\s*\(?/.exec(line)
      if (match !== null && match[1] !== '0x0') {
        windows.push({ id: match[1], title: (match[2] ?? '').trim() })
      }
    }
    return windows
  }

  /** Make the display emit a fresh frame before capturing. */
  async settle(ctx, session, opts) {
    await sleep(opts.settleMs ?? 1200, opts.signal)
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
