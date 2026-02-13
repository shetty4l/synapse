/**
 * Synapse — OpenAI-compatible LLM proxy with provider fallback chain.
 *
 * Entry point. Loads config and starts the HTTP server.
 */

import { loadConfig } from "./config";
import { createServer } from "./server";
import { VERSION } from "./version";

console.log(`synapse v${VERSION}`);

const config = loadConfig();
const server = createServer(config);
server.start();
