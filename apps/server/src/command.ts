import { isTuiAdapter, type AgentProfile, type Session } from "@loopy/shared";

export type RenderCommandInput = {
  profile: AgentProfile;
  session: Session;
  prompt: string;
  promptPath: string;
};

export type RenderedCommand = {
  command: string;
  args: string[];
  cwd: string;
  snapshot: string;
};

// 远端执行所需的额外信息：上传后的远端 prompt 文件路径。
// 调用方（adapter.invokeRemote）在 SSH 启动前把本地 prompt 上传到这个路径，
// 渲染时把 {prompt} 替换成 $(cat <remotePromptFile>)，{prompt_file} 替换成远端路径。
export type RemoteRenderExtras = {
  remotePromptFile: string;
};

function resolveWorkspace(input: RenderCommandInput): string {
  return input.profile.remote?.remoteCwd ?? input.session.workspace;
}

function replaceTokens(value: string, input: RenderCommandInput, remoteExtras?: RemoteRenderExtras) {
  const workspace = resolveWorkspace(input);
  return value
    .replaceAll("{prompt_file}", remoteExtras?.remotePromptFile ?? input.promptPath)
    .replaceAll("{workspace}", workspace)
    .replaceAll("{model}", input.profile.model)
    .replaceAll(
      "{prompt}",
      remoteExtras ? `$(cat ${shellQuote(remoteExtras.remotePromptFile)})` : input.prompt
    );
}

function quote(value: string) {
  if (/^[a-zA-Z0-9_./:=@+-]+$/.test(value)) return value;
  return JSON.stringify(value);
}

// 用于拼接到远端 bash 命令里的单层引号（remotePromptFile 是受控路径，简单引号即可）。
function shellQuote(value: string) {
  if (/^[a-zA-Z0-9_./:=@+-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function renderCommand(input: RenderCommandInput, remoteExtras?: RemoteRenderExtras): RenderedCommand {
  const workspace = resolveWorkspace(input);
  let args =
    input.profile.args.length > 0
      ? input.profile.args.map((arg) => replaceTokens(arg, input, remoteExtras))
      : defaultArgs(input, workspace, remoteExtras);
  if (isTuiAdapter(input.profile.adapterType)) {
    args = withAdapterOptions(args, input.profile);
  }
  const command = replaceTokens(input.profile.command, input, remoteExtras);
  const cwd = replaceTokens(input.profile.cwd || workspace, input, remoteExtras);
  return {
    command,
    args,
    cwd,
    snapshot: [command, ...args].map(quote).join(" ")
  };
}

function withAdapterOptions(args: string[], profile: RenderCommandInput["profile"]) {
  if (profile.adapterType === "opencode_cli") {
    return withOpencodeOptions(args, profile);
  }
  if (profile.adapterType === "claude_cli") {
    return withClaudeOptions(args, profile);
  }
  return args;
}

function withOpencodeOptions(args: string[], profile: RenderCommandInput["profile"]) {
  const next = [...args];
  const insertAt = next[0] === "run" ? 1 : 0;
  if (profile.opencodeAgent && !next.includes("--agent")) {
    next.splice(insertAt, 0, "--agent", profile.opencodeAgent);
  }
  if (profile.skipPermissions && !next.includes("--dangerously-skip-permissions")) {
    const insertPermissionAt = profile.opencodeAgent && !args.includes("--agent") ? insertAt + 2 : insertAt;
    next.splice(insertPermissionAt, 0, "--dangerously-skip-permissions");
  }
  return next;
}

function withClaudeOptions(args: string[], profile: RenderCommandInput["profile"]) {
  const next = [...args];
  if (profile.skipPermissions && !next.includes("--dangerously-skip-permissions")) {
    next.push("--dangerously-skip-permissions");
  }
  return next;
}

function defaultArgs(input: RenderCommandInput, workspace: string, remoteExtras?: RemoteRenderExtras) {
  const promptToken = remoteExtras ? `$(cat ${shellQuote(remoteExtras.remotePromptFile)})` : input.prompt;
  if (input.profile.adapterType === "opencode_cli") {
    return ["run", "-m", input.profile.model, "--dir", workspace, promptToken];
  }
  if (input.profile.adapterType === "claude_cli") {
    return ["-p", promptToken, "--output-format", "text"];
  }
  return [promptToken];
}
