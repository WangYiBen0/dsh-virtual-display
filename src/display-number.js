// Pick a free X display number.
//
// We cannot rely on /tmp/.X11-unix alone (a crashed server can leave a stale
// socket) nor on /tmp/.X{N}-lock alone (Xvfb may run with -nolock semantics on
// some builds). Check both, then probe upward.

import { existsSync } from 'node:fs'
import { run, sleep } from './exec.js'

const LOW = 90
const HIGH = 199

function inUse(n) {
  return existsSync(`/tmp/.X11-unix/X${n}`) || existsSync(`/tmp/.X${n}-lock`)
}

/** Cheap allocation: first number whose socket and lock are both absent. */
export async function allocateDisplayNumber(_ctx) {
  for (let n = LOW; n <= HIGH; n += 1) {
    if (!inUse(n)) return n
  }
  throw new Error(`no free X display number in :${LOW}-:${HIGH}`)
}

/**
 * Robust allocation: verify the candidate by connecting with xdpyinfo, so a
 * stale socket from a dead server does not hand us a broken display.
 */
export async function allocateVerifiedDisplayNumber(ctx, opts = {}) {
  const probe = opts.xdpyinfo
  for (let n = LOW; n <= HIGH; n += 1) {
    if (inUse(n)) continue
    if (probe === undefined) return n
    try {
      const result = await run(ctx, [probe], {
        env: { ...opts.env, DISPLAY: `:${n}` },
        maxBytes: 4096,
      })
      // exit 0 means something IS listening on a socket we thought free.
      if (result.exitCode === 0) continue
    } catch {
      return n
    }
    return n
  }
  throw new Error(`no free X display number in :${LOW}-:${HIGH}`)
}

/** Wait until /tmp/.X11-unix/XN appears, for callers that need the socket path. */
export async function waitForSocket(display, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(`/tmp/.X11-unix/X${display}`)) return true
    await sleep(100)
  }
  return false
}
