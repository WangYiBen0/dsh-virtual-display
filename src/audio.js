// Per-session audio isolation.
//
// A private display isolates pixels, not sound: a renderer that plays audio
// still plays it through the user's speakers. That is the wrong half of
// "silent" — an agent debugging a media app should not be audible in the room.
//
// The mechanism is one null sink per session plus a router variable in the
// renderer's environment, so every stream it opens lands in a sink nobody
// hears. Measured on this host (PipeWire 1.6.11 + WirePlumber):
//
//   PIPEWIRE_NODE=<sink name>  -> links into that sink   (verified)
//   PULSE_SINK=<sink name>     -> IGNORED by pw-play, still
//                                 reaches the real Speaker (verified)
//
// So PIPEWIRE_NODE is authoritative here, and PULSE_SINK is set as well for
// clients that only speak PulseAudio — it costs nothing and helps elsewhere.
//
// Nothing in this module reads or writes the user's default device. An earlier
// revision of this file was written against a report that creating a null sink
// silently mutes the default output on PipeWire 1.4.2 + KDE; that was measured
// again here and did NOT reproduce, so no "unmute the user" logic is included —
// guessing at a fix for a symptom we cannot observe would be worse than none.

import { run } from './exec.js'

/** Prefix for generated sink names, so cleanup can be precise. */
export const SINK_PREFIX = 'dsh-vd-'

/**
 * Node property recording which DSH process created a sink.
 *
 * `object.linger = true` is required — otherwise the sink would die the moment
 * `pw-cli` exits — but it also means the sink outlives us if the plugin process
 * is killed outright (`SIGKILL`, a crashed host, a `timeout` in a test). Those
 * orphans accumulate in the user's sound settings under the name "DSH virtual
 * display", which is exactly the kind of residue this plugin promises not to
 * leave behind. The owner pid is what makes them distinguishable from a sink
 * belonging to another, still-running DSH process.
 */
export const OWNER_PROP = 'dsh.vd.pid'

/** Is this pid still running? `EPERM` means alive but not ours. */
function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  if (pid === process.pid) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

/** True once this process has looked for orphans, so it happens at most once. */
let reapAttempted = false

/**
 * Destroy `dsh-vd-*` sinks whose owning process no longer exists.
 *
 * Runs lazily, immediately before the first sink this process creates, so a
 * host without PipeWire never pays for it and our own new sink cannot exist
 * yet. Sinks are matched by name prefix, then kept only when their owner pid is
 * dead — a concurrent DSH process must be left alone.
 *
 * A sink with no owner marker predates this property. It is reaped too: this
 * plugin is the only writer of the `dsh-vd-` namespace, so an unowned one can
 * only be a leftover from an older build.
 */
export async function reapOrphanSinks(session) {
  const dump = session.tools?.pwDump
  const pwCli = session.tools?.pwCli
  if (dump === undefined || pwCli === undefined) return []

  let parsed
  try {
    const result = await run(session.ctx, [dump], {
      env: { ...process.env },
      maxBytes: 1 << 24,
      graceMs: 8000,
    })
    parsed = JSON.parse(result.stdout)
  } catch {
    return []
  }

  const reaped = []
  for (const node of parsed ?? []) {
    const props = node?.info?.props
    const name = props?.['node.name']
    if (typeof name !== 'string' || !name.startsWith(SINK_PREFIX)) continue
    const owner = props?.[OWNER_PROP]
    if (owner !== undefined && isAlive(Number(owner))) continue
    try {
      await run(session.ctx, [pwCli, 'destroy', String(node.id)], {
        env: { ...process.env },
        maxBytes: 1 << 16,
        graceMs: 5000,
      })
      reaped.push(name)
    } catch {
      // Best effort: a sink we cannot remove is not worth failing a session.
    }
  }
  return reaped
}

/**
 * A session's audio sink.
 *
 * Lifecycle is explicit: `create()` then `destroy()`, and `destroy()` is
 * idempotent because teardown runs on several paths.
 */
export class AudioIsolation {
  constructor(session, options = {}) {
    this.session = session
    this.mode = options.mode ?? 'null-sink'
    this.sinkName = options.sinkName
    this.nodeId = undefined
    this.active = false
    /** Errors are reported, never thrown: audio must not break a display. */
    this.warning = undefined
  }

  /**
   * Environment for the audio daemon itself (pw-cli / pw-dump).
   *
   * These are control-plane calls, not renderers: they must reach the host's
   * PipeWire instance, which lives in the *user's* runtime dir. Using the
   * render environment here rewrites XDG_RUNTIME_DIR to the session directory,
   * where there is no pipewire-0 socket, and every call silently fails —
   * pw-cli still exits 0 while creating nothing.
   */
  controlEnv() {
    return { ...process.env }
  }

  /** Environment additions that route a renderer into this session's sink. */
  env() {
    if (!this.active || this.sinkName === undefined) return {}
    return {
      // PipeWire-native clients (pw-play, most modern toolkits).
      PIPEWIRE_NODE: this.sinkName,
      // PulseAudio-speaking clients, when the session has a Pulse bridge.
      PULSE_SINK: this.sinkName,
      // Belt and braces for clients that consult the ALSA/Pulse default name.
      PULSE_SERVER: process.env.PULSE_SERVER,
    }
  }

  /**
   * Create the sink.
   *
   * Failure is non-fatal by design: a host without PipeWire still gets a
   * working display, just an audible one, and `describe()` reports that.
   */
  async create() {
    if (this.mode === 'inherit') {
      this.warning = 'audio is not isolated (mode: inherit); sound goes to the default device'
      return this
    }

    const pwCli = this.session.tools?.pwCli
    if (pwCli === undefined) {
      this.mode = 'unavailable'
      this.warning =
        'pw-cli is not installed; audio from this display will reach the default output device'
      return this
    }

    const name = `${SINK_PREFIX}${String(this.session.options.sessionId ?? process.pid).slice(0, 8)}`
    // pw-cli takes the whole SPA-JSON properties blob as ONE argv element; it
    // has no script-file option, so a newline-separated script is not valid.
    const properties = [
      '{',
      'factory.name = support.null-audio-sink',
      `node.name = ${name}`,
      `node.description = "DSH virtual display"`,
      'media.class = Audio/Sink',
      'object.linger = true',
      'audio.position = [ FL FR ]',
      '}',
    ].join(' ')

    try {
      await run(this.session.ctx, [pwCli, 'create-node', 'adapter', properties], {
        env: this.controlEnv(),
        maxBytes: 1 << 16,
        graceMs: 5000,
      })

      // pw-cli exits 0 even when the node never appears, so the exit code
      // proves nothing. Confirm the sink exists before claiming isolation —
      // claiming it on faith is how an earlier build reported "isolated: true"
      // while audio still went to the speakers.
      this.nodeId = await this.waitForNode(name)
      if (this.nodeId === undefined) {
        this.mode = 'unavailable'
        this.warning =
          'pw-cli accepted the request but the sink never appeared; audio will reach the default output device'
        return this
      }
      this.sinkName = name
      this.active = true
    } catch (error) {
      this.mode = 'unavailable'
      this.warning = `could not create an audio sink: ${messageOf(error)}`
    }
    return this
  }

  /**
   * Wait for the sink to appear, returning its node id.
   *
   * Polls because node publication is asynchronous: a single immediate read can
   * miss a sink that is about to exist.
   */
  async waitForNode(name, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const id = await this.findNodeId(name)
      if (id !== undefined) return id
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    return undefined
  }

  /** Look the sink up by name in pw-dump output. */
  async findNodeId(name) {
    const dump = this.session.tools?.pwDump
    if (dump === undefined) return undefined
    try {
      const result = await run(this.session.ctx, [dump], {
        env: this.controlEnv(),
        maxBytes: 1 << 24,
        graceMs: 8000,
      })
      const parsed = JSON.parse(result.stdout)
      for (const node of parsed) {
        const props = node?.info?.props
        if (props?.['node.name'] === name) return node.id
      }
    } catch {
      // Resolution failure is not fatal here; the caller decides.
    }
    return undefined
  }

  /** Remove the sink. Safe to call when creation failed. */
  async destroy() {
    if (!this.active) return
    const pwCli = this.session.tools?.pwCli
    this.active = false
    if (pwCli === undefined) return
    const target = this.nodeId ?? this.sinkName
    if (target === undefined) return
    try {
      await run(this.session.ctx, [pwCli, 'destroy', String(target)], {
        env: this.controlEnv(),
        maxBytes: 1 << 16,
        graceMs: 5000,
      })
    } catch {
      // A lingering sink is harmless; the next run uses a fresh name.
    }
    this.nodeId = undefined
  }

  /** What `session.describe()` reports. */
  describe() {
    return {
      mode: this.mode,
      sink: this.sinkName,
      isolated: this.active,
      ...(this.warning === undefined ? {} : { warning: this.warning }),
    }
  }
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}
