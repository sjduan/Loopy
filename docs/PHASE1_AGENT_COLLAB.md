# Phase 1 双 opencode agent 协作任务

## 1. 阶段目标

在 macOS 本机跑起一个 Web 前端 + Node 后端工具，完成最小双 agent 协作闭环：

> 用户在 Web UI 创建一个 session，选择两个 opencode agent，把任务发给 Agent A，再把 Agent A 的结果发给 Agent B，最后把 Agent B 的结果回传给 Agent A。全过程有消息流、调用日志、状态和本地持久化。

第一阶段不要追求自动化程度，先追求协议、日志和可观察性正确。

## 2. 核心对象

### AgentProfile

表示一个可调用的本地 agent。

第一阶段字段：

- `id`
- `name`
- `adapterType`
- `command`
- `args`
- `cwd`
- `rolePrompt`
- `timeoutMs`

第一阶段必须支持：

- `opencode_cli`
- `shell_command` fallback

### Session

表示一次多 agent 协作任务。

第一阶段字段：

- `id`
- `name`
- `goal`
- `workspace`
- `status`
- `routingMode`
- `maxRounds`
- `roundCount`
- `maxFailures`
- `failureCount`
- `stopReason`

### Message

表示用户和 agent、agent 和 agent 之间的消息。

第一阶段字段：

- `id`
- `sessionId`
- `from`
- `to`
- `type`
- `content`
- `relatedInvocationId`
- `createdAt`

### Invocation

表示一次真实 agent 调用。

第一阶段字段：

- `id`
- `sessionId`
- `agentProfileId`
- `status`
- `commandSnapshot`
- `promptPath`
- `stdoutPath`
- `stderrPath`
- `resultPath`
- `exitCode`
- `startedAt`
- `endedAt`
- `summary`

## 3. 后端任务

### 3.1 项目骨架

- 创建 Node + TypeScript 后端。
- 使用 Fastify 提供 HTTP API。
- 使用 SQLite 做本地持久化。
- 使用本地文件目录保存 prompt、stdout、stderr、result。
- 提供 `npm run dev` 在 macOS 本机启动。

### 3.2 数据层

建立表：

- `agent_profiles`
- `sessions`
- `session_participants`
- `messages`
- `invocations`

要求：

- 所有主对象有稳定 id。
- 所有时间字段使用 ISO 字符串或 SQLite datetime，统一一种格式。
- invocation 的大文本写文件，数据库只存路径和摘要。

### 3.3 Agent Adapter

实现统一接口：

```ts
interface AgentAdapter {
  invoke(input: AgentInvocationInput): Promise<AgentInvocationResult>;
}
```

输入至少包含：

- `agentProfile`
- `session`
- `prompt`
- `workspace`
- `timeoutMs`

输出至少包含：

- `status`
- `stdout`
- `stderr`
- `exitCode`
- `startedAt`
- `endedAt`

第一阶段实现：

- `opencode_cli`
- `shell_command`

注意：

- prompt 必须优先通过临时 prompt 文件传入。
- 实际命令必须保存 command snapshot。
- 超时后必须 kill 子进程并记录 timeout。
- 不能让命令异常拖垮 Node 服务。

### 3.4 Session Engine

实现这些动作：

- 创建 session。
- 添加参与 agent。
- 从用户发送消息给某个 agent。
- 调用目标 agent。
- 将 invocation 结果追加到 message timeline。
- 将某条消息或 invocation result 转发给另一个 agent。
- 暂停 session。
- 继续 session。
- 结束 session。

第一阶段 routing 保持手动：

- 后端提供“send message to agent”接口。
- 后端提供“continue with result”接口。
- 自动建议可以记录，但不自动无限运行。

### 3.5 API 草案

```text
GET    /api/agent-profiles
POST   /api/agent-profiles
PATCH  /api/agent-profiles/:id
POST   /api/agent-profiles/:id/test

GET    /api/sessions
POST   /api/sessions
GET    /api/sessions/:id
PATCH  /api/sessions/:id
POST   /api/sessions/:id/participants
POST   /api/sessions/:id/messages
POST   /api/sessions/:id/invoke
POST   /api/sessions/:id/continue
POST   /api/sessions/:id/pause
POST   /api/sessions/:id/resume
POST   /api/sessions/:id/end

GET    /api/invocations/:id
GET    /api/invocations/:id/logs
```

## 4. 前端任务

### 4.1 项目骨架

- 创建 React + Vite 前端。
- 使用本地 API，不需要认证。
- 页面整体是开发工具风格，信息清楚、紧凑、可扫视。

### 4.2 Dashboard

显示：

- session 名称
- status
- participants
- 最近消息
- 最近 invocation 状态
- 当前等待对象
- inspect / pause / resume

### 4.3 Agent Settings

支持：

- 创建 opencode agent profile。
- 编辑 command、args、cwd、role prompt、timeout。
- 测试命令。
- 显示最终命令预览。

### 4.4 Session Detail

支持：

- 查看 goal、workspace、participants、status。
- 查看 message timeline。
- 查看每条消息关联的 invocation。
- 编写新 prompt 并选择 recipient。
- 从上一条 invocation result 一键生成下一条 prompt 草稿。
- pause / resume / end。

### 4.5 Invocation Log

支持查看：

- prompt
- command snapshot
- stdout
- stderr
- exit code
- duration
- result path

## 5. 第一阶段手动流程

完整验收流程：

1. 用户创建 `opencode planner` profile。
2. 用户创建 `opencode reviewer` profile。
3. 用户创建 session：`Fix failing auth test`。
4. 用户给 planner 发初始 prompt。
5. Loopy 调用 planner，保存日志。
6. 用户查看 planner 输出，点击“send to reviewer”。
7. Loopy 调用 reviewer，保存日志。
8. 用户查看 reviewer 输出，点击“send back to planner”。
9. Loopy 调用 planner，保存日志。
10. 用户暂停或结束 session。
11. 重启服务后，session timeline 和 invocation logs 仍可查看。

## 6. 扩展性要求

第一阶段实现时必须避免这些绑定：

- 不要把表名或字段写成只支持 opencode。
- 不要假设只有两个 agent。
- 不要假设消息只能 user -> agent。
- 不要假设 agent 一定是 CLI，后续可能是 API 或 MCP。
- 不要假设一个 session 只在一个固定目录运行，但第一版可以只暴露一个 workspace。
- 不要把 routing 写死成 A/B 两个按钮，前端可以有快捷按钮，但后端协议要支持任意 participant id。

## 7. 非目标

第一阶段不做：

- 自动无限多轮协作。
- 多 agent 投票。
- 工作流画布。
- 云端账号。
- 权限系统。
- GitHub/Linear/Jira connector。
- 自动 push/merge。
- macOS app 打包。

## 8. 技术验收

完成时至少满足：

- `npm run dev` 可以启动前后端。
- 没有配置 opencode 时，UI 能清楚提示如何配置。
- 任意一次 invocation 失败，session 不崩，日志可见。
- 超时会终止子进程并写入 timeout 状态。
- Dashboard、Session Detail、Invocation Log 刷新后状态仍正确。
- 后端重启后数据仍存在。
