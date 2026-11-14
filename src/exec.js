// Executable resolution + process helpers shared by every backend.
//
// The plugin never hardcodes an absolute interpreter path. It asks the harness
// `subprocess` service first, then scans PATH, then falls back to the profile
// and Nix store locations that actually exist on this machine.
//
// A previous revision hardcoded absolute /nix/store paths recorded from one
// environment probe. Every one of those hashes has since been garbage-collected,
// so the fallbacks silently resolved to nothing and `inspect` reported the host
// as incapable. Package *names* are stable across rebuilds; store hashes are
// not — so we search by name.

import { accessSync, constants, existsSync, readdirSync } from 'node:fs'

/**
 * Which packages can provide a given command.
 *
 * A command is not always named after its package: `Xvfb` ships in
 * `xorg-server`, `magick` in `imagemagick`, `kwin_wayland` in `kwin`. This map
 * is the only host-specific knowledge in the file.
 */
export const PROVIDERS = {
  Xvfb: ['xorg-server'],
  import: ['imagemagick'],
  magick: ['imagemagick'],
  identify: ['imagemagick'],
  xwd: ['xwd', 'xorg-server'],
  xwininfo: ['xwininfo'],
  xdpyinfo: ['xdpyinfo'],
  xprop: ['xprop'],
  Xwayland: ['xwayland'],
  waylandInfo: ['wayland-utils', 'wayland-info'],
  chromium: ['chromium', 'chromium-browser'],
  grim: ['grim'],
  slurp: ['slurp'],
  mutter: ['mutter'],
  gamescope: ['gamescope'],
  kwin_wayland: ['kwin'],
  sway: ['sway'],
  niri: ['niri'],
  ironbar: ['ironbar'],
  xdotool: ['xdotool'],
  podman: ['podman'],
  docker: ['docker'],
  'qemu-system-x86_64': ['qemu'],
  swaymsg: ['sway'],
}

function isExecutable(p) {
  try {
    accessSync(p, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** Directories that hold the user's or the system's current PATH entries. */
function profileBinDirs() {
  const dirs = [
    '/run/current-system/sw/bin',
    '/nix/var/nix/profiles/default/bin',
    `${process.env.HOME ?? ''}/.nix-profile/bin`,
  ]
  try {
    for (const user of readdirSync('/etc/profiles/per-user')) {
      dirs.push(`/etc/profiles/per-user/${user}/bin`)
    }
  } catch {
    // Not a NixOS host, or no per-user profiles. Harmless.
  }
  return dirs.filter((d) => d !== '/bin' && existsSync(d))
}

/**
 * Logical name -> real binary name, where they differ.
 *
 * The plugin addresses tools by a stable camelCase key (`waylandInfo`), but the
 * Nix store exposes the upstream argv name (`wayland-info`). Resolution has to
 * look for the real file.
 */
export const BIN_NAMES = {
  waylandInfo: 'wayland-info',
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Reading /nix/store costs ~50-70ms once; cache it for the process lifetime.
let storeEntries

function nixStoreCandidates(command) {
  if (!existsSync('/nix/store')) return []
  storeEntries ??= readdirSync('/nix/store')
  const bin = BIN_NAMES[command] ?? command
  const providers = PROVIDERS[command] ?? [command]
  const names = providers.map(escapeRegExp).join('|')
  const pattern = new RegExp(`^[a-z0-9]{32}-(${names})-[0-9]`)
  const found = []
  for (const entry of storeEntries) {
    if (!pattern.test(entry)) continue
    found.push(`/nix/store/${entry}/bin/${bin}`)
  }
  return found
}

/**
 * Resolve one command name to an absolute path.
 *
 * Order: harness resolveExecutable -> PATH scan -> profile dirs -> Nix store.
 * Returns undefined when nothing executable was found, so callers can report a
 * missing dependency instead of spawning a broken argv.
 */
export async function resolveCommand(ctx, command) {
  const bin = BIN_NAMES[command] ?? command
  for (const name of [command, bin]) {
    try {
      const resolved = await ctx.subprocess.resolveExecutable(name)
      if (resolved !== undefined && resolved !== null && resolved !== '') return resolved
    } catch {
      // resolveExecutable throws when the command is absent; fall through.
    }
  }

  const searchDirs = [
    ...(process.env.PATH ?? '').split(':').filter(Boolean),
    ...profileBinDirs(),
  ]
  for (const dir of searchDirs) {
    for (const name of new Set([command, bin])) {
      const candidate = `${dir}/${name}`
      if (isExecutable(candidate)) return candidate
    }
  }

  for (const candidate of nixStoreCandidates(command)) {
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
