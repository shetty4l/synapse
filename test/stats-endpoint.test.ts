import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { StatsResponse } from "../src/metrics";
import type { SynapseServer } from "../src/server";
import { createServer } from "../src/server";

type BunServer = ReturnType<typeof Bun.serve>;

/**
 * GET /stats endpoint integration tests.
 * Spins up a mock upstream + Synapse server, sends requests,
 * then verifies the stats endpoint reflects them.
 */

const MOCK_PORT = 19887;
const SYNAPSE_PORT = 19888;

function startMockUpstream(): BunServer {
  return Bun.serve({
    port: MOCK_PORT,
    fetch: async (req) => {
      const url = new URL(req.url);

      if (url.pathname === "/v1/models") {
        return Response.json({
          object: "list",
          data: [{ id: "test-model", object: "model", owned_by: "mock" }],
        });
      }

      if (url.pathname === "/v1/chat/completions") {
        return Response.json({
          id: "chat-1",
          object: "chat.completion",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "Hello!" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
        });
      }

      return new Response("Not Found", { status: 404 });
    },
  });
}

describe("GET /stats", () => {
  let mockUpstream: BunServer;
  let synapseServer: SynapseServer;

  const base = `http://localhost:${SYNAPSE_PORT}`;

  beforeAll(() => {
    mockUpstream = startMockUpstream();
    synapseServer = createServer({
      port: SYNAPSE_PORT,
      providers: [
        {
          name: "mock-provider",
          baseUrl: `http://localhost:${MOCK_PORT}/v1`,
          models: ["*"],
          maxFailures: 3,
          cooldownSeconds: 60,
        },
      ],
    });
  });

  afterAll(() => {
    synapseServer.stop();
    mockUpstream.stop(true);
  });

  test("returns 200 with correct shape when buffer is empty", async () => {
    const res = await fetch(`${base}/stats`);
    expect(res.status).toBe(200);

    const data = (await res.json()) as StatsResponse;

    // Buffer metadata
    expect(data.buffer.capacity).toBe(10_000);
    expect(data.buffer.size).toBe(0);
    expect(data.buffer.oldest_entry_at).toBeNull();

    // Request aggregates
    expect(data.requests.total_24h).toBe(0);
    expect(data.requests.errors_24h).toBe(0);
    expect(data.requests.by_provider).toEqual({});

    // Latency nulls when no data
    expect(data.latency.p50_ms).toBeNull();
    expect(data.latency.p95_ms).toBeNull();
    expect(data.latency.p99_ms).toBeNull();

    // Fallbacks
    expect(data.fallbacks.count_24h).toBe(0);

    // Provider health
    expect(data.providers).toHaveLength(1);
    expect(data.providers[0].name).toBe("mock-provider");
    expect(data.providers[0].healthy).toBe(true);
    expect(data.providers[0].consecutiveFailures).toBe(0);
  });

  test("stats reflect recorded requests", async () => {
    // Send a successful request first
    const chatRes = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "test-model",
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(chatRes.status).toBe(200);

    // Now check stats
    const res = await fetch(`${base}/stats`);
    expect(res.status).toBe(200);

    const data = (await res.json()) as StatsResponse;

    // Should have at least 1 entry (may have more if other tests ran first)
    expect(data.buffer.size).toBeGreaterThanOrEqual(1);
    expect(data.buffer.oldest_entry_at).toBeTypeOf("number");
    expect(data.requests.total_24h).toBeGreaterThanOrEqual(1);
    expect(data.requests.errors_24h).toBe(0);

    // Should have the mock-provider in by_provider
    expect(data.requests.by_provider["mock-provider"]).toBeDefined();
    expect(
      data.requests.by_provider["mock-provider"].total,
    ).toBeGreaterThanOrEqual(1);

    // Latency should be populated from successful requests
    expect(data.latency.p50_ms).toBeTypeOf("number");
    expect(data.latency.p95_ms).toBeTypeOf("number");
    expect(data.latency.p99_ms).toBeTypeOf("number");

    // No failovers (single provider, always succeeds)
    expect(data.fallbacks.count_24h).toBe(0);
  });

  test("returns CORS headers", async () => {
    const res = await fetch(`${base}/stats`);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });
});
