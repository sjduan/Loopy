# Loopy

> A local-first workbench for multi-agent development collaboration.

Loopy is a lightweight orchestration console that lets local coding agents (such as
`opencode` and `claude`) exchange prompts, review each other's results, ask follow-ups,
and form a collaborative loop around a shared development task — all observable and
controllable from a single web UI running on your own machine.

It deliberately does **not** try to be a general automation platform or a replacement for
your existing agent tools. Instead it is an **agent-neutral orchestration layer**: it
unifies configuration, describes message flow and stop conditions, and records every
invocation's input, output, and outcome.

```
            ┌──────────────────────────────────────────────┐
            │                  Loopy Web UI                 │
            │   Sessions · Agents · Timeline · Invocations  │
            └───────────────────────┬──────────────────────┘
                                    │  HTTP (Fastify)
            ┌───────────────────────▼──────────────────────┐
            │              Loopy Node Server                │
            │  Session Engine · Relay Graph · SQLite Store  │
            └───┬───────────────┬───────────────┬──────────┘
                │               │               │
        ┌───────▼──────┐ ┌──────▼───────┐ ┌─────▼──────────┐
        │ opencode CLI │ │  claude CLI  │ │  shell command │
        │   (local)    │ │ (local/SSH)  │ │   (fallback)   │
        └──────────────┘ └──────────────┘ └────────────────┘
```

---

## Highlights

- **Local-first** — runs entirely on your machine. No forced cloud account, no code upload.
  Your workspace, prompts, and logs never leave the host you control.
- **Agent-neutral** — an adapter pattern supports `opencode_cli`, `claude_cli`, and a
  generic `shell_command` fallback. Never hardcoded to a single tool.
- **Observable** — every invocation is traceable: prompt, command snapshot, stdout,
  stderr, exit code, duration, status, and artifact paths. Trust comes from seeing what
  agents said to each other.
- **Explicit stop conditions** — max rounds, per-call timeout, failure cap. No open-ended
  loops running in the dark.
- **Human at key nodes** — pause, resume, cancel, or take over the handoff at any time.
- **Graph-based routing** — describe who may talk to whom with communication `edges`, then
  let agents auto-relay via the `[NEXT: ...]` protocol.
- **Resilient remote execution** — run agents on a remote host over SSH with `setsid` +
  `nohup` headless jobs that survive connection drops, with live log polling.
- **Durable timeline** — messages, invocations, and artifacts are persisted to SQLite and
  the filesystem under `data/` so you can replay any session.

---

## How It Works

### Session model

A **Session** is a collaboration workspace with a goal, a workspace path, a set of
participant agents, and a message timeline. Each session is either **Manual** (you drive
the handoff) or **Auto Relay** (agents route among themselves).

### The relay protocol

Agents declare the next recipient with a structured line at the end of their output:

```text
[NEXT: Reviewer]
```

Loopy parses the *last* such tag, validates it against the session's communication
`edges`, and either auto-forwards a follow-up message or parks the session in
`waiting_for_user` when routing is not allowed.

### Communication edges

Edges define an undirected graph of who may talk to whom. Empty edges mean free routing
(backward compatible with manual sessions). `auto_relay` sessions with more than two
participants must declare edges explicitly — and you can configure them from a simple
N×N matrix in the UI.

### Locality constraint

A session is either fully **local** or fully **remote** to a single SSH target. Mixing
local and remote agents is forbidden at creation time, which keeps scheduling simple and
predictable.

### Session engine flow

```
load session → collect context → render prompt → call adapter
   → capture output/artifacts → append timeline → update memory
   → evaluate stop conditions → route next / pause / complete / fail
```

---

## Tech Stack

| Concern        | Choice                                              |
| -------------- | --------------------------------------------------- |
| Runtime        | Node.js 20+                                         |
| Language       | TypeScript 5.7 (ESM)                                |
| Backend        | Fastify 5 + `@fastify/cors`                         |
| Frontend       | React 19 + Vite 6 + lucide-react                    |
| Database       | better-sqlite3 (synchronous, native)                |
| Test runner    | vitest 2                                            |
| Monorepo       | npm workspaces (`apps/*`, `packages/*`)             |

### Repository layout

```
Loopy/
├── apps/
│   ├── server/          # Fastify API + session engine + adapters + SQLite
│   └── web/             # React + Vite single-page UI
├── packages/
│   └── shared/          # Shared types, enums, defaults (@loopy/shared)
├── config/
│   ├── loopy.example.json   # public, sanitized template (committed)
│   └── loopy.local.json     # private, machine-specific (git-ignored)
├── data/                # git-ignored runtime data (SQLite + artifacts)
├── docs/                # design + spec docs
└── package.json         # workspace root
```

---

## Quick Start

### Requirements

- macOS or another Unix-like development machine.
- Node.js 20+ and npm.
- Optional: `opencode` CLI installed and configured.
- Optional: `claude` CLI installed locally or on your configured remote host.

### Install

```bash
npm install
```

### Configure

Loopy keeps machine-specific information out of source control. The public template lives
at `config/loopy.example.json`; your private copy is `config/loopy.local.json` (ignored by
git).

```bash
cp config/loopy.example.json config/loopy.local.json
```

Edit `config/loopy.local.json` with your real values:

```json
{
  "defaults": {
    "workspace": "/path/to/your/workspace",
    "remoteTarget": {
      "label": "Remote machine",
      "host": "user@example.com",
      "sshKey": "~/.ssh/example",
      "remoteCwd": "/home/user/git"
    }
  }
}
```

Put real hostnames, SSH key paths, usernames, and personal workspace paths here — never in
source files. You can also point Loopy to another private config file:

```bash
LOOPY_LOCAL_CONFIG=/path/to/loopy.local.json npm run dev
```

If no local config exists, Loopy still starts; it simply leaves the default workspace empty
and does not seed remote Claude agent profiles.

### Run

Start the server and web app together:

```bash
npm run dev
```

| URL                   | What            |
| --------------------- | --------------- |
| `http://localhost:5173` | Web UI          |
| `http://localhost:8787` | Fastify API     |

The Vite dev server proxies `/api` requests to the Node server.

---

## Using the Web UI

### 1. Configure Agents

Open the **Agents** page. Loopy ships with several default opencode profiles, or you can
create a new one:

- Choose an adapter: `opencode_cli`, `claude_cli`, or `shell_command`.
- Set command, args, model, working directory, role prompt, timeout, and permission mode.
- Click **Test** to verify the CLI is available before saving.
- Enable remote execution only when your private config or manual SSH fields are correct.

The default opencode command shape is:

```text
opencode run -m {model} --dir {workspace} {prompt}
```

`{workspace}` and `{prompt}` are filled by Loopy for each invocation. Other tokens include
`{prompt_file}` and `{model}`.

### 2. Create a Session

Open the **Sessions** page and click **New Session**:

- Pick **Local** or **Remote**.
- Enter a session name, goal, and workspace.
- Select participants (filtered by locality).
- Choose **Manual** for direct handoff, or **Auto Relay** for graph-based conversation.
- Optionally configure the communication **edges** matrix between agents.

A session keeps its own message timeline and invocation history.

### 3. Send Work to an Agent

In the session detail view:

- Send a prompt to a participant, or start the relay.
- Watch the invocation status update in real time.
- Inspect stdout, stderr, result, and artifact paths in the log panel.
- **Continue** a result to another agent manually, or let Auto Relay follow the graph.
- **Stop** a running agent or stop relay automation whenever you need to take over.

---

## Remote Execution

Remote profiles run over SSH. Loopy uploads prompts to the remote host, launches the CLI
command as a headless job (`setsid` + `nohup`), polls logs every 2s, and stores the final
result locally. Because the job is detached, it survives SSH connection drops.

Before using a remote profile, verify SSH manually:

```bash
ssh -i ~/.ssh/example user@example.com "cd /home/user/git && pwd && node -v"
```

Remote defaults come only from `config/loopy.local.json`. They are not bundled into the
frontend and are never committed to the repository.

---

## Scripts

```bash
npm run dev          # run server + web concurrently (with watch)
npm run build        # build shared, server, and web
npm run typecheck    # tsc --noEmit across all workspaces
npm run test         # vitest run
```

You can override key paths and ports with environment variables:

| Variable              | Default                          |
| --------------------- | -------------------------------- |
| `LOOPY_HOST`          | `127.0.0.1`                      |
| `LOOPY_PORT`          | `8787`                           |
| `LOOPY_DATA_DIR`      | `<repo>/data`                    |
| `LOOPY_DB_PATH`       | `<dataDir>/loopy.db`             |
| `LOOPY_LOCAL_CONFIG`  | `<repo>/config/loopy.local.json` |

---

## Data & Privacy

Runtime state is written under `data/`:

- SQLite database (`loopy.db`, WAL mode).
- Per-session messages and artifacts: `prompt.md`, `stdout.log`, `stderr.log`, `result.md`.

`data/` is ignored by git because it may contain prompts, local paths, logs, and other
private data. Large text is stored on disk; the database stores paths and summaries only.

**Never commit:**

- `config/loopy.local.json`
- `data/`
- `apps/web/dist/`
- `.env*`
- real SSH hostnames, usernames, key paths, or provider secrets.

---

## Roadmap

| Milestone | Status | Focus                                            |
| --------- | ------ | ------------------------------------------------ |
| M0        | Done   | Planning & spec                                  |
| M1        | Done   | Local two-agent session                          |
| M2        | Done   | Web console + graph-based auto relay             |
| M3        | Next   | Human approval gates for high-risk actions       |
| M4        | Planned| Deeper agent integrations (Claude, Codex, …)    |
| M5        | Planned| macOS app packaging (Tauri / Electron)          |

Deferred items include cloud sync, multi-user support, a plugin marketplace, a visual
workflow canvas, and an LLM router.

---

## Project Docs

- [Product & technical plan](docs/LOOPY_PLAN.md)
- [MVP spec](docs/MVP_SPEC.md)
- [Phase 1 — agent collaboration](docs/PHASE1_AGENT_COLLAB.md)
- [Phase 2 — agent graph](docs/PHASE2_AGENT_GRAPH.md)
- [Remote connection template](docs/remote_connection.md)

---

## License

Licensed under the [Apache License, Version 2.0](LICENSE).
