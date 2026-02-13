#!/usr/bin/env bun

/**
 * Synapse CLI
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
  synapse version        Show version

Options:
  --json                 Machine-readable JSON output
  --version, -v          Show version
  --help, -h             Show help
`;

const LOG_PATH = join(homedir(), ".config", "synapse", "logs", "requests.log");

// --- Arg parsing ---

function parseArgs(args: string[]): {
  command: string;
  args: string[];
  json: boolean;
} {
  const filtered = args.filter((a) => a !== "--json");
  const json = args.includes("--json");
  const [command = "help", ...rest] = filtered;
  return { command, args: rest, json };
}

// --- Commands ---

function cmdServe(): void {
  const config = loadConfig();
  const server = createServer(config);
  const instance = server.start();

  const shutdown = () => {
    console.log("\nsynapse: shutting down...");
    instance.stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function cmdStart(): Promise<void> {
  const started = await startDaemon();
  process.exit(started ? 0 : 1);
}

async function cmdStop(): Promise<void> {
  const stopped = await stopDaemon();
  process.exit(stopped ? 0 : 1);
}

async function cmdStatus(json: boolean): Promise<void> {
  const status = await getDaemonStatus();

  if (json) {
    console.log(JSON.stringify(status, null, 2));
    process.exit(status.running ? 0 : 1);
  }

  if (!status.running) {
    console.log("synapse is not running");
    process.exit(1);
  }

  console.log(`synapse is running (PID: ${status.pid}, port: ${status.port})`);
  process.exit(0);
}

async function cmdRestart(): Promise<void> {
  const restarted = await restartDaemon();
  process.exit(restarted ? 0 : 1);
}

async function cmdHealth(json: boolean): Promise<void> {
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
    process.exit(1);
  }

  const data = await response.json();

  if (json) {
    console.log(JSON.stringify(data, null, 2));
    process.exit(data.status === "healthy" ? 0 : 1);
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
  process.exit(data.status === "healthy" ? 0 : 1);
}

function cmdConfig(json: boolean): void {
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

function cmdLogs(countStr: string | undefined, json: boolean): void {
  const count = countStr ? Number.parseInt(countStr, 10) : 10;

  if (Number.isNaN(count) || count < 1) {
    console.error("Error: count must be a positive number");
    process.exit(1);
  }

  if (!existsSync(LOG_PATH)) {
    if (json) {
      console.log(JSON.stringify({ entries: [], count: 0 }));
    } else {
      console.log("No request logs found.");
    }
    return;
  }

  const content = readFileSync(LOG_PATH, "utf-8").trimEnd();
  if (content.length === 0) {
    if (json) {
      console.log(JSON.stringify({ entries: [], count: 0 }));
    } else {
      console.log("No request logs found.");
    }
    return;
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
    return;
  }

  if (entries.length === 0) {
    console.log("No request logs found.");
    return;
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
}

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str.padEnd(maxLen);
  return `${str.slice(0, maxLen - 1)}…`;
}

// --- Main ---

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);

  if (
    rawArgs.includes("--help") ||
    rawArgs.includes("-h") ||
    rawArgs.length === 0
  ) {
    console.log(HELP);
    process.exit(0);
  }

  if (rawArgs.includes("--version") || rawArgs.includes("-v")) {
    console.log(VERSION);
    process.exit(0);
  }

  const { command, args, json } = parseArgs(rawArgs);

  switch (command) {
    case "start":
      await cmdStart();
      return;
    case "stop":
      await cmdStop();
      return;
    case "status":
      await cmdStatus(json);
      return;
    case "restart":
      await cmdRestart();
      return;
    case "serve":
      cmdServe();
      return;
    case "health":
      await cmdHealth(json);
      return;
    case "config":
      cmdConfig(json);
      return;
    case "logs":
      cmdLogs(args[0], json);
      return;
    case "version":
      console.log(VERSION);
      return;
    case "help":
      console.log(HELP);
      return;
    default:
      console.error(`Unknown command: ${command}`);
      console.log(HELP);
      process.exit(1);
  }
}

main();
