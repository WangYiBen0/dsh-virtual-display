// dsh-virtual-display — give the agent a private display instead of the
// user's desktop.
//
// Why this plugin exists:
//   When an agent needs to know what something actually looks like, the easy
//   path is to open a window on the user's live session and screenshot it.
//   That steals focus and interrupts whatever the human is doing. This plugin
//   exposes one tool that provisions a throwaway display instead, so the agent
//   gets the same real rendering without ever touching the user's session.
//
// The tool is `virtual_display`. Every session it hands out is built from an
// environment with the user's DISPLAY / WAYLAND_DISPLAY stripped out, so a
// misbehaving caller physically cannot land on the live session.

import Schema from '@deepseek-ai/schemastery'
import { createVirtualDisplayTool, VirtualDisplayManager } from './src/tool.js'

export const name = 'virtual-display'
export const inject = ['tools', 'subprocess', 'attachments']

/**
 * Config schema; every field is optional and has a working default.
 *
 * This must be a schemastery (standard-schema) instance, not a bare JSON Schema
 * literal: the loader calls `Config['~standard'].validate(...)` at activation.
 */
export const Config = Schema.object({
  runtimeRoot: Schema.string().description(
    'Directory that holds per-session runtime state (sockets, browser profiles, captures). Defaults to .dsh-virtual-display under the working directory.',
  ),
  defaultWidth: Schema.natural().min(64).max(7680).default(1280)
    .description('Default virtual display width in pixels.'),
  defaultHeight: Schema.natural().min(64).max(4320).default(800)
    .description('Default virtual display height in pixels.'),
})

export function apply(ctx, config = {}) {
  const manager = new VirtualDisplayManager(ctx, {
    runtimeRoot: config.runtimeRoot,
    defaultWidth: config.defaultWidth,
    defaultHeight: config.defaultHeight,
  })

  ctx.tools.register(createVirtualDisplayTool(ctx, { manager }))

  // Never leave a display, socket, or browser process behind.
  ctx.effect(() => () => manager.dispose())
}
