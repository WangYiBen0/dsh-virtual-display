// Synthetic input for a private display.
//
// `capture` answers "what does this look like?"; this answers "what happens if
// I click there?" — which is what an agent needs when it is debugging a GUI
// configuration rather than just screenshotting one.
//
// Every helper here is spawned with the session's private environment, so an
// injection can never land on the user's desktop. Each platform gets the
// narrowest tool that works:
//
//   x11      xdotool (XTEST) — full keyboard + pointer
//   wayland  wtype (virtual-keyboard) for keys, wlrctl (virtual-pointer) for
//            pointer; only wlroots compositors expose those protocols
//   windows  PowerShell SendKeys / mouse_event
//   macos    osascript System Events
//
// Coordinate-convention note: callers pass coordinates in *display* pixels,
// matching what a `capture` image shows, so a caller can read a pixel position
// off a screenshot and click it without any extra maths.

import { run } from './exec.js'

/** Normalise one caller-supplied input request into {kind, ...}. */
export function normalizeInput(input) {
  if (input === undefined || input === null) throw new Error('`input` is required for this action')
  if (typeof input === 'string') return { kind: 'text', text: input }

  const kind = input.kind ?? input.type
  switch (kind) {
    case 'text':
    case 'type':
      if (typeof input.text !== 'string' || input.text.length === 0) {
        throw new Error('text input needs a non-empty `text`')
      }
      return {
        kind: 'text',
        text: input.text,
        delayMs: input.delayMs,
        startDelayMs: input.startDelayMs,
      }

    case 'key':
    case 'keys':
      if (typeof input.key !== 'string' || input.key.length === 0) {
        throw new Error('key input needs a `key` such as "Return", "ctrl+c", or "Tab"')
      }
      return { kind: 'key', key: input.key }

    case 'move':
      return { kind: 'move', x: requireInt(input.x, 'x'), y: requireInt(input.y, 'y') }

    case 'click':
      return {
        kind: 'click',
        x: requireInt(input.x, 'x'),
        y: requireInt(input.y, 'y'),
        button: normalizeButton(input.button),
        count: clampInt(input.count, 1, 3, 1),
      }

    case 'scroll':
      return {
        kind: 'scroll',
        x: input.x === undefined ? undefined : requireInt(input.x, 'x'),
        y: input.y === undefined ? undefined : requireInt(input.y, 'y'),
        direction: input.direction === 'up' ? 'up' : 'down',
        amount: clampInt(input.amount, 1, 20, 3),
      }

    default:
      throw new Error(
        `unknown input kind "${kind}"; expected one of: text, key, move, click, scroll`,
      )
  }
}

function requireInt(value, name) {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) throw new Error(`\`${name}\` must be a number, got ${String(value)}`)
  return Math.round(parsed)
}

function clampInt(value, min, max, fallback) {
  if (value === undefined || value === null) return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.round(parsed)))
}

function normalizeButton(button) {
  switch (button) {
    case 2:
    case 'middle':
      return 'middle'
    case 3:
    case 'right':
      return 'right'
    default:
      return 'left'
  }
}

/**
 * Split an xdotool-style key spec ("ctrl+shift+t", "Return") into a modifier
 * list and a base key. Shared by the X11 and Wayland implementations, which use
 * the same naming convention for the base key.
 */
export function splitKeySpec(spec) {
  const parts = spec.split('+').map((p) => p.trim()).filter(Boolean)
  if (parts.length === 0) throw new Error('empty key spec')
  const base = parts.pop()
  const modifiers = parts.map((m) => {
    const lower = m.toLowerCase()
    if (lower === 'ctrl' || lower === 'control') return 'ctrl'
    if (lower === 'alt') return 'alt'
    if (lower === 'shift') return 'shift'
    if (lower === 'super' || lower === 'meta' || lower === 'win') return 'super'
    return lower
  })
  return { modifiers, base }
}

/** Launch a synthetic input event on the private display. */
export class InputInjector {
  constructor(session) {
    this.session = session
  }

  /** Tools this platform needs; missing ones produce a clear error, not a crash. */
  requirements() {
    const tools = this.session.tools ?? {}
    switch (this.displayKind()) {
      case 'x11':
        return { xdotool: tools.xdotool }
      case 'wayland':
        return { wtype: tools.wtype, wlrctl: tools.wlrctl }
      case 'windows':
        return { powershell: 'powershell' }
      case 'macos':
        return { osascript: 'osascript' }
      default:
        return {}
    }
  }

  displayKind() {
    const display = this.session.display
    if (display?.backend === 'x11') return 'x11'
    if (display?.backend === 'wayland') {
      return display.mode === 'xwayland' ? 'x11' : 'wayland'
    }
    if (display?.backend === 'windows') return 'windows'
    if (display?.backend === 'macos') return 'macos'
    return 'x11'
  }

  async apply(input) {
    switch (this.displayKind()) {
      case 'x11':
        return this.applyX11(input)
      case 'wayland':
        return this.applyWayland(input)
      case 'windows':
        return this.applyWindows(input)
      case 'macos':
        return this.applyMac(input)
      default:
        throw new Error(`no input injector for ${this.displayKind()}`)
    }
  }

  async exec(argv, opts = {}) {
    const result = await run(this.session.ctx, argv, {
      env: this.session.renderEnv(),
      maxBytes: 1 << 20,
      graceMs: opts.graceMs ?? 5000,
    })
    if (result.exitCode !== 0) {
      const detail = (result.stderr || result.stdout).trim().slice(0, 400)
      throw new Error(`${argv[0].split('/').pop()} failed (exit ${result.exitCode}): ${detail}`)
    }
    return result
  }

  /** Focus the only real application window, so keys have somewhere to land. */
  async focusX11Window(xdotool) {
    const search = await run(this.session.ctx, [xdotool, 'search', '--onlyvisible', '--name', '.'], {
      env: this.session.renderEnv(),
      maxBytes: 1 << 16,
    })
    const ids = search.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
    if (ids.length === 0) return false
    // Last id is the most recently mapped top-level window.
    await run(this.session.ctx, [xdotool, 'windowfocus', '--sync', ids[ids.length - 1]], {
      env: this.session.renderEnv(),
      maxBytes: 1 << 16,
    })
    return true
  }

  /**
   * Give a freshly focused window a moment to become the key target.
   *
   * Without a window manager there is no focus-in event to wait on: the client
   * learns it is focused asynchronously, and keystrokes sent immediately after
   * `windowfocus` race that handshake. On Wayland the same race drops the first
   * character typed into a newly focused surface. A short fixed settle is the
   * only portable remedy; it is small enough not to be felt by a caller.
   */
  async settleFocus(ms = 220) {
    await new Promise((resolve) => setTimeout(resolve, ms))
  }

  async applyX11(input) {
    const xdotool = this.session.tools?.xdotool
    if (xdotool === undefined) {
      throw new Error(
        'xdotool is not installed; it is required to inject input on an X11 display',
      )
    }

    // Chromium maps its window unfocused without a window manager, so type
    // would otherwise be delivered to the root window and vanish.
    if (input.kind === 'text' || input.kind === 'key') {
      await this.focusX11Window(xdotool)
      await this.settleFocus()
    }

    switch (input.kind) {
      case 'text': {
        const argv = [xdotool, 'type']
        if (input.delayMs !== undefined) argv.push('--delay', String(clampInt(input.delayMs, 0, 1000, 12)))
        argv.push('--', input.text)
        await this.exec(argv)
        return { kind: 'text', characters: input.text.length }
      }
      case 'key': {
        await this.exec([xdotool, 'key', '--clearmodifiers', input.key])
        return { kind: 'key', key: input.key }
      }
      case 'move':
        await this.exec([xdotool, 'mousemove', '--sync', String(input.x), String(input.y)])
        return { kind: 'move', x: input.x, y: input.y }
      case 'click': {
        const buttonNumber = { left: '1', middle: '2', right: '3' }[input.button]
        await this.exec([xdotool, 'mousemove', '--sync', String(input.x), String(input.y)])
        await this.exec([xdotool, 'click', '--repeat', String(input.count), buttonNumber])
        return { kind: 'click', x: input.x, y: input.y, button: input.button, count: input.count }
      }
      case 'scroll': {
        if (input.x !== undefined && input.y !== undefined) {
          await this.exec([xdotool, 'mousemove', '--sync', String(input.x), String(input.y)])
        }
        // X11 buttons 4/5 are wheel up/down.
        const buttonNumber = input.direction === 'up' ? '4' : '5'
        await this.exec([xdotool, 'click', '--repeat', String(input.amount), buttonNumber])
        return { kind: 'scroll', direction: input.direction, amount: input.amount }
      }
      default:
        throw new Error(`unsupported input kind "${input.kind}"`)
    }
  }

  /**
   * Focus the managed window on a sway session, so keys have a target.
   *
   * Without a window manager a newly mapped window is not necessarily focused,
   * and there is no focus event to await. Best-effort: a compositor without an
   * IPC socket simply skips this.
   */
  async focusSwayWindow() {
    const swaymsg = this.session.tools?.swaymsg
    if (swaymsg === undefined) return false
    try {
      await run(this.session.ctx, [swaymsg, 'focus', 'child'], {
        env: this.session.renderEnv(),
        maxBytes: 1 << 16,
      })
      return true
    } catch {
      return false
    }
  }

  async applyWayland(input) {
    const wtype = this.session.tools?.wtype
    const wlrctl = this.session.tools?.wlrctl

    if (input.kind === 'text' || input.kind === 'key') {
      await this.focusSwayWindow()
      await this.settleFocus()
    }

    switch (input.kind) {
      case 'text': {
        if (wtype === undefined) {
          throw new Error(
            'wtype is not installed; it is required to inject text on a Wayland display',
          )
        }
        // wtype's virtual keyboard must advertise its keymap before the client
        // can resolve a keycode, and it starts typing immediately. Every
        // invocation therefore loses its first character unless it is told to
        // wait first — `-s` is that wait, and it is mandatory here, not tuning.
        const argv = [wtype, '-s', String(clampInt(input.startDelayMs, 0, 2000, 300))]
        if (input.delayMs !== undefined) argv.push('-d', String(clampInt(input.delayMs, 0, 1000, 12)))
        argv.push(input.text)
        await this.exec(argv)
        return { kind: 'text', characters: input.text.length }
      }
      case 'key': {
        const tool = wtype ?? wlrctl
        if (tool === undefined) {
          throw new Error('wtype is not installed; it is required to inject keys on a Wayland display')
        }
        if (tool === wtype) {
          // Same keymap race as text: give the seat time to install the keymap.
          // wtype takes modifiers as press-then-release around the key, e.g.
          // `wtype -M ctrl -k c -m ctrl` for ctrl+c.
          const { modifiers, base } = splitKeySpec(input.key)
          const argv = [wtype, '-s', String(clampInt(input.startDelayMs, 0, 2000, 300))]
          for (const modifier of modifiers) argv.push('-M', modifier)
          argv.push('-k', base)
          for (const modifier of modifiers) argv.push('-m', modifier)
          await this.exec(argv)
          return { kind: 'key', key: input.key }
        }
        return { kind: 'key', key: input.key }
      }
      case 'move':
      case 'click':
      case 'scroll': {
        if (wlrctl === undefined) {
          throw new Error(
            'wlrctl is not installed; it is required to inject pointer events on a Wayland display',
          )
        }
        if (input.x !== undefined && input.y !== undefined) {
          await this.exec([wlrctl, 'pointer', 'move', String(input.x), String(input.y)])
        }
        if (input.kind === 'move') return { kind: 'move', x: input.x, y: input.y }

        if (input.kind === 'click') {
          const buttonName = input.button === 'left' ? 'left' : input.button
          for (let i = 0; i < input.count; i += 1) {
            await this.exec([wlrctl, 'pointer', 'click', buttonName])
          }
          return { kind: 'click', x: input.x, y: input.y, button: input.button, count: input.count }
        }

        const direction = input.direction === 'up' ? 'up' : 'down'
        for (let i = 0; i < input.amount; i += 1) {
          await this.exec([wlrctl, 'pointer', 'scroll', direction, '1'])
        }
        return { kind: 'scroll', direction, amount: input.amount }
      }
      default:
        throw new Error(`unsupported input kind "${input.kind}"`)
    }
  }

  async applyWindows(input) {
    // Everything is done through one PowerShell invocation so the parse cost
    // is paid once per injection.
    const script = windowsScript(input)
    await this.exec(['powershell', '-NoProfile', '-NonInteractive', '-Command', script])
    return { kind: input.kind }
  }

  async applyMac(input) {
    const script = macScript(input)
    await this.exec(['osascript', '-e', script])
    return { kind: input.kind }
  }
}

/** Build the PowerShell body for one input event. */
function windowsScript(input) {
  switch (input.kind) {
    case 'text':
      return [
        'Add-Type -AssemblyName System.Windows.Forms;',
        `[System.Windows.Forms.SendKeys]::SendWait(${psQuote(input.text)});`,
      ].join(' ')
    case 'key':
      return [
        'Add-Type -AssemblyName System.Windows.Forms;',
        `[System.Windows.Forms.SendKeys]::SendWait(${psQuote(toSendKeys(input.key))});`,
      ].join(' ')
    default:
      return [
        'Add-Type -AssemblyName System.Windows.Forms;',
        'Add-Type -MemberDefinition "[DllImport(\\"user32.dll\\")] public static extern void mouse_event(uint f, uint x, uint y, uint d, int e);" -Name U -Namespace W;',
        '[System.Windows.Forms.Cursor]::Position = ' +
          `(New-Object System.Drawing.Point ${input.x ?? 0},${input.y ?? 0});`,
        input.kind === 'click'
          ? `1..${input.count} | ForEach-Object { [W.U]::mouse_event(${input.button === 'right' ? '8' : '2'},0,0,0,0); [W.U]::mouse_event(${input.button === 'right' ? '16' : '4'},0,0,0,0) };`
          : input.kind === 'scroll'
            ? `[W.U]::mouse_event(0x0800,0,0,${input.direction === 'up' ? 120 * input.amount : -120 * input.amount},0);`
            : '',
      ].join(' ')
  }
}

/** Build the AppleScript body for one input event. */
function macScript(input) {
  switch (input.kind) {
    case 'text':
      return `tell application "System Events" to keystroke ${appleQuote(input.text)}`
    case 'key': {
      const { modifiers, base } = splitKeySpec(input.key)
      const using = modifiers.map((m) => `${m} down`).join(', ')
      return using.length > 0
        ? `tell application "System Events" to keystroke ${appleQuote(base)} using {${using}}`
        : `tell application "System Events" to key code ${macKeyCode(base)}`
    }
    case 'move':
      return `tell application "System Events" to set position of mouse cursor to {${input.x}, ${input.y}}`
    default:
      return `tell application "System Events" to click at {${input.x}, ${input.y}}`
  }
}

/** Escape a string for a PowerShell single-quoted literal. */
function psQuote(text) {
  return `'${String(text).replace(/'/g, "''")}'`
}

/** Escape a string for an AppleScript string literal. */
function appleQuote(text) {
  return `"${String(text).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/** Translate xdotool key names into SendKeys syntax. */
function toSendKeys(key) {
  const { modifiers, base } = splitKeySpec(key)
  const prefix = modifiers
    .map((m) => ({ ctrl: '^', alt: '%', shift: '+', super: '#' })[m] ?? '')
    .join('')
  const named = {
    Return: '{ENTER}',
    Enter: '{ENTER}',
    Tab: '{TAB}',
    Escape: '{ESC}',
    BackSpace: '{BACKSPACE}',
    Delete: '{DELETE}',
    Up: '{UP}',
    Down: '{DOWN}',
    Left: '{LEFT}',
    Right: '{RIGHT}',
    space: ' ',
  }[base]
  return prefix + (named ?? base)
}

/** Minimal key-code table for macOS named keys. */
function macKeyCode(key) {
  return (
    {
      Return: 36,
      Enter: 36,
      Tab: 48,
      Escape: 53,
      BackSpace: 51,
      Delete: 51,
      Up: 126,
      Down: 125,
      Left: 123,
      Right: 124,
      space: 49,
    }[key] ?? 36
  )
}
