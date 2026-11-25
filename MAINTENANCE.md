# Session Alarm 维护指南（Antigravity 适配版）

本文档记录本插件针对 Antigravity 的增强逻辑、权限联动机制与后续 Antigravity 升级后的排查修复流程。

---

## 1. 概述与文件结构

- **适用端**：专用于 **Antigravity 桌面端 App（Desktop App）**；**Antigravity IDE 与 Antigravity CLI 暂未适配与测试（不保证兼容）**。
- **插件安装目录**：
  - Windows：`%USERPROFILE%\.gemini\config\plugins\session-alarm`
  - macOS / Linux：`~/.gemini/config/plugins/session-alarm`
- **无自动升级**：纯本地插件目录，不含联网检查更新逻辑；插件目录不会在后台被静默覆盖。

| 路径 | 作用 |
|---|---|
| `hooks.json` | 生命周期钩子注册，监听 `SessionStart`、`PreToolUse`、`PostToolUse`（`run_command\|edit_file\|...\|read_file\|view_file\|mcp_.*\|call_mcp_tool`）、`Stop` |
| `sidecars/watcher/sidecar.json` | 无头 Sidecar 清单：向 Antigravity 注册后台常驻进程（`restart_policy: "always"`），由宿主注入 `ANTIGRAVITY_LS_ADDRESS` 与 `ANTIGRAVITY_CSRF_TOKEN` |
| `sidecars/watcher/watcher.mjs` | Sidecar 监听主进程：轮询本地语言服务器 `GetAllCascadeTrajectories` 的 `waitingSteps`，仅在真实弹窗出现时异步触发 `PermissionRequest`，并每 5 秒写 `sidecar-state.json` 心跳 |
| `sidecars/watcher/lib/waiting.mjs` | 纯函数模块：`parseLsEndpoint`、`extractTrajectories` 与 `WaitingTracker` 边沿状态跟踪 |
| `scripts/agy_hook.mjs` | Antigravity 钩子适配器：优先检测 `sidecar-state.json`（健康且未过期时抑制 5 秒延迟计时器与 `ask_question` 重复触发）；Sidecar 不可用时自动无缝回退至原有白名单 + 5 秒延迟审批方案，并始终负责 `SessionStart` 与 `Stop` |
| `scripts/delay_alert_worker.mjs` | 脱离后台延迟计时子进程（Hook 兜底模式下使用）：等待 `delayMs` 后检查 `pending/<toolCallId>.json`，未被取消则写日志并调用 `session_alarm.py` 触发 `PermissionRequest` |
| `session_alarm/core.py` | 事件分类（`event_from_hook`）、中文/英文/韩文报错识别（`stop_has_error`）、Windows 同步音频播放（`winsound`） |
| `scripts/session_alarm.py` / `session_alarm/cli.py` | CLI 配置、自定义 WAV 导入、试播与测试入口 |
| `%APPDATA%\session-alarm\`（Win）<br>`~/.config/session-alarm/`（Unix） | 运行时状态目录：`config.json`、`custom-sounds.json`、`custom/*.wav`、`history.jsonl`、`runtime.json`、`sidecar-state.json`（Sidecar 心跳）、`pending/`（兜底短生命周期计时器标记） |
| `~/.gemini/config/config.json` | Antigravity 全局配置（只读）：`userSettings` 权限档位与 `globalPermissionGrants.allow` |
| `~/.gemini/config/projects/*.json` | Antigravity 项目级配置（只读）：`projectResources`、`permissionGrants`、`settings` |
| `~/.gemini/antigravity/builtin/skills/agy-customizations/docs/hooks.md` | Antigravity 随版本更新的内置 Hook 协议文档（升级后排查首要参考） |

---

## 2. Antigravity 增强特性清单（与上游原版的差异）

### 2.1 默认声音映射（内置 CC0 动物音效）
- **`attention`（等待审批/输入）**：`cat`
- **`complete`（任务完成）**：`rooster`
- **`error`（发生错误）**：`crow`
- **`session_end`（会话结束）**：已静默（`hooks.json` 未监听 `SessionEnd`，且 `core.py` 中 `SessionEnd` 直接 `return None`）

用户可通过 `session_alarm.py custom add` 与 `configure` 在本机自行替换为任意合法本地 WAV。

### 2.2 混合真弹窗检测：Sidecar 主检测 + Hook 自动兜底（`sidecars/watcher/` + `agy_hook.mjs`）
- **Sidecar 实时真弹窗检测（主路径）**：
  - `sidecars/watcher/watcher.mjs` 由 Antigravity 作为后台 Sidecar 启动并切出插件目录（防止 Windows 卸载/更新锁目录），通过本地回环 HTTP 调用 `GetAllCascadeTrajectories`（活跃对话时每 `500ms`、空闲时每 `2000ms` 轮询一次）。
  - 通过 `WaitingTracker` 跟踪非空闲对话的 `waitingSteps` 数组，**仅在弹窗/等待输入真实出现（状态边沿跃迁）时**异步调用 `session_alarm.py` 触发 `attention`，并在 `history.jsonl` 记为 `hookEventName: "SidecarWaiting"`、`reason: "sidecar_waiting_step"`。
  - Sidecar 每 `5000ms` 原子写入一次 `sidecar-state.json`（默认 TTL `15000ms`）。当 `agy_hook.mjs` 检测到 `sidecar-state.json` 健康且未过期时：
    - 抑制 `PreToolUse` 的 5 秒延迟计时器与 `ask_question` 立即播报（保留 `WRITE_TOOLS` 的 `ArtifactMetadata.RequestFeedback === true` 立即提醒，并由 `core.py` 1.5s 去重保护）；
    - 保持所有安全 `decision` 返回值不变（绝不强行返回 `"allow"` 绕过审批）。
- **自动降级兜底（Fallback）**：
  - 若 `GetAllCascadeTrajectories` 连续失败 3 次（例如未来 Antigravity 升级更改了内部 RPC）、Sidecar 未启动/已退出，或设置了 `SESSION_ALARM_DISABLE_SIDECAR=1`，`sidecar-state.json` 立即标记 `healthy: false` 或超过 TTL，`agy_hook.mjs` 自动无缝切换回下方的 `PreToolUse` + `PostToolUse` + 5 秒延迟计时器方案。

### 2.3 `PreToolUse` + `PostToolUse` 触发规则（`hooks.json` + `agy_hook.mjs` + `delay_alert_worker.mjs`）
- **`PreToolUse` matcher 范围**：
  `ask_question|run_command|edit_file|write_file|code_action|write_to_file|replace_file_content|multi_replace_file_content|read_file|view_file|mcp_.*|call_mcp_tool`
- **`PostToolUse` matcher 范围**：
  `run_command|edit_file|write_file|code_action|write_to_file|replace_file_content|multi_replace_file_content|read_file|view_file|mcp_.*|call_mcp_tool`
- **立即触发 `attention`（非阻塞后台播放）**：
  - `ask_question`（弹出选择题）
  - `write_file` / `edit_file` 且 `ArtifactMetadata.RequestFeedback === true`（且 `artifactReviewMode` 不为 `TURBO`）
  - 以上立即触发项均通过 `delay_alert_worker.mjs --immediate` 脱离后台异步播放，让 `PreToolUse` 立即返回、不拖慢审批窗口弹出。
- **延迟审批提醒（待审查 `run_command`、工作区外 `WRITE_TOOLS`、`read_file` / `view_file` 与 `mcp_.*`）**：
  - 非 Turbo 模式下，`PreToolUse` 对未命中白名单的待审查 `run_command`（`BypassSandbox: true` 或 `Review` 模式，默认 `5000ms`，可通过 `SESSION_ALARM_DELAY_COMMAND_MS` 覆盖）、工作区外 `WRITE_TOOLS`（默认 `5000ms`，可通过 `SESSION_ALARM_DELAY_WRITE_MS` 覆盖；仅当前对话 `artifactDirectoryPath` 与工作区免审批，跨对话 `brain/<其他ID>` 写入不放行）、工作区与当前对话外 `read_file`/`view_file`（默认 `5000ms`，可通过 `SESSION_ALARM_DELAY_READ_MS` 覆盖；工作区、当前对话 `artifactDirectoryPath` 及命中 `read_file(...)` 白名单直接跳过不启闹钟）和未命中白名单/免跳过前缀的 `mcp_.*` / 懒加载 MCP `call_mcp_tool`（默认 `5000ms`，可通过 `SESSION_ALARM_DELAY_MCP_MS` 覆盖）写入 `pending/<pendingId>.json` 并以 `detached` + `unref()` 拉起 `delay_alert_worker.mjs`，同时安全返回 `{ decision: "ask" }`（绝不返回 `"allow"` 或 `{}`）。
  - 正常免审批（或已在当前会话通过「在此会话中始终允许」/ 单对话本地权限放行）的操作会在超时前结束，由 `PostToolUse` 删除标记文件静默取消闹钟；若被审批弹窗阻塞超过阈值，worker 原子删除标记、写入 `triggered` 日志并触发 `PermissionRequest` 响 `attention`。
  - `Stop` 触发时自动清理同 `conversationId` 的残留 pending 标记，防止中止后幽灵提醒；超过 5 分钟的陈旧标记在下次武装时自动清扫。
- **Windows Python 发现**：自动扫描 `%APPDATA%\uv\python\cpython-*\python.exe`（按版本号降序优先），找不到再依次回退 `py -3`、`python`、`python3`。
- **实时联动全局/项目权限与「总是允许」白名单（`loadAgyPermissionContext`）**：
  - 每次 `PreToolUse` 触发时只读加载全局 `config.json` 与匹配当前 `workspacePaths` 的 `projects/*.json`（支持 URL 编码的路径）。
  - 白名单支持：
    - `command(...)`：整条精确匹配、命令前缀（空格/制表符边界）、`*` 通配符
    - `write_file(...)` / `edit_file(...)` / `read_file(...)`：路径大小写与斜杠归一化、目录前缀、`*`/`**` 通配符
    - MCP 授权：`mcp(...)` / `call_mcp_tool(...)` / 裸 `server/tool` / `mcp_*` 精确或通配符匹配；也支持通过 `SESSION_ALARM_SKIP_MCP_PREFIXES` 跳过自定义受信任前缀（默认不跳过任何前缀）。
  - 权限档位策略（`parseCommandMode` 同时兼容旧版枚举 `TURBO` / `EAGER` / `OFF` / `AUTO` / `DEFAULT` 与新版策略名 `always-proceed` / `request-review` / `strict` / `proceed-in-sandbox`）：
    - **极速（Turbo）**：命令、工作区外写文件、以及 `read_file`/`view_file`/`mcp_.*` 延迟提醒均静默跳过（其中 `read_file`/`view_file`/`mcp_.*` 仍返回 `{ decision: "ask" }`）
    - **自动（Auto）/ 默认（Default）**：沙箱外 `run_command`（`BypassSandbox: true`）、工作区外写文件（均查白名单未命中时）与 `read_file`/`view_file`/`mcp_.*`/`call_mcp_tool` 均启用 `5000ms` 延迟审批提醒
    - **请求审查（Review）**：所有 `run_command`（含沙箱内）、工作区外写文件（均查白名单未命中时）与 `read_file`/`view_file`/`mcp_.*`/`call_mcp_tool` 均启用 `5000ms` 延迟审批提醒
- **安全不变量**：对于命中白名单的外部写文件、待审查命令，以及 `read_file`/`view_file`/`mcp_.*`，`agy_hook.mjs` 一律返回 `{ decision: "ask" }`（绝不替 Antigravity 强行返回 `"allow"`），由 Antigravity 自身的权限缓存决定放行或弹窗。

### 2.4 `Stop` 触发规则（`agy_hook.mjs` + `core.py`）
- **静默过滤**：子代理会话（无 `USER_INPUT`）、`USER_CANCELED`、`RUNNING` 后台任务、异步委派与交接/等待工具（`invoke_subagent` / `send_message` / `schedule` / `exit_plan_mode` / `swarm_wait`）、`continuationActive`、`fullyIdle === false` 均直接跳过（`run_workflow` 支持 `WaitMsBeforeAsync` 同步返回，继续由 `fullyIdle === false` 与 `RUNNING` 步骤状态兜底）。
- **不根据回复问句猜 `attention`**：`event_from_hook` 的 `Stop` 分支不调用 `stop_needs_input`，正常结束只区分 `error` 与 `complete`。
- **错误检测（`StopFailure` 或 `stop_has_error`）**：
  - `StopFailure`（`terminationReason === "ERROR"` 或带 `error`）直接归为 `error`。
  - 检查回复末尾 700 字符：除原版英文/韩文正则外，`_has_chinese_error` 会先剔除 Markdown 代码块与行内反引号，按标点分句后过滤含 `已修复`、`已解决`、`无报错`、`0 个失败`、`如果/假如` 等否定/假设词的分句，再匹配中文报错表达。
  - 其余正常完成一律归为 `complete`。

### 2.5 已知边界
- **Hook 兜底模式下**：聊天界面左下角「本地权限」的**单对话临时切换**以及弹窗上的「在此会话中始终允许」仅保存在 Antigravity 内存会话状态中，不会写入 `config.json`、`projects/*.json` 或 `transcript.jsonl`，外部钩子无法感知；**全局/项目设置页面修改**及**「总是允许」增删**均可 100% 实时同步。Sidecar 主检测模式下直接读取语言服务器 `waitingSteps`，不受上述内存开关盲区影响。
- **Sidecar 依赖内部接口**：`GetAllCascadeTrajectories` / `waitingSteps` 属于 Antigravity 未公开本地接口；若未来升级失效，会触发自动降级至 Hook 兜底模式。

---

## 3. Antigravity 升级后的排查与修复清单（Runbook）

当升级 Antigravity 后发现“不响、误响、或白名单失效”，按以下 4 步排查：

1. **先看执行日志与 Sidecar 状态**：
   - 检查状态目录下的 `sidecar-state.json`（确认 `healthy: true` 且 `updatedAtMs` 在最近 15 秒内，以及是否有 `reason: "rpc_unavailable"`）；
   - 读取状态目录下的 `history.jsonl` 最后 20 行，重点核对 `hookEventName`（`SidecarWaiting` / `PreToolUse` / `Stop`）、`toolName`、`action`（`triggered` / `skipped`）、`reason`、`mappedEvent`。
2. **核对最新 Hook 协议**：查看 `~/.gemini/antigravity/builtin/skills/agy-customizations/docs/hooks.md`：
   - 若官方新增了原生的审批弹窗事件（如原生 `PermissionRequest`），可直接替换 `PreToolUse` 里的权限启发式判断。
   - 检查工具名或参数名是否变化（如 `BypassSandbox`、`CommandLine`、`ArtifactMetadata.RequestFeedback`、`Path`）。
   - 检查 `Stop` 字段是否变化（`fullyIdle`、`continuationActive`、`terminationReason`、`transcriptPath`）。
3. **核对权限配置联动（注意硬编码安全边界）**：
   - Antigravity 对 `~/.gemini/config/config.json` 设有硬编码系统保护边界，会直接拒绝 AI 代理的 `read_file` 工具访问（`agy_hook.mjs` 作为外部 Node 进程直接读取本地文件，不受影响）。
   - **请勿让 AI 直接 `read_file` 读取 `config.json`**；应先通过 `history.jsonl` 中是否出现 `allowed_by_permission_grant` / `skipped_by_turbo_mode` 间接验证权限联动是否生效；仅在怀疑字段结构变化时，由用户手动贴出脱敏后的 `userSettings`（`permissionPreset`、`autoExecutionPolicy`、`nonWorkspaceFileAccessPolicy`、`globalPermissionGrants.allow`）与 `projects/*.json`（`projectResources.resources[].folderUri`、`permissionGrants`、`settings`）键名片段。
4. **区分 Hook 问题还是音频/Python 问题**：运行 CLI 的 `status` 和 `test` 命令；若 `test` 能正常出声但对话不响，说明问题在 `hooks.json` 或 `agy_hook.mjs`。注意：Windows 下若在受限终端沙箱中运行，`py -3` 或读取 `%APPDATA%\session-alarm\config.json` 可能因权限边界报错，请在普通 PowerShell 终端或沙箱外通过 uv 管理的 `python.exe` 执行 `status` / `test`。

---

## 4. 常用维护与静音测试命令

> Windows 下统一使用 Python 3.9+（如 uv 管理的 Python 或 `py -3`），且**不要手改状态目录中的 `config.json`**（必须通过 CLI 修改，以保证按音量重采样缓存生效）：

```powershell
$CLI = "$env:USERPROFILE\.gemini\config\plugins\session-alarm\scripts\session_alarm.py"
# 也可改用 python 或 $env:APPDATA\uv\python\...\python.exe

py -3 $CLI status
py -3 $CLI test attention
py -3 $CLI test complete
py -3 $CLI test error
```

### 静音隔离测试 `agy_hook.mjs`（不发声、不污染真实日志）
调试钩子逻辑时，设置以下环境变量后再通过 stdin 喂入测试 JSON 给 `node scripts/agy_hook.mjs`：
- `SESSION_ALARM_DISABLE_AUDIO=1`（禁用播放）
- `SESSION_ALARM_DISABLE_NOTIFICATIONS=1`（禁用桌面通知）
- `SESSION_ALARM_HOME=<临时目录>`（隔离 `history.jsonl`、`pending/` 与配置）
- `SESSION_ALARM_AGY_CONFIG_DIR=<临时目录>`（模拟不同 Antigravity 权限档位与白名单）
- `SESSION_ALARM_DISABLE_SIDECAR=1`（强制关闭 Sidecar 真弹窗检测，切回纯 Hook + 5 秒计时兜底模式）
- `SESSION_ALARM_SIDECAR_ACTIVE_POLL_MS` / `SESSION_ALARM_SIDECAR_IDLE_POLL_MS`（可选，Sidecar 轮询间隔毫秒，默认活跃 `500` / 空闲 `2000`）
- `SESSION_ALARM_SIDECAR_WAIT_GRACE_MS`（可选，检测到 `waitingSteps` 后的确认宽限毫秒，默认 `0`）
- `SESSION_ALARM_SIDECAR_TTL_MS`（可选，`sidecar-state.json` 心跳有效期毫秒，默认 `15000`）
- `SESSION_ALARM_DELAY_READ_MS` / `SESSION_ALARM_DELAY_WRITE_MS` / `SESSION_ALARM_DELAY_COMMAND_MS` / `SESSION_ALARM_DELAY_MCP_MS`（可选，正整数毫秒，分别覆盖 Hook 兜底模式下读文件、工作区外写文件、待审查命令与 MCP 默认 `5000` 延迟阈值）
- `SESSION_ALARM_SKIP_MCP_PREFIXES`（可选，逗号分隔的受信任 MCP 前缀，默认不跳过；例如设为 `mcp_myserver_` 可跳过该前缀下的 MCP）

---

## 5. 给未来 AI 的一键排查提示词

以后觉得提示音行为不对时，可直接把下面这段发给 AI：

```text
Antigravity 更新（或 Session Alarm 提示音出现异常）了。请先阅读插件目录下的 MAINTENANCE.md，
再对比状态目录中的 history.jsonl 最近日志（重点看 allowed_by_permission_grant、skipped_by_turbo_mode 与 reason 字段）
以及 Antigravity 内置最新的 docs/hooks.md 协议（不要直接用 read_file 读取 ~/.gemini/config/config.json，以免触发硬编码系统保护边界；
若怀疑权限字段名变更再向我索取脱敏后的键名结构），定位原因并修复 hooks.json / agy_hook.mjs / core.py，最后用静音隔离环境变量测试验证。
```
