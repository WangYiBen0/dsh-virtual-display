// The single model-facing tool: virtual_display.
//
// Design intent (why this tool exists at all):
// An agent that needs to see "what does this window actually look like?" has
// historically opened a window on the user's live session and screenshotted it.
// That hijacks the session the human is working in. This tool gives the agent a
// private display instead, so the same question is answered without the human
// ever losing focus.

import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { VirtualDisplaySession } from './session.js'
import { InputInjector, normalizeInput } from './input.js'
import { inspectCapabilities, choosePlatform, assertSupported, PLATFORMS, GEARS } from './capabilities.js'

const ACTIONS = ['inspect', 'start', 'capture', 'input', 'view', 'stop']

/**
 * Clamp one optional numeric argument to an inclusive range.
 *
 * The harness value-schema DSL has no `minimum`/`maximum`, so the bounds cannot
 * be expressed in the parameter schema at all. They are documented in each
 * parameter's description and enforced here instead: an out-of-range value is
 * pulled back to the nearest legal bound rather than failing the whole call,
 * which keeps a slightly wrong width from wasting a display boot.
 *
 * @param value - Caller-supplied number, or undefined to keep the default.
 * @param min - Smallest accepted value, used by default.
 * @param max - Largest accepted value, used by default.
 * @param fallback - Value used when the caller supplied nothing usable.
 * @returns A finite integer within [min, max].
 */
function clampNumber(value, min, max, fallback) {
  if (value === undefined || value === null) return fallback
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.round(parsed)))
}

export function createVirtualDisplayTool(ctx, options) {
  const manager = options.manager
  return defineTool({
    name: 'virtual_display',
    description: [
      'Provision a private virtual display and capture a real, fully rendered instance on it.',
      '',
      'Use this instead of screenshotting the user\'s own desktop: it never opens a window on the session the user is working in, so it cannot steal their focus or interrupt them.',
      '',
      'Actions:',
      '- `inspect`: report which platforms and isolation gears (direct/container/vm) actually work on this host, before you commit to one.',
      '- `start`: boot a display, optionally launching a page or program on it. Returns a session id.',
      '- `capture`: render an image from a session, returned as a viewable attachment.',
      '- `input`: inject synthetic keyboard/mouse events into a session (type, click, scroll).',
      '- `view`: report the exact commands a human can run to watch this session live (no listener is started).',
      '- `stop`: tear a session down.',
      '',
      'Pick `platform` (`x11`, `wayland`, `windows`, `macos`) and `gear` (`direct`, `container`, `vm`). Omit both to get the host\'s best private option.',
      '',
      'Reuse a session id across several `capture` calls when you are iterating on one window; each `start` allocates a fresh display.',
    ].join('\n'),
    parameters: {
      action: {
        type: 'string',
        description: `One of: ${ACTIONS.join(', ')}.`,
        enum: ACTIONS,
      },
      platform: {
        type: 'string',
        description: `Rendering platform to target. One of: ${PLATFORMS.join(', ')}. Defaults to the best private option for this host.`,
        enum: PLATFORMS,
      },
      gear: {
        type: 'string',
        description: `Isolation gear. \`direct\` renders on this host's own stack but on a private display; \`container\` runs the renderer in a disposable container; \`vm\` boots a disposable VM. One of: ${GEARS.join(', ')}. Defaults to \`direct\`.`,
        enum: GEARS,
      },
      target: {
        type: 'string',
        description:
          'What to render: an http(s)/data/file URL, or the name or path of a program. Optional with `start`.',
      },
      args: {
        type: 'array',
        description: 'Arguments for `target` when it is a program rather than a URL.',
        items: { type: 'string' },
      },
      argv: {
        type: 'array',
        description: 'Explicit argv to run as the renderer, bypassing `target` handling entirely.',
        items: { type: 'string' },
      },
      sessionId: {
        type: 'string',
        description:
          'Session to act on. Required for `capture`, `input`, `view`, and `stop`; ignored for `start`.',
      },
      input: {
        type: 'object',
        additionalProperties: true,
        description: [
          'Event for `action: "input"`. One of:',
          '- `{ kind: "text", text, delayMs? }` type characters',
          '- `{ kind: "key", key }` a key or chord, e.g. "Return", "ctrl+c", "Tab"',
          '- `{ kind: "click", x, y, button?, count? }` button is left/middle/right',
          '- `{ kind: "move", x, y }`',
          '- `{ kind: "scroll", x?, y?, direction: "up"|"down", amount? }`',
          'Coordinates are display pixels — the same space a `capture` image uses.',
        ].join('\n'),
      },
      captureAfter: {
        type: 'boolean',
        description:
          'For `input`: capture a fresh frame after injecting and return it as an attachment. Defaults to false.',
      },
      // Note: the harness value-schema DSL supports only
      // description/title/default/examples plus type/enum/const/items/
      // properties/additionalProperties. JSON Schema keywords such as
      // `minimum` are rejected at registration, so numeric bounds live in the
      // descriptions and are enforced by clampNumber() in execute().
      width: {
        type: 'number',
        description: 'Display width in pixels, 64-7680. Defaults to 1280.',
      },
      height: {
        type: 'number',
        description: 'Display height in pixels, 64-4320. Defaults to 800.',
      },
      waitMs: {
        type: 'number',
        description:
          'How long to wait for the renderer to paint before capturing, 0-180000. Defaults to 30000. Raise it for heavy pages.',
      },
      settleMs: {
        type: 'number',
        description: 'Extra quiet time after painting, before the frame is taken, 0-60000. Defaults to 1200.',
      },
      capturePath: {
        type: 'string',
        description: 'Optional absolute path to write the PNG to. Defaults to a file inside the session runtime directory.',
      },
      image: {
        type: 'string',
        description: 'Container image for `gear: "container"`. Defaults to a minimal alpine.',
      },
      baseImage: {
        type: 'string',
        description: 'Base disk image (qcow2) for `gear: "vm"`. A disposable overlay is created over it.',
      },
      keep: {
        type: 'boolean',
        description: 'Keep the session alive after `capture` for reuse. `stop` still tears it down.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', required: true },
          ok: { type: 'boolean', required: true },
          sessionId: { type: 'string' },
          capabilities: { type: 'object', additionalProperties: true },
          session: { type: 'object', additionalProperties: true },
          path: { type: 'string' },
          image: {
            type: 'object',
            additionalProperties: false,
            properties: {
              attachmentId: { type: 'string' },
              mediaType: { type: 'string' },
              bytes: { type: 'number' },
              width: { type: 'number' },
              height: { type: 'number' },
              name: { type: 'string' },
            },
          },
          windows: { type: 'array', items: { type: 'object', additionalProperties: true } },
          input: { type: 'object', additionalProperties: true },
          view: { type: 'object', additionalProperties: true },
          warning: { type: 'string' },
          notes: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args, value) => [renderValue(value)],
    },
    async execute(args, exec) {
      return manager.run(args, exec)
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `virtual_display ${args.action}${args.platform ? ` (${args.platform}/${args.gear ?? 'direct'})` : ''}`,
      rawInput: args,
    }),
  })
}

function renderValue(value) {
  const lines = []
  if (value.action === 'inspect') {
    lines.push('virtual display capabilities on this host:')
    for (const [platform, info] of Object.entries(value.capabilities?.platforms ?? {})) {
      lines.push(`  platform ${platform}: ${info.supported ? 'available' : `unavailable (${info.reason})`}`)
    }
    for (const [gear, info] of Object.entries(value.capabilities?.gears ?? {})) {
      lines.push(`  gear ${gear}: ${info.supported ? `available${info.acceleration ? ` (${info.acceleration})` : ''}` : `unavailable (${info.reason})`}`)
    }
    if (value.capabilities?.live?.waylandDisplay || value.capabilities?.live?.x11Display) {
      lines.push(
        `  user session (never used unless you ask for it): ${[
          value.capabilities.live.waylandDisplay,
          value.capabilities.live.x11Display,
        ]
          .filter(Boolean)
          .join(' / ')}`,
      )
    }
    return { type: 'text', text: lines.join('\n') }
  }

  if (!value.ok) {
    return { type: 'text', text: `virtual_display ${value.action} failed: ${value.error ?? 'unknown error'}` }
  }

  if (value.action === 'input') {
    const applied = value.input ?? {}
    lines.push(
      `injected ${applied.kind}${applied.characters !== undefined ? ` (${applied.characters} chars)` : ''}` +
        (applied.x !== undefined ? ` at ${applied.x},${applied.y}` : ''),
    )
    if (value.image !== undefined) lines.push(`captured ${value.path} (${value.image.width}x${value.image.height})`)
    if (value.warning !== undefined) lines.push(`warning: ${value.warning}`)
    return { type: 'text', text: lines.join('\n') }
  }

  if (value.action === 'view') {
    const view = value.view ?? {}
    lines.push(`session ${value.sessionId} is on ${view.kind}`)
    if (view.env !== undefined) {
      for (const [key, val] of Object.entries(view.env)) lines.push(`  ${key}=${val}`)
    }
    if (view.stillCapture !== undefined) lines.push(`still frame: ${view.stillCapture}`)
    if (view.liveViewer !== undefined) lines.push(`live viewer: ${view.liveViewer}`)
    if (view.note !== undefined) lines.push(`note: ${view.note}`)
    return { type: 'text', text: lines.join('\n') }
  }

  if (value.image !== undefined) {
    lines.push(
      `captured ${value.path} (${value.image.width}x${value.image.height}, ${value.image.bytes} bytes)`,
    )
  }
  if (value.sessionId !== undefined) lines.push(`session: ${value.sessionId}`)
  if (value.session?.display !== undefined) lines.push(`display: :${value.session.display}`)
  if (value.session?.gear !== undefined) lines.push(`gear: ${value.session.gear}`)
  if (value.windows?.length) {
    lines.push(`windows on the private display (${value.windows.length}):`)
    for (const w of value.windows.slice(0, 8)) lines.push(`  ${w.id} ${w.title || '(untitled)'}`)
  }
  if (value.warning !== undefined) lines.push(`warning: ${value.warning}`)
  for (const note of value.notes ?? []) lines.push(`note: ${note}`)
  return { type: 'text', text: lines.join('\n') }
}

/**
 * Owns every live session and serialises the tool's four actions.
 */
export class VirtualDisplayManager {
  constructor(ctx, options = {}) {
    this.ctx = ctx
    this.options = options
    this.sessions = new Map()
  }

  async run(args, exec) {
    try {
      switch (args.action) {
        case 'inspect':
          return await this.inspect()
        case 'start':
          return await this.start(args, exec)
        case 'capture':
          return await this.capture(args, exec)
        case 'input':
          return await this.input(args, exec)
        case 'view':
          return await this.view(args)
        case 'stop':
          return await this.stop(args)
        default:
          throw new Error(`unknown action "${args.action}"`)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { action: args.action, ok: false, error: message }
    }
  }

  async inspect() {
    const capabilities = await inspectCapabilities(this.ctx)
    return { action: 'inspect', ok: true, capabilities }
  }

  /**
   * Report how a human can watch this session live.
   *
   * `capture` gives the model a still frame; this gives the *human* a way in.
   * Nothing is launched — the result is a recipe built from the live socket
   * paths, so it stays accurate across platforms and never starts a listener
   * the caller did not ask for.
   */
  async view(args) {
    const { session } = this.require(args.sessionId)
    return {
      action: 'view',
      ok: true,
      sessionId: args.sessionId,
      session: session.describe(),
      view: session.viewHints(),
    }
  }

  async start(args, exec) {
    const capabilities = await inspectCapabilities(this.ctx)
    const platform = choosePlatform(capabilities, args.platform)
    const gear = args.gear ?? 'direct'
    assertSupported(capabilities, platform, gear)

    const width = clampNumber(args.width, 64, 7680, this.options.defaultWidth ?? 1280)
    const height = clampNumber(args.height, 64, 4320, this.options.defaultHeight ?? 800)
    const runtimeRoot = this.options.runtimeRoot ?? join(process.cwd(), '.dsh-virtual-display')
    const sessionId = randomUUID()
    const runtimeDir = join(runtimeRoot, sessionId)

    const session = new VirtualDisplaySession(this.ctx, {
      platform,
      gear,
      width,
      height,
      runtimeDir,
      env: this.options.env,
      settleMs: clampNumber(args.settleMs, 0, 60000, undefined),
      image: args.image,
      baseImage: args.baseImage,
      acceleration: capabilities.gears.vm?.acceleration,
      keepRuntimeDir: true,
    })

    this.sessions.set(sessionId, session)

    // Register teardown on the execution scope so an aborted turn cannot leak
    // a display, and on plugin dispose so nothing survives a reload.
    if (exec?.signal !== undefined) {
      exec.signal.addEventListener(
        'abort',
        () => {
          void this.stop({ sessionId })
        },
        { once: true },
      )
    }

    await session.acquire()
    const notes = []

    if (args.target !== undefined || args.argv !== undefined) {
      await session.launch({
        kind: /^https?:|^data:|^file:/.test(args.target ?? '') ? 'url' : 'program',
        target: args.target,
        args: args.args,
        argv: args.argv,
      })
    }

    if (args.action === 'start' && args.captureAfterStart === true) {
      notes.push('captureAfterStart is not used; call capture explicitly')
    }

    return {
      action: 'start',
      ok: true,
      sessionId,
      session: session.describe(),
      notes,
    }
  }

  /**
   * Inject a synthetic input event into a live session.
   *
   * This exists so an agent can *drive* what it rendered — click the menu it
   * just screenshotted, type into the field it wants to check — instead of only
   * observing the first frame. Coordinates are display pixels, matching what
   * `capture` returned, so a caller can read a position off a screenshot.
   */
  async input(args, exec) {
    const { session } = this.require(args.sessionId)
    const request = normalizeInput(args.input)
    const injector = new InputInjector(session)
    const applied = await injector.apply(request)

    // An injection that does not change the frame is indistinguishable from a
    // no-op, so hand back a fresh capture unless the caller opted out.
    if (args.captureAfter !== true) {
      return {
        action: 'input',
        ok: true,
        sessionId: args.sessionId,
        input: applied,
        session: session.describe(),
      }
    }

    const destPath = args.capturePath ?? join(session.runtimeDir, `input-${Date.now()}.png`)
    await new Promise((resolve) => setTimeout(resolve, 250))
    const result = await session.capture({
      destPath,
      waitMs: clampNumber(args.waitMs, 0, 180000, 5000),
      settleMs: clampNumber(args.settleMs, 0, 60000, 400),
      signal: exec?.signal,
    })
    const image = await this.attach(result.path)

    return {
      action: 'input',
      ok: true,
      sessionId: args.sessionId,
      input: applied,
      path: result.path,
      image,
      windows: result.windows,
      session: session.describe(),
      warning: session.windowWarning,
    }
  }

  async capture(args, exec) {
    const { session } = this.require(args.sessionId)
    const destPath = args.capturePath ?? join(session.runtimeDir, `capture-${Date.now()}.png`)
    const result = await session.capture({
      destPath,
      waitMs: clampNumber(args.waitMs, 0, 180000, undefined),
      settleMs: clampNumber(args.settleMs, 0, 60000, undefined),
      signal: exec?.signal,
    })

    const image = await this.attach(result.path)
    if (args.keep !== true) {
      await this.stop({ sessionId: args.sessionId })
    }

    return {
      action: 'capture',
      ok: true,
      sessionId: args.sessionId,
      path: result.path,
      image,
      windows: result.windows,
      session: session.describe(),
      warning: session.windowWarning,
    }
  }

  async stop(args) {
    const session = this.sessions.get(args.sessionId)
    if (session === undefined) {
      return { action: 'stop', ok: true, sessionId: args.sessionId, notes: ['no such session; nothing to do'] }
    }
    await session.release()
    this.sessions.delete(args.sessionId)
    return { action: 'stop', ok: true, sessionId: args.sessionId }
  }

  /** Read the PNG back through the attachment store so it renders inline. */
  async attach(path) {
    const { readFileSync } = await import('node:fs')
    const { basename } = await import('node:path')
    const data = readFileSync(path)
    const attachments = await this.resolveAttachments()
    if (attachments === undefined) {
      // Without an attachment store the capture is still on disk; the caller
      // just does not get an inline preview.
      return { bytes: data.byteLength, mediaType: 'image/png', name: basename(path) }
    }
    const ref = await attachments.saveImage({ data, mediaType: 'image/png', name: basename(path) })
    return {
      attachmentId: String(ref.attachmentId),
      mediaType: ref.mediaType,
      bytes: ref.bytes,
      width: ref.width,
      height: ref.height,
      name: ref.name ?? basename(path),
    }
  }

  /**
   * Find the attachment store.
   *
   * Cordis exposes services as plain properties, but `ctx.get(name)` is also
   * valid and *may* be async in a wrapped context. A Promise here previously
   * surfaced as the confusing "attachments.saveImage is not a function", so we
   * resolve and validate rather than trusting the first thing we find.
   */
  async resolveAttachments() {
    for (const candidate of [this.ctx.attachments, this.ctx.get?.('attachments')]) {
      const resolved = await candidate
      if (resolved !== undefined && resolved !== null && typeof resolved.saveImage === 'function') {
        return resolved
      }
    }
    return undefined
  }

  require(sessionId) {
    if (sessionId === undefined) throw new Error('sessionId is required for this action')
    const session = this.sessions.get(sessionId)
    if (session === undefined) {
      throw new Error(
        `unknown session "${sessionId}"; it may have been stopped or the plugin may have reloaded`,
      )
    }
    return { session }
  }

  /** Dispose every session; called from the plugin's teardown. */
  async dispose() {
    const ids = [...this.sessions.keys()]
    await Promise.all(ids.map((id) => this.stop({ sessionId: id })))
  }
}
