/**
 * Synapse — OpenAI-compatible LLM proxy with provider fallback chain.
 *
 * Entry point. Loads config and starts the HTTP server.
 */

import { run } from "./cli";

if (import.meta.main) {
  run();
}
