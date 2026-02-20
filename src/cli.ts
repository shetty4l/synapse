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

import {
  createDaemonCommands,
  createHealthCommand,
  createLogsCommand,
  runCli,
} from "@shetty4l/core/cli";
import { getConfigDir } from "@shetty4l/core/config";
import { createDaemonManager } from "@shetty4l/core/daemon";
import { onShutdown } from "@shetty4l/core/signals";
import { join } from "path";
import { loadConfig } from "./config";
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

const CONFIG_DIR = getConfigDir("synapse");
const LOG_PATH = join(CONFIG_DIR, "synapse.log");

// --- Daemon ---

function getDaemon() {
  const configResult = loadConfig({ quiet: true });
  const port = configResult.ok ? configResult.value.port : 7750;

  return createDaemonManager({
    name: "synapse",
    configDir: CONFIG_DIR,
    cliPath: join(import.meta.dir, "cli.ts"),
    healthUrl: `http://localhost:${port}/health`,
  });
}

// --- Commands ---

export function run(): void {
  const configResult = loadConfig();
  if (!configResult.ok) {
    console.error(`synapse: config error: ${configResult.error}`);
    process.exit(1);
  }
  const server = createServer(configResult.value);

  onShutdown(
    async () => {
      await server.logger.shutdown();
      server.stop();
    },
    { name: "synapse", timeoutMs: 15_000 },
  );
}

const daemonCmds = createDaemonCommands({ name: "synapse", getDaemon });

const cmdHealth = createHealthCommand({
  name: "synapse",
  getHealthUrl: () => {
    const configResult = loadConfig({ quiet: true });
    const port = configResult.ok ? configResult.value.port : 7750;
    return `http://localhost:${port}/health`;
  },
  formatExtra: (data) => {
    const providers = data.providers as
      | {
          name: string;
          healthy: boolean;
          reachable: boolean;
          consecutiveFailures: number;
        }[]
      | undefined;
    if (!providers || providers.length === 0) return;

    const nameWidth = Math.max(8, ...providers.map((p) => p.name.length));
    console.log(
      `${"Provider".padEnd(nameWidth)}  ${"Healthy".padEnd(9)}  ${"Reachable".padEnd(11)}  Failures`,
    );
    console.log("-".repeat(nameWidth + 9 + 11 + 10 + 6));

    for (const p of providers) {
      const healthy = p.healthy ? "yes" : "NO";
      const reachable = p.reachable ? "yes" : "NO";
      console.log(
        `${p.name.padEnd(nameWidth)}  ${healthy.padEnd(9)}  ${reachable.padEnd(11)}  ${p.consecutiveFailures}`,
      );
    }
  },
});

function cmdConfig(_args: string[], json: boolean): void {
  const configResult = loadConfig();
  if (!configResult.ok) {
    console.error(`synapse: config error: ${configResult.error}`);
    process.exit(1);
  }
  const config = configResult.value;

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
  emptyMessage: "No daemon logs found.",
  defaultCount: 10,
});

// --- Main ---

runCli({
  name: "synapse",
  version: VERSION,
  help: HELP,
  commands: {
    ...daemonCmds,
    serve: () => run(),
    health: cmdHealth,
    config: cmdConfig,
    logs: cmdLogs,
  },
});
