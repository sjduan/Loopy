# Phase 2 通用 Agent 协作图与自动接力

## 1. 阶段目标

把 Loopy 从"写死的 auto_3agent 三角 + 无约束 manual"升级为**通用协作图模型**：

> 用户创建一个 session，选中若干 agent，自定义任意两个 agent 之间的"通信连线"。session 启动后，agent 在自己的输出里声明下一步要联系谁，Loopy 沿着允许的连线自动接力转发；agent 不声明或声明无效时，停下来等用户手动选。

这一阶段替代 Phase 1 的 `auto_3agent` 硬编码状态机，让任意两个（或多个）agent 之间能形成可配置、可观察、可追踪的协作闭环。

## 2. 核心设计决策

| 维度 | 决策 |
|---|---|
| 范围约束 | **session 级别二选一**：一个 session 要么全是本机 agent，要么全是同一个远端目标的 agent。本机与远端 agent 之间**不互联**。 |
| 旧 `auto_3agent` | **删除**，由 `auto_relay` 替代。删除旧的 `AutoSessionConfig` / `AutoSessionState` / `maybeAdvanceAutoSession` 状态机及相关 prompt 构造器、API 端点（`/auto/start`、`/auto/stop`）、UI（AutoWorkflowPanel）。 |
| 通信图 | `edges` 定义"谁能跟谁通信"，**无向**。manual 模式下 edges 为空 = 任意参与者都能互发（兼容老 session）；auto_relay 模式下若参与者超过 2 个则必须配置 edges。 |
| 接力触发 | **agent 在输出末尾带结构化标记** `[NEXT: <participant_display_name>]` 声明下一个收件人。Loopy 解析此标记。 |
| 接力停止 | (a) agent 未给出有效声明；(b) 声明的目标不在 edges 允许范围；(c) 用户点 Stop；(d) 达到 `maxRounds`；(e) 单次调用 timeout；(f) 连续失败达上限。 |
| prompt 增强 | `buildPrompt` 注入协作上下文：session 参与者、当前 agent 的可通信对象、`[NEXT: ...]` 声明语法。 |
| 转发校验 | 声明的目标必须在 edges 允许范围内（edges 非空时），否则当"无声明"处理 → 停下等用户。 |

## 3. 范围约束详解

### 3.1 session 级别二选一

一个 session 的所有参与者必须属于同一 locality：

- **local session**：所有 agent 的 `remote` 字段为 `null`，全部在本机 spawn。
- **remote session**：所有 agent 的 `remote` 字段**指向同一个 `RemoteTarget`**（相同的 `host` + `sshKey`），全部在该远端宿主机执行。

### 3.2 不允许的混搭

- 一个 session 里既有本机 agent 又有远端 agent → **创建时报错**。
- 两个远端 agent 指向不同 host（如一个 1 号机、一个 2 号机）→ **创建时报错**。

### 3.3 为什么这样约束

- 避免跨本机/远端边界的执行调度复杂性（本机 spawn → SSH 远端，或反过来）。
- 远端 session 内的接力仍在同一个 SSH 目标内，执行模型不变。
- "远端几个 agent 自己互联"指它们都跑在**同一个远端目标**（当前即 1 号机）上。

### 3.4 UI 影响

- CreateSessionForm 在选 agent 之前先选 **session locality**（local / remote）。
- 选 remote 时，远端目标用一个下拉（当前只有 1 号机默认值，未来扩展为多选）。
- agent 多选框只列出符合所选 locality 的 agent。

## 4. 数据模型变更

### 4.1 新增类型（`packages/shared/src/index.ts`）

```ts
// 一条通信边。内部存对称两条有向边方便校验；UI 上是一条无向连线。
export type SessionEdge = {
  fromParticipantId: string;
  toParticipantId: string;
};

// 接力状态机
export type RelayState = {
  enabled: boolean;           // 是否处于自动接力模式（用户 Start 后为 true）
  lastParticipantId: string | null;   // 上一个发言的 participant
  lastInvocationId: string | null;    // 上一条 invocation
  pendingNext: string | null;         // agent 声明的下一个 participantId（待校验）
  stopReason: string | null;          // 停下原因
  autoStopped: boolean;               // 是否被自动停下（非用户主动）
};

// routingMode 新增 auto_relay
export type RoutingMode = "manual" | "auto_relay";
```

### 4.2 Session 变更

```ts
export type Session = {
  // ...既有字段...
  routingMode: "manual" | "auto_relay";   // 删除 "auto_3agent" 和 "suggested"
  edges: SessionEdge[];                    // 新增
  relayState: RelayState | null;           // 新增（替代 autoState）
  // 删除：autoConfig, autoState
};
```

### 4.3 删除的类型

- `AutoSessionConfig`
- `AutoSessionState` / `AutoSessionPhase` / `AutoManagerPlan` / `AutoReviewerDecision`
- `CreateAutoSessionInput`
- `routingMode` 枚举值 `"auto_3agent"` 和 `"suggested"`

### 4.4 CreateSessionInput 变更

```ts
export type CreateSessionInput = {
  name: string;
  goal: string;
  workspace: string;
  participantAgentProfileIds: string[];
  edges?: SessionEdge[];           // 新增：participant id 对，可选
  routingMode?: "manual" | "auto_relay";
  maxRounds?: number;
  maxFailures?: number;
};
```

注意 `edges` 用 **participant id**，但 participant 在 session 创建时才生成，所以创建接口实际接受的是 **agent profile id 对**，在 `createSession` 内部转换成 participant id 对存库。详见 §6.1。

## 5. `[NEXT:]` 声明协议

### 5.1 语法

agent 的输出**末尾**带一行：

```
[NEXT: <participant_display_name>]
```

- `<participant_display_name>` 是 session 里某个参与者的 `displayName`（通常等于 agent profile name）。
- 大小写不敏感。
- 标记后可以有空白，但**不应有其它实质内容**——Loopy 只解析**最后一个** `[NEXT: ...]`。
- 不带此标记 = agent 不指定下一个 → session 停下等用户。

### 5.2 Loopy 解析规则

1. 从 invocation 的 `result`（agent 输出正文）**末尾**反向查找 `[NEXT: ...]`。
2. 提取括号内的 display name，trim + lowercase。
3. 在 session 参与者里按 `displayName` 模糊匹配（trim + lowercase 相等）。
4. 命中且该目标与当前 agent 的连线在 `edges` 允许范围内 → `pendingNext = 目标 participantId`，自动接力。
5. 未命中 / 不在 edges / auto_relay 中超过 2 个参与者但未配置 edges → 当"无有效声明"处理 → session 进 `waiting_for_user`。

### 5.3 旁路：用户手动覆盖

即便处于 auto_relay 且 agent 声明了 next，用户仍可在 UI 上：
- 点 **"Stop"** 立即终止接力（session 进 `paused`）。
- 在 agent 跑完后、Loopy 自动接力前，手动改下一个收件人（半自动）。

## 6. 后端改动（`apps/server`）

### 6.1 `createSession` 透传 edges + locality 校验

```ts
export function createSession(db, input: {
  // ...
  edges?: { fromAgentProfileId: string; toAgentProfileId: string }[];
}) {
  // 1. 校验 locality 一致性：所有 participant 的 profile.remote 要么全 null，要么全同一个 RemoteTarget
  // 2. 创建 participants
  // 3. 把 edges 里的 agent profile id 转成 participant id 存库
}
```

**Locality 校验伪码**：

```
remotes = participants.map(p => p.remote)
if any(r => r !== null) && any(r => r === null): error "不能混搭本机和远端 agent"
if 远端 agent 们指向不同 host: error "远端 agent 必须指向同一台机器"
```

### 6.2 invoke / continue 校验连线

`invokeForSession` 和 `continue` 端点在执行前校验 `from → to` 是否被允许：

- `routingMode === "manual"` 且 `edges` 为空 → 允许任意 from/to（兼容老行为）。
- `routingMode === "auto_relay"`、参与者超过 2 个且 `edges` 为空 → 启动接力时报错，要求用户配置通信图。
- `edges` 非空 → `(from, to)` 或 `(to, from)` 必须在 edges 里，否则 400 "This connection is not allowed by the session edges"。

### 6.3 接力状态机：`maybeAdvanceRelay`

替代 `maybeAdvanceAutoSession`。在每次 invocation 完成后（`runInvocation` 末尾）调用：

```
maybeAdvanceRelay(sessionId, invocationId, status):
  session = getSessionDetail(sessionId)
  if !session.relayState?.enabled: return
  if session.status in [paused, cancelled, completed, timeout]: return
  if status !== "succeeded":
    recordRelayStop(session, "Invocation failed: <status>")
    setSessionStatus(session, "failed", ...)
    return

  invocation = getInvocation(invocationId)
  result = readText(invocation.resultPath)
  nextName = parseNextTag(result)          // 解析 [NEXT: ...]
  nextParticipant = matchParticipantByName(session, nextName)

  if !nextParticipant || !edgeAllows(session.edges, fromId, nextParticipant.id):
    # 无有效声明 → 停下等用户
    updateRelayState(session, { pendingNext: null })
    setSessionStatus(session, "waiting_for_user", "Agent did not request a next recipient.")
    return

  # 有效声明 → 自动转发
  updateRelayState(session, {
    lastParticipantId: nextParticipant.id,
    lastInvocationId: invocationId,
    pendingNext: nextParticipant.id
  })
  invokeForSession(session.id, {
    toParticipantId: nextParticipant.id,
    fromParticipantId: invocation.agentProfileParticipantId,
    sourceInvocationId: invocationId,
    content: formatRelayMessage(fromName, result)
  })
```

**接力转发的 content 格式**（让下一个 agent 知道这是来自谁的消息）：

```
Message from <fromDisplayName>:

<上一个 agent 的输出正文（去掉 [NEXT:] 标记后的部分）>
```

### 6.4 API 端点变更

**删除**：
- `POST /api/auto-sessions`
- `POST /api/sessions/:id/auto/start`
- `POST /api/sessions/:id/auto/stop`

**新增/复用**：
- `POST /api/sessions/:id/relay/start` — 把 `relayState.enabled = true`，从指定起始 participant 开始发第一条（或继续）。
- `POST /api/sessions/:id/relay/stop` — 把 `relayState.enabled = false`，session 进 `paused`。
- 复用既有 `POST /api/sessions/:id/invoke`（首次发起 + 手动模式下转发都用它，内部按 routingMode 分流）。
- 复用既有 `POST /api/sessions/:id/continue`（手动转发既有 source invocation）。

### 6.5 `buildPrompt` 协作上下文注入

`adapter.buildPrompt` 签名扩展，接收 session 的 participants 和当前 agent 的可通信对象：

```
# Loopy Session
Goal: ...
Workspace: ...

# Participants
- planner (opencode, local)
- reviewer (claude, remote)   ← 你能和谁通信会单独标出

# Your Communication Channels
You can hand off to: reviewer, worker
To hand off, end your response with a line exactly like:
    [NEXT: <display-name>]
where <display-name> is one of: reviewer, worker
If your work is done and no handoff is needed, do not include the line.

# Agent Role
<rolePrompt>

# Operating Rules
...

# Task Message
<message>
```

### 6.6 删除的旧代码

- `maybeAdvanceAutoSession` 及其调用的 `buildManagerPlanningPrompt` / `buildWorkerPrompt` / `buildReviewerPrompt` / `buildManagerFinalPrompt` / `parseJsonFromText` / `pauseAutoForUser` / `createInitialAutoState`。
- `AutoSessionConfig` / `AutoSessionState` 相关的 db 列读写（`auto_config_json` / `auto_state_json` 列保留不动以兼容旧数据，但不再读写）。

## 7. 数据库迁移（`apps/server/src/db.ts`）

### 7.1 新增列

```sql
ALTER TABLE sessions ADD COLUMN edges_json TEXT;          -- SessionEdge[] 的 JSON
ALTER TABLE sessions ADD COLUMN relay_state_json TEXT;    -- RelayState 的 JSON
```

### 7.2 旧数据兼容

- `auto_config_json` / `auto_state_json` 列**保留不删**（避免迁移风险），但代码不再读写。
- 旧的 `auto_3agent` session：`routingMode` 字段值保持 `'auto_3agent'`，但 UI 显示为"已弃用"，不再可启动；建议用户重建。
- `mapSession` 解析 `edges_json` / `relay_state_json`，默认空数组 / null。
- 老的 manual session（无 edges）继续工作（edges 为空 = 任意互发）。

### 7.3 seed 不变

5 个 opencode profile + 2 个远端 claude profile 保持不变，用户可在创建 session 时自由组合。

## 8. 前端改动（`apps/web`）

### 8.1 CreateSessionForm 重构

当前表单是"Auto 3-Agent / Manual"分段。改为：

1. **Session locality** 单选：`local` / `remote`。
2. **Agent 多选**：只列符合 locality 的 agent。
3. **Communication edges**（连线配置）：选中 agent 后渲染一个 **N×N 矩阵 checkbox**（或 agent 列表两两 checkbox），勾上的对可以互发。留空 = 任意互发（提示用户）。
4. **Routing mode** 单选：
   - `manual`（默认）：用户每次手动转发。
   - `auto_relay`：agent 输出带 `[NEXT:]` 自动接力。
5. task / goal / workspace / maxRounds / maxFailures 保留。

### 8.2 SessionDetail 显示通信图

- 用一个**参与者列表 + 连线标识**展示当前 session 的图（每条边一行：`planner ↔ reviewer`）。
- `auto_relay` session 显示当前接力状态：`enabled` / `lastParticipant` / `pendingNext` / `stopReason`。
- 删除旧的 `AutoWorkflowPanel`（manager plan / reviewer decision / final summary 卡片）。

### 8.3 Composer 收件人受约束

- Composer 的 "To" 下拉只列出**当前可通信的 agent**（基于 edges 和上一个发言者）。
- manual 模式：列出所有与"上一个发言者"有边的 participant；edges 为空时列出所有其它 participant。
- auto_relay 模式且 `relayState.enabled`：Composer 默认禁用（接力自动进行），但保留 "Stop" 和 "Override next" 按钮。

### 8.4 接力控制按钮

- `auto_relay` session 的 toolbar 加 **"Start Relay"** / **"Stop Relay"** 按钮。
- Start：调用 `/relay/start`，可带初始 task。
- Stop：调用 `/relay/stop`。

## 9. 迁移影响：现有测试

`app.test.ts` 里有一个测试用例 `"runs an auto 3-agent session through manager, worker, reviewer, revision, and final summary"` 直接依赖被删除的 `auto_3agent` 流程。

**处理方式**：删除该测试用例，新增一个等价的 `auto_relay` 接力测试（用两个 shell agent 互相 `[NEXT: ...]` 声明，验证 2 轮接力后停下或完成）。详见 §11。

## 10. 端到端流程示例

### 10.1 示例 A：两个本地 opencode agent 手动协作（manual + edges）

1. 用户创建 session：local，选 `opencode planner` + `opencode reviewer`，勾上 planner↔reviewer 边，routingMode = `manual`。
2. 用户在 Composer 发 `to=planner`：`"设计一个登录页"`。
3. planner 跑完，输出方案（不带 `[NEXT:]`）。session 进 `waiting_for_user`。
4. 用户看 planner 输出，点"Continue with reviewer"，可编辑转发内容。
5. reviewer 跑完，输出审查意见。session 进 `waiting_for_user`。
6. 用户点"Continue back to planner"。循环。

### 10.2 示例 B：两个远端 claude agent 自动接力（auto_relay）

1. 用户创建 session：remote，选 `claude planner` + `claude reviewer`，勾上 planner↔reviewer 边，routingMode = `auto_relay`。
2. 用户点 **Start Relay**，输入初始 task：`"评估代码库里的认证模块风险"`。
3. Loopy 调 planner（远端 SSH）。planner 输出方案，末尾 `[NEXT: claude reviewer]`。
4. Loopy 解析到 next=reviewer，校验边允许，自动转发（content = `Message from claude planner:\n\n<方案>`）。
5. reviewer 跑完，输出审查，末尾 `[NEXT: claude planner]`。
6. Loopy 自动转回 planner。planner 输出修订（不带 `[NEXT:]`）。
7. session 进 `waiting_for_user`。用户可在 Composer 手动继续，或 Stop。

### 10.3 示例 C：无效声明 → 停下

1. agent 输出 `[NEXT: someone-not-in-session]`。
2. Loopy 匹配参与者失败 → 当无声明处理 → `waiting_for_user`，stopReason = "Agent requested unknown recipient."

## 11. 测试计划

### 11.1 删除

- `app.test.ts` 里的 auto 3-agent 测试用例。

### 11.2 新增单元测试

- `parseNextTag(result)`：解析各种位置/大小写的 `[NEXT: ...]`，包括无标记、无效格式。
- `edgeAllows(edges, fromId, toId)`：双向校验。

### 11.3 新增集成测试（`app.test.ts`）

1. **手动 + edges**：两 shell agent，edges 配置允许互发；invoke planner；continue 到 reviewer；continue 回 planner。
2. **手动 + edges 拒绝**：三 agent，只配 A↔B 边；尝试 invoke A→C 返回 400。
3. **auto_relay 2 轮**：两 shell agent（B 的脚本固定输出 `[NEXT: A]`，A 的脚本固定输出 `[NEXT: B]`），maxRounds=3；start relay；验证 3 次 invocation 后 session completed。
4. **auto_relay 无声明停下**：shell agent 输出纯文本无 `[NEXT:]`；验证 session 进 `waiting_for_user`。
5. **auto_relay 越权停下**：三 agent，A↔B 有边，A 输出 `[NEXT: C]`；验证不转发，进 `waiting_for_user`。
6. **locality 校验**：创建 session 时混搭本机 + 远端 agent 返回 400。
7. **远端 session 同 host 校验**：两个指向不同 host 的远端 agent 返回 400（需要构造 fixture）。

## 12. 验收标准

1. 可以创建 local session（纯本机 agent）或 remote session（纯同一远端 agent），混搭时被拒绝。
2. 可以在创建时配置任意 agent 对之间的通信连线。
3. manual 模式下，只能在有连线的 agent 对之间转发；无连线时 invoke 返回 400。
4. auto_relay 模式下，agent 输出带 `[NEXT: ...]` 时自动接力，目标必须在 edges 允许范围内。
5. agent 无有效声明时 session 停下等用户，不乱跑。
6. 用户可随时 Start/Stop 接力。
7. 旧的 auto_3agent 代码、API、UI 完全移除。
8. 旧 manual session（无 edges）仍可正常使用。
9. `npm run typecheck` 和 `npm test` 全绿。

## 13. 不在本次范围

- 本机 agent 与远端 agent 的跨边界互联（明确排除）。
- 多个远端目标（多台机器）的 session。
- agent 主动调用 MCP 工具来触发转发（本阶段用 `[NEXT:]` 文本标记）。
- LLM 路由器自动判别下一个收件人。
- 自动重试 / 自动修订循环（auto_3agent 的 reviewer 反馈机制不迁移到 auto_relay；agent 想重试就自己 `[NEXT:]` 回对方）。
- 可视化图编辑器（本次用矩阵 checkbox，后续可升级为拖拽画布）。

## 14. 工作分解（建议实现顺序）

1. **shared 类型**：加 `SessionEdge` / `RelayState` / routingMode 新值；删旧 auto 类型。
2. **db 迁移**：`edges_json` / `relay_state_json` 列；`mapSession` 解析；`createSession` locality 校验 + edges 转换存库。
3. **buildPrompt**：注入协作上下文 + `[NEXT:]` 语法说明。
4. **app 接力状态机**：`parseNextTag` / `edgeAllows` / `maybeAdvanceRelay`；删除 `maybeAdvanceAutoSession` 及相关。
5. **app API**：删 `/auto-sessions`、`/auto/start`、`/auto/stop`；加 `/relay/start`、`/relay/stop`；`invoke`/`continue` 加 edges 校验。
6. **app.test.ts**：删旧 auto 测试，加 §11 的新测试。
7. **web CreateSessionForm**：locality 选择 + edges 矩阵 + routingMode。
8. **web SessionDetail / Composer**：显示图、约束收件人、接力控制按钮。
9. **全链路 typecheck + test 验收。**

每一步完成后跑一次 typecheck，保持绿。
