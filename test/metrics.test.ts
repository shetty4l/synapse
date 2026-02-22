import { describe, expect, test } from "bun:test";
import type { ProviderHealth } from "../src/health";
import {
  MetricsRingBuffer,
  percentile,
  type RequestEntry,
} from "../src/metrics";

// --- Helpers ---

const EMPTY_PROVIDERS: ProviderHealth[] = [];

function makeEntry(overrides: Partial<RequestEntry> = {}): RequestEntry {
  return {
    timestamp: Date.now(),
    model: "test-model",
    provider: "test-provider",
    latencyMs: 100,
    success: true,
    wasFailover: false,
    ...overrides,
  };
}

function makeProviderHealth(
  name: string,
  healthy = true,
  consecutiveFailures = 0,
): ProviderHealth {
  return {
    name,
    healthy,
    consecutiveFailures,
    unhealthySince: 0,
    cooldownUntil: 0,
  };
}

// --- Tests ---

describe("percentile", () => {
  test("returns 0 for empty array", () => {
    expect(percentile([], 50)).toBe(0);
    expect(percentile([], 95)).toBe(0);
    expect(percentile([], 99)).toBe(0);
  });

  test("returns the single value for single-element array", () => {
    expect(percentile([42], 50)).toBe(42);
    expect(percentile([42], 95)).toBe(42);
    expect(percentile([42], 99)).toBe(42);
  });

  test("computes correct percentiles for known data", () => {
    // 10 values: 100, 200, 300, 400, 500, 600, 700, 800, 900, 1000
    const sorted = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000];

    // p50: ceil(0.5 * 10) - 1 = 4 → sorted[4] = 500
    expect(percentile(sorted, 50)).toBe(500);

    // p95: ceil(0.95 * 10) - 1 = 9 → sorted[9] = 1000
    expect(percentile(sorted, 95)).toBe(1000);

    // p99: ceil(0.99 * 10) - 1 = 9 → sorted[9] = 1000
    expect(percentile(sorted, 99)).toBe(1000);
  });

  test("computes p95 with 100 values", () => {
    // 1..100
    const sorted = Array.from({ length: 100 }, (_, i) => i + 1);

    // p50: ceil(0.5 * 100) - 1 = 49 → sorted[49] = 50
    expect(percentile(sorted, 50)).toBe(50);

    // p95: ceil(0.95 * 100) - 1 = 94 → sorted[94] = 95
    expect(percentile(sorted, 95)).toBe(95);

    // p99: ceil(0.99 * 100) - 1 = 98 → sorted[98] = 99
    expect(percentile(sorted, 99)).toBe(99);
  });
});

describe("MetricsRingBuffer", () => {
  test("empty buffer returns zeros/nulls", () => {
    const buf = new MetricsRingBuffer(100);
    const stats = buf.getStats(EMPTY_PROVIDERS);

    expect(stats.buffer.capacity).toBe(100);
    expect(stats.buffer.size).toBe(0);
    expect(stats.buffer.oldest_entry_at).toBeNull();
    expect(stats.requests.total_24h).toBe(0);
    expect(stats.requests.errors_24h).toBe(0);
    expect(stats.requests.by_provider).toEqual({});
    expect(stats.latency.p50_ms).toBeNull();
    expect(stats.latency.p95_ms).toBeNull();
    expect(stats.latency.p99_ms).toBeNull();
    expect(stats.fallbacks.count_24h).toBe(0);
    expect(stats.providers).toEqual([]);
  });

  test("single entry stats", () => {
    const buf = new MetricsRingBuffer(100);
    const now = Date.now();
    buf.record(makeEntry({ timestamp: now, provider: "kimi", latencyMs: 500 }));

    const stats = buf.getStats(EMPTY_PROVIDERS, now);

    expect(stats.buffer.size).toBe(1);
    expect(stats.buffer.oldest_entry_at).toBe(now);
    expect(stats.requests.total_24h).toBe(1);
    expect(stats.requests.errors_24h).toBe(0);
    expect(stats.requests.by_provider).toEqual({
      kimi: { total: 1, errors: 0 },
    });
    expect(stats.latency.p50_ms).toBe(500);
    expect(stats.latency.p95_ms).toBe(500);
    expect(stats.latency.p99_ms).toBe(500);
    expect(stats.fallbacks.count_24h).toBe(0);
  });

  test("ring buffer overflow — old entries overwritten, size capped", () => {
    const capacity = 5;
    const buf = new MetricsRingBuffer(capacity);
    const now = Date.now();

    // Insert 8 entries (3 more than capacity)
    for (let i = 0; i < 8; i++) {
      buf.record(
        makeEntry({
          timestamp: now + i,
          latencyMs: (i + 1) * 100,
          provider: `p-${i}`,
        }),
      );
    }

    const stats = buf.getStats(EMPTY_PROVIDERS, now + 10);

    // Size should be capped at capacity
    expect(stats.buffer.size).toBe(capacity);

    // Oldest entry should be the 4th (index 3), not the 1st
    // Entries 0,1,2 were overwritten by 5,6,7
    expect(stats.buffer.oldest_entry_at).toBe(now + 3);

    // All 5 remaining entries are within the window
    expect(stats.requests.total_24h).toBe(5);
  });

  test("time window filtering — old entries excluded from 24h aggregates", () => {
    const buf = new MetricsRingBuffer(100);
    const now = Date.now();
    const oneDayAgo = now - 86_400_000;

    // Insert 3 old entries (outside 24h window)
    for (let i = 0; i < 3; i++) {
      buf.record(
        makeEntry({
          timestamp: oneDayAgo - 1000 * (i + 1),
          provider: "old",
          latencyMs: 100,
        }),
      );
    }

    // Insert 2 recent entries (inside 24h window)
    buf.record(makeEntry({ timestamp: now - 1000, provider: "new" }));
    buf.record(makeEntry({ timestamp: now - 500, provider: "new" }));

    const stats = buf.getStats(EMPTY_PROVIDERS, now);

    // Buffer has all 5 entries
    expect(stats.buffer.size).toBe(5);

    // But 24h aggregates only count the 2 recent ones
    expect(stats.requests.total_24h).toBe(2);
    expect(stats.requests.by_provider).toEqual({
      new: { total: 2, errors: 0 },
    });
  });

  test("per-provider grouping", () => {
    const buf = new MetricsRingBuffer(100);
    const now = Date.now();

    buf.record(makeEntry({ timestamp: now, provider: "kimi" }));
    buf.record(makeEntry({ timestamp: now, provider: "kimi" }));
    buf.record(
      makeEntry({ timestamp: now, provider: "local-gpu", success: false }),
    );
    buf.record(makeEntry({ timestamp: now, provider: "local-gpu" }));
    buf.record(makeEntry({ timestamp: now, provider: null, success: false }));

    const stats = buf.getStats(EMPTY_PROVIDERS, now);

    expect(stats.requests.total_24h).toBe(5);
    expect(stats.requests.by_provider).toEqual({
      kimi: { total: 2, errors: 0 },
      "local-gpu": { total: 2, errors: 1 },
      "(none)": { total: 1, errors: 1 },
    });
  });

  test("error counting", () => {
    const buf = new MetricsRingBuffer(100);
    const now = Date.now();

    buf.record(makeEntry({ timestamp: now, success: true }));
    buf.record(makeEntry({ timestamp: now, success: false }));
    buf.record(makeEntry({ timestamp: now, success: false }));
    buf.record(makeEntry({ timestamp: now, success: true }));

    const stats = buf.getStats(EMPTY_PROVIDERS, now);

    expect(stats.requests.total_24h).toBe(4);
    expect(stats.requests.errors_24h).toBe(2);
  });

  test("fallover counting", () => {
    const buf = new MetricsRingBuffer(100);
    const now = Date.now();

    buf.record(makeEntry({ timestamp: now, wasFailover: false }));
    buf.record(makeEntry({ timestamp: now, wasFailover: true }));
    buf.record(makeEntry({ timestamp: now, wasFailover: true }));
    buf.record(makeEntry({ timestamp: now, wasFailover: false }));

    const stats = buf.getStats(EMPTY_PROVIDERS, now);

    expect(stats.fallbacks.count_24h).toBe(2);
  });

  test("latency percentiles only from successful requests", () => {
    const buf = new MetricsRingBuffer(100);
    const now = Date.now();

    // Successful requests with known latencies
    buf.record(makeEntry({ timestamp: now, success: true, latencyMs: 100 }));
    buf.record(makeEntry({ timestamp: now, success: true, latencyMs: 200 }));
    buf.record(makeEntry({ timestamp: now, success: true, latencyMs: 300 }));
    buf.record(makeEntry({ timestamp: now, success: true, latencyMs: 400 }));
    buf.record(makeEntry({ timestamp: now, success: true, latencyMs: 500 }));

    // Failed request with very high latency — should be excluded
    buf.record(makeEntry({ timestamp: now, success: false, latencyMs: 99999 }));

    const stats = buf.getStats(EMPTY_PROVIDERS, now);

    // p50: ceil(0.5 * 5) - 1 = 2 → sorted[2] = 300
    expect(stats.latency.p50_ms).toBe(300);

    // p95: ceil(0.95 * 5) - 1 = 4 → sorted[4] = 500
    expect(stats.latency.p95_ms).toBe(500);

    // p99: ceil(0.99 * 5) - 1 = 4 → sorted[4] = 500
    expect(stats.latency.p99_ms).toBe(500);
  });

  test("latency is null when all requests failed", () => {
    const buf = new MetricsRingBuffer(100);
    const now = Date.now();

    buf.record(makeEntry({ timestamp: now, success: false, latencyMs: 1000 }));
    buf.record(makeEntry({ timestamp: now, success: false, latencyMs: 2000 }));

    const stats = buf.getStats(EMPTY_PROVIDERS, now);

    expect(stats.latency.p50_ms).toBeNull();
    expect(stats.latency.p95_ms).toBeNull();
    expect(stats.latency.p99_ms).toBeNull();
  });

  test("buffer metadata — oldest_entry_at, capacity, size", () => {
    const buf = new MetricsRingBuffer(50);
    const now = Date.now();

    buf.record(makeEntry({ timestamp: now - 5000 }));
    buf.record(makeEntry({ timestamp: now - 3000 }));
    buf.record(makeEntry({ timestamp: now - 1000 }));

    const stats = buf.getStats(EMPTY_PROVIDERS, now);

    expect(stats.buffer.capacity).toBe(50);
    expect(stats.buffer.size).toBe(3);
    expect(stats.buffer.oldest_entry_at).toBe(now - 5000);
  });

  test("providers array reflects health tracker state", () => {
    const buf = new MetricsRingBuffer(100);
    const providers = [
      makeProviderHealth("kimi", true, 0),
      makeProviderHealth("local-gpu", false, 3),
    ];

    const stats = buf.getStats(providers);

    expect(stats.providers).toEqual([
      { name: "kimi", healthy: true, consecutiveFailures: 0 },
      { name: "local-gpu", healthy: false, consecutiveFailures: 3 },
    ]);
  });

  test("default capacity is 10000", () => {
    const buf = new MetricsRingBuffer();
    const stats = buf.getStats(EMPTY_PROVIDERS);
    expect(stats.buffer.capacity).toBe(10_000);
  });
});
