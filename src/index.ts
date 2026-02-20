/**
 * Synapse — OpenAI-compatible LLM proxy with provider fallback chain.
 *
 * Entry point. Loads config and starts the HTTP server.
 */

import { createLogger } from "@shetty4l/core/log";
import { loadConfig } from "./config";
import { createServer } from "./server";
import { VERSION } from "./version";

const log = createLogger("synapse");

log(`v${VERSION}`);

const configResult = loadConfig();
if (!configResult.ok) {
  log(`config error: ${configResult.error}`);
  process.exit(1);
}
const server = createServer(configResult.value);
server.start();
