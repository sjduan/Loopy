# Loopy 第一阶段 MVP

## 1. MVP 目标

第一版不做“大而全的 agent 平台”，也不先做单 agent 定时 loop runner。第一版只做一个稳定、可控、能在 macOS 本机跑的小工具：

> 用户可以创建一个开发协作 session，让两个 opencode agent 互相发送 prompt、回看结果、继续交流，并在 Web UI 里看到完整消息流、调用日志和停止状态。

这个 MVP 的核心价值不是“自动跑很多次”，而是验证 Loopy 能不能成为本地多 agent 开发协作的外层控制台。

## 2. 第一版只解决六件事

### 2.1 Web 可视化控制台

Web UI 是 MVP 必做项，不是后续增强。

原因：

- 多 agent 交流必须能看清消息来源和去向。
- Agent 输出不可预测，必须能看调用日志。
- 两个 agent 可能互相误导，必须能人工暂停和插入消息。
- 用户需要随时知道当前轮到哪个 agent、上一轮做了什么、为什么停下。

第一版 Web UI 不追求复杂设计，但必须清楚、稳定、可操作。

最小页面：

- Dashboard
- Session Detail
- Agent Settings
- Invocation Log

### 2.2 配置两个 opencode agent

第一阶段优先支持 opencode CLI。系统设计必须保留 adapter 扩展口，后续能接 Claude Code、Codex、自定义 shell、OpenAI API 等。

一个 agent profile 至少包含：

- 名称
- adapter 类型
- 命令
- 参数
- 工作目录
- 角色说明
- 超时时间

示例：

```text
name: opencode planner
adapter_type: opencode_cli
command: opencode
args: run --prompt-file {prompt_file}
role_prompt: 你负责拆解任务、提出实现方案，并决定要问 reviewer 什么。
```

```text
name: opencode reviewer
adapter_type: opencode_cli
command: opencode
args: run --prompt-file {prompt_file}
role_prompt: 你负责审查 planner 的方案、指出风险，并给出验证建议。
```

第一版可以让两个 profile 使用同一个 opencode 命令，但它们必须在 Loopy 里被视为两个独立参与者。

### 2.3 创建协作 Session

一个 session 至少包含：

- 名称
- 目标
- 工作目录
- 参与 agent 列表
- 初始 prompt
- routing 模式
- 最大轮数
- 单次调用超时
- 失败次数上限
- 当前状态

第一版只支持两种 routing：

- 手动 routing：用户选择下一条消息发给哪个 agent。
- 建议 routing：agent 输出里给出下一步建议，但 Loopy 仍要求用户点击继续。

先不做完全自动的多 agent 自驱循环，避免第一版失控。

### 2.4 Agent 之间发送 prompt

这是第一版最重要的行为。

MVP 必须支持：

- 用户给 Agent A 发送初始 prompt。
- Agent A 的输出被记录为消息和 invocation。
- 用户可以把 Agent A 的结果整理成 prompt 发给 Agent B。
- Agent B 的输出被记录。
- 用户可以把 Agent B 的结果回传给 Agent A。
- 每条消息都能看到 from、to、时间、关联 invocation。

第一版可以先由用户点击按钮完成“发送给另一个 agent”，不要求 agent 自动调用工具。关键是底层模型要支持 agent-to-agent message，而不是只支持单个 loop run。

### 2.5 记录调用日志和产物

每次 agent 调用必须留下记录：

- 本次 prompt
- 调用的 agent profile
- 实际命令
- stdout
- stderr
- exit code
- 开始和结束时间
- 调用状态
- 产物路径
- 摘要

日志要能在 UI 里看，也要在本地文件里能找到。

建议目录：

```text
data/
  loopy.db
  sessions/
    session_123/
      memory.md
      messages.jsonl
      invocations/
        inv_001/
          prompt.md
          stdout.log
          stderr.log
          result.md
```

这是第一版最关键的信任基础。多 agent 自动化不可怕，不知道它们互相说了什么、做了什么才可怕。

### 2.6 停止、暂停和人工介入

每个 session 都必须能安全停下来。

第一版停止条件：

- 达到最大轮数
- 单次调用失败
- 连续失败次数达到上限
- 单次调用超时
- 用户手动暂停
- 用户手动结束

默认值要保守：

- 最大轮数默认 6
- 单次调用超时默认 10 分钟
- 连续失败上限默认 2
- 默认不允许无限循环
- 默认同一 session 内同一时间只运行一个 agent invocation

## 3. 第一版不做什么

明确不做：

- 不做多用户系统。
- 不做云同步。
- 不做插件市场。
- 不做复杂 workflow canvas。
- 不做完全自动的多 agent 自驱循环。
- 不做 agent 自动 git push/merge。
- 不做生产环境写入操作。
- 不做成本计费系统，只预留字段。
- 不做复杂权限模型，只做本机安全提示。
- 不做 Claude Code/Codex 专属深度集成，只预留 adapter。

可以预留接口，但不要先实现。

## 4. 推荐技术方案

第一版建议：

- 前端：React + Vite
- 后端：Node.js + Fastify
- 数据：SQLite
- Agent 调用：Node child_process
- 日志文件：本地 `data/sessions/`
- 启动方式：`npm run dev`

先不打包成 macOS app。等核心稳定后，再用 Tauri 包一层桌面壳。

## 5. 极简架构

```text
Web UI
  |
HTTP API
  |
Session Engine
  |
Router / Human Control
  |
Agent Adapter  --->  opencode / codex / claude / shell / custom cli
  |
Invocation Logger
  |
SQLite + local files
```

## 6. Web 界面范围

第一版只需要四个页面或区域。

### Dashboard

显示所有 sessions：

- 名称
- 状态
- 参与 agents
- 最近消息
- 最近调用结果
- 当前等待对象
- continue / pause / inspect

建议布局：

```text
┌──────────────────────────────────────────────────────────┐
│ Loopy                                                    │
│ Active: 1   Paused: 1   Failed: 0                       │
├──────────────────────────────────────────────────────────┤
│ Session            Status    Waiting For     Action      │
│ Auth Test Fix      active    user decision   inspect     │
│ README Sync        paused    -               continue    │
└──────────────────────────────────────────────────────────┘
```

Dashboard 的目标不是配置细节，而是让用户 5 秒内知道：

- 哪些 session 正在协作。
- 哪些卡住了。
- 当前需要谁行动。
- 哪个需要人看。

### Session Detail

编辑 session：

- goal
- workspace
- participants
- initial prompt
- routing mode
- stop conditions

查看：

- message timeline
- 最近 invocation 摘要
- memory 摘要
- artifact 列表

Session Detail 必须有：

- `Send to Agent` 按钮
- `Continue with other agent` 按钮
- `Pause` / `Resume` / `End` 按钮
- 当前状态
- 当前轮数
- 最近一次 invocation 摘要
- 停止原因

建议布局：

```text
┌──────────────────────────────────────────────────────────┐
│ Auth Test Fix                         Pause   End        │
│ status: active      round: 3/6      waiting: user        │
├──────────────────────────────────────────────────────────┤
│ Goal / Workspace / Agents                                │
├──────────────────────────────────────────────────────────┤
│ Timeline                                                 │
│ user -> planner      initial task                        │
│ planner -> reviewer  please review this plan             │
│ reviewer -> planner  missing failing test reproduction   │
├──────────────────────────────────────────────────────────┤
│ Compose next message                                     │
│ To: planner | reviewer                                   │
└──────────────────────────────────────────────────────────┘
```

### Agent Settings

管理 agent profile：

- 新建
- 编辑
- 测试命令是否可运行
- 设置角色说明

Agent Settings 必须显示最终会执行的命令预览。

例如：

```text
opencode run --prompt-file /path/to/prompt.md
```

这可以减少误配和危险命令。

### Invocation Log

查看单次调用详情：

- prompt
- agent profile
- 命令
- 输出
- 错误
- exit code
- 产物路径
- 摘要

Invocation Log 是“信任来源”，必须尽量完整。

建议用左右或上下分区：

```text
Invocation #18
agent: opencode reviewer
status: succeeded
duration: 42s
exit code: 0

[Prompt]
[Command]
[Stdout]
[Stderr]
[Artifacts]
```

## 7. Web UI 设计原则

第一版界面应该偏开发工具型，而不是营销型。

原则：

- 信息密度适中，方便扫视。
- 消息流要清楚区分 from/to。
- 操作按钮明确，不隐藏关键动作。
- 状态颜色克制，失败和等待确认要明显。
- 日志区域要适合长文本。
- 表单字段不要太多，默认值要合理。
- 移动端不优先，但窄屏不能坏。

第一版视觉可以很朴素，但不能缺少：

- 状态 badge。
- agent 名称。
- 消息方向。
- 最近调用时间。
- 一键暂停。
- 一键继续。
- 日志入口。

## 8. 状态模型

Session 状态：

```text
draft
active
running
waiting_for_user
paused
completed
failed
timeout
cancelled
```

Invocation 状态：

```text
queued
running
succeeded
failed
timeout
cancelled
```

Message 类型：

```text
user_to_agent
agent_to_agent
agent_to_user
system_event
human_override
```

## 9. 数据表草案

### agent_profiles

```text
id
name
adapter_type
command
args_json
cwd
role_prompt
timeout_ms
created_at
updated_at
```

### sessions

```text
id
name
goal
workspace
status
routing_mode
max_rounds
round_count
max_failures
failure_count
created_at
updated_at
ended_at
stop_reason
```

### session_participants

```text
id
session_id
agent_profile_id
display_name
role
created_at
```

### messages

```text
id
session_id
from_type
from_id
to_type
to_id
message_type
content
related_invocation_id
created_at
```

### invocations

```text
id
session_id
agent_profile_id
status
command_snapshot
prompt_path
stdout_path
stderr_path
result_path
exit_code
started_at
ended_at
summary
suggested_next_recipient_id
```

## 10. 稳定性要求

第一版要优先做到：

- App 重启后 session、messages、invocations 不丢。
- 正在运行的调用有超时保护。
- 命令失败不会拖垮整个服务。
- 每次调用都有完整日志。
- UI 刷新后仍能看到真实状态。
- 同一个 session 默认不会并发跑两个 agent。
- 默认配置不会无限消耗资源。
- Web UI 显示的状态和后端真实状态一致。
- 浏览器刷新后不丢当前监控视图。

## 11. 第一版验收标准

MVP 完成的标准：

1. 可以添加两个 opencode agent profile。
2. 可以创建一个 session，并选择这两个 agent 作为参与者。
3. 可以给 Agent A 发送初始 prompt。
4. 可以看到 Agent A 的 invocation 日志。
5. 可以把 Agent A 的结果作为 prompt 发给 Agent B。
6. 可以看到 Agent B 的 invocation 日志。
7. 可以把 Agent B 的结果回传给 Agent A。
8. Dashboard 能看到所有 session 的状态、参与 agent、最近消息和最近调用结果。
9. Session Detail 能看到完整 message timeline。
10. Invocation Log 能看到 prompt、命令、stdout、stderr、exit code 和 artifact 路径。
11. 达到最大轮数、失败或超时后 session 状态正确。
12. 重启服务后 sessions、messages、invocations 仍然存在。

做到这些，就已经是一个有用的小产品，而不是 demo。

## 12. 后续再加

等 MVP 稳定后，再考虑：

- 自动 routing 策略。
- planner / executor / reviewer 多角色模板。
- Claude Code adapter。
- Codex adapter。
- OpenAI API adapter。
- GitHub issue connector。
- Approval queue。
- 多 workspace。
- LLM evaluator。
- macOS 菜单栏状态。
- Tauri 打包。
