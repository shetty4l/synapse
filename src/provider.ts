/**
 * OpenAI-compatible provider client.
 *
 * Single implementation that works for any OpenAI-compatible API:
 * Ollama, OpenAI, Groq, OpenRouter, etc.
 *
 * - POST /chat/completions (streaming or non-streaming)
 * - GET /models
 *
 * Streaming uses SSE passthrough via ReadableStream -- we don't parse
 * the individual SSE events, just pipe the upstream response body through.
 */

import type { ProviderConfig } from "./config";

export interface ProviderResult {
  /** HTTP status code from upstream */
  status: number;
  /** Response headers to forward */
  headers: Record<string, string>;
  /** Response body -- either a ReadableStream (streaming) or a string (non-streaming) */
  body: ReadableStream<Uint8Array> | string;
  /** Whether this is a streaming response */
  streaming: boolean;
}

const TIMEOUT_MS = 120_000; // 2 minutes
const STREAM_IDLE_TIMEOUT_MS = 30_000; // 30 seconds between chunks

/**
 * Wrap a ReadableStream with an idle timeout that aborts if no data
 * arrives within the given interval. Also ensures cleanup on completion.
 */
function withStreamTimeout(
  stream: ReadableStream<Uint8Array>,
  controller: AbortController,
  idleMs: number,
): ReadableStream<Uint8Array> {
  let timer: ReturnType<typeof setTimeout>;

  const resetTimer = () => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(), idleMs);
  };

  return stream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      start() {
        resetTimer();
      },
      transform(chunk, ctrl) {
        resetTimer();
        ctrl.enqueue(chunk);
      },
      flush() {
        clearTimeout(timer);
      },
      // cancel is valid per the WHATWG Streams spec but missing from TS's
      // Transformer type.  It ensures the timer is cleared when the readable
      // side is cancelled (e.g. client disconnect).
      cancel() {
        clearTimeout(timer);
      },
    } as Transformer<Uint8Array, Uint8Array>),
  );
}

/**
 * Forward a chat completions request to an upstream provider.
 */
export async function chatCompletions(
  provider: ProviderConfig,
  body: string,
  signal?: AbortSignal,
): Promise<ProviderResult> {
  const url = `${provider.baseUrl}/chat/completions`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (provider.apiKey) {
    headers["Authorization"] = `Bearer ${provider.apiKey}`;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  // Chain caller's abort signal if provided
  if (signal) {
    signal.addEventListener("abort", () => controller.abort(), { once: true });
  }

  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
    });

    const contentType = response.headers.get("content-type") ?? "";
    const streaming = contentType.includes("text/event-stream");

    const responseHeaders: Record<string, string> = {
      "content-type": contentType,
    };

    if (streaming && response.body) {
      // Replace the initial connection timeout with a per-chunk idle timeout.
      clearTimeout(timeout);
      const guardedStream = withStreamTimeout(
        response.body,
        controller,
        STREAM_IDLE_TIMEOUT_MS,
      );
      return {
        status: response.status,
        headers: responseHeaders,
        body: guardedStream,
        streaming: true,
      };
    }

    clearTimeout(timeout);
    const text = await response.text();
    return {
      status: response.status,
      headers: responseHeaders,
      body: text,
      streaming: false,
    };
  } catch (error) {
    clearTimeout(timeout);

    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error(`Provider "${provider.name}" request timed out`);
    }
    throw error;
  }
}

/**
 * Fetch available models from an upstream provider.
 */
export async function listModels(
  provider: ProviderConfig,
): Promise<{ id: string; object: string; owned_by: string }[]> {
  const url = `${provider.baseUrl}/models`;
  const headers: Record<string, string> = {};
  if (provider.apiKey) {
    headers["Authorization"] = `Bearer ${provider.apiKey}`;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  try {
    const response = await fetch(url, {
      headers,
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      return [];
    }

    const data = (await response.json()) as {
      data?: { id: string; object: string; owned_by: string }[];
    };
    return data.data ?? [];
  } catch {
    clearTimeout(timeout);
    return [];
  }
}

/**
 * Check basic reachability of a provider (GET /models).
 */
export async function checkReachable(
  provider: ProviderConfig,
): Promise<boolean> {
  const url = `${provider.baseUrl}/models`;
  const headers: Record<string, string> = {};
  if (provider.apiKey) {
    headers["Authorization"] = `Bearer ${provider.apiKey}`;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);
    const response = await fetch(url, {
      headers,
      signal: controller.signal,
    });
    clearTimeout(timeout);
    return response.ok;
  } catch {
    return false;
  }
}
