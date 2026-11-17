// Regression test for the lossless-JSON boundary.
//
// The failure this guards against, seen in a real TUI session:
//
//     ToolOutputError: INVALID_TOOL_OUTPUT — tool "virtual_display" returned
//     invalid output: value is not lossless JSON
//
// The harness snapshots every tool result with `snapshotJsonValue`, which —
// unlike `JSON.stringify` — REJECTS a value when an object owns a property
// whose value is `undefined`. Building an object with an unfilled optional
// field therefore fails the whole tool call.
//
// This asserts against the harness's OWN validator when it is resolvable, so
// the test cannot drift from the real rule; `isLossless()` is only a fallback.
//
// Run: node .scratch/lossless-test.mjs
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { spawn as nodeSpawn } from 'node:child_process'
import { join } from 'node:path'
import { isLossless, lossless } from '../src/lossless.js'
import { VirtualDisplayManager } from '../src/tool.js'

let failures = 0
const check = (label, ok, detail) => {
  if (ok) { console.log('ok:', label); return }
  failures += 1
  console.error('FAIL:', label, detail ?? '')
}

/** Load the harness's real validator, or report that we fell back. */
async function loadRealValidator() {
  const candidates = []
  try {
    // The repo's own dependency symlink lives inside the harness tree, so
    // resolving from it reaches the sibling packages without hardcoding a
    // store path.
    const anchor = createRequire(import.meta.url)
    const toolsEntry = anchor.resolve('@deepseek-ai/dsh-tools/package.json')
    const fromTools = createRequire(toolsEntry)
    candidates.push(fromTools.resolve('@deepseek-ai/dsh-util-values'))
  } catch {
    // Fall through to the bare specifier.
  }
  try {
    candidates.push(createRequire(import.meta.url).resolve('@deepseek-ai/dsh-util-values'))
  } catch {
    // Not resolvable here; the caller falls back.
  }
  for (const path of candidates) {
    try {
      const module = await import(pathToFileURL(path).href)
      if (typeof module.snapshotJsonValue === 'function') return module.snapshotJsonValue
    } catch {
      // Try the next candidate.
    }
  }
  return undefined
}

const realValidator = await loadRealValidator()
const usingReal = realValidator !== undefined
console.log(usingReal
  ? 'validator: harness snapshotJsonValue'
  : 'validator: local isLossless fallback (harness module not resolvable)')

/** Would the harness accept this value? */
const accepted = (value) => (usingReal ? realValidator(value) !== undefined : isLossless(value))

// --- 1. The rule itself, including what JSON.stringify hides ----------------
{
  // This is the exact shape that broke the tool: a valid object with one
  // optional field left unfilled.
  const withUndefined = { action: 'start', ok: true, session: { mode: 'sway', audio: undefined } }
  check('an undefined property is rejected before normalization', !accepted(withUndefined))
  check('JSON.stringify would have hidden it (why this is easy to miss)',
    JSON.stringify(withUndefined) === '{"action":"start","ok":true,"session":{"mode":"sway"}}')
  check('lossless() makes it acceptable', accepted(lossless(withUndefined)))
  check('the key is dropped, not nulled', !('audio' in lossless(withUndefined).session))

  check('nested undefined is rejected', !accepted({ a: { b: undefined } }))
  check('nested undefined is normalized', accepted(lossless({ a: { b: undefined } })))
  check('NaN is rejected', !accepted({ a: NaN }))
  check('Infinity is rejected', !accepted({ a: Infinity }))
  check('a sparse array is rejected', !accepted([1, , 3]))
  check('a Date is rejected', !accepted({ a: new Date() }))
  check('a Map is rejected', !accepted({ a: new Map() }))
  check('a class instance is rejected', !accepted({ a: new (class X {})() }))
  check('an array of undefined is rejected', !accepted([undefined]))

  // Arrays keep their length; positions matter for coordinate-style data.
  const normalizedArray = lossless([1, undefined, 3])
  check('array length is preserved', normalizedArray.length === 3, JSON.stringify(normalizedArray))
  check('undefined array element becomes null', normalizedArray[1] === null)
  check('normalized array is acceptable', accepted(normalizedArray))
  check('null survives normalization', lossless({ a: null }).a === null)
  check('0 survives normalization', lossless({ a: 0 }).a === 0)
  check('false survives normalization', lossless({ a: false }).a === false)
  check('empty string survives normalization', lossless({ a: '' }).a === '')
  check('empty object survives normalization', accepted(lossless({ a: {} })))
  check('empty array survives normalization', accepted(lossless({ a: [] })))

  // The local mirror must agree with the harness on ordinary values.
  if (usingReal) {
    const corpus = [
      { a: 1 }, { a: undefined }, { a: NaN }, [1, 2], [1, undefined], null, 'x', 0, -0,
      { a: { b: { c: undefined } } }, [], {},
    ]
    const disagreements = corpus.filter((value) => isLossless(value) !== accepted(value))
    check('isLossless() agrees with the harness validator', disagreements.length === 0,
      JSON.stringify(disagreements))
  }
}

// --- 2. Real manager actions must all be acceptable ------------------------
const ctx = {
  subprocess: {
    async resolveExecutable() { throw new Error('resolve via PATH/store instead') },
    async terminalEnvironment() { return { platform: 'posix' } },
    spawn(spec) {
      const c = nodeSpawn(spec.argv[0], spec.argv.slice(1), { env: spec.env, stdio: ['ignore', 'pipe', 'pipe'] })
      let o = '', e = ''
      c.stdout.on('data', (d) => { o += d })
      c.stderr.on('data', (d) => { e += d })
      const done = new Promise((r) => c.on('close', (code, signal) => r({ exitCode: code ?? 0, signal })))
      return {
        collected: { stdout: { readFrom: () => ({ text: o, nextOffset: o.length }) },
                     stderr: { readFrom: () => ({ text: e, nextOffset: e.length }) } },
        done, terminate: () => c.kill('SIGTERM'), waitForExit: () => done,
      }
    },
  },
}

const manager = new VirtualDisplayManager(ctx, {
  defaultWidth: 320,
  defaultHeight: 240,
  runtimeRoot: new URL('./lossless-run', import.meta.url).pathname,
})

/**
 * Run an action and assert both that it worked and that its value is lossless.
 *
 * The lossless assertion is unconditional — that is the point of this file. The
 * success assertion is skipped, with a printed reason, when the host simply
 * lacks a tool the action needs: a garbage-collected `xdotool` is an
 * environment fact, not a regression.
 */
async function action(label, args, expectOk = true) {
  let value
  try {
    value = await manager.run(args)
  } catch (error) {
    check(`${label} does not throw`, false, error.message)
    return undefined
  }
  // The assertion that matters: the real validator accepts what we returned.
  check(`${label} value is lossless JSON`, accepted(value),
    usingReal ? 'harness snapshotJsonValue rejected it' : JSON.stringify(value).slice(0, 200))
  if (expectOk && value?.ok !== true) {
    if (/is not installed|not available|not resolvable/i.test(String(value?.error))) {
      console.log(`skip: ${label} needs a tool this host lacks — ${value.error}`)
      return value
    }
    check(`${label} succeeded`, false, value?.error)
  }
  return value
}

try {
  await action('inspect', { action: 'inspect' })

  const started = await action('start', { action: 'start', platform: 'x11', gear: 'direct' })
  const sessionId = started?.sessionId

  if (sessionId !== undefined) {
    await action('view', { action: 'view', sessionId })
    await action('input', { action: 'input', sessionId, input: { kind: 'key', key: 'Return' } })
    await action('capture', { action: 'capture', sessionId, keep: true, waitMs: 3000 })
    await action('stop', { action: 'stop', sessionId })
  } else {
    check('session started (later actions skipped)', false, 'no sessionId')
  }

  // Failure path: the error result must also be acceptable.
  await action('unknown action (error path)', { action: 'nope' }, false)
  await action('unknown session (error path)', { action: 'view', sessionId: 'missing' }, false)
} finally {
  await manager.dispose().catch(() => {})
}

console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`)
process.exitCode = failures ? 1 : 0
