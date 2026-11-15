# dsh-virtual-display

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件：给 Agent 提供一块**私有显示器**用于渲染、操作和截图，从而避免抢占你的桌面。

四项能力，可各自独立使用：

- **私有显示器** —— 启动、渲染、截取真实像素。
- **合成输入** —— 往渲染结果里打字、点击、滚动，让 Agent 真正*操作*界面而不只是拍照。
- **实时面板** —— 在**右侧栏**直接看这块显示器，并亲手点进去。
- **静音音频** —— 每个会话的声音进入自己的 sink，永远不到你的扬声器。

## 为什么需要它

当 Agent 需要知道一个窗口*实际*长什么样时，最直接的做法是截你的屏——或者更糟，在你当前的 `wayland-1` 会话里弹出窗口再截图。这两种方式都会抢走焦点，打断你正在做的事。

本插件提供一个工具 `virtual_display`：它启动一块只有 Agent 在用的显示器，在上面渲染，并把画面作为图片附件返回。你的会话完全不会被触碰。

## 工具接口

| `action` | 作用 |
|---|---|
| `inspect` | 在真正使用前，探测**当前主机**上哪些平台与隔离挡位实际可用 |
| `start` | 启动一块显示器，可选地同时拉起一个页面或程序；返回 `sessionId` |
| `capture` | 从指定会话截取渲染画面，并作为可查看的图片附件返回 |
| `input` | 往会话中注入文本、组合键、点击、移动与滚动 |
| `view` | 返回“人类该如何实时查看这块显示器”的精确命令（本身不启动任何监听） |
| `stop` | 销毁会话 |

其他参数：`platform`（`x11` / `wayland` / `windows` / `macos`）、`gear`（`direct` / `container` / `vm`）、`width`、`height`、`target`、`args`、`argv`、`input`、`captureAfter`、`waitMs`、`settleMs`、`capturePath`、`keep`。

对同一个窗口反复迭代时，可以复用同一个 `sessionId` 多次调用 `capture`；每次 `start` 都会分配一块全新的显示器。

### 驱动显示器

`input` 每次接受一个事件：

```jsonc
{ "kind": "text",   "text": "hello" }          // 打字
{ "kind": "key",    "key": "ctrl+c" }          // 单个键或组合键
{ "kind": "click",  "x": 131, "y": 180 }       // 左/中/右键
{ "kind": "scroll", "direction": "down", "amount": 3 }
```

坐标是**显示器像素**，与 `capture` 返回的图片同一坐标系——从截图上读出位置，直接点它，无需换算。`captureAfter: true` 会在同一次调用里返回新的一帧。

底层实现：X11 用 `xdotool`（XTEST），Wayland 用 `wtype` + `wlrctl`，Windows 用 PowerShell，macOS 用 `osascript`。有两处坑必须处理，否则注入会静默失效：

- 没有窗口管理器时没有窗口持有焦点，按键会发给根窗口然后消失。注入器会先聚焦顶层窗口（X11）或让 sway 聚焦子窗口（Wayland）。
- `wtype` 是**异步**声明虚拟键盘 keymap 的，但立刻就开打，所以每次调用都会吞掉第一个字符——除非传 `-s`。这是正确性要求，不是调参。

headless wlroots 合成器上的指针注入是已知限制：seat 报 `capabilities: 0`，没有指针设备，所以点击不会生效。键盘可用，因为 `wtype` 会自建虚拟键盘。

### 实时面板

**右侧栏的一个 Tab**，按 1–3 fps 从 `/virtual-display/frame` 轮询一张 PNG，并把点击 POST 到 `/virtual-display/input`。放在侧栏而不是输入框下面，是因为实时画面属于「视口」而不是「输入控件」：它需要空间、有自己的生命周期，不该挤动对话，也不该在你离开输入框时消失。

面板所有文案都走 Client locale 服务（`ctx.locale.register` 加 slot 级别的 `locale:` 命名空间），简体中文与英文词典保持键完全一致。`node .scratch/i18n-test.mjs` 会在缺键、两种语言的占位符不一致、或组件里硬编码了可见文案时报错。点画面即按该点发送点击，坐标会按 `naturalWidth/clientWidth` 缩放，所以画面被缩小显示时也能点准。

这些路由挂在 Harness 自己的 Web 服务器上，面板与页面同源，不额外开端口。设 `webPanel: false` 可完全不注册它们。

### 静音音频

每个会话创建一个 PipeWire null sink（`dsh-vd-<id>`），并把渲染器路由进去，声音混进一个没人听的设备。`audio: inherit` 恢复外放；主机没有 PipeWire 时会话报告 `mode: unavailable`，而不是启动失败。

以下是实测而非假设：真正起作用的是 `PIPEWIRE_NODE`；`pw-play` 会**忽略** `PULSE_SINK`，直接链到真实扬声器。两者都会设置，但只有前者承载行为。插件还会在声称隔离之前**验证 sink 确实存在**——`pw-cli` 在什么都没创建时依然返回 0，早期版本因此谎报过「已隔离」。

## 隔离挡位（Gear）

| 挡位 | 机制 |
|---|---|
| `direct` | 使用主机自身的显示栈渲染，但运行在私有显示器上 |
| `container` | 在一次性的 podman/docker 容器中运行渲染器 |
| `vm` | 通过 qemu 启动一次性的 qcow2 overlay 虚拟机 |

`inspect` 会探测主机并返回 `platforms` / `gears` 的支持情况，以及它刻意避开的当前用户会话信息——因此调用方可以提前看到：例如在没有 `/dev/kvm` 的机器上 `vm` 不可用。

### 如何隔离用户会话

`src/session.js` 通过 `privateBaseEnv()` 构造所有子进程环境，渲染器只能触达分配出的私有显示器。要做到这一点需要三件事，插件全都做了：

1. **抹掉指向用户会话的变量** — 删除 `DISPLAY`、`WAYLAND_DISPLAY`、`WAYLAND_SOCKET`、`XAUTHORITY`、`XDG_SESSION_TYPE`、`XDG_CURRENT_DESKTOP`、`DESKTOP_SESSION`。
2. **断掉回退路径** — 只删 `WAYLAND_DISPLAY` **不够**：libwayland 会转而连接 `$XDG_RUNTIME_DIR/wayland-0`，那通常正是你的合成器。所以 `XDG_RUNTIME_DIR` 也会被改写为会话私有目录，其中根本没有 `wayland-0` 可找。
3. **钉住工具链后端** — GTK / Qt / SDL / Electron 在查看 `DISPLAY` 之前就各自选好了后端，因此会设置 `GDK_BACKEND=x11`、`QT_QPA_PLATFORM=xcb`、`SDL_VIDEODRIVER=x11`、`ELECTRON_OZONE_PLATFORM_HINT=x11`、`CLUTTER_BACKEND=x11` —— 但真正嵌套的 Wayland 合成器除外，那种情况下客户端必须留在 Wayland。

即使调用方传入显式 `argv`，也无法触达你的会话。`.scratch/safety-test.mjs` 会断言上述三条性质，包括调用方伪造 `DISPLAY` 也无法把用户会话塞回来。

## 依赖与已验证环境

已验证组合：

- **X11** — `Xvfb` + ImageMagick `import`
- **Wayland** — headless 合成器（依次尝试 `sway`、`mutter`、`gamescope`/`kwin_wayland`），全部失败时回退到 `xwayland` 模式
- **Windows** — PowerShell + .NET GDI+ `CopyFromScreen`
- **macOS** — `screencapture -x -o -l <windowId>`

可执行文件按 宿主解析 → `PATH` → profile bin → Nix store **按包名匹配**（绝不按 store hash）。早期版本把某次探测得到的绝对 `/nix/store/…` 路径写死了；那些 hash 后来都被 GC 回收，回退路径因此静默失效。`inspect` 现在会为每个平台报告 `driver`，解析错误一眼可见。

Wayland 截图需要合成器实现 `wlr-screencopy`。**sway 支持，mutter 不支持** —— mutter 在无 GPU 主机上能正常 headless 启动（日志会写 *"Created surfaceless renderer without GPU"*），但 grim 对它截图会失败并报 *"compositor doesn't support the screen capture protocol"*。因此 sway 排在第一位。`gamescope --backend headless` 与 `kwin_wayland --virtual` 在无 GPU 时都不可用，保留为后续尝试，而 Xwayland 回退保证平台整体仍可用。

在无 GPU 主机上，Chromium 可能自动选择 Wayland ozone 后端，从而不创建任何 X 窗口。本插件会显式传入 `--ozone-platform=x11`；完整探测记录与 `drm_render_node_path_finder.cc:40` 症状见 [docs/ENVIRONMENT-PROBE.md](docs/ENVIRONMENT-PROBE.md)。

## 安装

```sh
dsh plugin install /绝对路径/dsh-virtual-display
```

如默认值不合适，可配置 `runtimeRoot` / `defaultWidth` / `defaultHeight`。

## 目录结构

```
index.js                  插件入口：name、inject、Config、apply
cordis.patch.yml          写入 profile 的 bundle patch
src/tool.js               virtual_display 工具 + VirtualDisplayManager
src/session.js            会话生命周期、私有环境、基于像素变化的绘制等待与截图
src/capabilities.js       主机探测、平台/挡位选择
src/gears.js              direct / container / vm 隔离挡位
src/display-number.js     X 显示号分配（:90-:199），检查 socket + lock
src/exec.js               可执行文件解析（宿主 -> PATH -> profile -> nix 按包名匹配）
src/input.js              合成键鼠注入（X11 / Wayland / Windows / macOS）
src/panel.js              Web 实时面板的 HTTP 路由
src/audio.js              每会话 null sink 与音频路由
client.js                 Web 面板：右侧栏 Tab（实时画面 + 点击注入）
src/backends/             x11、wayland、windows、macos 后端
```

## 测试

```sh
node .scratch/smoke.mjs              # X11 E2E：Xvfb -> chromium -> 真实像素
node .scratch/wayland-test.mjs       # Wayland E2E：headless 合成器 -> grim -> 真实像素
node .scratch/input-test.mjs         # X11 E2E：打字与点击真的到达页面
node .scratch/wayland-input-test.mjs # Wayland E2E：wtype 真的到达页面
node .scratch/panel-test.mjs         # 面板路由跑在真实 HTTP 监听上
node .scratch/i18n-test.mjs          # 面板词典：键对齐、占位符、无硬编码文案
node .scratch/audio-test.mjs         # 音频进入会话 sink，而不是扬声器
node .scratch/view-test.mjs          # view 配方只指向私有会话
node .scratch/manager-test.mjs       # 管理器 E2E：inspect/start/capture/stop/dispose
node .scratch/safety-test.mjs        # 环境隔离（无需额外工具）
```

每个测试断言基于真实捕获像素、真实 HTTP 响应、真实 PipeWire 链路或真实环境属性——绝不只是退出码。这不是吹毛求疵：`pw-cli` 在什么都没创建时依然返回 0，若只看退出码，就会把不存在的音频隔离测成「通过」。

`safety-test.mjs` 不需要任何额外工具，是校验隔离承诺最廉价的回归防线。

**音频测试绝不允许发出声音。** 它们只播放数字静音（全零）PCM，这样路由出错时也是悄无声息的，而不是对着坐在机器前的人嘟嘟响。不要给测试加可听音调。

## 许可证

MIT

## 挡位说明

| 挡位 | 状态 | 在你的环境中可能不可用的原因 |
|------|------|------------------------------|
| `direct` | ✅ 支持 | 使用主机自身的合成器/显示栈。只要系统具备可用显示后端（如 Xvfb、niri 等）即可工作。 |
| `container` | ✅ 支持 | 需要 podman 或 docker，并且容器运行时目录可写。若 `/run/user/1001` **只读**，则无法创建容器运行时目录。可尝试：<br>• 在启动前设置 `export XDG_RUNTIME_DIR=/tmp/xdg-runtime`（使用可写路径）<br>• 或使用拥有可写 `/run/user/<uid>` 的用户 |
| `vm` | ❌ 不支持/不可用 | 需要 `/dev/kvm`（或 qemu-tcg）以及 qcow2 overlay。若主机没有 `/dev/kvm` 且当前 profile 未配置 qemu 二进制，则 `vm` 在该主机上会被标记为不可用。 |

如果你需要类似 VM 的隔离显示，可以改用 `container` 并配置可写的运行时目录，或使用远程 VM，并通过 `target`/相关参数将 `virtual_display` 指向其 X11/Wayland socket。
