/**
 * Configuration for Synapse.
 *
 * Load order:
 *   1. Defaults (hardcoded)
 *   2. Config file (~/.config/synapse/config.json)
 *   3. Environment variables (SYNAPSE_PORT, SYNAPSE_CONFIG_PATH)
 *
 * String values in the config file support ${ENV_VAR} interpolation.
 */

import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

// --- Types ---

export interface ProviderConfig {
  /** Display name for logging */
  name: string;
  /** Base URL including version prefix, e.g. "http://localhost:11434/v1" */
  baseUrl: string;
  /** Optional API key or Bearer token */
  apiKey?: string;
  /** Models this provider serves. Use ["*"] for wildcard (matches any model). */
  models: string[];
  /** Max consecutive failures before marking unhealthy (default: 3) */
  maxFailures?: number;
  /** Seconds to wait before retrying an unhealthy provider (default: 60) */
  cooldownSeconds?: number;
}

export interface SynapseConfig {
  port: number;
  providers: ProviderConfig[];
}

// --- Defaults ---

const DEFAULT_PORT = 7750;

const DEFAULT_CONFIG: SynapseConfig = {
  port: DEFAULT_PORT,
  providers: [
    {
      name: "ollama",
      baseUrl: "http://localhost:11434/v1",
      models: ["*"],
      maxFailures: 3,
      cooldownSeconds: 60,
    },
  ],
};

const DEFAULT_CONFIG_PATH = join(
  homedir(),
  ".config",
  "synapse",
  "config.json",
);

// --- Port validation ---

function parsePort(value: string, source: string): number {
  const port = Number.parseInt(value, 10);
  if (Number.isNaN(port) || port < 1 || port > 65535) {
    throw new Error(
      `${source}: "${value}" is not a valid port number (must be 1-65535)`,
    );
  }
  return port;
}

// --- Env var interpolation ---

/**
 * Replace ${ENV_VAR} patterns in a string with the corresponding env value.
 * Throws if the env var is not set.
 */
export function interpolateEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_match, varName: string) => {
    const envValue = process.env[varName];
    if (envValue === undefined) {
      throw new Error(
        `Config references \${${varName}} but it is not set in the environment`,
      );
    }
    return envValue;
  });
}

/**
 * Recursively walk a JSON-parsed value and interpolate env vars in all strings.
 * Only accepts JSON-compatible types (no class instances).
 */
type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

function interpolateDeep(value: JsonValue): JsonValue {
  if (typeof value === "string") {
    return interpolateEnvVars(value);
  }
  if (Array.isArray(value)) {
    return value.map(interpolateDeep);
  }
  if (value !== null && typeof value === "object") {
    const result: Record<string, JsonValue> = {};
    for (const [k, v] of Object.entries(value)) {
      result[k] = interpolateDeep(v);
    }
    return result;
  }
  return value;
}

// --- Validation ---

function validateProvider(p: unknown, index: number): ProviderConfig {
  if (typeof p !== "object" || p === null) {
    throw new Error(`providers[${index}]: must be an object`);
  }
  const obj = p as Record<string, unknown>;

  if (typeof obj.name !== "string" || obj.name.length === 0) {
    throw new Error(`providers[${index}].name: must be a non-empty string`);
  }
  if (typeof obj.baseUrl !== "string" || obj.baseUrl.length === 0) {
    throw new Error(`providers[${index}].baseUrl: must be a non-empty string`);
  }
  if (!Array.isArray(obj.models) || obj.models.length === 0) {
    throw new Error(
      `providers[${index}].models: must be a non-empty array of strings`,
    );
  }
  for (const m of obj.models) {
    if (typeof m !== "string") {
      throw new Error(
        `providers[${index}].models: all entries must be strings`,
      );
    }
  }

  return {
    name: obj.name,
    baseUrl: obj.baseUrl,
    apiKey: typeof obj.apiKey === "string" ? obj.apiKey : undefined,
    models: obj.models as string[],
    maxFailures: typeof obj.maxFailures === "number" ? obj.maxFailures : 3,
    cooldownSeconds:
      typeof obj.cooldownSeconds === "number" ? obj.cooldownSeconds : 60,
  };
}

function validateConfig(raw: unknown): SynapseConfig {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("Config must be a JSON object");
  }
  const obj = raw as Record<string, unknown>;

  const port =
    typeof obj.port === "number"
      ? (() => {
          if (!Number.isInteger(obj.port) || obj.port < 1 || obj.port > 65535) {
            throw new Error(
              `port: ${obj.port} is not a valid port number (must be an integer 1-65535)`,
            );
          }
          return obj.port;
        })()
      : DEFAULT_PORT;

  if (!Array.isArray(obj.providers) || obj.providers.length === 0) {
    throw new Error("Config must have a non-empty 'providers' array");
  }

  const providers = obj.providers.map((p, i) => validateProvider(p, i));

  // Enforce unique provider names
  const names = new Set<string>();
  for (const p of providers) {
    if (names.has(p.name)) {
      throw new Error(
        `Duplicate provider name "${p.name}". Each provider must have a unique name.`,
      );
    }
    names.add(p.name);
  }

  return { port, providers };
}

// --- Load ---

export function loadConfig(options?: {
  configPath?: string;
  quiet?: boolean;
}): SynapseConfig {
  const envPort = process.env.SYNAPSE_PORT;
  const filePath =
    options?.configPath ??
    process.env.SYNAPSE_CONFIG_PATH ??
    DEFAULT_CONFIG_PATH;
  const quiet = options?.quiet ?? false;

  if (!existsSync(filePath)) {
    if (!quiet) {
      console.error(
        `synapse: no config at ${filePath}, using defaults (ollama @ localhost:11434)`,
      );
    }
    const config = { ...DEFAULT_CONFIG };
    if (envPort) {
      config.port = parsePort(envPort, "SYNAPSE_PORT");
    }
    return config;
  }

  const rawText = readFileSync(filePath, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    throw new Error(`Failed to parse config file ${filePath}: invalid JSON`);
  }

  const interpolated = interpolateDeep(parsed as JsonValue);
  const config = validateConfig(interpolated);

  // Env var overrides
  if (envPort) {
    config.port = parsePort(envPort, "SYNAPSE_PORT");
  }

  if (!quiet) {
    console.error(
      `synapse: loaded config from ${filePath} (${config.providers.length} provider(s))`,
    );
  }
  return config;
}
