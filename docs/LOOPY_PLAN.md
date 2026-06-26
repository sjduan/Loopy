# Loopy 产品与技术规划

## 1. 背景

Loopy 的第一版目标不是先做一个通用自动化平台，而是先验证一个更具体的问题：

> 两个本地 coding agent 能不能在一个可观察、可控的工具里互相发送 prompt、查看结果、继续追问，并围绕同一个开发任务形成协作闭环？

这个问题比普通的“定时运行一个 agent”更接近最初想要的产品：一个多 agent 工具相互调用开发的东西。

Loop engineering 仍然是长期方向，但它在 Loopy 里应该服务于 agent 协作，而不是把产品收窄成单 agent runner。Loopy 需要把人从“每一步都手动提示 agent”的位置上移开，改为设计一个外层协作循环：

1. 定义目标。
2. 选择一组 agent 和它们的角色。
3. 让某个 agent 对另一个 agent 发起 prompt。
4. 观察被调用 agent 的执行结果、stdout、stderr、产物和总结。
5. 把结果作为上下文继续交给下一个 agent。
6. 记录所有消息、调用、文件产物和人工干预。
7. 判断继续、暂停、请求人工确认，或结束。

这类协作循环适合代码维护、测试修复、文档更新、issue triage、方案评审、竞品或网页监控等任务。它的价值在于把“一次性对话”变成“多个 agent 可重复协作、可验证、可追踪的开发过程”。

参考来源：

- Forbes: <https://www.forbes.com/sites/lanceeliot/2026/06/17/loop-engineering-is-fully-making-the-rounds-for-boosting-generative-ai-and-agentic-ai/>
- Addy Osmani: <https://addyosmani.com/blog/loop-engineering/>

## 2. 产品定位

Loopy 是一个运行在 macOS 本地的小程序，用来管理不同 agent 工具之间的协作。

它不直接替代 opencode、Codex、Claude Code、Cursor、OpenAI API 或其他 agent，而是作为一个轻量 multi-agent orchestration layer：

- 统一配置不同 agent 工具。
- 统一描述开发任务、agent 角色、消息流、状态和停止条件。
- 统一记录每次 agent 调用的输入、输出、成本、结论和人工干预。
- 让用户能在一个本地控制台里观察和管理 agent 之间的对话与动作。

一句话定位：

> Loopy 是给本地 coding agent 用的多 agent 协作控制台。

## 3. 目标用户

第一阶段优先面向个人开发者和小团队，而不是企业级平台。

典型用户：

- 在 macOS 上同时使用 opencode、Codex、Claude Code、Cursor、shell 脚本、OpenAI API 的开发者。
- 想让多个 agent 分别承担实现、审查、测试、总结等角色的人。
- 想实验 multi-agent development，但不想先搭一堆复杂基础设施的人。

## 4. 核心使用场景

### 4.1 双 agent 开发协作

第一阶段优先做这个场景：

- 用户创建一个 session，选择两个 opencode agent。
- Agent A 收到初始开发任务。
- 用户把 Agent A 的结果发送给 Agent B，请它审查方案、补充实现、运行验证或提出问题。
- Loopy 调用 Agent B，记录 prompt、输出和产物。
- 用户把 Agent B 的结果回传给 Agent A，并继续下一轮。
- 用户可以随时插入消息、暂停、终止或手动选择下一步。

第一阶段不要求 agent 自己真的“点击按钮调用另一个 agent”。关键是 Loopy 的数据模型和后端动作支持 agent-to-agent message，UI 可以先由用户触发转发。

### 4.2 代码项目巡检

每天早上自动运行：

- 拉取最新状态。
- 查看失败测试、lint、最近 commit。
- 让一个 agent 总结风险。
- 让另一个 agent review 结论或提出修复计划。
- 必要时创建一个修复任务或草稿 patch。
- 如果置信度不足，则只生成报告。

### 4.3 Issue triage

定期读取 GitHub、Linear、Jira：

- 聚类新 issue。
- 判断优先级。
- 查找重复 issue。
- 由第二个 agent 复核建议 owner 和风险。
- 需要人工确认后再更新外部系统。

### 4.4 小修小补协作

给定明确目标：

- “让这个测试通过。”
- “把 README 的 API 示例和当前代码同步。”
- “检查依赖更新并给出升级建议。”

一个 agent 负责尝试修改，另一个 agent 负责审查、验证或反驳。Loopy 记录每轮执行、消息、验证和停止原因。

### 4.5 内容和文档维护

定期检查：

- 文档是否过时。
- changelog 是否缺失。
- API 示例是否还能运行。
- 产品说明是否和代码行为一致。

## 5. 产品原则

### 5.1 本地优先

第一版默认运行在用户本机，不强制云端账号，不上传项目代码。

### 5.2 Agent 中立

不要把系统设计死在某一个 agent 上。第一阶段先接 opencode，但 opencode、Codex、Claude Code、OpenAI API、自定义 shell、MCP 工具都应该通过 adapter 接入。

### 5.3 可观察

每次 agent 调用都必须能追溯：

- 输入 prompt。
- 使用了哪个 agent。
- 执行了什么命令或 API。
- 输出是什么。
- 谁把结果交给了谁。
- 判断为什么继续、停止或请求人工确认。
- 人有没有介入。

### 5.4 协议先于具体工具

Loopy 内部不要直接把“agent 等于一个 shell 命令”写死。需要先定义一层统一协议：

- `AgentProfile`: 某个可调用 agent 的配置。
- `AgentInvocation`: 对一个 agent 的单次调用。
- `Message`: agent 之间或用户与 agent 之间的消息。
- `Session`: 一组 agent 围绕同一个目标的协作上下文。
- `Artifact`: 调用产生的日志、diff、报告、文件路径等产物。

具体工具通过 adapter 把统一协议映射成 opencode、Claude Code、Codex 或其它 CLI/API 调用。

### 5.5 明确停止条件

任何 session 都不能只有“持续运行”。必须至少有一个停止条件：

- 最大轮数。
- 最大时长。
- 最大成本。
- 成功验证条件。
- 人工确认。
- 错误次数上限。

### 5.6 人在关键节点上

Loopy 的第一版不追求完全无人值守。高风险动作需要人工确认：

- 写入生产系统。
- push 或 merge 代码。
- 发外部消息。
- 删除文件。
- 运行高成本任务。

## 6. 核心概念模型

### 6.1 Session

Session 是一组 agent 围绕同一目标进行协作的上下文。第一阶段可以理解为一次“双 opencode agent 开发协作”。

字段建议：

- `id`
- `name`
- `goal`
- `workspace`
- `participants`
- `routing_policy`
- `initial_prompt`
- `context_sources`
- `memory`
- `stop_conditions`
- `approval_policy`
- `status`

状态建议：

- `draft`
- `active`
- `running`
- `waiting_for_user`
- `waiting_for_approval`
- `paused`
- `completed`
- `failed`
- `timeout`
- `cancelled`

### 6.2 Agent Profile

Agent Profile 描述一个可以被 Loopy 调用的 agent 实例。

字段建议：

- `id`
- `name`
- `adapter_type`
- `command`
- `args`
- `cwd`
- `env`
- `timeout_ms`
- `capabilities`
- `role_prompt`

第一阶段至少配置两个 opencode profile，例如：

- `opencode_planner`
- `opencode_reviewer`

二者可以使用同一个 opencode CLI，但用不同 prompt、工作目录、模型参数或角色说明区分。

### 6.3 Agent Adapter

Agent adapter 负责把 Loopy 的标准任务请求转成具体工具能理解的调用。

第一阶段 adapter 类型：

- `opencode_cli`: opencode 命令行封装。
- `shell_command`: 任意命令行工具 fallback。

后续 adapter 类型：

- `codex_cli`: Codex CLI 或 Codex 本地命令封装。
- `claude_code`: Claude Code 命令封装。
- `openai_api`: 直接调用 OpenAI API。
- `mcp_server`
- `github_action`
- `remote_worker`
- `browser_agent`

### 6.4 Message

Message 是 Loopy 内部的协作消息，不等同于某个 agent 工具自己的聊天记录。

消息类型：

- `user_to_agent`
- `agent_to_agent`
- `agent_to_user`
- `system_event`
- `human_override`

关键字段：

- `from_participant_id`
- `to_participant_id`
- `content`
- `related_invocation_id`
- `created_at`

### 6.5 Agent Invocation

Agent Invocation 是对一个 agent 的单次实际调用。

必须记录：

- 请求 prompt。
- 实际命令或 API payload。
- stdout。
- stderr。
- exit code。
- 开始和结束时间。
- 产物路径。
- 摘要和下一步建议。

### 6.6 Memory

Memory 是 session 的外部持久记忆，不依赖单次模型上下文。

第一版可以用本地文件：

- `memory.md`: 人类可读的运行摘要。
- `messages.jsonl`: 消息流。
- `invocations/*.json`: 结构化调用记录。
- `artifacts/`: prompt、日志、diff、报告等。

后续可以支持向量检索或更复杂的 SQLite 索引。

### 6.7 Router

Router 决定下一条消息应该交给谁。

第一阶段先做非常保守的手动或半自动 routing：

- 用户手动选择把结果发给 Agent A 或 Agent B。
- Agent 输出里可以给出建议下一步，但不能直接无限自驱。
- 每轮都受最大轮数、超时和人工暂停保护。

后续再支持自动 routing、角色策略、多 agent 投票和 planner/executor/reviewer 模式。

### 6.8 Evaluator

Evaluator 判断一轮调用后该做什么。

第一版支持：

- 命令退出码。
- 最大轮数。
- 最大失败次数。
- 单次调用超时。
- 人工确认。

后续支持：

- 正则匹配输出。
- 测试命令是否通过。
- LLM judge。
- 多 agent review。
- 自定义 JavaScript 或 Python evaluator。

## 7. MVP 范围

第一版建议做“够小但完整”的双 agent 协作闭环。

必须有：

- 本地 Web 控制台，用于可视化监控 session、agent 消息、调用日志和人工操作。
- Agent Profile 配置，第一阶段至少能配置两个 opencode agent。
- Session 创建、暂停、继续、终止。
- 用户给 Agent A 发起初始 prompt。
- Agent A 的结果可以通过 Loopy 发送给 Agent B。
- Agent B 的结果可以通过 Loopy 回传给 Agent A。
- 本地 invocation log 和 message timeline。
- 停止条件：最大轮数、单次调用超时、失败次数。
- 人工继续按钮。

可以暂缓：

- Electron 或 Tauri 打包。
- 云同步。
- 用户系统。
- 复杂权限模型。
- 多人协作。
- 插件市场。
- 自动 routing DSL。
- 多 agent 自动投票。
- 复杂 workflow canvas。

## 8. 技术架构建议

### 8.1 第一阶段技术栈

建议：

- 前端：React + Vite。
- 后端：Node.js + Fastify。
- 本地存储：SQLite。
- 后台任务：Node worker + durable invocation table。
- Agent 调用：child process + adapter interface。
- macOS 打包：后续用 Tauri 或 Electron。

理由：

- macOS 本地开发体验好。
- Node 对命令行工具、文件、HTTP API 都很顺。
- SQLite 足够支撑本地状态、日志、队列。
- Tauri 后续打包体积更小，但 MVP 可以先用浏览器打开本地服务。
- Web UI 是第一版必做项；桌面壳可以后置，但可视化监控不能后置。

### 8.2 模块划分

```text
loopy/
  apps/
    desktop/        # 后续 Tauri/Electron 壳
    web/            # 本地控制台
    server/         # Fastify API
  packages/
    core/           # session engine + routing
    adapters/       # agent adapters
    storage/        # SQLite + artifact store
    evaluator/      # stop/evaluation logic
  data/
    loopy.db
    sessions/
```

### 8.3 Session Engine 流程

```text
load session
  -> collect context
  -> render message prompt
  -> call selected agent adapter
  -> capture output/artifacts
  -> append message timeline
  -> update memory
  -> evaluate stop conditions
  -> route next message / pause / complete / fail / ask human
```

## 9. 数据结构草案

### 9.1 sessions

```json
{
  "id": "session_123",
  "name": "Fix failing auth test",
  "goal": "Use two opencode agents to diagnose, implement, and review a fix.",
  "status": "active",
  "workspace": "/path/to/project",
  "participants": ["agent_opencode_a", "agent_opencode_b"],
  "routing_policy": "manual",
  "stop_conditions": {
    "max_rounds": 6,
    "per_invocation_timeout_ms": 600000,
    "max_failures": 2
  },
  "approval_policy": {
    "before_file_write": false,
    "before_git_push": true,
    "before_external_post": true
  }
}
```

### 9.2 agent_profiles

```json
{
  "id": "agent_opencode_a",
  "name": "opencode planner",
  "adapter_type": "opencode_cli",
  "command": "opencode",
  "args": ["run", "--prompt-file", "{prompt_file}"],
  "cwd": "{workspace}",
  "role_prompt": "Plan implementation steps and ask the reviewer for critique."
}
```

### 9.3 messages

```json
{
  "id": "msg_456",
  "session_id": "session_123",
  "from_participant_id": "agent_opencode_a",
  "to_participant_id": "agent_opencode_b",
  "type": "agent_to_agent",
  "content": "Please review this plan and identify missing validation.",
  "related_invocation_id": "inv_789",
  "created_at": "2026-06-22T08:00:00Z"
}
```

### 9.4 invocations

```json
{
  "id": "inv_789",
  "session_id": "session_123",
  "agent_profile_id": "agent_opencode_b",
  "status": "completed",
  "started_at": "2026-06-22T08:00:00Z",
  "ended_at": "2026-06-22T08:02:10Z",
  "prompt_path": "sessions/session_123/invocations/inv_789/prompt.md",
  "stdout_path": "sessions/session_123/invocations/inv_789/stdout.log",
  "stderr_path": "sessions/session_123/invocations/inv_789/stderr.log",
  "summary": "Reviewed the plan and requested a failing test reproduction.",
  "suggested_next_recipient": "agent_opencode_a"
}
```

## 10. UI 信息架构

第一版页面：

- Dashboard: 所有 sessions 的状态、最近消息、最近调用结果。
- Session Detail: goal、participants、message timeline、memory、invocations、停止条件。
- Agent Profiles: 管理不同 agent 工具，第一阶段重点是两个 opencode profile。
- Invocation Log: 每次 agent 调用的 prompt、输出、artifact、评价结果。

交互重点：

- 一眼看出哪些 session 正在跑、卡住、失败、等待确认。
- 每个 session 都能手动发送下一条消息。
- 每个 invocation 都能打开完整日志。
- 危险动作需要明确确认。

## 11. 安全与风险

主要风险：

- 无限循环导致 token 或 API 成本失控。
- Agent 执行破坏性 shell 命令。
- 模型自评过于乐观。
- 多 agent 同时改同一个工作区造成冲突。
- Agent 互相放大错误结论。
- 运行日志泄露敏感信息。

第一版防护：

- 默认最大轮数。
- 默认超时。
- 默认禁止自动 push、merge、delete。
- 明确显示每次运行命令。
- 第一阶段默认一次只允许一个 invocation 运行，避免两个 agent 同时改同一工作区。
- 高风险动作进 approval queue 或人工确认。
- 每个 session 可配置独立 workspace。

## 12. 里程碑

### Milestone 0: 规划

- 完成本文档。
- 明确 MVP 场景。
- 明确第一批 adapter。

### Milestone 1: Local Two-Agent Session

- SQLite schema。
- Session CRUD。
- Agent Profile CRUD。
- opencode CLI adapter。
- Message timeline。
- Invocation log。
- Stop condition。

### Milestone 2: Web Console

- Dashboard。
- Session detail。
- Agent profile 配置。
- Invocation log 查看。
- 手动 send / continue / pause / stop。

### Milestone 3: Human Approval

- Approval queue。
- 危险动作确认。
- 审计记录。

### Milestone 4: More Agent Integrations

- 第二个 CLI adapter 抽象验证。
- OpenAI API adapter。
- Codex adapter。
- Claude Code adapter。
- GitHub/Linear connector 初版。

### Milestone 5: macOS App

- Tauri/Electron shell。
- Menu bar quick status。
- Launch at login。
- 本地通知。

## 13. 第一版建议决策

为了快速推进，建议第一版做成：

- “本地 Web app + Node 后端”，先不打包。
- 数据存 SQLite。
- 第一批只支持 opencode CLI adapter，加一个通用 shell command fallback。
- UI 先服务开发者，不做过度视觉设计。
- 先把双 agent 消息流、调用日志、可观察性和停止条件做好。

这样能最快验证核心问题：

> 用户是否真的愿意把日常 agent 提示工作，沉淀成两个或多个 agent 可追踪协作的开发 session？
