/**
 * Synapse — OpenAI-compatible LLM proxy with provider fallback chain.
 *
 * Entry point. Loads config and starts the HTTP server.
 */

import { loadConfig } from "./config";
import { createServer } from "./server";
import { VERSION } from "./version";

console.error(`synapse v${VERSION}`);

const configResult = loadConfig();
if (!configResult.ok) {
  console.error(`synapse: config error: ${configResult.error}`);
  process.exit(1);
}
const server = createServer(configResult.value);
server.start();
