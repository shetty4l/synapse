/**
 * HTTP server — the main Synapse entry point.
 *
 * Endpoints:
 *   POST /v1/chat/completions  — proxy to provider chain
 *   GET  /v1/models            — aggregated models from all healthy providers
 *   GET  /health               — service health + provider status
 *
 * Uses Bun.serve for native performance.
 */

import type { SynapseConfig } from "./config";
import { createLogEntry, RequestLogger } from "./logger";
import { checkReachable } from "./provider";
import { Router } from "./router";
import { VERSION } from "./version";

// --- Constants ---

/** Maximum request body size (1 MB) */
const MAX_BODY_BYTES = 1 * 1024 * 1024;

/** Reachability cache TTL (30 seconds) */
const REACHABILITY_TTL_MS = 30_000;

// --- Reachability cache ---

interface ReachabilityEntry {
  reachable: boolean;
  cachedAt: number;
}

const reachabilityCache = new Map<string, ReachabilityEntry>();

async function getCachedReachability(provider: {
  name: string;
  baseUrl: string;
  apiKey?: string;
  models: string[];
}): Promise<boolean> {
  const cacheKey = provider.baseUrl;
  const entry = reachabilityCache.get(cacheKey);
  if (entry && Date.now() - entry.cachedAt < REACHABILITY_TTL_MS) {
    return entry.reachable;
  }

  const reachable = await checkReachable(
    provider as import("./config").ProviderConfig,
  );
  reachabilityCache.set(cacheKey, { reachable, cachedAt: Date.now() });
  return reachable;
}

// --- OpenAI error format ---

function openaiError(
  status: number,
  message: string,
  type = "server_error",
): Response {
  return Response.json(
    {
      error: {
        message,
        type,
        code: null,
        param: null,
      },
    },
    { status, headers: corsHeaders() },
  );
}

// --- CORS ---

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

function handleCors(): Response {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

// --- Handlers ---

async function handleChatCompletions(
  router: Router,
  logger: RequestLogger,
  request: Request,
): Promise<Response> {
  if (request.method !== "POST") {
    return openaiError(405, "Method not allowed", "invalid_request_error");
  }

  let body: string;
  try {
    body = await request.text();
  } catch {
    return openaiError(
      400,
      "Failed to read request body",
      "invalid_request_error",
    );
  }

  // Enforce body size limit regardless of Content-Length header presence
  if (body.length > MAX_BODY_BYTES) {
    return openaiError(
      413,
      `Request body too large (max ${MAX_BODY_BYTES} bytes)`,
      "invalid_request_error",
    );
  }

  let parsed: { model?: string; stream?: boolean };
  try {
    parsed = JSON.parse(body);
  } catch {
    return openaiError(400, "Invalid JSON body", "invalid_request_error");
  }

  if (!parsed.model || typeof parsed.model !== "string") {
    return openaiError(
      400,
      "'model' is required and must be a string",
      "invalid_request_error",
    );
  }

  const start = performance.now();
  const result = await router.routeChatCompletions(parsed.model, body);
  const latencyMs = performance.now() - start;

  if (!result.result) {
    logger.log(
      createLogEntry(
        parsed.model,
        null,
        502,
        parsed.stream ?? false,
        latencyMs,
        result.attempted,
        result.skipped,
        result.error,
      ),
    );
    return openaiError(502, result.error ?? "All providers exhausted");
  }

  const { result: upstream } = result;

  logger.log(
    createLogEntry(
      parsed.model,
      result.provider?.name ?? null,
      upstream.status,
      upstream.streaming,
      latencyMs,
      result.attempted,
      result.skipped,
    ),
  );

  const headers = new Headers({
    ...corsHeaders(),
    ...upstream.headers,
  });

  if (upstream.streaming && typeof upstream.body !== "string") {
    return new Response(upstream.body, {
      status: upstream.status,
      headers,
    });
  }

  return new Response(upstream.body as string, {
    status: upstream.status,
    headers,
  });
}

async function handleModels(router: Router): Promise<Response> {
  const models = await router.listAllModels();
  return Response.json(
    { object: "list", data: models },
    { headers: corsHeaders() },
  );
}

async function handleHealth(
  config: SynapseConfig,
  router: Router,
): Promise<Response> {
  const providerHealth = await Promise.all(
    config.providers.map(async (p) => {
      const health = router.health.get(p.name);
      const reachable = await getCachedReachability(p);
      return {
        name: p.name,
        healthy: health?.healthy ?? false,
        reachable,
        consecutiveFailures: health?.consecutiveFailures ?? 0,
        models: p.models,
      };
    }),
  );

  const allHealthy = providerHealth.every((p) => p.healthy);

  return Response.json(
    {
      status: allHealthy ? "healthy" : "degraded",
      version: VERSION,
      uptime: Math.floor((Date.now() - startTime) / 1000),
      providers: providerHealth,
    },
    {
      status: allHealthy ? 200 : 503,
      headers: corsHeaders(),
    },
  );
}

// --- Server ---

const startTime = Date.now();

export function createServer(config: SynapseConfig): {
  start: () => ReturnType<typeof Bun.serve>;
} {
  const router = new Router(config);
  const logger = new RequestLogger();

  return {
    start: () => {
      const server = Bun.serve({
        port: config.port,
        fetch: async (request) => {
          const url = new URL(request.url);
          const path = url.pathname;
          const start = performance.now();

          // CORS preflight
          if (request.method === "OPTIONS") {
            return handleCors();
          }

          // Route
          let response: Response;
          if (path === "/v1/chat/completions") {
            response = await handleChatCompletions(router, logger, request);
          } else if (path === "/v1/models") {
            response = await handleModels(router);
          } else if (path === "/health") {
            response = await handleHealth(config, router);
          } else {
            response = openaiError(
              404,
              `Unknown endpoint: ${path}`,
              "not_found",
            );
          }

          const latency = (performance.now() - start).toFixed(0);
          // Skip health checks to reduce noise
          if (path !== "/health") {
            console.error(
              `synapse: ${request.method} ${path} ${response.status} ${latency}ms`,
            );
          }

          return response;
        },
      });

      console.error(
        `synapse: listening on http://localhost:${server.port} (${config.providers.length} provider(s))`,
      );
      return server;
    },
  };
}
