/**
 * In-memory metrics ring buffer for request tracking.
 *
 * Fixed-size circular buffer that stores the most recent N request entries.
 * Provides aggregated stats over a 1-hour sliding window for the /stats
 * endpoint. All data lives in memory and resets on restart.
 */

import type { ProviderHealth } from "./health";

// --- Types ---

export interface RequestEntry {
  /** Epoch milliseconds (Date.now()) */
  timestamp: number;
  /** Requested model ID */
  model: string;
  /** Provider that handled the request (null if all failed) */
  provider: string | null;
  /** End-to-end latency in milliseconds */
  latencyMs: number;
  /** True if a 2xx response was returned to the client */
  success: boolean;
  /** True if the primary provider was skipped or failed */
  wasFailover: boolean;
}

export interface ProviderStats {
  total: number;
  errors: number;
}

export interface StatsResponse {
  buffer: {
    capacity: number;
    size: number;
    oldest_entry_at: number | null;
  };
  requests: {
    total_1h: number;
    errors_1h: number;
    by_provider: Record<string, ProviderStats>;
  };
  latency: {
    p50_ms: number | null;
    p95_ms: number | null;
    p99_ms: number | null;
  };
  fallbacks: {
    count_1h: number;
  };
  providers: {
    name: string;
    healthy: boolean;
    consecutiveFailures: number;
  }[];
}

// --- Constants ---

/** Sliding window for time-based aggregations (1 hour) */
const WINDOW_MS = 3_600_000;

// --- Percentile helper ---

/**
 * Compute a percentile value from a sorted array.
 * Returns 0 for empty arrays.
 */
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

// --- Ring buffer ---

export class MetricsRingBuffer {
  private readonly buffer: (RequestEntry | null)[];
  private readonly cap: number;
  private head = 0;
  private count = 0;

  constructor(capacity = 10_000) {
    this.cap = capacity;
    this.buffer = Array.from<RequestEntry | null>({ length: capacity }).fill(
      null,
    );
  }

  /** Record a request entry into the ring buffer. */
  record(entry: RequestEntry): void {
    this.buffer[this.head] = entry;
    this.head = (this.head + 1) % this.cap;
    if (this.count < this.cap) {
      this.count += 1;
    }
  }

  /**
   * Compute aggregated stats from the buffer.
   *
   * @param providerHealth - Current provider health state from HealthTracker
   * @param now - Current timestamp for time window filtering (defaults to Date.now())
   */
  getStats(providerHealth: ProviderHealth[], now?: number): StatsResponse {
    const currentTime = now ?? Date.now();
    const windowStart = currentTime - WINDOW_MS;

    // Collect all valid entries and find oldest
    let oldestTimestamp: number | null = null;
    const windowEntries: RequestEntry[] = [];

    for (let i = 0; i < this.count; i++) {
      const entry = this.buffer[i];
      if (!entry) continue;

      if (oldestTimestamp === null || entry.timestamp < oldestTimestamp) {
        oldestTimestamp = entry.timestamp;
      }

      if (entry.timestamp >= windowStart) {
        windowEntries.push(entry);
      }
    }

    // Aggregate requests
    let totalErrors = 0;
    let failoverCount = 0;
    const byProvider: Record<string, ProviderStats> = {};
    const successLatencies: number[] = [];

    for (const entry of windowEntries) {
      if (!entry.success) {
        totalErrors += 1;
      }
      if (entry.wasFailover) {
        failoverCount += 1;
      }

      // Group by provider
      const key = entry.provider ?? "(none)";
      if (!byProvider[key]) {
        byProvider[key] = { total: 0, errors: 0 };
      }
      byProvider[key].total += 1;
      if (!entry.success) {
        byProvider[key].errors += 1;
      }

      // Latency from successful requests only
      if (entry.success) {
        successLatencies.push(entry.latencyMs);
      }
    }

    // Sort latencies for percentile computation
    successLatencies.sort((a, b) => a - b);

    const hasLatency = successLatencies.length > 0;

    return {
      buffer: {
        capacity: this.cap,
        size: this.count,
        oldest_entry_at: oldestTimestamp,
      },
      requests: {
        total_1h: windowEntries.length,
        errors_1h: totalErrors,
        by_provider: byProvider,
      },
      latency: {
        p50_ms: hasLatency ? percentile(successLatencies, 50) : null,
        p95_ms: hasLatency ? percentile(successLatencies, 95) : null,
        p99_ms: hasLatency ? percentile(successLatencies, 99) : null,
      },
      fallbacks: {
        count_1h: failoverCount,
      },
      providers: providerHealth.map((p) => ({
        name: p.name,
        healthy: p.healthy,
        consecutiveFailures: p.consecutiveFailures,
      })),
    };
  }
}
