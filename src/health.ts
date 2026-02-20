/**
 * Per-provider health tracking.
 *
 * Tracks consecutive failures per provider. When failures exceed the
 * configured threshold, the provider is marked unhealthy for a cooldown
 * period. After cooldown expires, the provider auto-recovers to healthy
 * and is eligible for routing again.
 */

import { createLogger } from "@shetty4l/core/log";
import type { ProviderConfig } from "./config";

const log = createLogger("synapse");

export interface ProviderHealth {
  /** Provider name (matches ProviderConfig.name) */
  name: string;
  /** Whether the provider is currently healthy */
  healthy: boolean;
  /** Number of consecutive failures */
  consecutiveFailures: number;
  /** Timestamp (ms) when the provider became unhealthy, or 0 if healthy */
  unhealthySince: number;
  /** Timestamp (ms) when the cooldown expires and provider auto-recovers */
  cooldownUntil: number;
}

export class HealthTracker {
  private readonly state = new Map<string, ProviderHealth>();

  constructor(providers: ProviderConfig[]) {
    for (const p of providers) {
      this.state.set(p.name, {
        name: p.name,
        healthy: true,
        consecutiveFailures: 0,
        unhealthySince: 0,
        cooldownUntil: 0,
      });
    }
  }

  /**
   * Check if a provider is healthy.
   * If the cooldown has expired, auto-recovers the provider first.
   */
  isHealthy(providerName: string): boolean {
    const health = this.state.get(providerName);
    if (!health) return false;

    if (!health.healthy && health.cooldownUntil > 0) {
      if (Date.now() >= health.cooldownUntil) {
        this.recover(providerName);
        return true;
      }
    }
    return health.healthy;
  }

  /**
   * Record a successful request. Resets failure count.
   */
  recordSuccess(providerName: string): void {
    const health = this.state.get(providerName);
    if (!health) return;

    health.consecutiveFailures = 0;
    health.healthy = true;
    health.unhealthySince = 0;
    health.cooldownUntil = 0;
  }

  /**
   * Record a failed request. Increments failure count and potentially
   * marks the provider as unhealthy.
   */
  recordFailure(
    providerName: string,
    maxFailures: number,
    cooldownSeconds: number,
  ): void {
    const health = this.state.get(providerName);
    if (!health) return;

    health.consecutiveFailures += 1;

    if (health.consecutiveFailures >= maxFailures) {
      const wasHealthy = health.healthy;
      health.healthy = false;
      health.cooldownUntil = Date.now() + cooldownSeconds * 1000;

      if (wasHealthy) {
        health.unhealthySince = Date.now();
        log(
          `provider "${providerName}" marked unhealthy after ${health.consecutiveFailures} failures (cooldown ${cooldownSeconds}s)`,
        );
      } else {
        // Already unhealthy — extend cooldown on continued failures
        log(
          `provider "${providerName}" still failing (${health.consecutiveFailures} consecutive), cooldown extended`,
        );
      }
    }
  }

  /**
   * Manually recover a provider to healthy state.
   */
  private recover(providerName: string): void {
    const health = this.state.get(providerName);
    if (!health) return;

    log(`provider "${providerName}" auto-recovered after cooldown`);
    health.healthy = true;
    health.consecutiveFailures = 0;
    health.unhealthySince = 0;
    health.cooldownUntil = 0;
  }

  /**
   * Get health snapshot for all providers.
   */
  getAll(): ProviderHealth[] {
    return Array.from(this.state.values());
  }

  /**
   * Get health for a single provider.
   */
  get(providerName: string): ProviderHealth | undefined {
    return this.state.get(providerName);
  }
}
