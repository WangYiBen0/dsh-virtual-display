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
//
// Beyond capture, the plugin can also drive a session with synthetic input,
// show it live in a right-Sidebar tab, and route its audio into a per-session
// silent sink. The panel is switched off with `webPanel: false`, audio falls
// back to the default device with `audio: 'inherit'`, and each degrades on its
// own when the host lacks the needed tools.

import Schema from '@deepseek-ai/schemastery'
import { createVirtualDisplayTool, VirtualDisplayManager } from './src/tool.js'
import { registerPanelRoutes } from './src/panel.js'

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
  webPanel: Schema.boolean().default(true).description(
    'Serve the live-preview routes under /virtual-display, used by the right-Sidebar "Virtual display" tab. Disable to keep the HTTP surface closed.',
  ),
  audio: Schema.union(['null-sink', 'inherit']).default('null-sink').description(
    'Audio isolation for renderers. `null-sink` routes each session into its own silent sink; `inherit` plays through the default device.',
  ),
})

export function apply(ctx, config = {}) {
  const manager = new VirtualDisplayManager(ctx, {
    runtimeRoot: config.runtimeRoot,
    defaultWidth: config.defaultWidth,
    defaultHeight: config.defaultHeight,
    audio: config.audio,
  })

  ctx.tools.register(createVirtualDisplayTool(ctx, { manager }))

  // The panel lives on the harness's own web server, so it shares the origin
  // the user already trusts and opens no extra port.
  if (config.webPanel !== false) registerPanelRoutes(ctx, manager)

  // Never leave a display, socket, or browser process behind.
  ctx.effect(() => () => manager.dispose())
}
