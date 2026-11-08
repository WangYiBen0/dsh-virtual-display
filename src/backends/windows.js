// Windows backend.
//
// There is no Xvfb equivalent on Windows, so a *private* display means a
// headless/virtual session: either the app's own offscreen mode, or an RDP /
// virtual-desktop session. We implement it with PowerShell so no extra binary
// is required, and we always capture into a file we then read back.

import { mkdirSync } from 'node:fs'
import { run, sleep } from '../exec.js'

export class WindowsBackend {
  name = 'windows'

  async start(ctx, opts) {
    if (process.platform !== 'win32' && opts.force !== true) {
      throw new Error('the windows backend can only run on a Windows host')
    }
    mkdirSync(opts.runtimeDir, { recursive: true })
    // Windows has no per-app display allocation; the "virtual display" is a
    // private desktop within the session, described by metadata rather than a
    // device path. Capture is done with .NET GDI+ via PowerShell.
    const session = {
      backend: 'windows',
      mode: 'desktop',
      displayEnv: {},
      sockets: [],
      handle: undefined,
      runtimeDir: opts.runtimeDir,
      width: opts.width,
      height: opts.height,
      startedAt: Date.now(),
    }
    await sleep(opts.settleMs ?? 300, opts.signal)
    return session
  }

  async capture(ctx, session, opts) {
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms,System.Drawing;',
      '$b = [System.Windows.Forms.SystemInformation]::VirtualScreen;',
      'if ($env:VD_WIDTH) { $b = New-Object System.Drawing.Rectangle 0,0,[int]$env:VD_WIDTH,[int]$env:VD_HEIGHT };',
      '$bmp = New-Object System.Drawing.Bitmap $b.Width,$b.Height;',
      '$g = [System.Drawing.Graphics]::FromImage($bmp);',
      '$g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size);',
      `$bmp.Save(${JSON.stringify(windowsPath(opts.destPath))},[System.Drawing.Imaging.ImageFormat]::Png);`,
    ].join(' ')

    const result = await run(
      ctx,
      ['powershell', '-NoProfile', '-NonInteractive', '-Command', script],
      {
        env: {
          ...opts.env,
          ...session.displayEnv,
          VD_WIDTH: String(session.width ?? opts.width),
          VD_HEIGHT: String(session.height ?? opts.height),
        },
        maxBytes: 1 << 20,
        signal: opts.signal,
      },
    )
    if (result.exitCode !== 0) {
      throw new Error(`Windows capture failed: ${result.stderr.trim()}`)
    }
    return opts.destPath
  }

  async listWindows() {
    // Window enumeration needs user32 P/Invoke; omitted until required.
    return []
  }

  async settle(ctx, session, opts) {
    await sleep(opts.settleMs ?? 500, opts.signal)
    return session
  }

  async stop() {
    // Nothing persistent to tear down for a desktop-session capture.
  }
}

function windowsPath(path) {
  return path.replace(/\//g, '\\')
}
