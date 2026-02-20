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

import { loadJsonConfig, parsePort } from "@shetty4l/core/config";
import { createLogger } from "@shetty4l/core/log";
import type { Result } from "@shetty4l/core/result";
import { err, ok } from "@shetty4l/core/result";

const log = createLogger("synapse");

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

const DEFAULTS = {
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

// --- Validation ---

function validateProvider(
  p: unknown,
  index: number,
): Result<ProviderConfig, string> {
  if (typeof p !== "object" || p === null) {
    return err(`providers[${index}]: must be an object`);
  }
  const obj = p as Record<string, unknown>;

  if (typeof obj.name !== "string" || obj.name.length === 0) {
    return err(`providers[${index}].name: must be a non-empty string`);
  }
  if (typeof obj.baseUrl !== "string" || obj.baseUrl.length === 0) {
    return err(`providers[${index}].baseUrl: must be a non-empty string`);
  }
  if (!Array.isArray(obj.models) || obj.models.length === 0) {
    return err(
      `providers[${index}].models: must be a non-empty array of strings`,
    );
  }
  for (const m of obj.models) {
    if (typeof m !== "string") {
      return err(`providers[${index}].models: all entries must be strings`);
    }
  }

  return ok({
    name: obj.name,
    baseUrl: obj.baseUrl,
    apiKey: typeof obj.apiKey === "string" ? obj.apiKey : undefined,
    models: obj.models as string[],
    maxFailures: typeof obj.maxFailures === "number" ? obj.maxFailures : 3,
    cooldownSeconds:
      typeof obj.cooldownSeconds === "number" ? obj.cooldownSeconds : 60,
  });
}

function validateConfig(raw: unknown): Result<SynapseConfig, string> {
  if (typeof raw !== "object" || raw === null) {
    return err("Config must be a JSON object");
  }
  const obj = raw as Record<string, unknown>;

  let port = DEFAULT_PORT;
  if (obj.port !== undefined) {
    if (
      typeof obj.port !== "number" ||
      !Number.isInteger(obj.port) ||
      obj.port < 1 ||
      obj.port > 65535
    ) {
      return err(
        `port: ${obj.port} is not a valid port number (must be an integer 1-65535)`,
      );
    }
    port = obj.port;
  }

  if (!Array.isArray(obj.providers) || obj.providers.length === 0) {
    return err("Config must have a non-empty 'providers' array");
  }

  const providers: ProviderConfig[] = [];
  for (let i = 0; i < obj.providers.length; i++) {
    const result = validateProvider(obj.providers[i], i);
    if (!result.ok) return result as Result<never>;
    providers.push(result.value);
  }

  // Enforce unique provider names
  const names = new Set<string>();
  for (const p of providers) {
    if (names.has(p.name)) {
      return err(
        `Duplicate provider name "${p.name}". Each provider must have a unique name.`,
      );
    }
    names.add(p.name);
  }

  return ok({ port, providers });
}

// --- Load ---

export function loadConfig(options?: {
  configPath?: string;
  quiet?: boolean;
}): Result<SynapseConfig, string> {
  const configPath =
    options?.configPath ?? process.env.SYNAPSE_CONFIG_PATH ?? undefined;
  const quiet = options?.quiet ?? false;

  // Load file config via core (handles file reading, JSON parsing, env interpolation)
  const loaded = loadJsonConfig({
    name: "synapse",
    defaults: DEFAULTS as Record<string, unknown>,
    configPath,
  });

  if (!loaded.ok) return loaded;

  // When no config file exists, loadJsonConfig returns defaults merged.
  // But our defaults include a providers array, so validateConfig will work.
  const validated = validateConfig(loaded.value.config);
  if (!validated.ok) return validated;

  if (!quiet) {
    if (loaded.value.source === "file") {
      log(
        `loaded config from ${loaded.value.path} (${validated.value.providers.length} provider(s))`,
      );
    } else {
      log(
        `no config at ${loaded.value.path}, using defaults (ollama @ localhost:11434)`,
      );
    }
  }

  const config = validated.value;

  // Env var overrides
  if (process.env.SYNAPSE_PORT) {
    const portResult = parsePort(process.env.SYNAPSE_PORT, "SYNAPSE_PORT");
    if (!portResult.ok) return portResult as Result<never>;
    config.port = portResult.value;
  }

  return ok(config);
}
