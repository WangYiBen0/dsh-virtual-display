// Platform + gear capability detection.
//
// Two orthogonal axes, exactly as the user asked:
//   - platform:  x11 | wayland | windows | macos
//   - gear:      direct | container | vm
//
// `direct` renders on the host's own display stack but ON A PRIVATE DISPLAY
// when the platform supports one (Xvfb on X11, a private Wayland compositor on
// Wayland). It never opens a window on the user's live session unless the
// caller explicitly opts into `attach: true`.

import { existsSync } from 'node:fs'
import { resolveAll } from './exec.js'

export const PLATFORMS = ['x11', 'wayland', 'windows', 'macos']
export const GEARS = ['direct', 'container', 'vm']

/** Tools each platform's `direct` gear needs. */
const DIRECT_REQUIREMENTS = {
  x11: ['Xvfb', 'import'],
  wayland: ['waylandInfo'],
  windows: [],
  macos: [],
}

/** Tools each isolation gear needs to be usable at all. */
const GEAR_REQUIREMENTS = {
  direct: [],
  container: ['podman'],
  vm: [],
}

/** Detect the host platform family from the harness terminal environment. */
export async function detectHostPlatform(ctx) {
  let terminal
  try {
    terminal = await ctx.subprocess.terminalEnvironment()
  } catch {
    terminal = undefined
  }
  const kind = terminal?.platform
  if (kind === 'windows') return 'windows'
  // A posix terminal may still be macOS.
  const uname = await ctx.subprocess
    .spawn({
      argv: ['uname', '-s'],
      stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 } },
      graceMs: 2000,
    })
    .done.catch(() => undefined)
  void uname
  return process.platform === 'darwin' ? 'macos' : 'x11'
}

/**
 * Inspect the host and report what each platform/gear combination can do here.
 * This is what makes the tier selector honest instead of aspirational.
 */
export async function inspectCapabilities(ctx) {
  const tools = await resolveAll(ctx, [
    'Xvfb',
    'import',
    'magick',
    'xwd',
    'xwininfo',
    'waylandInfo',
    'Xwayland',
    'chromium',
    'podman',
    'docker',
    'qemu-system-x86_64',
  ])

  const hasDri = existsSync('/dev/dri')
  const hasKvm = existsSync('/dev/kvm')

  const platforms = {}
  for (const platform of PLATFORMS) {
    const needed = DIRECT_REQUIREMENTS[platform] ?? []
    const missing = needed.filter((t) => tools[t] === undefined)
    const hostIs = hostFamily(platform)
    platforms[platform] = {
      supported: missing.length === 0,
      missing,
      // Whether this platform is the one the host itself runs.
      native: hostIs,
      reason:
        missing.length > 0
          ? `missing ${missing.join(', ')}`
          : platform === 'x11' && !hasDri
            ? 'software rendering (no /dev/dri)'
            : undefined,
    }
  }

  const gears = {}
  for (const gear of GEARS) {
    if (gear === 'direct') {
      gears.direct = { supported: true }
      continue
    }
    if (gear === 'container') {
      const runtime = tools.podman ?? tools.docker
      gears.container = runtime
        ? { supported: true, runtime }
        : { supported: false, reason: 'neither podman nor docker is available' }
      continue
    }
    const qemu = tools['qemu-system-x86_64']
    if (qemu === undefined) {
      gears.vm = { supported: false, reason: 'qemu-system-x86_64 is not available' }
    } else if (!hasKvm) {
      gears.vm = { supported: true, acceleration: 'tcg', reason: 'no /dev/kvm; emulation will be slow' }
    } else {
      gears.vm = { supported: true, acceleration: 'kvm' }
    }
  }

  const live = {
    waylandDisplay: process.env.WAYLAND_DISPLAY,
    x11Display: process.env.DISPLAY,
    sessionType: process.env.XDG_SESSION_TYPE,
  }

  return { platforms, gears, tools, hasDri, hasKvm, live }
}

function hostFamily(platform) {
  switch (process.platform) {
    case 'win32':
      return platform === 'windows'
    case 'darwin':
      return platform === 'macos'
    default:
      return platform === 'x11' || platform === 'wayland'
  }
}

/**
 * Pick the platform the caller should get when they did not name one:
 * the host's native family, preferring X11 on Linux because it is the family
 * that can be virtualised privately and deterministically.
 */
export function choosePlatform(caps, requested) {
  if (requested !== undefined) return requested
  if (process.platform === 'win32') return 'windows'
  if (process.platform === 'darwin') return 'macos'
  if (caps.platforms.x11?.supported) return 'x11'
  if (caps.platforms.wayland?.supported) return 'wayland'
  return 'x11'
}

/** Validate a platform/gear pair against the live capabilities. */
export function assertSupported(caps, platform, gear) {
  const p = caps.platforms[platform]
  if (p === undefined) {
    throw new Error(`unknown platform "${platform}"; expected one of: ${PLATFORMS.join(', ')}`)
  }
  if (!p.supported) {
    throw new Error(
      `platform "${platform}" is not available on this host: ${p.reason ?? 'unsupported'}`,
    )
  }
  const g = caps.gears[gear]
  if (g === undefined) {
    throw new Error(`unknown gear "${gear}"; expected one of: ${GEARS.join(', ')}`)
  }
  if (!g.supported) throw new Error(`gear "${gear}" is not available on this host: ${g.reason}`)
}
