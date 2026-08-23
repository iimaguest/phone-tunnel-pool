# phone-tunnel-pool — 面向 dsh web 图形界面的 Cloudflare 快速隧道池

[English](./README.md) | **简体中文**

通过一个悬浮组件（带有可扫描二维码），为 `http://127.0.0.1:3080`
（DeepSeek Harness 的 web 图形界面）启用/禁用**自愈式 Cloudflare 快速隧道池**。
用手机扫一次码，池子就自己保持存活：

- **分代轮换（12 小时）：** 新的一对隧道按时生成；只要旧的代还有流量就一直保持存活。
- **追猎 Service Worker：** 浏览器访问过的每个域名都会注册一个 service worker。
  失效或已轮换的主机名会重定向到存活的兄弟隧道或最新的主隧道 —— 只要连接不断，
  同一个打开的标签页就能挺过代际切换。
- **免弹窗迁移：** 代理只向已认证过的页面注入凭据；任何重定向前，看门狗会先
  认证目标主机名（铸造其登录 cookie），因此迁移落地即是已登录状态 —— 不会出现
  "需要认证" 弹窗。
- **按用量退役：** 代际只在空闲（无标签页 / WebSocket / 近期流量）或达到硬性
  寿命上限时才退役。
- **带退避的复活：** 失效隧道用新主机名替换；遵循快速隧道的配额（Cloudflare 429），
  采用指数退避 + 2 次探测的死区宽限（等待 DNS 传播）。

额外：守护进程以分离方式运行，在 `dsh web` 重启后**收养**既有隧道，
因此同一 URL、密码和二维码一直有效，直到你点击"禁用" —— 无需重新扫码
（系统重启仍需要重新扫一次；命名隧道连这一步都不需要 —— 见
[`PLAN.md`](./PLAN.md) §7）。

## 安装 / 卸载

```bash
# 安装（来自本公开仓库）
dsh plugin --profile web add github:iimaguest/phone-tunnel-pool
dsh web        # 图形界面右下角出现悬浮 📱 组件

# 卸载（一条命令 —— 同时移除依赖与 dsh.profile.bundles 层）
dsh plugin --profile web remove phone-tunnel-pool
dsh web
```

安装后：打开组件 → **启用** → 用手机相机扫描二维码。安装/移除会
自动对账 `dsh.profile.bundles` 与已安装状态 —— **切勿手工编辑
`~/.dsh/profiles/web/package.json`**；一条没有对应依赖的多余 bundle 条目
正是导致 profile 启动失败（"cannot resolve profile bundle"）的那种状态。

## 前置条件（全部列出）

| 项目 | 必需? | 由谁提供 |
|---|---|---|
| `dsh web` 运行在默认端口 **3080**（可用 `DSH_TARGET_PORT` 覆盖） | 必需 | 你自己（插件是*通向*它的隧道） |
| PATH 中的 `cloudflared` 可执行文件 | 必需 | 你自己 —— `brew install cloudflared`（或 apt/dnf/Chocolatey，或用 `DSH_CLOUDFLARED` 指定已有二进制） |
| Node.js 运行时 | 必需 | dsh 自带 —— 无需单独安装（守护进程复用 dsh 的 node） |
| `python3` + `qrcode` 包 | 可选 | 你自己 —— `pip install qrcode`；缺少时组件只显示 URL + 登录信息，不显示可扫描二维码 |
| `caffeinate` | 可选 | macOS 自带；其他平台跳过 |
| PowerShell | 可选 | Windows 自带 —— 仅用于 Windows 上的进程清理（那里没有 `pkill`） |
| 出站网络 | 必需 | cloudflared → Cloudflare 边缘节点 443/7844（无需入站端口） |

组件会在 **dsh web 启动时预检这些项**，在你点击"启用"之前就以黄色警告行
显示（并给出具体修复方式，如 `brew install cloudflared`）；如果启用时缺少
cloudflared，守护进程也会用可读的错误快速失败；弹窗里的"刷新"会重新检查一切 ——
前置条件满足后，过期的错误信息会自动清除。

特性标志集按 `cloudflared --version` 版本门控：2024.6+ 启用可选的
后量子握手（`DSH_PQ=1`），2024.8+ 增加 `--management-diagnostics=false`；
较旧的构建（apt/dnf 包）使用缩减的、兼容的标志集。

**平台。** macOS、Linux 和 Windows（Windows 使用 PowerShell 做进程清理；
`caffeinate` 仅限 macOS，其他平台静默跳过）。守护进程的状态文件与日志位于
各操作系统的临时目录（`os.tmpdir()`）；组件的设置文件
（`iptunnel-settings.json`）位于 `~/.dsh`。

## 截图

<p align="center">
  <img src="docs/phone-on-tunnel.jpg" alt="通过隧道池在手机上访问 dsh web" width="280">
</p>

<p align="center">
  <img src="docs/screenshot-widget.png" alt="隧道池组件：已启用的手机隧道与存活的代际池" width="380">
</p>

*截图中的活跃主机名、凭据与二维码均已模糊处理。*

## 工作原理

```
dsh web GUI  <--  /iptunnel 路由  --  认证代理 (127.0.0.1:3090)
                                              │  Basic + 会话 cookie,
                                              │  Host 改写为 127.0.0.1:3080
                                              │  （GUI 的浏览器信任围栏）
                                              ▼
cloudflared A ─ 到 ─ 认证代理 ───────────────────────────────────┐
cloudflared B ─ 到 ─ 认证代理 ───────────────────────────────────┤ （隧道守护进程
    ... 新代际 ...  ──────────────────────────────────   │   统一管理）
```

文件：`lib/index.js`（主机 API：启用/禁用/收养、状态与二维码 SVG 路由）、
`lib/daemon.mjs`（分离的池大脑：生成、探测、轮换、退役、复活）、
`cf-auth-proxy.mjs`（公有 `/iptunnel/*` 服务路径 + Basic 认证 +
看门狗注入 + 凭据交接）、`iptunnel-sw.js`（追猎 service worker）、
`iptunnel-watchdog.js`（打开标签页的看门狗）、`lib/client.js`（组件）、
`verify.sh`（端到端审计）。`PLAN.md` = 完整规格 + 边界情况；
`NOTES.md` = 工程历史。

## 资源占用（默认最小化）

- **禁用状态 = 零进程**（只保留 GUI 里的悬浮小图标）。
- **启用状态** = 1 个 node 守护进程 + 1 个认证代理 + 每个存活代际 2 个
  `cloudflared`。默认上限：4 代 × 2 = **8 条隧道**（繁忙时全部在跑；
  空闲代 60 分钟后自行退役）。
- 进一步缩小的旋钮：`DSH_MAX_GENS=2`（≤4 条隧道）、`DSH_IDLE_MS=1200000`
  （空闲 20 分钟即退役）；`DSH_PQ` —— 后量子握手**默认关闭**
  （`DSH_PQ=1` 开启），因为每次连接都有 CPU 开销；不开启时使用经典握手。
- **手机电量：** 看门狗在无变化时退避 30 秒 → 300 秒（5 分钟）。
- **保持唤醒为可选：** `caffeinate`（macOS）**默认关闭**；在组件里打开
  （"Keep machine awake while enabled"）或设置 `DSH_CAFFEINATE=1` ——
  下次"启用"时生效（并允许屏幕睡眠 —— 仅 `-i`，不额外耗电亮屏）。
  不开启时，闲置的 MacBook 可能休眠，池子在唤醒前保持静默。
- 守护进程日志上限 512 KB（保留最近 128 KB）；探测每 30 秒一次。

## 安全模型

- 密码**每次"启用"时生成**，仅存于内存，在组件中显示并嵌入二维码；
  不提交、不发布。（守护进程把*当前*凭据放在操作系统中临时目录下的
  `0600` 状态文件中，使隧道在 dsh web 重启后仍存活；禁用时删除该文件。）
- `/iptunnel/*` 服务路径（health、sw-config、sw.js、entry、watchdog.js、
  telemetry、preauth）**因故必须公开** —— 浏览器取 service worker 时不带凭据；
  它们只携带主机名与池存活信息。凭据交接（`/iptunnel/preauth`）只为
  出示了有效密码的调用方铸造 cookie，绝不回显任何内容。
- `window.__ptAuth` **只注入代理已认证过的 HTML**。
- 代理监听 127.0.0.1；公网暴露只通过隧道主机名发生 ——
  **二维码/主机名相当于随身令牌**（拿到它的人就能在启用期间打开隧道）：
  用完请禁用。
- 快速隧道属于测试级（无 SLA，按 IP 有生成配额）。
  [与该仓库解耦的同模式包](https://github.com/iimaguest/port-tunnel-pool)
  适用于任意本地端口；命名隧道是终极形态（一个稳定主机名 → 无需重扫、
  无弹窗、无配额）。

## 许可证

Apache-2.0 —— 见 [LICENSE](./LICENSE)。第三方代码：
[cloudflared](https://github.com/cloudflare/cloudflared)（由 Cloudflare 分发）、
Python `qrcode` 库 —— 仅在运行时使用，未随仓库内置。
