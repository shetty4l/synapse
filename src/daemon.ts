/**
 * Daemon management for Synapse.
 *
 * Handles starting/stopping the server as a background process.
 * PID and log files stored in ~/.config/synapse/
 */

import type { Result } from "@shetty4l/core/result";
import { err, ok } from "@shetty4l/core/result";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { loadConfig } from "./config";

const DATA_DIR = join(homedir(), ".config", "synapse");
const PID_FILE = join(DATA_DIR, "synapse.pid");
const LOG_FILE = join(DATA_DIR, "synapse.log");

export interface DaemonStatus {
  running: boolean;
  pid?: number;
  port?: number;
  uptime?: number;
}

/**
 * Check if a process with the given PID is running.
 */
function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read PID from file, returns undefined if not found or invalid.
 */
function readPid(): number | undefined {
  if (!existsSync(PID_FILE)) {
    return undefined;
  }
  try {
    const content = readFileSync(PID_FILE, "utf-8").trim();
    const pid = Number.parseInt(content, 10);
    return Number.isNaN(pid) ? undefined : pid;
  } catch {
    return undefined;
  }
}

function writePid(pid: number): void {
  writeFileSync(PID_FILE, pid.toString(), "utf-8");
}

function removePidFile(): void {
  if (existsSync(PID_FILE)) {
    unlinkSync(PID_FILE);
  }
}

/**
 * Get daemon status.
 */
export async function getDaemonStatus(): Promise<DaemonStatus> {
  const pid = readPid();

  if (!pid) {
    return { running: false };
  }

  if (!isProcessRunning(pid)) {
    removePidFile();
    return { running: false };
  }

  // Try to get health info from the running server
  const configResult = loadConfig({ quiet: true });
  const port = configResult.ok ? configResult.value.port : 7750;

  try {
    const response = await fetch(`http://localhost:${port}/health`);
    if (response.ok) {
      const data = (await response.json()) as { uptime?: number };
      return { running: true, pid, port, uptime: data.uptime };
    }
  } catch {
    // Server might be starting up
  }

  return { running: true, pid, port };
}

/**
 * Start the daemon.
 * Returns ok with pid and port on success, err with reason on failure.
 */
export async function startDaemon(): Promise<
  Result<{ pid: number; port: number }, string>
> {
  const status = await getDaemonStatus();

  if (status.running) {
    return err(`already running (pid ${status.pid})`);
  }

  const configResult = loadConfig({ quiet: true });
  const port = configResult.ok ? configResult.value.port : 7750;

  const cliPath = join(import.meta.dir, "cli.ts");

  const proc = Bun.spawn(["bun", "run", cliPath, "serve"], {
    stdout: Bun.file(LOG_FILE),
    stderr: Bun.file(LOG_FILE),
    stdin: "ignore",
  });

  writePid(proc.pid);

  // Wait for the server to start
  await new Promise((resolve) => setTimeout(resolve, 500));

  const newStatus = await getDaemonStatus();
  if (newStatus.running) {
    return ok({ pid: proc.pid, port });
  }

  removePidFile();
  return err(`failed to start — check logs at ${LOG_FILE}`);
}

/**
 * Stop the daemon.
 * Returns ok on success, err with reason on failure.
 */
export async function stopDaemon(): Promise<Result<void, string>> {
  const status = await getDaemonStatus();

  if (!status.running || !status.pid) {
    return err("not running");
  }

  try {
    process.kill(status.pid, "SIGTERM");

    const maxWait = 5000;
    const interval = 100;
    let waited = 0;

    while (waited < maxWait) {
      await new Promise((resolve) => setTimeout(resolve, interval));
      waited += interval;

      if (!isProcessRunning(status.pid)) {
        break;
      }
    }

    if (isProcessRunning(status.pid)) {
      process.kill(status.pid, "SIGKILL");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    removePidFile();
    return ok(undefined);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    removePidFile();
    return err(`failed to stop (pid ${status.pid}): ${message}`);
  }
}

/**
 * Restart the daemon.
 */
export async function restartDaemon(): Promise<
  Result<{ pid: number; port: number }, string>
> {
  const stopResult = await stopDaemon();
  // Ignore "not running" error on stop — that's fine for restart
  if (!stopResult.ok && stopResult.error !== "not running") {
    return stopResult as Result<never>;
  }
  return startDaemon();
}
