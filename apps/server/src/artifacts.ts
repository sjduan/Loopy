import fs from "node:fs";
import path from "node:path";

export type ArtifactPaths = {
  dir: string;
  promptPath: string;
  stdoutPath: string;
  stderrPath: string;
  resultPath: string;
};

export function invocationArtifacts(dataDir: string, sessionId: string, invocationId: string): ArtifactPaths {
  const dir = path.join(dataDir, "sessions", sessionId, "invocations", invocationId);
  return {
    dir,
    promptPath: path.join(dir, "prompt.md"),
    stdoutPath: path.join(dir, "stdout.log"),
    stderrPath: path.join(dir, "stderr.log"),
    resultPath: path.join(dir, "result.md")
  };
}

export function ensureArtifactDir(paths: ArtifactPaths) {
  fs.mkdirSync(paths.dir, { recursive: true });
}

export function writeText(filePath: string, content: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

export function readText(filePath: string) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}
