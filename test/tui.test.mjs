// Structural check of the TUI adapter against dsh-tui's extension contract.
//
// The scene needs a live TUI process and a graphics-capable terminal, so this
// verifies what is checkable offline: registration shape, command semantics,
// origin resolution, and — the bug that shipped once — that no service is read
// outside `ctx.inject`.
//
// Run: node .scratch/tui-test.mjs
import { readFileSync } from 'node:fs'
import { applyTui } from '../tui.js'

// The adapter logs its activation path for real TUI debugging; drop only those
// lines so the test's own output stays readable.
const realLog = console.log
console.log = (...args) => {
  if (typeof args[0] === 'string' && args[0].startsWith('[dsh-virtual-display]')) return
  realLog(...args)
}

let failures = 0
const check = (label, ok, detail) => {
  if (ok) { console.log('ok:', label); return }
  failures += 1
  console.error('FAIL:', label, detail ?? '')
}

/**
 * A cordis-shaped context that enforces the inject rule.
 *
 * Real cordis throws `cannot get property "<name>" without inject` on a bare
 * read of an undeclared service. This stub reproduces that, so a regression
 * fails here instead of in a user's terminal.
 */
function makeCtx({ withScenes = true, withCommands = true, withWeb = false, port = undefined } = {}) {
  const scenes = []
  const commands = []
  const services = {}
  if (withScenes) {
    services.tuiScenes = {
      register: (descriptor) => { scenes.push(descriptor); return () => {} },
      open: (id) => scenes.some((s) => s.id === id),
    }
  }
  if (withCommands) {
    services.commands = { register: (definition) => { commands.push(definition); return () => {} } }
  }
  if (withWeb) {
    services.webServer = {
      port,
      getOrigin: () => {
        if (port === undefined) throw new Error('not listening')
        return `http://127.0.0.1:${port}`
      },
    }
  }

  /** Build a context proxy that only exposes declared services. */
  const makeScope = (declared) => {
    const scope = {
      effect: (fn) => { fn(); return () => {} },
      inject: (names, fn) => {
        const ready = names.every((n) => services[n] !== undefined)
        if (ready) fn(makeScope([...declared, ...names]))
      },
      reflect: { get: (name) => services[name] },
    }
    return new Proxy(scope, {
      get(target, prop) {
        if (prop in target) return target[prop]
        if (typeof prop !== 'string') return undefined
        if (!declared.includes(prop)) {
          throw new Error(`cannot get property "${prop}" without inject`)
        }
        return services[prop]
      },
    })
  }

  return { ctx: makeScope([]), scenes, commands, services }
}

// --- registration ---
{
  const { ctx, scenes, commands } = makeCtx({ withWeb: true, port: 41234 })
  let threw
  try { applyTui(ctx) } catch (error) { threw = error }
  check('applies without reading an undeclared service', threw === undefined, threw?.message)

  check('registers one scene', scenes.length === 1, String(scenes.length))
  check('scene id is kebab-case', /^[a-z][a-z0-9_-]*$/.test(scenes[0]?.id ?? ''), scenes[0]?.id)
  check('scene id is virtual-display', scenes[0]?.id === 'virtual-display', scenes[0]?.id)
  check('scene has a component', typeof scenes[0]?.component === 'function')
  check('scene has a title', typeof scenes[0]?.title === 'string')

  check('registers one command', commands.length === 1, String(commands.length))
  check('command is named display', commands[0]?.name === 'display', commands[0]?.name)
  check('command uses `handler`, not execute', typeof commands[0]?.handler === 'function')
  check('command has no `execute` field', commands[0]?.execute === undefined)
}

// --- command opens the scene when a carrier is listening ---
{
  const { ctx, commands } = makeCtx({ withWeb: true, port: 41234 })
  applyTui(ctx)
  // The stub throws if the handler reads an undeclared service, so this also
  // proves `scope.tuiScenes` is declared where it is used.
  let result
  let threw
  try { result = await commands[0].handler({ rawInput: '' }) } catch (error) { threw = error }
  check('handler runs without an undeclared read', threw === undefined, threw?.message)
  check('handler returns a result object', typeof result === 'object' && result !== null)
  check('handler returns success', result?.kind === 'success', JSON.stringify(result))
  check('success text is empty (conversation untouched)', result?.text === '')
}

// --- no carrier: refuse with a reason instead of opening a dead scene ---
{
  const { ctx, commands } = makeCtx({ withWeb: false })
  applyTui(ctx)
  const result = await commands[0].handler({ rawInput: '' })
  check('no carrier returns an error', result?.kind === 'error', JSON.stringify(result))
  check('error names the cause', /web carrier|webserver|unreachable/i.test(result?.text ?? ''), result?.text)
}

// --- static: the command's inject list covers everything it reads ---
{
  const source = readFileSync(new URL('../tui.js', import.meta.url), 'utf8')
  const commandBlock = source.slice(source.indexOf("tui.inject(['commands'"))
  const injectList = /tui\.inject\(\[([^\]]*)\]/.exec(source.slice(source.indexOf("tui.inject(['commands'")))?.[1] ?? ''
  const handlerBody = commandBlock.slice(0, commandBlock.indexOf('})'))
  // `effect`/`inject`/`on` are cordis context methods, not injectable services.
  const CTX_METHODS = new Set(['effect', 'inject', 'on', 'get', 'emit', 'reflect'])
  const reads = [...handlerBody.matchAll(/scope\.([a-zA-Z_][\w]*)/g)]
    .map((m) => m[1])
    .filter((name) => !CTX_METHODS.has(name))
  const undeclared = [...new Set(reads)].filter((name) => !injectList.includes(`'${name}'`))
  check('command inject list covers every scope.* read it performs', undeclared.length === 0,
    `read: ${[...new Set(reads)].join(', ')} | declared: ${injectList.trim()}`)
}

// --- explicit origin wins (and avoids needing webServer at all) ---
// This path also reaches `scope.tuiScenes.open(...)`, so it proves the handler
// declares the services it reads rather than only the registration callback.
{
  const { ctx, commands } = makeCtx({ withWeb: false })
  applyTui(ctx, { origin: 'http://127.0.0.1:3080' })
  let result
  let threw
  try { result = await commands[0].handler({ rawInput: '' }) } catch (error) { threw = error }
  check('handler opens the scene without an undeclared read', threw === undefined, threw?.message)
  check('explicit origin still succeeds', result?.kind === 'success', JSON.stringify(result))
}

// --- no tuiScenes: silent no-op, and nothing may be read ---
{
  const { ctx, commands } = makeCtx({ withScenes: false })
  let threw
  try { applyTui(ctx) } catch (error) { threw = error }
  check('no tuiScenes does not throw', threw === undefined, threw?.message)
  check('no tuiScenes registers no command', commands.length === 0, String(commands.length))
}

// --- no commands service: scene still registers, command does not ---
{
  const { ctx, scenes, commands } = makeCtx({ withCommands: false, withWeb: true, port: 1 })
  let threw
  try { applyTui(ctx) } catch (error) { threw = error }
  check('missing commands does not throw', threw === undefined, threw?.message)
  check('scene registers without commands', scenes.length === 1, String(scenes.length))
  check('no command registered without commands', commands.length === 0, String(commands.length))
}

console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`)
process.exitCode = failures ? 1 : 0
