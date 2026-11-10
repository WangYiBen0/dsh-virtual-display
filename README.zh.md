# dsh-virtual-display

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件：给 Agent 提供一块**私有显示器**用于渲染和截图，从而避免抢占你的桌面。

## 为什么需要它

当 Agent 需要知道一个窗口*实际*长什么样时，最直接的做法是截你的屏——或者更糟，在你当前的 `wayland-1` 会话里弹出窗口再截图。这两种方式都会抢走焦点，打断你正在做的事。

本插件提供一个工具 `virtual_display`：它启动一块只有 Agent 在用的显示器，在上面渲染，并把画面作为图片附件返回。你的会话完全不会被触碰。

## 工具接口

| `action` | 作用 |
|---|---|
| `inspect` | 在真正使用前，探测**当前主机**上哪些平台与隔离挡位实际可用 |
| `start` | 启动一块显示器，可选地同时拉起一个页面或程序；返回 `sessionId` |
| `capture` | 从指定会话截取渲染画面，并作为可查看的图片附件返回 |
| `stop` | 销毁会话 |

其他参数：`platform`（`x11` / `wayland` / `windows` / `macos`）、`gear`（`direct` / `container` / `vm`）、`width`、`height`、`target`、`args`、`argv`、`waitMs`、`settleMs`、`capturePath`、`keep`。

对同一个窗口反复迭代时，可以复用同一个 `sessionId` 多次调用 `capture`；每次 `start` 都会分配一块全新的显示器。

## 隔离挡位（Gear）

| 挡位 | 机制 |
|---|---|
| `direct` | 使用主机自身的显示栈渲染，但运行在私有显示器上 |
| `container` | 在一次性的 podman/docker 容器中运行渲染器 |
| `vm` | 通过 qemu 启动一次性的 qcow2 overlay 虚拟机 |

`inspect` 会探测主机并返回 `platforms` / `gears` 的支持情况，以及它刻意避开的当前用户会话信息——因此调用方可以提前看到：例如在没有 `/dev/kvm` 的机器上 `vm` 不可用。

### 如何隔离用户会话

`src/session.js` 通过 `privateBaseEnv()` 构造子进程环境，并**删除 `DISPLAY`、`WAYLAND_DISPLAY`、`XAUTHORITY`**。所有渲染器只会连接到分配出的私有显示器。即使调用方传入显式 `argv`，也无法触达你的会话。

## 依赖与已验证环境

已验证组合：

- **X11** — `Xvfb` + ImageMagick `import`
- **Wayland** — 嵌套合成器，失败时回退到 `xwayland` 模式
- **Windows** — PowerShell + .NET GDI+ `CopyFromScreen`
- **macOS** — `screencapture -x -o -l <windowId>`

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
src/exec.js               可执行文件解析（含 nix-store 回退路径）
src/backends/             x11、wayland、windows、macos 后端
```

## 测试

```sh
node .scratch/smoke.mjs          # 引擎 E2E，stub subprocess
node .scratch/manager-test.mjs   # 管理器 E2E：inspect/start/capture/stop/dispose
```

测试断言基于真实捕获像素，而不只是退出码。

## 许可证

MIT

## 挡位说明

| 挡位 | 状态 | 在你的环境中可能不可用的原因 |
|------|------|------------------------------|
| `direct` | ✅ 支持 | 使用主机自身的合成器/显示栈。只要系统具备可用显示后端（如 Xvfb、niri 等）即可工作。 |
| `container` | ✅ 支持 | 需要 podman 或 docker，并且容器运行时目录可写。若 `/run/user/1001` **只读**，则无法创建容器运行时目录。可尝试：<br>• 在启动前设置 `export XDG_RUNTIME_DIR=/tmp/xdg-runtime`（使用可写路径）<br>• 或使用拥有可写 `/run/user/<uid>` 的用户 |
| `vm` | ❌ 不支持/不可用 | 需要 `/dev/kvm`（或 qemu-tcg）以及 qcow2 overlay。若主机没有 `/dev/kvm` 且当前 profile 未配置 qemu 二进制，则 `vm` 在该主机上会被标记为不可用。 |

如果你需要类似 VM 的隔离显示，可以改用 `container` 并配置可写的运行时目录，或使用远程 VM，并通过 `target`/相关参数将 `virtual_display` 指向其 X11/Wayland socket。
