# Virtual Display — host capability probe (verified on this machine)

## Session
- Compositor: **niri 26.04** on Wayland; `WAYLAND_DISPLAY=wayland-1`; `DISPLAY=:0`
- Output: eDP-1 1920x1200
- `XDG_RUNTIME_DIR=/run/user/1001` is **READ-ONLY** in this sandbox (cannot create sockets/lockfiles there)

## Blocking host facts
- **No `/dev/dri`** -> no GPU, no DRM render node. Software rendering only (llvmpipe).
- **No `/dev/kvm`**, no qemu/qemu-img/virsh -> the **VM gear cannot be implemented natively here**.
- podman/docker binaries exist but `/run/user/1001/libpod` cannot be created -> container gear needs a configurable runtime dir.

## Tier probe results
| Backend | Verdict | Evidence |
|---|---|---|
| gamescope `--backend headless` | **NOT VIABLE** | reaches headless backend, sockets created, then `vkAllocateMemory failed (VkResult: -2)` -> `Failed to get DRM FD from renderer` -> `Assertion 'm_texture' failed` in `MouseCursor::getTexture()` at `../src/steamcompmgr.cpp:2359`, exit 134. `GAMESCOPE_RENDERER=gles LIBGL_ALWAYS_SOFTWARE=1` identical. |
| kwin_wayland `--virtual` | **NOT VIABLE** | exit 1: `failed to inherit capabilities: Operation not permitted` |
| Xvfb (X11) | **VIABLE** | `/nix/store/pg7d981bvshg7dv3ncq1dr2k9l60795m-xvfb-21.1.24/bin/Xvfb :N -screen 0 WxHx24 -nolisten tcp -noreset`; creates `/tmp/.X11-unix/XN`; server stable |
| chromium in Xvfb | **VIABLE** | window `0x200002` created, 800x600 |

## Required flags & paths (proven)
- chromium (156.0.8078.79) **MUST** get `--ozone-platform=x11`; without it ozone selects Wayland and chromium creates **0 X windows** (the X root capture stays black).
  - Symptom without it: `ERROR:ui/ozone/platform/wayland/common/drm_render_node_path_finder.cc:40] drmGetDevices2() has not found any devices`
  - Also needed: `--no-sandbox --disable-gpu --user-data-dir=<writable>`
- Xvfb: `/nix/store/pg7d981bvshg7dv3ncq1dr2k9l60795m-xvfb-21.1.24/bin/Xvfb`
- Capture: `/nix/store/8v793n92zi6apwmazy23gqhc8raszg6p-imagemagick-7.1.2-34/bin/import -window root OUT.png` (also `magick`/`convert`/`identify`)
- Alt capture: `/nix/store/sri5ylclw5pdjzi591ppcm66j9bmihqx-xwd-1.0.10/bin/xwd -root`
- Introspection: `xdpyinfo`, `xwininfo`, `xprop` in the nix store
- WMs available in store: `marco-1.28.2`, `mutter-50.5`
- Also present: `xvfb-run`, `wayland-info`, `chromium` at `/run/current-system/sw/bin/chromium`

## Capture sanity note
An **empty** Xvfb root legitimately captures as black/gray. Verify a tier works by launching a real client first.
Proof of a working chain: xmessage `-bg red` -> histogram red/white/black; chromium page `#163A6B` -> 347823 px of exactly `(22,58,107)`.
