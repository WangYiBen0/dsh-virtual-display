// Guards the plugin's core promise: a renderer must never be able to reach the
// user's live display session, even when it asks for one explicitly.
import { privateBaseEnv } from '../src/session.js'

let failures = 0
const check = (label, ok, detail) => {
  if (ok) { console.log('ok:', label); return }
  failures += 1
  console.error('FAIL:', label, detail ?? '')
}

// Pretend to be a host with a live session.
const live = {
  DISPLAY: ':0',
  WAYLAND_DISPLAY: 'wayland-1',
  XDG_RUNTIME_DIR: '/run/user/1001',
  XAUTHORITY: '/run/user/1001/xauth',
  XDG_SESSION_TYPE: 'wayland',
  XDG_CURRENT_DESKTOP: 'niri',
  DESKTOP_SESSION: 'niri',
}

// 1. Scrubbed environment drops every live pointer.
{
  const env = privateBaseEnv(live)
  for (const key of Object.keys(live)) check(`drops ${key}`, env[key] === undefined, env[key])
}

// 2. A Wayland client cannot fall back to $XDG_RUNTIME_DIR/wayland-0.
{
  const env = privateBaseEnv(live, { runtimeDir: '/tmp/private-session' })
  check('redirects XDG_RUNTIME_DIR', env.XDG_RUNTIME_DIR === '/tmp/private-session')
  check('no WAYLAND_DISPLAY fallback', env.WAYLAND_DISPLAY === undefined)
}

// 3. Toolkits are pinned to X11 so they cannot choose Wayland on their own.
{
  const env = privateBaseEnv(live, { runtimeDir: '/tmp/private-session', pin: 'x11' })
  for (const key of ['GDK_BACKEND', 'QT_QPA_PLATFORM', 'SDL_VIDEODRIVER', 'ELECTRON_OZONE_PLATFORM_HINT']) {
    check(`pins ${key}`, env[key] !== undefined, env[key])
  }
  check('GDK is x11', env.GDK_BACKEND === 'x11')
  check('SESSION_TYPE is x11', env.XDG_SESSION_TYPE === 'x11')
}

// 4. An explicit caller-supplied env cannot smuggle the live session back in.
{
  const env = privateBaseEnv({ ...live, DISPLAY: ':0', WAYLAND_DISPLAY: 'wayland-1' }, { runtimeDir: '/tmp/p', pin: 'x11' })
  check('extra cannot restore DISPLAY', env.DISPLAY === undefined, env.DISPLAY)
  check('extra cannot restore WAYLAND_DISPLAY', env.WAYLAND_DISPLAY === undefined, env.WAYLAND_DISPLAY)
}

console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`)
process.exitCode = failures ? 1 : 0
