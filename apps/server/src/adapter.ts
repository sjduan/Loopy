import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isTuiAdapter, type AgentProfile, type AgentRuntimeSession, type InvocationStatus, type RemoteTarget, type Session } from "@loopy/shared";
import { renderCommand, type RemoteRenderExtras } from "./command.js";

export type AgentInvocationInput = {
  profile: AgentProfile;
  session: Session;
  prompt: string;
  promptPath: string;
  runtimeSession?: AgentRuntimeSession | null;
  signal?: AbortSignal;
  onOutput?: (chunk: string) => void;
};

export type AgentInvocationResult = {
  status: InvocationStatus;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  startedAt: string;
  endedAt: string;
  commandSnapshot: string;
  nativeSessionId?: string | null;
};

export async function invokeAgent(input: AgentInvocationInput): Promise<AgentInvocationResult> {
  const rendered = renderCommand(input);
  const startedAt = new Date().toISOString();

  // 远端执行：headless + nohup + log 轮询，扛 SSH 断线。
  if (input.profile.remote) {
    return invokeRemote(input, rendered, startedAt);
  }

  try {
    await access(rendered.cwd);
  } catch {
    return {
      status: "failed",
      stdout: "",
      stderr: `Workspace does not exist or is not accessible: ${rendered.cwd}`,
      exitCode: null,
      startedAt,
      endedAt: new Date().toISOString(),
      commandSnapshot: rendered.snapshot
    };
  }

  // 本机 TUI 类 adapter（opencode / claude）走 PTY 包一层 + ANSI 剥离 + 实时流。
  if (isTuiAdapter(input.profile.adapterType)) {
    const result = await invokeWithScriptPty(input, rendered, startedAt);
    return withNativeSessionResult(input, result);
  }

  // shell_command fallback：普通 spawn。
  return invokeLocalSpawn(input, rendered, startedAt);
}

// ───────────────────────── 本机执行 ─────────────────────────

function invokeLocalSpawn(
  input: AgentInvocationInput,
  rendered: ReturnType<typeof renderCommand>,
  startedAt: string
): Promise<AgentInvocationResult> {
  return new Promise<AgentInvocationResult>((resolve) => {
    const child = spawn(rendered.command, rendered.args, {
      cwd: rendered.cwd,
      shell: false,
      env: { ...process.env, PATH: withOpencodePath(process.env.PATH) },
      detached: process.platform !== "win32"
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let cancelled = false;
    let resolved = false;

    const killChild = () => killProcessGroup(child);

    const finish = (result: AgentInvocationResult) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };

    const onAbort = () => {
      cancelled = true;
      killChild();
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killChild();
    }, input.profile.timeoutMs);

    if (input.signal?.aborted) {
      onAbort();
    } else {
      input.signal?.addEventListener("abort", onAbort, { once: true });
    }

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      finish({
        status: "failed",
        stdout,
        stderr: stderr ? `${stderr}\n${error.message}` : error.message,
        exitCode: null,
        startedAt,
        endedAt: new Date().toISOString(),
        commandSnapshot: rendered.snapshot
      });
    });
    child.on("close", (code) => {
      finish({
        status: cancelled ? "cancelled" : timedOut ? "timeout" : code === 0 ? "succeeded" : "failed",
        stdout,
        stderr,
        exitCode: code,
        startedAt,
        endedAt: new Date().toISOString(),
        commandSnapshot: rendered.snapshot
      });
    });
  });
}

function invokeWithScriptPty(
  input: AgentInvocationInput,
  rendered: ReturnType<typeof renderCommand>,
  startedAt: string
): Promise<AgentInvocationResult> {
  return new Promise<AgentInvocationResult>((resolve) => {
    let output = "";
    let timedOut = false;
    let cancelled = false;
    let resolved = false;

    const child = spawn("script", ["-q", "/dev/null", resolveCommand(rendered.command), ...rendered.args], {
      cwd: rendered.cwd,
      env: { ...process.env, PATH: withOpencodePath(process.env.PATH), TERM: "xterm-256color", NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32"
    });

    const finish = (status: InvocationStatus, exitCode: number | null) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", onAbort);
      resolve({
        status,
        stdout: stripAnsi(output),
        stderr: "",
        exitCode,
        startedAt,
        endedAt: new Date().toISOString(),
        commandSnapshot: rendered.snapshot
      });
    };

    const onAbort = () => {
      cancelled = true;
      killProcessGroup(child);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killProcessGroup(child);
    }, input.profile.timeoutMs);

    if (input.signal?.aborted) {
      onAbort();
    } else {
      input.signal?.addEventListener("abort", onAbort, { once: true });
    }

    child.stdout?.on("data", (data: Buffer) => {
      const text = data.toString();
      output += text;
      input.onOutput?.(stripAnsi(text));
    });
    child.stderr?.on("data", (data: Buffer) => {
      const text = data.toString();
      output += text;
      input.onOutput?.(stripAnsi(text));
    });

    child.on("error", (error) => {
      output += error.message;
      finish("failed", null);
    });

    child.on("close", (exitCode) => {
      finish(cancelled ? "cancelled" : timedOut ? "timeout" : exitCode === 0 ? "succeeded" : "failed", exitCode);
    });
  });
}

function killProcessGroup(child: ReturnType<typeof spawn>) {
  if (child.pid && process.platform !== "win32") {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
  } else {
    child.kill("SIGTERM");
  }
  setTimeout(() => {
    if (child.pid && process.platform !== "win32") {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    } else {
      child.kill("SIGKILL");
    }
  }, 2000).unref();
}

function resolveCommand(command: string) {
  if (command.includes("/") || command !== "opencode") return command;
  const candidate = path.join(os.homedir(), ".opencode", "bin", "opencode");
  return fs.existsSync(candidate) ? candidate : command;
}

function withOpencodePath(currentPath = "") {
  const opencodeBin = path.join(os.homedir(), ".opencode", "bin");
  return currentPath.includes(opencodeBin) ? currentPath : `${opencodeBin}:${currentPath}`;
}

function stripAnsi(value: string) {
  return value
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b\][^\u0007]*(\u0007|\u001b\\)/g, "")
    .replace(/\^D/g, "")
    .replace(/[\u0004\u0008]/g, "")
    .replace(/\r/g, "");
}

// ───────────────────────── 远端执行 ─────────────────────────
// 模型：scp prompt 上去 → SSH setsid+nohup 起进程，日志落 /tmp/proj_output/<run_id>/ →
// 周期 SSH 轮询（exit_code 出现=done，按偏移量取新增 stdout 流式回传）→ 完成后 cat 全量。
// nohup 让远端进程脱离 SSH 父进程，SSH 断线不影响它；重连后照常轮询。

const REMOTE_POLL_INTERVAL_MS = 2000;
const REMOTE_UPLOAD_MAX_ATTEMPTS = 3;

function invokeRemote(
  input: AgentInvocationInput,
  rendered: ReturnType<typeof renderCommand>,
  startedAt: string
): Promise<AgentInvocationResult> {
  const remote = input.profile.remote!;
  const runId = `loopy_${input.session.id}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const runDir = `/tmp/proj_output/${runId}`;
  const remotePromptFile = `/tmp/loopy-prompts/${runId}.md`;

  return (async () => {
    // 1. 用远端 prompt 文件路径重新渲染（{prompt} → $(cat remotePromptFile)，{workspace} → remoteCwd）。
    const extras: RemoteRenderExtras = { remotePromptFile };
    const remoteRendered = renderCommand(input, extras);

    // 2. 通过 SSH stdin 写入 prompt 文件。相比 mkdir+scp 少一次连接，也更容易重试。
    const uploadOk = await uploadRemotePromptWithRetry(remote, input.prompt, remotePromptFile);
    if (!uploadOk.ok) {
      return failedResult(rendered.snapshot, startedAt, `Failed to upload prompt to remote: ${uploadOk.stderr || uploadOk.stdout}`);
    }

    // 3. 启动远端 headless 进程（setsid 进程组 + nohup，立即返回）。启动不重试，避免断线后重复启动。
    const launch = await launchRemoteJob(remote, runDir, remoteRendered.snapshot);
    if (!launch.ok) {
      return failedResult(rendered.snapshot, startedAt, `Failed to launch remote job: ${launch.stderr || launch.stdout}`);
    }

    // 4. 轮询直到完成、超时或取消。
    const deadline = Date.now() + input.profile.timeoutMs;
    let cancelled = false;
    let lastStdoutOffset = 0;

    const onAbort = () => {
      cancelled = true;
    };
    if (input.signal?.aborted) cancelled = true;
    else input.signal?.addEventListener("abort", onAbort, { once: true });

    let exitCode: number | null = null;
    let done = false;
    let lastErr = "";

    while (!done) {
      if (cancelled) {
        await killRemoteJob(remote, runDir);
        break;
      }
      if (Date.now() > deadline) {
        await killRemoteJob(remote, runDir);
        input.signal?.removeEventListener("abort", onAbort);
        const logs = await fetchRemoteLogs(remote, runDir);
        const timeoutMessage = `Remote invocation timed out after ${input.profile.timeoutMs}ms.`;
        return {
          status: "timeout",
          stdout: stripAnsi(logs.stdout),
          stderr: [timeoutMessage, logs.stderr].filter(Boolean).join("\n\n"),
          exitCode: null,
          startedAt,
          endedAt: new Date().toISOString(),
          commandSnapshot: rendered.snapshot
        };
      }

      const poll = await pollRemoteJob(remote, runDir, lastStdoutOffset);
      if (poll.ok) {
        // 流式回传新增 stdout。
        if (poll.newStdout) {
          lastStdoutOffset += Buffer.byteLength(poll.newStdout, "utf8");
          input.onOutput?.(stripAnsi(poll.newStdout));
        }
        if (poll.done) {
          exitCode = poll.exitCode;
          done = true;
        } else if (poll.dead) {
          // 进程已消失但没有 exit_code：异常崩溃。
          done = true;
          exitCode = poll.exitCode;
          lastErr = "Remote process exited without writing an exit code.";
        }
      } else {
        // 单次轮询失败（SSH 抖动等），记录但继续重试，不直接判失败。
        lastErr = poll.error || "Transient SSH poll failure; retrying.";
      }
      if (!done) await sleep(REMOTE_POLL_INTERVAL_MS);
    }

    input.signal?.removeEventListener("abort", onAbort);

    // 5. 取回完整日志。
    const logs = await fetchRemoteLogs(remote, runDir);
    const status: InvocationStatus = cancelled
      ? "cancelled"
      : exitCode === 0
        ? "succeeded"
        : "failed";

    return withRemoteNativeSessionResult(input, {
      status,
      stdout: stripAnsi(logs.stdout),
      stderr: logs.stderr || lastErr,
      exitCode,
      startedAt,
      endedAt: new Date().toISOString(),
      commandSnapshot: rendered.snapshot
    });
  })();
}

async function withNativeSessionResult(input: AgentInvocationInput, result: AgentInvocationResult): Promise<AgentInvocationResult> {
  const runtime = input.runtimeSession;
  if (!runtime || runtime.contextMode !== "native_cli") return result;
  if (input.profile.adapterType === "claude_cli") {
    return { ...result, nativeSessionId: runtime.nativeSessionId };
  }
  if (input.profile.adapterType !== "opencode_cli") return result;
  if (runtime.nativeSessionId) return { ...result, nativeSessionId: runtime.nativeSessionId };
  if (!runtime.nativeTitle) return result;
  const list = await runSmallCommand(resolveCommand(input.profile.command || "opencode"), ["session", "list"]);
  if (!list.ok) return result;
  return { ...result, nativeSessionId: parseOpencodeSessionIdFromList(list.stdout, runtime.nativeTitle) };
}

async function withRemoteNativeSessionResult(input: AgentInvocationInput, result: AgentInvocationResult): Promise<AgentInvocationResult> {
  const runtime = input.runtimeSession;
  if (!runtime || runtime.contextMode !== "native_cli") return result;
  if (input.profile.adapterType === "claude_cli") {
    return { ...result, nativeSessionId: runtime.nativeSessionId };
  }
  if (input.profile.adapterType !== "opencode_cli") return result;
  if (runtime.nativeSessionId) return { ...result, nativeSessionId: runtime.nativeSessionId };
  if (!runtime.nativeTitle || !input.profile.remote) return result;
  const cmd = input.profile.command || "opencode";
  const list = await runRemoteBash(input.profile.remote, `${JSON.stringify(cmd)} session list`);
  if (!list.ok) return result;
  return { ...result, nativeSessionId: parseOpencodeSessionIdFromList(list.stdout, runtime.nativeTitle) };
}

export function parseOpencodeSessionIdFromList(output: string, title: string): string | null {
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("ses_") || !trimmed.includes(title)) continue;
    return trimmed.split(/\s+/)[0] ?? null;
  }
  return null;
}

function failedResult(snapshot: string, startedAt: string, message: string): AgentInvocationResult {
  return {
    status: "failed",
    stdout: "",
    stderr: message,
    exitCode: null,
    startedAt,
    endedAt: new Date().toISOString(),
    commandSnapshot: snapshot
  };
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ssh 基础参数。BatchMode=yes 避免卡在密码/passphrase 提示上。
function sshArgs(remote: RemoteTarget, remoteCmd: string[]): string[] {
  const args = [
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=10",
    "-o",
    "ConnectionAttempts=3",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=3"
  ];
  if (remote.sshKey) args.push("-i", expandTilde(remote.sshKey));
  args.push(remote.host);
  args.push(...remoteCmd);
  return args;
}

function expandTilde(p: string) {
  if (p.startsWith("~/") || p === "~") return path.join(os.homedir(), p.slice(1));
  return p;
}

// 通过 stdin 把 bash 脚本喂给远端 `bash -s`，避免一层 SSH 引号嵌套。
function runRemoteBash(
  remote: RemoteTarget,
  script: string,
  scriptArgs: string[] = []
): Promise<{ ok: boolean; code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("ssh", sshArgs(remote, ["bash", "-s", "--", ...scriptArgs]), { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let stdinError = "";
    let settled = false;
    const finish = (result: { ok: boolean; code: number | null; stdout: string; stderr: string }) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString()));
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
    child.stdin.on("error", (error) => {
      stdinError = error.message;
    });
    child.on("error", (error) => finish({ ok: false, code: null, stdout, stderr: [stripSshNoise(stderr), error.message].filter(Boolean).join("\n") }));
    child.on("close", (code) => {
      const cleanStderr = [stripSshNoise(stderr), stdinError ? `stdin write failed: ${stdinError}` : ""].filter(Boolean).join("\n");
      finish({ ok: code === 0 && !stdinError, code, stdout, stderr: cleanStderr });
    });
    child.stdin.write(script, (error) => {
      if (error) stdinError = error.message;
      child.stdin.end();
    });
  });
}

// OpenSSH 的 post-quantum 提醒（pq.html）不是错误，但会污染 stderr，排查时去掉。
function stripSshNoise(stderr: string): string {
  return stderr
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      return (
        trimmed !== "" &&
        !trimmed.startsWith("** WARNING: connection is not using a post-quantum") &&
        !trimmed.startsWith("** This session may be vulnerable") &&
        !trimmed.startsWith("** The server may need to be upgraded") &&
        !trimmed.includes("openssh.com/pq.html")
      );
    })
    .join("\n");
}

async function uploadRemotePromptWithRetry(
  remote: RemoteTarget,
  prompt: string,
  remotePath: string
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const failures: string[] = [];
  for (let attempt = 1; attempt <= REMOTE_UPLOAD_MAX_ATTEMPTS; attempt += 1) {
    const result = await uploadRemotePrompt(remote, prompt, remotePath);
    if (result.ok) {
      return attempt === 1
        ? result
        : {
            ...result,
            stderr: `Prompt upload succeeded on attempt ${attempt} after ${attempt - 1} transient failure(s).`
          };
    }
    failures.push(`attempt ${attempt}: ${result.stderr || result.stdout || "unknown upload failure"}`);
    if (attempt < REMOTE_UPLOAD_MAX_ATTEMPTS) {
      await sleep(500 * 2 ** (attempt - 1));
    }
  }
  return {
    ok: false,
    stdout: "",
    stderr: `Prompt upload failed after ${REMOTE_UPLOAD_MAX_ATTEMPTS} attempts.\n${failures.join("\n")}`
  };
}

async function uploadRemotePrompt(
  remote: RemoteTarget,
  prompt: string,
  remotePath: string
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const remoteDir = path.posix.dirname(remotePath);
  const promptB64 = Buffer.from(prompt, "utf8").toString("base64");
  const script = `set -euo pipefail
remote_dir=$1
remote_path=$2
mkdir -p "$remote_dir"
tmp_b64="$remote_path.b64.$$"
cat > "$tmp_b64" <<'LOOPYPROMPTB64'
${promptB64}
LOOPYPROMPTB64
if base64 -d "$tmp_b64" > "$remote_path" 2>/dev/null; then
  rm -f "$tmp_b64"
elif base64 --decode "$tmp_b64" > "$remote_path" 2>/dev/null; then
  rm -f "$tmp_b64"
else
  rm -f "$tmp_b64"
  echo "Failed to decode prompt payload with base64." >&2
  exit 1
fi
printf 'UPLOADED:%s\\n' "$remote_path"
`;
  const result = await runRemoteBash(remote, script, [remoteDir, remotePath]);
  return {
    ok: result.ok,
    stdout: result.stdout,
    stderr: result.ok ? stripSshNoise(result.stderr) : `ssh prompt upload failed: ${stripSshNoise(result.stderr) || result.stdout}`
  };
}

// 启动远端 headless 作业：写命令文件 + runner，setsid 起进程组，立即返回。
function launchRemoteJob(remote: RemoteTarget, runDir: string, snapshot: string) {
  const cmdDir = path.posix.dirname(runDir) + "/cmds";
  const cmdFile = `${cmdDir}/${path.posix.basename(runDir)}.sh`;
  const runnerFile = `${runDir}/runner.sh`;
  const script = `set -euo pipefail
mkdir -p "${runDir}" "${cmdDir}"
cat > "${cmdFile}" <<'LOOPYCMD'
${snapshot}
LOOPYCMD
cat > "${runnerFile}" <<'RUNNER'
bash "$1"
code=$?
echo "$code" > "$RUN_DIR/exit_code"
date -Is > "$RUN_DIR/finished_at"
RUNNER
export RUN_DIR="${runDir}"
date -Is > "$RUN_DIR/started_at"
cd "${remote.remoteCwd}"
setsid bash "${runnerFile}" "${cmdFile}" > "$RUN_DIR/stdout.log" 2> "$RUN_DIR/stderr.log" < /dev/null &
echo $! > "$RUN_DIR/pid"
echo "LAUNCHED:$RUN_DIR"
`;
  return runRemoteBash(remote, script);
}

interface PollResult {
  ok: boolean;
  done: boolean;
  dead: boolean;
  exitCode: number | null;
  newStdout: string;
  error?: string;
}

// 轮询：检查 exit_code，按偏移量取新增 stdout，取 stderr 末尾。
function pollRemoteJob(remote: RemoteTarget, runDir: string, stdoutOffset: number): Promise<PollResult> {
  const script = `set +e
run_dir="$1"
stdout_off="$2"
if [ -f "\$run_dir/exit_code" ]; then
  echo "STATUS:done:\$(cat "\$run_dir/exit_code")"
else
  if [ -f "\$run_dir/pid" ]; then
    pid=\$(cat "\$run_dir/pid")
    if kill -0 "\$pid" 2>/dev/null; then
      echo "STATUS:running"
    else
      echo "STATUS:dead"
    fi
  else
    echo "STATUS:missing"
  fi
fi
echo "---NEWSTDOUT---"
size=\$(wc -c < "\$run_dir/stdout.log" 2>/dev/null || echo 0)
if [ "\$size" -gt "\$stdout_off" ] 2>/dev/null; then
  dd if="\$run_dir/stdout.log" bs=1 skip="\$stdout_off" count=131072 2>/dev/null
fi
echo "---END---"
`;
  return (async () => {
    const res = await runRemoteBash(remote, script, [runDir, String(stdoutOffset)]);
    if (!res.ok && res.code !== 0) {
      // SSH 自身失败（网络抖动）。
      return { ok: false, done: false, dead: false, exitCode: null, newStdout: "", error: res.stderr || res.stdout };
    }
    const out = res.stdout;
    let status = "running";
    let exitCode: number | null = null;
    const statusLine = out.split("\n").find((l) => l.startsWith("STATUS:"));
    if (statusLine) {
      const parts = statusLine.split(":");
      status = parts[1] ?? "running";
      if (parts.length >= 3 && parts[2] !== "") {
        const parsed = Number(parts[2]);
        if (!Number.isNaN(parsed)) exitCode = parsed;
      }
    }
    let newStdout = "";
    const startMarker = out.indexOf("---NEWSTDOUT---");
    const endMarker = out.lastIndexOf("---END---");
    if (startMarker >= 0 && endMarker > startMarker) {
      // 去掉 marker 行后的换行。
      const inner = out.slice(startMarker + "---NEWSTDOUT---".length, endMarker);
      // dd 输出与 marker 之间有一个换行，剥掉。
      newStdout = inner.startsWith("\n") ? inner.slice(1) : inner;
    }
    const done = status === "done";
    const dead = status === "dead";
    return { ok: true, done, dead, exitCode, newStdout };
  })();
}

function killRemoteJob(remote: RemoteTarget, runDir: string) {
  const script = `set +e
run_dir="$1"
if [ -f "\$run_dir/pid" ]; then
  pid=\$(cat "\$run_dir/pid")
  # setsid 起的进程组，负号 pid 杀整组。
  kill -TERM -"\$pid" 2>/dev/null
  kill -TERM "\$pid" 2>/dev/null
  sleep 1
  kill -KILL -"\$pid" 2>/dev/null
  kill -KILL "\$pid" 2>/dev/null
fi
`;
  return runRemoteBash(remote, script, [runDir]);
}

function fetchRemoteLogs(remote: RemoteTarget, runDir: string): Promise<{ stdout: string; stderr: string }> {
  const script = `set +e
run_dir="$1"
echo "---STDOUT---"
cat "\$run_dir/stdout.log" 2>/dev/null
echo "---STDERR---"
cat "\$run_dir/stderr.log" 2>/dev/null
echo "---END---"
`;
  return (async () => {
    const res = await runRemoteBash(remote, script, [runDir]);
    const out = res.stdout;
    const stdoutStart = out.indexOf("---STDOUT---");
    const stderrStart = out.indexOf("---STDERR---");
    const end = out.lastIndexOf("---END---");
    let stdout = "";
    let stderr = "";
    if (stdoutStart >= 0 && stderrStart > stdoutStart) {
      stdout = out.slice(stdoutStart + "---STDOUT---".length, stderrStart).replace(/^\n/, "");
    }
    if (stderrStart >= 0 && end > stderrStart) {
      stderr = out.slice(stderrStart + "---STDERR---".length, end).replace(/^\n/, "");
    }
    return { stdout, stderr };
  })();
}

// ───────────────────────── prompt 模板 + 测试 ─────────────────────────

export function buildPrompt(profile: AgentProfile, session: Session, message: string) {
  const currentParticipant = session.participants?.find((participant) => participant.agentProfileId === profile.id);
  const participants = session.participants ?? [];
  const handoffTargets = currentParticipant
    ? participants.filter((participant) => participant.id !== currentParticipant.id && promptEdgeAllows(session, currentParticipant.id, participant.id))
    : participants.filter((participant) => participant.agentProfileId !== profile.id);
  const participantLines = participants.map((participant) => {
    const locality = participant.agentProfile?.remote ? `remote ${participant.agentProfile.remote.host}` : "local";
    return `- ${participant.displayName} (${participant.agentProfile?.adapterType ?? "agent"}, ${locality})`;
  });
  const targetNames = handoffTargets.map((participant) => participant.displayName);
  return [
    `# Loopy Session`,
    ``,
    `Goal: ${session.goal}`,
    `Workspace: ${session.workspace}`,
    ``,
    `# Participants`,
    participantLines.length ? participantLines.join("\n") : "- No other participants are registered.",
    ``,
    `# Your Communication Channels`,
    targetNames.length
      ? `You can hand off to: ${targetNames.join(", ")}`
      : `You do not have any configured handoff targets.`,
    `To hand off, end your response with a final line exactly like:`,
    `    [NEXT: <display-name>]`,
    targetNames.length
      ? `The <display-name> must be one of: ${targetNames.join(", ")}`
      : `If your work is done or no handoff is needed, do not include a [NEXT:] line.`,
    `If your work is done or no handoff is needed, do not include a [NEXT:] line.`,
    ``,
    `# Agent Role`,
    profile.rolePrompt || "You are a coding agent participating in a multi-agent development session.",
    ``,
    `# Operating Rules`,
    `Follow the Task Message exactly. Do not inspect files, run shell commands, or modify the workspace unless the Task Message explicitly asks you to do that. If the task is a simple response check, only answer the check.`,
    ``,
    `# Task Message`,
    message,
    ``,
    `# Response Contract`,
    `Return a concise result. If you used tools or inspected the workspace, mention what you did; otherwise just answer the task directly.`
  ].join("\n");
}

function promptEdgeAllows(session: Session, fromParticipantId: string, toParticipantId: string) {
  if (session.edges.length === 0) return true;
  return session.edges.some(
    (edge) =>
      (edge.fromParticipantId === fromParticipantId && edge.toParticipantId === toParticipantId) ||
      (edge.fromParticipantId === toParticipantId && edge.toParticipantId === fromParticipantId)
  );
}

export async function testAgentProfile(profile: AgentProfile, sessionWorkspace: string) {
  const pseudoSession = {
    id: "session_preview",
    name: "Preview",
    goal: "Preview command rendering.",
    workspace: sessionWorkspace || profile.cwd || process.cwd(),
    status: "draft",
    routingMode: "manual",
    maxRounds: 1,
    roundCount: 0,
    maxFailures: 1,
    failureCount: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    endedAt: null,
    stopReason: null,
    edges: [],
    relayState: null
  } satisfies Session;
  const commandPreview = renderCommand({
    profile,
    session: pseudoSession,
    prompt: "Hello from Loopy test.",
    promptPath: "/tmp/loopy-prompt.md"
  }).snapshot;

  // 远端 profile：通过 SSH 在远端做版本检查。
  if (profile.remote) {
    return testRemoteProfile(profile, commandPreview);
  }

  // shell_command 本机：只验证可渲染。
  if (profile.adapterType === "shell_command") {
    return { ok: true, commandPreview, message: "Shell command profile can be rendered." };
  }

  // opencode / claude 本机。
  const command = resolveCommand(profile.command || (profile.adapterType === "claude_cli" ? "claude" : "opencode"));
  const versionCheck = await runSmallCommand(command, ["--version"]);
  if (!versionCheck.ok) {
    return {
      ok: false,
      commandPreview,
      message: `Could not run ${profile.command}: ${versionCheck.stderr || versionCheck.stdout || "version check failed"}`
    };
  }

  if (profile.adapterType === "opencode_cli") {
    const provider = profile.model.split("/")[0];
    if (!provider) {
      return { ok: false, commandPreview, version: versionCheck.stdout.trim(), message: `Model must use provider/model format. Current value: ${profile.model}` };
    }
    const modelCheck = await runSmallCommand(command, ["models", provider]);
    if (!modelCheck.ok) {
      return { ok: false, commandPreview, version: versionCheck.stdout.trim(), message: modelCheck.stderr.trim() || modelCheck.stdout.trim() || `Provider not available: ${provider}` };
    }
    if (!modelCheck.stdout.includes(profile.model)) {
      return { ok: false, commandPreview, version: versionCheck.stdout.trim(), message: `opencode provider '${provider}' is available, but model '${profile.model}' was not listed. Available models:\n${modelCheck.stdout.trim()}` };
    }
    return { ok: true, commandPreview, version: versionCheck.stdout.trim(), message: `opencode ${versionCheck.stdout.trim() || "is available"} and model ${profile.model} is listed.` };
  }

  // claude_cli 本机：只做版本检查（claude model 是别名，不做 provider 校验）。
  return { ok: true, commandPreview, version: versionCheck.stdout.trim(), message: `claude ${versionCheck.stdout.trim() || "is available"}.` };
}

async function testRemoteProfile(profile: AgentProfile, commandPreview: string) {
  const remote = profile.remote!;
  const cmd = profile.command || (profile.adapterType === "claude_cli" ? "claude" : "opencode");
  const check = await runRemoteBash(remote, `command -v ${JSON.stringify(cmd)} && ${JSON.stringify(cmd)} --version`);
  if (!check.ok) {
    return {
      ok: false,
      commandPreview,
      message: `Remote ${remote.host}: could not run '${cmd}'. ${check.stderr.trim() || check.stdout.trim() || "Is it on the remote PATH?"}`
    };
  }
  const version = check.stdout.trim().split("\n").pop() || "";
  return {
    ok: true,
    commandPreview,
    version,
    message: `Remote ${remote.host}: '${cmd}' is available${version ? ` (${version})` : ""}. cwd=${remote.remoteCwd}`
  };
}

function runSmallCommand(command: string, args: string[]) {
  return new Promise<{ ok: boolean; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(command, args, { shell: false, env: { ...process.env, PATH: withOpencodePath(process.env.PATH) } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      resolve({
        ok: false,
        stdout,
        stderr: error.message
      });
    });
    child.on("close", (code) => {
      resolve({
        ok: code === 0,
        stdout,
        stderr
      });
    });
  });
}
