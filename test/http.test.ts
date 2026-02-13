import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer } from "../src/server";

type BunServer = ReturnType<typeof Bun.serve>;

/**
 * Full HTTP integration test.
 * Spins up a mock upstream + Synapse server, sends real HTTP requests.
 */

const MOCK_PORT = 19877;
const SYNAPSE_PORT = 19878;

function startMockUpstream(): BunServer {
  return Bun.serve({
    port: MOCK_PORT,
    fetch: async (req) => {
      const url = new URL(req.url);

      if (url.pathname === "/v1/models") {
        return Response.json({
          object: "list",
          data: [
            { id: "test-model", object: "model", owned_by: "mock" },
            { id: "another-model", object: "model", owned_by: "mock" },
          ],
        });
      }

      if (url.pathname === "/v1/chat/completions") {
        const body = (await req.json()) as { stream?: boolean };

        if (body.stream) {
          const stream = new ReadableStream({
            start(controller) {
              const encoder = new TextEncoder();
              controller.enqueue(
                encoder.encode(
                  'data: {"id":"chat-1","object":"chat.completion.chunk","choices":[{"delta":{"content":"Hi"},"index":0}]}\n\n',
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

describe("HTTP integration", () => {
  let mockUpstream: BunServer;
  let synapseServer: BunServer;

  beforeAll(() => {
    mockUpstream = startMockUpstream();
    const server = createServer({
      port: SYNAPSE_PORT,
      providers: [
        {
          name: "mock",
          baseUrl: `http://localhost:${MOCK_PORT}/v1`,
          models: ["*"],
          maxFailures: 3,
          cooldownSeconds: 60,
        },
      ],
    });
    synapseServer = server.start();
  });

  afterAll(() => {
    synapseServer.stop(true);
    mockUpstream.stop(true);
  });

  const base = `http://localhost:${SYNAPSE_PORT}`;

  test("POST /v1/chat/completions — non-streaming", async () => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "test-model",
        messages: [{ role: "user", content: "hi" }],
      }),
    });

    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      choices: { message: { content: string } }[];
    };
    expect(data.choices[0].message.content).toBe("Hello!");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  test("POST /v1/chat/completions — streaming", async () => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "test-model",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const text = await res.text();
    expect(text).toContain("data:");
    expect(text).toContain("[DONE]");
  });

  test("POST /v1/chat/completions — missing model", async () => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [] }),
    });

    expect(res.status).toBe(400);
    const data = (await res.json()) as { error: { type: string } };
    expect(data.error.type).toBe("invalid_request_error");
  });

  test("POST /v1/chat/completions — invalid JSON", async () => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });

    expect(res.status).toBe(400);
  });

  test("GET /v1/chat/completions — wrong method", async () => {
    const res = await fetch(`${base}/v1/chat/completions`);
    expect(res.status).toBe(405);
  });

  test("GET /v1/models — returns aggregated models", async () => {
    const res = await fetch(`${base}/v1/models`);
    expect(res.status).toBe(200);

    const data = (await res.json()) as {
      object: string;
      data: { id: string }[];
    };
    expect(data.object).toBe("list");
    expect(data.data.length).toBeGreaterThan(0);
    expect(data.data.some((m) => m.id === "test-model")).toBe(true);
  });

  test("GET /health — returns health status", async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);

    const data = (await res.json()) as {
      status: string;
      version: string;
      providers: { name: string; healthy: boolean }[];
    };
    expect(data.status).toBe("healthy");
    expect(data.version).toBeDefined();
    expect(data.providers).toHaveLength(1);
    expect(data.providers[0].name).toBe("mock");
    expect(data.providers[0].healthy).toBe(true);
  });

  test("OPTIONS — CORS preflight", async () => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "OPTIONS",
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
  });

  test("GET /unknown — 404 in OpenAI error format", async () => {
    const res = await fetch(`${base}/unknown-path`);
    expect(res.status).toBe(404);

    const data = (await res.json()) as {
      error: { type: string; message: string };
    };
    expect(data.error.type).toBe("not_found");
  });
});
