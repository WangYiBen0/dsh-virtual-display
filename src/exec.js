// Executable resolution + process helpers shared by every backend.
//
// The plugin never hardcodes an absolute interpreter path: it asks the harness
// `subprocess` service to resolve a command on PATH first, and only then falls
// back to the well-known locations discovered during the environment probe.

import { accessSync, constants } from 'node:fs'

/** Well-known absolute fallbacks, used only if PATH resolution fails. */
export const KNOWN = {
  Xvfb: ['/nix/store/pg7d981bvshg7dv3ncq1dr2k9l60795m-xvfb-21.1.24/bin/Xvfb'],
  import: ['/nix/store/8v793n92zi6apwmazy23gqhc8raszg6p-imagemagick-7.1.2-34/bin/import'],
  magick: ['/nix/store/8v793n92zi6apwmazy23gqhc8raszg6p-imagemagick-7.1.2-34/bin/magick'],
  identify: ['/nix/store/8v793n92zi6apwmazy23gqhc8raszg6p-imagemagick-7.1.2-34/bin/identify'],
  xwd: ['/nix/store/sri5ylclw5pdjzi591ppcm66j9bmihqx-xwd-1.0.10/bin/xwd'],
  xwininfo: ['/nix/store/yazjxi185xinbzrs9kwgg3fvlkga91mj-xwininfo-1.1.6/bin/xwininfo'],
  xdpyinfo: ['/nix/store/bdybhrvih3v9lr1plkqlf3lgnqz8w603-xdpyinfo-1.4.0/bin/xdpyinfo'],
  xprop: ['/nix/store/aambn0gkn2dmk9vfkq6dzzcwnd7wf4yn-xprop-1.2.8/bin/xprop'],
  Xwayland: ['/run/current-system/sw/bin/Xwayland'],
  waylandInfo: ['/run/current-system/sw/bin/wayland-info'],
  chromium: ['/run/current-system/sw/bin/chromium'],
  grim: [],
  slurp: [],
}

function isExecutable(p) {
  try {
    accessSync(p, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Resolve one command name to an absolute path.
 * Order: harness resolveExecutable -> PATH scan -> KNOWN fallbacks.
 */
export async function resolveCommand(ctx, command) {
  try {
    const resolved = await ctx.subprocess.resolveExecutable(command)
    if (resolved !== undefined && resolved !== null && resolved !== '') return resolved
  } catch {
    // resolveExecutable throws when the command is absent; fall through.
  }
  const paths = (process.env.PATH ?? '').split(':').filter(Boolean)
  for (const dir of paths) {
    const candidate = `${dir}/${command}`
    if (isExecutable(candidate)) return candidate
  }
  for (const candidate of KNOWN[command] ?? []) {
    if (isExecutable(candidate)) return candidate
  }
  return undefined
}

/** Resolve many commands at once; returns { name: path|undefined }. */
export async function resolveAll(ctx, commands) {
  const entries = await Promise.all(
    commands.map(async (command) => [command, await resolveCommand(ctx, command)]),
  )
  return Object.fromEntries(entries)
}

/** Collect a spawned handle to completion and return its output. */
export async function collect(handle) {
  const outcome = await handle.done
  return {
    exitCode: outcome.exitCode,
    signal: outcome.signal,
    stdout: handle.collected?.stdout?.readFrom(0)?.text ?? '',
    stderr: handle.collected?.stderr?.readFrom(0)?.text ?? '',
  }
}

/**
 * Run a command, collect its output, and optionally abort it on `signal`.
 * `env` additions are merged over the terminal environment.
 */
export async function run(ctx, argv, opts = {}) {
  const stdio = {
    stdin: 'ignore',
    stdout: { maxBytes: opts.maxBytes ?? 1 << 20 },
    stderr: { maxBytes: opts.maxBytes ?? 1 << 20 },
  }
  const handle = ctx.subprocess.spawn({
    argv,
    cwd: opts.cwd,
    env: opts.env,
    stdio,
    graceMs: opts.graceMs ?? 3000,
    signal: opts.signal,
  })
  return collect(handle)
}

/** Spawn without waiting; the caller owns the handle. */
export function spawn(ctx, argv, opts = {}) {
  return ctx.subprocess.spawn({
    argv,
    cwd: opts.cwd,
    env: opts.env,
    stdio: {
      stdin: 'ignore',
      stdout: opts.stdout ?? { maxBytes: 1 << 20 },
      stderr: opts.stderr ?? { maxBytes: 1 << 20 },
    },
    graceMs: opts.graceMs ?? 3000,
    signal: opts.signal,
  })
}

export const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(new Error('aborted'))
      },
      { once: true },
    )
  })
