// HTTP surface for the Web panel.
//
// The panel needs two things the tool cannot give it: a frame it can refresh on
// a timer, and a way to send an input event without going through the agent.
// Both are plain HTTP routes on the harness's own web server, so the panel
// talks to the same origin it was served from and no extra port is opened.
//
// Security posture: this is a remote control for a display. Every route is
// registered only when `webPanel` is enabled, sessions are addressed by opaque
// id (never by display number), and the handlers refuse to touch a session that
// does not belong to this manager. There is deliberately no route that accepts
// an arbitrary argv.

import { readFileSync } from 'node:fs'

/** Route prefix; kept under one namespace so it cannot shadow /api. */
export const ROUTE_PREFIX = '/virtual-display'

/**
 * Register the panel's routes.
 *
 * @param ctx - Plugin context; `webServer` must be injected.
 * @param manager - The VirtualDisplayManager that owns live sessions.
 * @returns Nothing; routes are owned by the surrounding `ctx.effect`.
 */
export function registerPanelRoutes(ctx, manager) {
  ctx.inject(['webServer'], (webCtx) => {
    const route = (kind, path, handler) =>
      webCtx.effect(
        () => webCtx.webServer.register({ kind, path: `${ROUTE_PREFIX}${path}`, handler }),
        `virtual-display: ${kind} ${path}`,
      )

    // Live session inventory for the panel's picker.
    route('exact', '/sessions', async (_req, res) => {
      const sessions = manager.listSessions()
      sendJson(res, 200, { sessions })
    })

    // One PNG frame, or 404 when the session is gone.
    route('exact', '/frame', async (req, res) => {
      const session = requireSession(manager, urlParam(req, 'sessionId'), res)
      if (session === undefined) return
      try {
        const buffer = await manager.grabFrame(session)
        res.writeHead(200, {
          'content-type': 'image/png',
          'content-length': String(buffer.byteLength),
          // A viewer polls this; a stale frame must never be served from cache.
          'cache-control': 'no-store, no-cache, must-revalidate',
        })
        res.end(buffer)
      } catch (error) {
        sendJson(res, 500, { error: messageOf(error) })
      }
    })

    // Inject one input event. Body: the same shape the tool's `input` accepts.
    route('exact', '/input', async (req, res) => {
      const session = requireSession(manager, urlParam(req, 'sessionId'), res)
      if (session === undefined) return
      let body
      try {
        body = await readJsonBody(req)
      } catch (error) {
        sendJson(res, 400, { error: messageOf(error) })
        return
      }
      try {
        const applied = await manager.injectInput(session, body)
        sendJson(res, 200, { ok: true, input: applied })
      } catch (error) {
        sendJson(res, 400, { ok: false, error: messageOf(error) })
      }
    })

    // Session facts (display env, window list) without starting anything.
    route('exact', '/session', async (req, res) => {
      const session = requireSession(manager, urlParam(req, 'sessionId'), res)
      if (session === undefined) return
      try {
        sendJson(res, 200, {
          session: session.describe(),
          view: session.viewHints(),
          windows: await manager.listWindows(session),
        })
      } catch (error) {
        sendJson(res, 500, { error: messageOf(error) })
      }
    })
  })
}

function requireSession(manager, sessionId, res) {
  if (sessionId === undefined || sessionId === '') {
    sendJson(res, 400, { error: 'sessionId is required' })
    return undefined
  }
  const session = manager.peekSession(sessionId)
  if (session === undefined) {
    sendJson(res, 404, { error: `unknown session "${sessionId}"` })
    return undefined
  }
  return session
}

/** Read `?key=value` from a node request without pulling in a URL parser. */
function urlParam(req, key) {
  const url = req.url ?? ''
  const index = url.indexOf('?')
  if (index === -1) return undefined
  const params = new URLSearchParams(url.slice(index + 1))
  return params.get(key) ?? undefined
}

/**
 * Read a JSON request body.
 *
 * Bounded on purpose: this endpoint is reachable from the page, and an
 * unbounded read would let one request exhaust memory.
 */
async function readJsonBody(req, limitBytes = 64 * 1024) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > limitBytes) throw new Error(`request body exceeds ${limitBytes} bytes`)
    chunks.push(chunk)
  }
  if (total === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('request body is not valid JSON')
  }
}

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.byteLength),
    'cache-control': 'no-store',
  })
  res.end(body)
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/** Read a PNG back from disk; used when a capture path is already known. */
export function readPng(path) {
  return readFileSync(path)
}
