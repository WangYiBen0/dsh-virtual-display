// Isolation gears (挡位).
//
// A gear decides WHERE the rendering process runs; a backend decides WHAT
// display it renders onto. They compose:
//
//   direct     -> the renderer runs on this host, on a private virtual display
//   container  -> the renderer runs in a disposable container, display passed in
//   vm         -> the renderer runs in a disposable VM, capture pulled back out
//
// Every gear exposes the same tiny interface so the tool layer never branches
// on it: wrap(argv, opts) -> { argv, env, cwd, teardown }.

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { run } from './exec.js'

export class DirectGear {
  name = 'direct'

  async prepare(_ctx, opts) {
    mkdirSync(opts.runtimeDir, { recursive: true })
    return {
      gear: 'direct',
      /** Run a command as-is, on the host, against the private display. */
      wrap(argv, extra = {}) {
        return { argv, env: { ...opts.env, ...extra.env, ...opts.displayEnv }, cwd: extra.cwd }
      },
      async teardown() {},
    }
  }
}

export class ContainerGear {
  name = 'container'

  async prepare(ctx, opts) {
    const runtime = opts.runtime
    if (runtime === undefined) {
      throw new Error('no container runtime (podman or docker) is available')
    }
    mkdirSync(opts.runtimeDir, { recursive: true })

    // A container has its own filesystem, so an X11 unix socket must be shared
    // explicitly. We publish it as a directory mount rather than a raw socket.
    const image = opts.image ?? 'docker.io/library/alpine:latest'
    const name = `dsh-vd-${process.pid}-${Date.now().toString(36)}`

    const baseArgs = [
      runtime,
      'run',
      '--rm',
      '--name',
      name,
      '--runtime-dir',
      opts.runtimeDir,
      '-v',
      `${opts.runtimeDir}:${opts.runtimeDir}:rw`,
    ]

    let pulled = false
    const ensureImage = async () => {
      if (pulled) return
      const inspect = await run(ctx, [runtime, 'image', 'exists', image], {
        env: opts.env,
        cwd: opts.runtimeDir,
      })
      if (inspect.exitCode !== 0) {
        const pull = await run(ctx, [runtime, 'pull', image], {
          env: opts.env,
          cwd: opts.runtimeDir,
          maxBytes: 1 << 22,
        })
        if (pull.exitCode !== 0) {
          throw new Error(`failed to pull container image ${image}: ${pull.stderr.trim()}`)
        }
      }
      pulled = true
    }

    return {
      gear: 'container',
      name,
      image,
      wrap(argv, extra = {}) {
        return {
          argv: [...baseArgs, ...(extra.mounts ?? []), image, ...argv],
          env: { ...opts.env, ...extra.env, ...opts.displayEnv, XDG_RUNTIME_DIR: opts.runtimeDir },
          cwd: extra.cwd,
        }
      },
      async ensure() {
        await ensureImage()
      },
      async teardown() {
        await run(ctx, [runtime, 'rm', '-f', name], { env: opts.env }).catch(() => undefined)
      },
    }
  }
}

export class VmGear {
  name = 'vm'

  async prepare(ctx, opts) {
    const qemu = opts.qemu
    if (qemu === undefined) throw new Error('qemu-system-x86_64 is not available')

    mkdirSync(opts.runtimeDir, { recursive: true })
    const disk = join(opts.runtimeDir, 'vm.qcow2')
    const seed = join(opts.runtimeDir, 'seed.img')

    // A discardable overlay: the base image is never modified, so every run
    // starts from a clean, known-good state.
    if (opts.baseImage !== undefined) {
      const create = await run(
        ctx,
        [opts.qemuImg ?? 'qemu-img', 'create', '-f', 'qcow2', '-F', 'qcow2', '-b', opts.baseImage, disk],
        { env: opts.env, maxBytes: 1 << 20 },
      )
      if (create.exitCode !== 0) {
        throw new Error(`qemu-img create failed: ${create.stderr.trim()}`)
      }
    }
    writeFileSync(join(opts.runtimeDir, 'vm.notes'), 'ephemeral overlay; deleted on teardown\n')

    const acceleration = opts.acceleration ?? 'tcg'
    const argv = [
      qemu,
      '-machine',
      'q35',
      '-accel',
      acceleration,
      '-m',
      opts.memory ?? '2048',
      '-smp',
      String(opts.cpus ?? 2),
      '-display',
      'none',
      '-vnc',
      `127.0.0.1:${opts.vncPort ?? 0}`,
      '-serial',
      'mon:stdio',
    ]
    if (opts.baseImage !== undefined) {
      argv.push('-drive', `file=${disk},if=virtio,format=qcow2`)
    }
    if (opts.cloudInit !== false) {
      argv.push('-drive', `file=${seed},if=virtio,format=raw`)
    }

    return {
      gear: 'vm',
      argv,
      disk,
      seed,
      acceleration,
      /** A VM is a whole machine; commands are injected over serial/ssh, not argv. */
      wrap(command) {
        return {
          mode: 'serial',
          command,
          note: 'VM gear boots a guest; payload execution uses the guest serial console',
        }
      },
      async teardown() {
        // Cleanup is the lifecycle manager's job (it owns the qemu process).
      },
    }
  }
}

export function createGear(gear) {
  switch (gear) {
    case 'direct':
      return new DirectGear()
    case 'container':
      return new ContainerGear()
    case 'vm':
      return new VmGear()
    default:
      throw new Error(`unknown gear "${gear}"`)
  }
}
