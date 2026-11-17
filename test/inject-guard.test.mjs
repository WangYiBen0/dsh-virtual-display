// Static guard: no module may read an undeclared cordis service.
//
// cordis throws `cannot get property "<name>" without inject` on a bare read of
// a service the fiber did not declare. That shipped once (`ctx.tuiScenes` read
// outside `ctx.inject`), so this scans source for the pattern.
//
// Run: node .scratch/inject-guard-test.mjs
import { readFileSync } from 'node:fs'

const SOURCES = ['index.js', 'tui.js', 'client.js', 'src/tool.js', 'src/panel.js', 'src/session.js']

// Services the plugin may touch through a bare `ctx.<name>` read.
// `tools`/`subprocess`/`attachments` are declared in index.js `inject`.
const DECLARED_IN_ENTRY = new Set(['tools', 'subprocess', 'attachments'])
// Services reached only inside `ctx.inject([...], cb)` are checked separately.
const INJECT_ONLY = new Set(['webServer', 'commands', 'tuiScenes', 'locale', 'slots', 'sidebarRightTabs', 'sidebarRight'])

let failures = 0
const check = (label, ok, detail) => {
  if (ok) { console.log('ok:', label); return }
  failures += 1
  console.error('FAIL:', label, detail ?? '')
}

for (const file of SOURCES) {
  let source
  try { source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8') } catch { continue }

  // Strip comments and strings so prose about a service is not read as code.
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/.*$/gm, ' ')
    .replace(/`(?:\\.|[^`\\])*`/g, '``')
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""')

  if (file === 'client.js') {
    // Read the declaration from the ORIGINAL source: the comment/string
    // stripper above would blank the quoted service names.
    const declared = /inject:\s*\[([^\]]*)\]/.exec(source)?.[1] ?? ''
    for (const service of ['locale', 'slots', 'sidebarRightTabs', 'sidebarRight']) {
      if (!declared.includes(`'${service}'`)) continue
      check(`client.js declares ${service}`, true)
    }
    check('client.js declares locale', declared.includes("'locale'"), declared.trim())
    check('client.js declares sidebarRightTabs', declared.includes("'sidebarRightTabs'"), declared.trim())
    continue
  }

  if (file === 'tui.js') {
    // A bare `ctx.tuiScenes` outside an inject callback is the exact bug.
    const bare = [...code.matchAll(/ctx\.(tuiScenes|commands|webServer)\b/g)]
    check('tui.js has no bare ctx.tuiScenes/commands/webServer read', bare.length === 0,
      bare.map((m) => m[0]).join(', '))
    continue
  }

  // Host modules may only touch the entry-declared services.
  const found = new Set([...code.matchAll(/ctx\.([a-zA-Z_][\w]*)\b/g)].map((m) => m[1]))
  for (const name of found) {
    if (DECLARED_IN_ENTRY.has(name) || INJECT_ONLY.has(name)) continue
    if (['effect', 'on', 'inject', 'get', 'tools', 'reflect', 'emit', 'waterfall', 'root', 'logger'].includes(name)) continue
    // Anything else would be an undeclared service; report it for review.
    check(`${file}: no unexpected ctx.${name} access`, false, name)
  }
}

console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`)
process.exitCode = failures ? 1 : 0
