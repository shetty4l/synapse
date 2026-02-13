import { afterAll, beforeAll, describe, expect, test } from "bun:test";

type BunServer = ReturnType<typeof Bun.serve>;

import type { SynapseConfig } from "../src/config";
import { Router } from "../src/router";

/**
 * Mock upstream OpenAI-compatible server.
 * Responds to /v1/chat/completions and /v1/models.
 */
function startMockUpstream(
  port: number,
  opts?: { failCount?: number; statusCode?: number },
): BunServer {
  let requestCount = 0;
  const failCount = opts?.failCount ?? 0;
  const failStatus = opts?.statusCode ?? 500;

  return Bun.serve({
    port,
    fetch: async (req) => {
      const url = new URL(req.url);

      if (url.pathname === "/v1/models") {
        return Response.json({
          object: "list",
          data: [{ id: "test-model", object: "model", owned_by: "mock" }],
        });
      }

      if (url.pathname === "/v1/chat/completions") {
        requestCount++;
        if (requestCount <= failCount) {
          return new Response("Internal Server Error", { status: failStatus });
        }

        const body = (await req.json()) as { stream?: boolean };

        if (body.stream) {
          // Return SSE stream
          const stream = new ReadableStream({
            start(controller) {
              const encoder = new TextEncoder();
              controller.enqueue(
                encoder.encode(
                  'data: {"id":"mock-1","object":"chat.completion.chunk","choices":[{"delta":{"content":"hello"},"index":0}]}\n\n',
                ),
              );
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              controller.close();
            },
          });
          return new Response(stream, {
            headers: { "content-type": "text/event-stream" },
          });
        }

        return Response.json({
          id: "mock-1",
          object: "chat.completion",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "Hello from mock!" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        });
      }

      return new Response("Not Found", { status: 404 });
    },
  });
}

describe("Router", () => {
  let mockServer: BunServer;
  const MOCK_PORT = 19876;

  beforeAll(() => {
    mockServer = startMockUpstream(MOCK_PORT);
  });

  afterAll(() => {
    mockServer.stop(true);
  });

  function makeConfig(overrides?: Partial<SynapseConfig>): SynapseConfig {
    return {
      port: 7750,
      providers: [
        {
          name: "mock-primary",
          baseUrl: `http://localhost:${MOCK_PORT}/v1`,
          models: ["test-model", "gpt-4"],
          maxFailures: 3,
          cooldownSeconds: 60,
        },
      ],
      ...overrides,
    };
  }

  test("routes to matching provider", async () => {
    const router = new Router(makeConfig());
    const body = JSON.stringify({ model: "test-model", messages: [] });
    const result = await router.routeChatCompletions("test-model", body);

    expect(result.provider?.name).toBe("mock-primary");
    expect(result.result?.status).toBe(200);
    expect(result.attempted).toEqual(["mock-primary"]);
  });

  test("skips providers that don't serve the model", async () => {
    const config = makeConfig({
      providers: [
        {
          name: "wrong-models",
          baseUrl: `http://localhost:${MOCK_PORT}/v1`,
          models: ["other-model"],
          maxFailures: 3,
          cooldownSeconds: 60,
        },
        {
          name: "right-models",
          baseUrl: `http://localhost:${MOCK_PORT}/v1`,
          models: ["test-model"],
          maxFailures: 3,
          cooldownSeconds: 60,
        },
      ],
    });

    const router = new Router(config);
    const body = JSON.stringify({ model: "test-model", messages: [] });
    const result = await router.routeChatCompletions("test-model", body);

    expect(result.provider?.name).toBe("right-models");
    expect(result.skipped).toContain("wrong-models(no-model)");
  });

  test("wildcard model matches any request", async () => {
    const config = makeConfig({
      providers: [
        {
          name: "wildcard",
          baseUrl: `http://localhost:${MOCK_PORT}/v1`,
          models: ["*"],
          maxFailures: 3,
          cooldownSeconds: 60,
        },
      ],
    });

    const router = new Router(config);
    const body = JSON.stringify({ model: "any-model-name", messages: [] });
    const result = await router.routeChatCompletions("any-model-name", body);

    expect(result.provider?.name).toBe("wildcard");
    expect(result.result?.status).toBe(200);
  });

  test("returns 502 when all providers exhausted", async () => {
    const config = makeConfig({
      providers: [
        {
          name: "unreachable",
          baseUrl: "http://localhost:1/v1", // will fail to connect
          models: ["*"],
          maxFailures: 10,
          cooldownSeconds: 60,
        },
      ],
    });

    const router = new Router(config);
    const body = JSON.stringify({ model: "test-model", messages: [] });
    const result = await router.routeChatCompletions("test-model", body);

    expect(result.provider).toBeNull();
    expect(result.result).toBeNull();
    expect(result.error).toContain("All providers exhausted");
  });

  test("skips unhealthy providers", async () => {
    const config = makeConfig({
      providers: [
        {
          name: "unhealthy-one",
          baseUrl: "http://localhost:1/v1",
          models: ["*"],
          maxFailures: 1,
          cooldownSeconds: 300,
        },
        {
          name: "healthy-backup",
          baseUrl: `http://localhost:${MOCK_PORT}/v1`,
          models: ["*"],
          maxFailures: 3,
          cooldownSeconds: 60,
        },
      ],
    });

    const router = new Router(config);
    const body = JSON.stringify({ model: "test-model", messages: [] });

    // First request: unhealthy-one fails and gets marked unhealthy
    const result1 = await router.routeChatCompletions("test-model", body);
    expect(result1.provider?.name).toBe("healthy-backup");

    // Second request: unhealthy-one should be skipped
    const result2 = await router.routeChatCompletions("test-model", body);
    expect(result2.provider?.name).toBe("healthy-backup");
    expect(result2.skipped).toContain("unhealthy-one(unhealthy)");
  });

  test("lists models from all healthy providers", async () => {
    const router = new Router(makeConfig());
    const models = await router.listAllModels();

    expect(models.length).toBeGreaterThan(0);
    expect(models[0].id).toBe("test-model");
  });

  test("handles streaming response", async () => {
    const router = new Router(makeConfig());
    const body = JSON.stringify({
      model: "test-model",
      messages: [],
      stream: true,
    });
    const result = await router.routeChatCompletions("test-model", body);

    expect(result.result?.streaming).toBe(true);
    expect(result.result?.body).toBeInstanceOf(ReadableStream);
  });
});
