# Loopy

Loopy is a local Web + Node workbench for experimenting with multi-agent development workflows.
It lets CLI agents such as opencode and Claude exchange prompts, inspect each other's results,
and keep a durable timeline of messages, invocations, logs, and artifacts.

Loopy runs on your own machine. It does not manage provider API keys directly; it calls local or
remote CLI tools that you have already configured.

## Features

- Local Fastify API + React/Vite web UI.
- Agent profiles for `opencode`, `claude`, and generic shell commands.
- Manual agent-to-agent handoff and automatic relay sessions.
- Per-session workspace selection.
- Invocation logs with prompt, command snapshot, stdout, stderr, result, status, and artifacts.
- Optional SSH remote execution through a private local config file.
- SQLite persistence under `data/`, ignored by git.

## Requirements

- macOS or another Unix-like development machine.
- Node.js 20+ and npm.
- Optional: `opencode` CLI installed and configured.
- Optional: `claude` CLI installed locally or on your configured remote host.

## Install

```bash
npm install
```

## Local Private Config

Loopy keeps machine-specific information out of source code.
Public source only includes anonymous defaults in `config/loopy.example.json`.

Create your private config:

```bash
cp config/loopy.example.json config/loopy.local.json
```

Edit `config/loopy.local.json`:

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

`config/loopy.local.json` is ignored by git. Put real hostnames, SSH key paths, usernames,
and personal workspace paths there, not in source files.

You can also point Loopy to another private config file:

```bash
LOOPY_LOCAL_CONFIG=/path/to/loopy.local.json npm run dev
```

If no local config exists, Loopy still starts. It simply leaves the default workspace empty and
does not seed remote Claude agent profiles.

## Run

Start the server and web app together:

```bash
npm run dev
```

Default URLs:

- Web: `http://localhost:5173`
- API: `http://localhost:8787`

The Vite dev server proxies `/api` requests to the Node server.

## Using The Web UI

### 1. Configure Agents

Open the Agents page.

- Use the default opencode profiles, or create a new profile.
- Choose an adapter: `opencode_cli`, `claude_cli`, or `shell_command`.
- Set command, args, model, working directory, role prompt, timeout, and permission mode.
- Click Test to verify the CLI is available.
- Enable remote execution only when your private config or manual SSH fields are correct.

The default opencode command shape is:

```text
opencode run -m {model} --dir {workspace} {prompt}
```

`{workspace}` and `{prompt}` are filled by Loopy for each invocation.

### 2. Create A Session

Open the Sessions page and click New Session.

- Pick Local or Remote.
- Enter a session name, goal, and workspace.
- Select participants.
- Choose Manual for direct handoff, or Auto Relay for graph-based agent conversation.
- Optionally add communication edges between agents.

A session keeps its own message timeline and invocation history.

### 3. Send Work To An Agent

In the session detail view:

- Send a prompt to a participant.
- Watch the invocation status update.
- Inspect stdout, stderr, result, and artifact paths in the log panel.
- Continue a result to another agent manually, or let Auto Relay follow the configured graph.
- Stop a running agent or stop relay automation when needed.

## Remote Execution

Remote profiles run over SSH. Loopy uploads prompts to the remote host, launches the CLI command,
polls logs, and stores the final result locally.

Before using a remote profile, verify SSH manually:

```bash
ssh -i ~/.ssh/example user@example.com "cd /home/user/git && pwd && node -v"
```

Remote defaults come only from `config/loopy.local.json`. They are not bundled into the frontend
and are not committed to the repository.

## Scripts

```bash
npm run dev
npm run typecheck
npm run test
npm run build
```

## Data And Artifacts

Runtime state is written under `data/`:

- SQLite database.
- Session messages.
- Invocation prompts.
- stdout/stderr logs.
- Result artifacts.

`data/` is ignored by git because it may contain prompts, local paths, logs, and other private data.

## Open Source Hygiene

Before publishing or committing, run:

```bash
rg -n --hidden -S "BEGIN .*PRIVATE KEY|api[_-]?key|token|secret|password|/Users/|~/.ssh|user@your-real-host" . \
  -g '!node_modules' -g '!data' -g '!apps/web/dist' -g '!.git'
```

Do not commit:

- `config/loopy.local.json`
- `data/`
- `apps/web/dist/`
- `.env*`
- real SSH hostnames, usernames, key paths, or provider secrets

## Project Docs

- [Product and technical plan](docs/LOOPY_PLAN.md)
- [MVP spec](docs/MVP_SPEC.md)
- [Phase 1 agent collaboration](docs/PHASE1_AGENT_COLLAB.md)
- [Phase 2 agent graph](docs/PHASE2_AGENT_GRAPH.md)
- [Remote connection template](docs/remote_connection.md)
