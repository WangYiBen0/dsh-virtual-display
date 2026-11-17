// Guards the panel's localization.
//
// Checks the three things that actually break: a dictionary missing a key, a
// placeholder used in one language but not the other, and visible English text
// hardcoded in the component instead of routed through `t`.
//
// Run: node .scratch/i18n-test.mjs
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

let failures = 0
const check = (label, ok, detail) => {
  if (ok) { console.log('ok:', label); return }
  failures += 1
  console.error('FAIL:', label, detail ?? '')
}

// --- load the module with stubs that capture the dictionaries and slots ---
const React = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
  useEffect: () => {}, useCallback: (fn) => fn, useRef: (v) => ({ current: v }),
}
const require = (name) => {
  if (name === 'react') return React
  throw new Error(`unexpected require: ${name}`)
}
let factory
globalThis.window = { __ModuleLoader__: { load({ factory: f }) { factory = f } } }
new Function('window', 'require', src)(globalThis.window, require)
const mod = factory(require)

let dicts
const slots = []
mod.apply({
  effect: (fn) => fn(),
  locale: {
    register: (_ns, d) => { dicts = d; return () => {} },
    bind: () => (key) => key,
  },
  slots: { inject: (_o, cb) => slots.push({ cb }), register: (opts, component) => ({ opts, component }) },
  sidebarRightTabs: { register: () => () => {} },
})

check('registers zh and en', dicts !== undefined && 'zh' in dicts && 'en' in dicts)

if (dicts !== undefined) {
  const zhKeys = Object.keys(dicts.zh).sort()
  const enKeys = Object.keys(dicts.en).sort()

  check('zh and en have identical keys', JSON.stringify(zhKeys) === JSON.stringify(enKeys),
    `missing in en: ${zhKeys.filter(k => !enKeys.includes(k))} | extra in en: ${enKeys.filter(k => !zhKeys.includes(k))}`)

  // Placeholders must match per key, or one language renders a literal {name}.
  const placeholders = (text) => [...String(text).matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort().join(',')
  const mismatched = zhKeys.filter((key) => placeholders(dicts.zh[key]) !== placeholders(dicts.en[key]))
  check('placeholders match per key', mismatched.length === 0,
    mismatched.map(k => `${k}: zh{${placeholders(dicts.zh[k])}} en{${placeholders(dicts.en[k])}}`).join('; '))

  // Chinese strings should not be byte-identical to English (a missed
  // translation) — except pure composition templates, whose content is only
  // placeholders and punctuation, where identical is correct.
  const isCompositionOnly = (text) => String(text).replace(/\{\w+\}/g, '').replace(/[\s\-—–·:：,，.。→]/g, '') === ''
  const untranslated = zhKeys.filter(
    (key) => dicts.zh[key] === dicts.en[key]
      && /[a-z]/i.test(dicts.en[key])
      && !isCompositionOnly(dicts.en[key]),
  )
  check('no untranslated zh entries', untranslated.length === 0, untranslated.join(', '))

  check('dictionary is non-trivial', zhKeys.length >= 15, `${zhKeys.length} keys`)
}

// Every slot that renders text must declare the locale namespace.
const textSlots = slots.map((s) => s.cb()).filter((r) => r?.opts !== undefined)
check('panel slots declare a locale', textSlots.every((r) => typeof r.opts.locale === 'string'),
  JSON.stringify(textSlots.map((r) => r.opts)))

// No user-visible literal should survive outside the dictionaries: look for
// quoted prose in JSX-ish child position (the pattern that regressed before).
const proseOutsideDicts = [...src.matchAll(/h\(\s*'div'[^)]*\{\s*style:\s*styles\.\w+\s*\},\s*'([A-Z][^']{12,})'/g)]
  .map((m) => m[1])
check('no hardcoded prose in rendered divs', proseOutsideDicts.length === 0, JSON.stringify(proseOutsideDicts))

console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`)
process.exitCode = failures ? 1 : 0
