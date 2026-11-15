// TUI surface for the plugin.
//
// The Web panel is a Sidebar tab built on the browser slot system; the terminal
// has no such thing. dsh-tui's extension point for a whole-screen experience is
// a *scene* (`ctx.tuiScenes.register` + `ctx.tuiScenes.open`), so the TUI
// counterpart is a fullscreen scene: the same private display, the same input
// injection, rendered as a terminal image when the terminal speaks Kitty or
// Sixel, and as a text summary when it does not.
//
// This module deliberately shares nothing but HTTP with the Web panel: both
// speak to the same `/virtual-display/*` routes on the Harness web server, so
// the host-side code (`src/panel.js`) stays the single source of truth.
//
// Loading is optional. A profile without dsh-tui simply never gets here,
// because `apply()` never runs.

import { readFile } from 'node:fs/promises'

/** Route prefix shared with the Web panel and the host routes. */
const BASE = '/virtual-display'

/** Convert a PNG buffer to the raw RGBA snapshot `ui.Image` expects. */
async function decodeToRgba(buffer) {
  // First choice: the host's own decoder, for the same reason dsh-tui loads
  // sharp from the host tree — a second libvips in one process is trouble.
  const decoder = await loadHostSharp()
  if (decoder === undefined) return undefined
  try {
    const image = decoder(buffer)
    const { data, info } = await image.ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    return {
      data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
      width: info.width,
      height: info.height,
    }
  } catch {
    return undefined
  }
}

/**
 * Resolve `sharp` from the host tree, falling back to a direct require.
 *
 * Returns undefined when no copy exists; callers keep their text fallback.
 */
async function loadHostSharp() {
  const { createRequire } = await import('node:module')
  const candidates = []
  const local = createRequire(import.meta.url)
  try {
    const anchor = local.resolve('@deepseek-ai/dsh-session/package.json')
    candidates.push(createRequire(anchor).resolve('sharp'))
  } catch {
    // No host tree; try our own resolution below.
  }
  candidates.push('sharp')
  for (const specifier of candidates) {
    try {
      const loaded = await import(specifier)
      return loaded.default ?? loaded
    } catch {
      // Try the next candidate.
    }
  }
  return undefined
}

/** Fetch the sessions list from the host routes. */
async function fetchSessions(origin) {
  const response = await fetch(new URL(`${BASE}/sessions`, origin))
  if (!response.ok) throw new Error(`sessions answered ${response.status}`)
  const body = await response.json()
  return body.sessions ?? []
}

/** Fetch one frame as a Buffer. */
async function fetchFrame(origin, sessionId) {
  const url = new URL(`${BASE}/frame`, origin)
  url.searchParams.set('sessionId', sessionId)
  url.searchParams.set('t', String(Date.now()))
  const response = await fetch(url)
  if (!response.ok) throw new Error(`frame answered ${response.status}`)
  return Buffer.from(await response.arrayBuffer())
}

/** POST one input event. */
async function sendInput(origin, sessionId, payload) {
  const url = new URL(`${BASE}/input`, origin)
  url.searchParams.set('sessionId', sessionId)
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok || body.ok !== true) {
    throw new Error(body.error ?? `input answered ${response.status}`)
  }
  return body.input
}

/**
 * The scene body.
 *
 * Everything is drawn with the TUI's own kit (`ui.Box`, `ui.Text`, `ui.Image`),
 * and `props.React` is used for hooks so this component shares the TUI's React
 * instance rather than bundling a second one.
 */
function VirtualDisplayScene(props) {
  const { React, ui, channel } = props
  const { useState, useEffect, useCallback, useMemo } = React
  const h = React.createElement

  // The scene is host-side and reaches the routes over HTTP. The origin cannot
  // be assumed: dsh-tui mounts the web carrier with `port: 0`, so the port is
  // OS-assigned. `applyTui` resolves the real origin from `ctx.webServer` and
  // hands it down; without one there is nothing to talk to, which the caller
  // reports before opening the scene.
  const origin = props.origin

  const [sessions, setSessions] = useState([])
  const [selected, setSelected] = useState(undefined)
  const [raster, setRaster] = useState(undefined)
  const [error, setError] = useState(undefined)
  const [paused, setPaused] = useState(false)
  const [nonce, setNonce] = useState(0)

  const graphics = ui.useTerminalImages(true)
  const protocol = ui.useTerminalImageProtocol()
  const size = ui.useTerminalSize()

  // Refresh the session list on a slow timer: displays appear and disappear.
  useEffect(() => {
    let cancelled = false
    const tick = async () => {
      try {
        const list = await fetchSessions(origin)
        if (cancelled) return
        setSessions(list)
        setSelected((current) => {
          if (current !== undefined && list.some((s) => s.sessionId === current)) return current
          return list[0]?.sessionId
        })
        setError(undefined)
      } catch (cause) {
        if (!cancelled) setError(cause.message)
      }
    }
    void tick()
    const timer = setInterval(tick, 3000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [origin])

  // Poll one frame and decode it for the terminal.
  useEffect(() => {
    if (paused || selected === undefined) return undefined
    let cancelled = false
    const tick = async () => {
      try {
        const png = await fetchFrame(origin, selected)
        if (cancelled) return
        if (!graphics) {
          // Without a graphics protocol the frame cannot be shown inline; the
          // caption below still reports its size so the scene stays useful.
          setRaster({ bytes: png.byteLength })
          return
        }
        const decoded = await decodeToRgba(png)
        if (cancelled) return
        setRaster(decoded ?? { bytes: png.byteLength })
      } catch (cause) {
        if (!cancelled) setError(cause.message)
      }
    }
    void tick()
    const timer = setInterval(tick, 1000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [origin, selected, paused, graphics, nonce])

  const inject = useCallback(
    async (payload) => {
      if (selected === undefined) return
      try {
        await sendInput(origin, selected, payload)
        setError(undefined)
        setNonce((n) => n + 1)
      } catch (cause) {
        setError(cause.message)
      }
    },
    [origin, selected],
  )

  // Terminal input maps onto display input: the terminal cannot report pixels,
  // so clicks are not available here. Keys and scrolls are.
  ui.useInput((input, key) => {
    if (key.escape) {
      props.close()
      return
    }
    if (input === 'p') {
      setPaused((v) => !v)
      return
    }
    if (input === 'r') {
      setNonce((n) => n + 1)
      return
    }
    if (input === 'k') {
      void inject({ kind: 'key', key: 'Up' })
      return
    }
    if (input === 'j') {
      void inject({ kind: 'key', key: 'Down' })
      return
    }
    if (key.return) {
      void inject({ kind: 'key', key: 'Return' })
      return
    }
    if (key.wheelUp) {
      void inject({ kind: 'scroll', direction: 'up', amount: 3 })
      return
    }
    if (key.wheelDown) {
      void inject({ kind: 'scroll', direction: 'down', amount: 3 })
      return
    }
    if (input.length > 0) {
      void inject({ kind: 'text', text: input })
    }
  })

  // --- render ---
  const header = h(
    ui.Box,
    { flexDirection: 'row', gap: 1 },
    h(ui.Text, { bold: true, color: 'cyan' }, 'Virtual display'),
    h(ui.Text, { dimColor: true }, selected === undefined ? 'no session' : selected.slice(0, 8)),
    h(ui.Text, { dimColor: true }, paused ? '[paused]' : '[live]'),
    protocol !== undefined ? h(ui.Text, { dimColor: true }, `[${protocol}]`) : h(ui.Text, { dimColor: true }, '[no graphics]'),
  )

  const body = (() => {
    if (sessions.length === 0) {
      return h(
        ui.Box,
        { flexDirection: 'column' },
        h(ui.Text, { dimColor: true }, 'No live virtual display yet.'),
        h(ui.Text, { dimColor: true }, 'Ask the agent to run virtual_display with action: "start".'),
      )
    }
    if (raster === undefined) {
      return h(ui.Text, { dimColor: true }, 'Waiting for a frame…')
    }
    if (raster.data === undefined) {
      // Text fallback: prove the frame arrived and how big it is.
      return h(
        ui.Box,
        { flexDirection: 'column' },
        h(ui.Text, { dimColor: true }, `frame received (${raster.bytes ?? 0} bytes)`),
        h(ui.Text, { dimColor: true }, 'This terminal has no Kitty/Sixel graphics support,'),
        h(ui.Text, { dimColor: true }, 'so the frame cannot be drawn inline.'),
      )
    }
    // Fit the image to the available cells, preserving aspect ratio.
    const maxColumns = Math.max(20, size.columns - 4)
    const maxRows = Math.max(6, size.rows - 8)
    const scale = Math.min(maxColumns / raster.width, maxRows / raster.height)
    const width = Math.max(1, Math.floor(raster.width * scale))
    const height = Math.max(1, Math.floor(raster.height * scale))
    return h(ui.Image, {
      source: { data: raster.data, width: raster.width, height: raster.height },
      width,
      height,
      alt: 'private virtual display',
    })
  })()

  const footer = h(
    ui.Box,
    { flexDirection: 'column' },
    h(ui.Text, { dimColor: true }, 'type to send text · Enter · j/k scroll · wheel scrolls · p pause · r refresh · Esc close'),
    error !== undefined ? h(ui.Text, { color: 'red' }, error) : null,
  )

  return h(ui.Box, { flexDirection: 'column', padding: 1 }, header, body, footer)
}

/**
 * Register the scene and a command that opens it.
 *
 * Everything runs inside `ctx.inject(['tuiScenes'], ...)`, which is the only
 * legal way to reach that service: cordis throws
 * `cannot get property "tuiScenes" without inject` on a bare property read, and
 * an injected callback simply never runs in a profile without dsh-tui. That is
 * also why a Web-only installation is unaffected — not because of a runtime
 * check on our side.
 *
 * `webServer` is injected the same way but is genuinely optional: a TUI profile
 * without an HTTP carrier still gets the command, which then explains why it
 * cannot open.
 */
export function applyTui(ctx, options = {}) {
  // Diagnostics: this plugin has been silent in the TUI twice, and silence is
  // indistinguishable from "never activated". These lines say which branch ran.
  // dsh-tui surfaces plugin console output with the entry name, so they cost
  // nothing at rest and answer the question immediately when something is off.
  const log = (message) => {
    // eslint-disable-next-line no-console
    console.log(`[dsh-virtual-display] ${message}`)
  }

  const scenesPresent = ctx.reflect?.get?.('tuiScenes') !== undefined
  const commandsPresent = ctx.reflect?.get?.('commands') !== undefined
  log(`tui: service probe — tuiScenes=${scenesPresent} commands=${commandsPresent}`)

  if (!scenesPresent) {
    log('tui: no tuiScenes in this profile; the /display scene is not registered')
    return
  }

  ctx.inject(['tuiScenes'], (tui) => {
    log('tui: tuiScenes injected')
    /**
     * Resolve the HTTP origin of this process's web carrier.
     *
     * Read lazily, at scene-open time: the carrier binds during initialization,
     * so `getOrigin()` throws before that. An explicit option wins, which is
     * what a test or an unusual composition needs.
     */
    const resolveOrigin = () => {
      if (typeof options.origin === 'string') return options.origin
      const server = tui.reflect.get('webServer', false)
      if (typeof server?.port !== 'number') return undefined
      try {
        return server.getOrigin()
      } catch {
        return undefined
      }
    }

    tui.effect(
      () =>
        tui.tuiScenes.register({
          id: 'virtual-display',
          title: 'Virtual display',
          component: (sceneProps) => VirtualDisplayScene({ ...sceneProps, origin: resolveOrigin() }),
        }),
      'virtual-display: tui scene',
    )
    log('tui: scene "virtual-display" registered')

    // A slash command is the natural way to open a whole-screen view. The
    // handler signature and the result union are dsh-commands': `{ kind:
    // 'success', text }` with `text` empty, so the conversation is not disturbed.
    log(`tui: commands present = ${tui.reflect?.get?.('commands') !== undefined}`)
    tui.inject(['commands', 'tuiScenes'], (scope) => {
      log('tui: commands injected')
      scope.effect(
        () =>
          scope.commands.register({
            name: 'display',
            description: 'Open the private virtual display (live preview + input)',
            recordInput: false,
            handler: async () => {
              const origin = resolveOrigin()
              if (origin === undefined) {
                return {
                  kind: 'error',
                  text: 'No web carrier is listening, so the panel routes are unreachable. Enable webPanel and a webserver in this profile.',
                }
              }
              // `scope` declares tuiScenes too, so this read is legal.
              const opened = scope.tuiScenes.open('virtual-display')
              if (opened !== true) {
                return { kind: 'error', text: 'The virtual-display scene is not registered.' }
              }
              return { kind: 'success', text: '' }
            },
          }),
        'virtual-display: /display command',
      )
      log('tui: command "display" registered')
    })
  })
}
