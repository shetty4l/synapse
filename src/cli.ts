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
 *   synapse logs [n]       Show last n request log entries (default: 10)
 *   synapse version        Show version
 *
 * Options:
 *   --json                 Machine-readable JSON output
 *   --help, -h             Show help
 */

import { formatUptime, runCli } from "@shetty4l/core/cli";
import { onShutdown } from "@shetty4l/core/signals";
import { existsSync, readFileSync } from "fs";
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
  synapse logs [n]       Show last n request log entries (default: 10)

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

function cmdLogs(args: string[], json: boolean): number {
  const countStr = args[0];
  const count = countStr ? Number.parseInt(countStr, 10) : 10;

  if (Number.isNaN(count) || count < 1) {
    console.error("Error: count must be a positive number");
    return 1;
  }

  if (!existsSync(LOG_PATH)) {
    if (json) {
      console.log(JSON.stringify({ entries: [], count: 0 }));
    } else {
      console.log("No request logs found.");
    }
    return 0;
  }

  const content = readFileSync(LOG_PATH, "utf-8").trimEnd();
  if (content.length === 0) {
    if (json) {
      console.log(JSON.stringify({ entries: [], count: 0 }));
    } else {
      console.log("No request logs found.");
    }
    return 0;
  }

  const lines = content.split("\n");
  const tail = lines.slice(-count);
  const entries = tail
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  if (json) {
    console.log(JSON.stringify({ entries, count: entries.length }, null, 2));
    return 0;
  }

  if (entries.length === 0) {
    console.log("No request logs found.");
    return 0;
  }

  // Table header
  const cols = {
    time: 19,
    model: 20,
    provider: 14,
    status: 6,
    latency: 9,
    stream: 6,
  };

  console.log(
    `\n${"Timestamp".padEnd(cols.time)}  ${"Model".padEnd(cols.model)}  ${"Provider".padEnd(cols.provider)}  ${"Status".padEnd(cols.status)}  ${"Latency".padEnd(cols.latency)}  Stream`,
  );
  console.log(
    "-".repeat(
      cols.time +
        cols.model +
        cols.provider +
        cols.status +
        cols.latency +
        cols.stream +
        10,
    ),
  );

  for (const e of entries) {
    const ts = e.timestamp?.slice(0, 19).replace("T", " ") ?? "?";
    const model = truncate(e.model ?? "?", cols.model);
    const provider = (e.provider ?? "-").padEnd(cols.provider);
    const status = String(e.status ?? "?").padEnd(cols.status);
    const latency = `${e.latencyMs ?? "?"}ms`.padEnd(cols.latency);
    const stream = e.streaming ? "yes" : "no";

    console.log(
      `${ts.padEnd(cols.time)}  ${model}  ${provider}  ${status}  ${latency}  ${stream}`,
    );
  }

  console.log(`\nShowing ${entries.length} of ${lines.length} entries\n`);
  return 0;
}

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str.padEnd(maxLen);
  return `${str.slice(0, maxLen - 1)}…`;
}

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
