import { describe, expect, it } from "vitest";
import { DEFAULT_INVOCATION_TIMEOUT_MS, DEFAULT_OPENCODE_MODEL, type AgentProfile, type Session } from "@loopy/shared";
import { renderCommand } from "./command.js";

const profile: AgentProfile = {
  id: "agent_test",
  name: "opencode planner",
  adapterType: "opencode_cli",
  command: "opencode",
  args: ["run", "-m", "{model}", "--dir", "{workspace}", "{prompt}"],
  cwd: "{workspace}",
  rolePrompt: "Plan.",
  model: DEFAULT_OPENCODE_MODEL,
  opencodeAgent: "",
  skipPermissions: false,
  timeoutMs: DEFAULT_INVOCATION_TIMEOUT_MS,
  remote: null,
  createdAt: "2026-06-22T00:00:00.000Z",
  updatedAt: "2026-06-22T00:00:00.000Z"
};

const session: Session = {
  id: "session_test",
  name: "Test",
  goal: "Verify command rendering.",
  workspace: "/tmp/loopy-workspace",
  status: "active",
  routingMode: "manual",
  maxRounds: 6,
  roundCount: 0,
  maxFailures: 2,
  failureCount: 0,
  createdAt: "2026-06-22T00:00:00.000Z",
  updatedAt: "2026-06-22T00:00:00.000Z",
  endedAt: null,
  stopReason: null,
  edges: [],
  relayState: null
};

describe("renderCommand", () => {
  it("renders opencode provider/model, workspace, and prompt", () => {
    const rendered = renderCommand({
      profile,
      session,
      prompt: "hello",
      promptPath: "/tmp/prompt.md"
    });
    expect(rendered.command).toBe("opencode");
    expect(rendered.args).toEqual(["run", "-m", "zhipuai-coding-plan/glm-5.2", "--dir", "/tmp/loopy-workspace", "hello"]);
    expect(rendered.snapshot).toContain("zhipuai-coding-plan/glm-5.2");
  });

  it("adds opencode mode and permission flags from the profile", () => {
    const rendered = renderCommand({
      profile: { ...profile, opencodeAgent: "plan", skipPermissions: true },
      session,
      prompt: "hello",
      promptPath: "/tmp/prompt.md"
    });
    expect(rendered.args.slice(0, 4)).toEqual(["run", "--agent", "plan", "--dangerously-skip-permissions"]);
  });

  it("adds opencode native title before a native session id exists", () => {
    const rendered = renderCommand({
      profile,
      session,
      prompt: "hello",
      promptPath: "/tmp/prompt.md",
      runtimeSession: {
        id: "runtime_test",
        sessionId: session.id,
        participantId: "participant_test",
        adapterType: "opencode_cli",
        nativeSessionId: null,
        nativeTitle: "loopy-test",
        contextMode: "native_cli",
        status: "pending",
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        lastUsedAt: null
      }
    });
    expect(rendered.args.slice(0, 3)).toEqual(["run", "--title", "loopy-test"]);
  });

  it("adds opencode native session id when available", () => {
    const rendered = renderCommand({
      profile,
      session,
      prompt: "hello",
      promptPath: "/tmp/prompt.md",
      runtimeSession: {
        id: "runtime_test",
        sessionId: session.id,
        participantId: "participant_test",
        adapterType: "opencode_cli",
        nativeSessionId: "ses_123",
        nativeTitle: "loopy-test",
        contextMode: "native_cli",
        status: "active",
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        lastUsedAt: session.updatedAt
      }
    });
    expect(rendered.args.slice(0, 3)).toEqual(["run", "--session", "ses_123"]);
  });

  it("adds claude native session id for a new runtime session", () => {
    const rendered = renderCommand({
      profile: { ...profile, adapterType: "claude_cli", command: "claude", args: ["-p", "{prompt}", "--output-format", "text"], model: "sonnet" },
      session,
      prompt: "hello",
      promptPath: "/tmp/prompt.md",
      runtimeSession: {
        id: "runtime_claude",
        sessionId: session.id,
        participantId: "participant_test",
        adapterType: "claude_cli",
        nativeSessionId: "123e4567-e89b-12d3-a456-426614174000",
        nativeTitle: "loopy-test",
        contextMode: "native_cli",
        status: "pending",
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        lastUsedAt: null
      }
    });
    expect(rendered.args).toContain("--session-id");
    expect(rendered.args).toContain("123e4567-e89b-12d3-a456-426614174000");
  });

  it("resumes an active claude native session", () => {
    const rendered = renderCommand({
      profile: { ...profile, adapterType: "claude_cli", command: "claude", args: ["-p", "{prompt}", "--output-format", "text"], model: "sonnet" },
      session,
      prompt: "hello again",
      promptPath: "/tmp/prompt.md",
      runtimeSession: {
        id: "runtime_claude",
        sessionId: session.id,
        participantId: "participant_test",
        adapterType: "claude_cli",
        nativeSessionId: "123e4567-e89b-12d3-a456-426614174000",
        nativeTitle: "loopy-test",
        contextMode: "native_cli",
        status: "active",
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        lastUsedAt: session.updatedAt
      }
    });
    expect(rendered.args).toContain("--resume");
    expect(rendered.args).toContain("123e4567-e89b-12d3-a456-426614174000");
    expect(rendered.args).not.toContain("--session-id");
  });

  it("renders remote prompt file tokens with the uploaded remote path", () => {
    const rendered = renderCommand(
      {
        profile: {
          ...profile,
          adapterType: "claude_cli",
          command: "claude",
          args: ["-p", "{prompt_file}", "--output-format", "text"],
          model: "claude-sonnet-4-5",
          remote: { host: "user@example.test", sshKey: "~/.ssh/example", remoteCwd: "/srv/loopy" }
        },
        session,
        prompt: "hello",
        promptPath: "/tmp/local-prompt.md",
        runtimeSession: {
          id: "runtime_remote",
          sessionId: session.id,
          participantId: "participant_test",
          adapterType: "claude_cli",
          nativeSessionId: "123e4567-e89b-12d3-a456-426614174001",
          nativeTitle: "loopy-remote",
          contextMode: "native_cli",
          status: "active",
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
          lastUsedAt: session.updatedAt
        }
      },
      { remotePromptFile: "/tmp/loopy-prompts/remote-prompt.md" }
    );
    expect(rendered.args).toContain("/tmp/loopy-prompts/remote-prompt.md");
    expect(rendered.args).toContain("--resume");
    expect(rendered.args).not.toContain("/tmp/local-prompt.md");
    expect(rendered.cwd).toBe("/srv/loopy");
  });
});
