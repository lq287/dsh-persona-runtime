# dsh-persona-runtime

[English](#english) | 中文

把小羽的人格做成 DSH 插件：**人格不再是"一段 prompt"，也不是"一个外部 HTTP 服务"**，而是宿主里的一层能力。装配、偏好、关系、权限都在 dsh 进程内生效。

> ⚠️ **这个插件是"壳"**：真正的语义（四层人格、两道偏好闸门、守卫、漂移基线）在一个 Python 包里，插件通过常驻 sidecar（`python -m persona.sidecar`）驱动它。**只装这个 npm 包跑不起来** —— 你需要那个 Python 包（`projectRoot` 指向它）。这样切是因为那套逻辑有 88 项自检盯着，用 Node 重写一遍必然出现两套语义。

## 它做什么

| 能力 | 实现 |
|---|---|
| **每轮自动注入人格** | `agent/pre-step` 把「关系层 + 偏好摘要 + 裁决顺序 + 场景风格 + 边界示范」作为一条 plugin 消息插进请求（核心由 `system-prompt` 的 persona 段常驻，`includeCore: true` 时也一起注入） |
| 6 个原生工具 | `persona_status` / `persona_assemble` / `persona_observe` / `persona_auth` / `persona_drift` / `persona_health` |
| 失败即降级 | sidecar 挂了 → 注入静默跳过、工具返回错误文本，**绝不让会话挂掉** |

和 `dsh-memory-pg` 同一个架构取向：**插件只注册工具、转发请求**。

```
dsh-plugin/
  package.json          dsh.bundle.patch → cordis.patch.yml
  cordis.patch.yml      插件树里插一行（id: persona）
  lib/index.js          Config(schemastery) + 6 个工具 + pre-step 注入
  lib/sidecar.js        常驻 `python -m persona.sidecar`，JSON-lines
  test/smoke.mjs        13 项协议/语义断言（不启 DSH 也能跑）
```

## 安装（三步 + 一次重启）

```powershell
# 1) 把插件装进 profile（先别选正在用的那个 web，见"风险"）
dsh plugin --profile <profile> add "file:D:\DSH proj\shell\persona\dsh-plugin"

# 2) 在该 profile 的 package.json 里加进 bundles
#    "dsh": { "profile": { "bundles": ["...", "dsh-persona-runtime"] } }

# 3) 在 profile 的 cordis.patch.yml（用户覆盖层）里给出必填配置
#    ★ 补丁整块替换 config，所以键要写全
- id: persona
  config:
    projectRoot: 'D:\DSH proj\shell'
    actor: 'qq:2872422308'      # 你本人；留空=匿名（陌生人档）
    backend: auto
    inject: true
    injectBudget: 3000

# 4) 重启 dsh（宿主会把插件加载进会话）
```

冒烟（不需要 DSH、不花 token）：

```powershell
cd persona\dsh-plugin
node test/smoke.mjs
```

预期 13 项全 `ok`：核心可渲染、owner→`closest`、陌生人→`familiar`、
人格段含硬边界与裁决顺序、陌生人不能 `core_edit`、漂移分在 0~1。

## 两件事必须一起做，否则会"两个人格"

1. **清空旧人设**：`proactive/headless-overlay.active.yml` 里 `system-prompt.persona`
   那段静态文本要删成空（或留一句"人格由 dsh-persona-runtime 插件注入"）。
   否则插件每轮注入一份、profile 里还常驻一份，两份会打架。
2. **`actor` 要跟着会话走**：插件配置里的 `actor` 是"当前对话者"，静态配置只能写死一个人。
   多人/多渠道场景要让调用方在会话里覆盖（或用 `persona_auth` 工具现查）。
   目前最简做法：给"你自己的 profile"配你的 owner 身份，给"对外值守的 profile"留空。

## 已知限制

- **`spawn EPERM`**：插件的 sidecar 用管道 stdio 起子进程。在**沙箱内**（workspace-write）
  跑 `node test/smoke.mjs` 会直接 EPERM —— 这是本机沙箱禁命名管道的老问题
  （`dsh-memory-pg` 也是靠宿主内运行绕过去的）。在宿主进程里跑不受影响。
- **`pythonExe`**：默认 `python`。服务器上是 `/opt/persona/.venv/bin/python`，要显式配。
- **关系档位靠 `owner` 白名单**：`state/owners.json` 里没有的身份一律 `familiar`。
  QQ 官方 bot 场景下同一个人有多个 openid，都要加进去（已踩过）。
- **偏好写入仍需要 DB**（`auto` 会退到 memory，重启即丢）；纯离线部署用 `backend: memory`。
