#!/usr/bin/env bun

/**
 * Synapse CLI — OpenAI-compatible LLM proxy
 *
 * Usage:
 *   synapse start          Start the server (background daemon)
 *   synapse stop           Stop the daemon
 *   synapse status         Show daemon status
 *   synapse restart        Restart the daemon
 *   synapse serve          Start the server (foreground)
 *   synapse health         Check health of running instance
 *   synapse config         Print resolved configuration
 *   synapse logs [n]       Show last n log lines (default: 10)
 *   synapse version        Show version
 *
 * Options:
 *   --json                 Machine-readable JSON output
 *   --help, -h             Show help
 */

import { createLogsCommand, formatUptime, runCli } from "@shetty4l/core/cli";
import { onShutdown } from "@shetty4l/core/signals";
import { homedir } from "os";
import { join } from "path";
import { loadConfig } from "./config";
import {
  getDaemonStatus,
  restartDaemon,
  startDaemon,
  stopDaemon,
} from "./daemon";
import { createServer } from "./server";
import { VERSION } from "./version";

const HELP = `
Synapse CLI — OpenAI-compatible LLM proxy

Usage:
  synapse start          Start the server (background daemon)
  synapse stop           Stop the daemon
  synapse status         Show daemon status
  synapse restart        Restart the daemon
  synapse serve          Start the server (foreground)
  synapse health         Check health of running instance
  synapse config         Print resolved configuration
  synapse logs [n]       Show last n log lines (default: 10)

Options:
  --json                 Machine-readable JSON output
  --version, -v          Show version
  --help, -h             Show help
`;

const LOG_PATH = join(homedir(), ".config", "synapse", "logs", "requests.log");

// --- Commands ---

function cmdServe(): void {
  const config = loadConfig();
  const server = createServer(config);
  const instance = server.start();

  onShutdown(() => instance.stop(), { name: "synapse" });
}

async function cmdStart(): Promise<number> {
  const started = await startDaemon();
  return started ? 0 : 1;
}

async function cmdStop(): Promise<number> {
  const stopped = await stopDaemon();
  return stopped ? 0 : 1;
}

async function cmdStatus(_args: string[], json: boolean): Promise<number> {
  const status = await getDaemonStatus();

  if (json) {
    console.log(JSON.stringify(status, null, 2));
    return status.running ? 0 : 1;
  }

  if (!status.running) {
    console.log("synapse is not running");
    return 1;
  }

  const uptimeStr = status.uptime ? formatUptime(status.uptime) : "unknown";
  console.log(
    `synapse is running (PID: ${status.pid}, port: ${status.port}, uptime: ${uptimeStr})`,
  );
  return 0;
}

async function cmdRestart(): Promise<number> {
  const restarted = await restartDaemon();
  return restarted ? 0 : 1;
}

async function cmdHealth(_args: string[], json: boolean): Promise<number> {
  let port: number;
  try {
    const config = loadConfig({ quiet: true });
    port = config.port;
  } catch {
    port = 7750;
  }

  let response: Response;
  try {
    response = await fetch(`http://localhost:${port}/health`);
  } catch {
    if (json) {
      console.log(JSON.stringify({ error: "Server not reachable", port }));
    } else {
      console.error(`synapse is not running on port ${port}`);
    }
    return 1;
  }

  const data = await response.json();

  if (json) {
    console.log(JSON.stringify(data, null, 2));
    return data.status === "healthy" ? 0 : 1;
  }

  console.log(
    `\nStatus:  ${data.status === "healthy" ? "healthy" : "degraded"}`,
  );
  console.log(`Version: ${data.version}\n`);

  if (data.providers && data.providers.length > 0) {
    const nameWidth = Math.max(
      8,
      ...data.providers.map((p: { name: string }) => p.name.length),
    );
    console.log(
      `${"Provider".padEnd(nameWidth)}  ${"Healthy".padEnd(9)}  ${"Reachable".padEnd(11)}  Failures`,
    );
    console.log("-".repeat(nameWidth + 9 + 11 + 10 + 6));

    for (const p of data.providers) {
      const healthy = p.healthy ? "yes" : "NO";
      const reachable = p.reachable ? "yes" : "NO";
      console.log(
        `${p.name.padEnd(nameWidth)}  ${healthy.padEnd(9)}  ${reachable.padEnd(11)}  ${p.consecutiveFailures}`,
      );
    }
  }

  console.log();
  return data.status === "healthy" ? 0 : 1;
}

function cmdConfig(_args: string[], json: boolean): void {
  const config = loadConfig();

  if (json) {
    console.log(JSON.stringify(config, null, 2));
    return;
  }

  console.log(`\nPort: ${config.port}\n`);
  console.log("Providers:");

  for (const p of config.providers) {
    console.log(`  ${p.name}`);
    console.log(`    URL:      ${p.baseUrl}`);
    console.log(`    API key:  ${p.apiKey ? "***" : "(none)"}`);
    console.log(`    Models:   ${p.models.join(", ")}`);
    console.log(
      `    Failures: max ${p.maxFailures ?? 3}, cooldown ${p.cooldownSeconds ?? 60}s`,
    );
  }

  console.log();
}

const cmdLogs = createLogsCommand({
  logFile: LOG_PATH,
  emptyMessage: "No request logs found.",
  defaultCount: 10,
});

// --- Main ---

runCli({
  name: "synapse",
  version: VERSION,
  help: HELP,
  commands: {
    start: () => cmdStart(),
    stop: () => cmdStop(),
    status: cmdStatus,
    restart: () => cmdRestart(),
    serve: () => cmdServe(),
    health: cmdHealth,
    config: cmdConfig,
    logs: cmdLogs,
  },
});
