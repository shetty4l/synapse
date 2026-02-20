/**
 * Daemon management for Synapse.
 *
 * Thin wrapper around createDaemonManager from @shetty4l/core/daemon.
 * Preserves the existing function signatures so cli.ts call sites are unchanged.
 */

import { createDaemonManager, type DaemonStatus } from "@shetty4l/core/daemon";
import type { Result } from "@shetty4l/core/result";
import { err, ok } from "@shetty4l/core/result";
import { homedir } from "os";
import { join } from "path";
import { loadConfig } from "./config";

export type { DaemonStatus };

const CONFIG_DIR = join(homedir(), ".config", "synapse");

function getHealthUrl(): string {
  const configResult = loadConfig({ quiet: true });
  const port = configResult.ok ? configResult.value.port : 7750;
  return `http://localhost:${port}/health`;
}

const manager = createDaemonManager({
  name: "synapse",
  configDir: CONFIG_DIR,
  cliPath: join(import.meta.dir, "cli.ts"),
  healthUrl: getHealthUrl(),
});

/**
 * Get daemon status.
 */
export async function getDaemonStatus(): Promise<DaemonStatus> {
  return manager.status();
}

/**
 * Start the daemon.
 * Returns ok with pid and port on success, err with reason on failure.
 */
export async function startDaemon(): Promise<
  Result<{ pid: number; port: number }, string>
> {
  const result = await manager.start();
  if (!result.ok) return result as Result<never>;
  const s = result.value;
  return ok({ pid: s.pid ?? 0, port: s.port ?? 7750 });
}

/**
 * Stop the daemon.
 * Returns ok on success, err with reason on failure.
 */
export async function stopDaemon(): Promise<Result<void, string>> {
  const result = await manager.stop();
  if (!result.ok) {
    // Normalize error message: core uses "synapse: not running", cli expects "not running"
    const msg = result.error.replace(/^synapse: /, "");
    return err(msg);
  }
  return ok(undefined);
}

/**
 * Restart the daemon.
 */
export async function restartDaemon(): Promise<
  Result<{ pid: number; port: number }, string>
> {
  const result = await manager.restart();
  if (!result.ok) return result as Result<never>;
  const s = result.value;
  return ok({ pid: s.pid ?? 0, port: s.port ?? 7750 });
}
