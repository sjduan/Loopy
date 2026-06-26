import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { LoopyLocalConfig, RemoteTargetDefaults, RuntimeConfig } from "@loopy/shared";

const here = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(here, "../../..");

export type ServerConfig = {
  host: string;
  port: number;
  dataDir: string;
  dbPath: string;
  localConfigPath?: string;
  localConfigPresent?: boolean;
  localConfig?: LoopyLocalConfig;
  runtimeConfig?: RuntimeConfig;
};

export function getConfig(): ServerConfig {
  const dataDir = process.env.LOOPY_DATA_DIR ?? path.join(repoRoot, "data");
  const localConfigPath = process.env.LOOPY_LOCAL_CONFIG ?? path.join(repoRoot, "config", "loopy.local.json");
  const loaded = loadLocalConfig(localConfigPath);
  return {
    host: process.env.LOOPY_HOST ?? "127.0.0.1",
    port: Number(process.env.LOOPY_PORT ?? 8787),
    dataDir,
    dbPath: process.env.LOOPY_DB_PATH ?? path.join(dataDir, "loopy.db"),
    localConfigPath,
    localConfigPresent: loaded.present,
    localConfig: loaded.config,
    runtimeConfig: toRuntimeConfig(loaded.present, loaded.config)
  };
}

export function loadLocalConfig(configPath: string): { present: boolean; config: LoopyLocalConfig } {
  if (!fs.existsSync(configPath)) return { present: false, config: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (error) {
    throw new Error(`Could not parse Loopy local config at ${configPath}: ${String(error)}`);
  }
  return { present: true, config: validateLocalConfig(parsed, configPath) };
}

function validateLocalConfig(value: unknown, configPath: string): LoopyLocalConfig {
  if (!isPlainObject(value)) {
    throw new Error(`Loopy local config at ${configPath} must be a JSON object.`);
  }
  const defaults = value.defaults;
  if (defaults === undefined) return {};
  if (!isPlainObject(defaults)) {
    throw new Error(`Loopy local config defaults at ${configPath} must be an object.`);
  }
  const workspace = defaults.workspace;
  const remoteTarget = defaults.remoteTarget;
  return {
    defaults: {
      workspace: typeof workspace === "string" ? workspace : undefined,
      remoteTarget: normalizeRemoteTarget(remoteTarget, configPath)
    }
  };
}

function normalizeRemoteTarget(value: unknown, configPath: string): RemoteTargetDefaults | null {
  if (value === undefined || value === null) return null;
  if (!isPlainObject(value)) {
    throw new Error(`Loopy local config remoteTarget at ${configPath} must be an object or null.`);
  }
  const label = typeof value.label === "string" && value.label.trim() ? value.label : "Remote machine";
  const host = typeof value.host === "string" ? value.host : "";
  const sshKey = typeof value.sshKey === "string" ? value.sshKey : undefined;
  const remoteCwd = typeof value.remoteCwd === "string" ? value.remoteCwd : "";
  return { label, host, sshKey, remoteCwd };
}

function toRuntimeConfig(configPresent: boolean, config: LoopyLocalConfig): RuntimeConfig {
  const remoteTarget = config.defaults?.remoteTarget;
  return {
    configPresent,
    defaults: {
      workspace: config.defaults?.workspace ?? "",
      remoteTarget: remoteTarget?.host && remoteTarget.remoteCwd ? remoteTarget : null
    }
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
