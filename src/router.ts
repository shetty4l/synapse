/**
 * Router — walks the provider chain to fulfill a request.
 *
 * For a given model, tries each provider in order:
 *   1. Skip if provider doesn't serve the requested model (unless wildcard)
 *   2. Skip if provider is unhealthy
 *   3. Forward request to provider
 *   4. On success: record success, return result
 *   5. On failure: record failure, try next provider
 *   6. If all exhausted: return 502
 */

import type { ProviderConfig, SynapseConfig } from "./config";
import { HealthTracker } from "./health";
import { chatCompletions, listModels, type ProviderResult } from "./provider";

export interface RouteResult {
  /** The provider that handled the request (null if all failed) */
  provider: ProviderConfig | null;
  /** The result from the provider (null if all failed) */
  result: ProviderResult | null;
  /** Providers attempted (in order) */
  attempted: string[];
  /** Providers skipped (not serving model or unhealthy) */
  skipped: string[];
  /** Error message if all providers failed */
  error?: string;
}

export class Router {
  private readonly config: SynapseConfig;
  readonly health: HealthTracker;

  constructor(config: SynapseConfig) {
    this.config = config;
    this.health = new HealthTracker(config.providers);
  }

  /**
   * Check if a provider serves a given model.
   * Wildcard ["*"] matches any model.
   */
  private servesModel(provider: ProviderConfig, model: string): boolean {
    return provider.models.includes("*") || provider.models.includes(model);
  }

  /**
   * Route a chat completions request through the provider chain.
   */
  async routeChatCompletions(
    model: string,
    body: string,
    signal?: AbortSignal,
  ): Promise<RouteResult> {
    const attempted: string[] = [];
    const skipped: string[] = [];

    for (const provider of this.config.providers) {
      // Check model match
      if (!this.servesModel(provider, model)) {
        skipped.push(`${provider.name}(no-model)`);
        continue;
      }

      // Check health
      if (!this.health.isHealthy(provider.name)) {
        skipped.push(`${provider.name}(unhealthy)`);
        continue;
      }

      attempted.push(provider.name);

      try {
        const result = await chatCompletions(provider, body, signal);

        if (result.status >= 200 && result.status < 500) {
          // 404 from a wildcard provider means "I don't have this model" —
          // fall through to the next provider instead of returning the error.
          const isWildcard = provider.models.includes("*");
          if (result.status === 404 && isWildcard) {
            console.log(
              `synapse: provider "${provider.name}" returned 404 for model "${model}" (wildcard), trying next`,
            );
            continue;
          }

          // Success or client error (4xx) — don't failover on client errors
          this.health.recordSuccess(provider.name);
          return { provider, result, attempted, skipped };
        }

        // 5xx — provider error, fail over
        this.health.recordFailure(
          provider.name,
          provider.maxFailures ?? 3,
          provider.cooldownSeconds ?? 60,
        );
        console.log(
          `synapse: provider "${provider.name}" returned ${result.status} for model "${model}", trying next`,
        );
      } catch (error) {
        this.health.recordFailure(
          provider.name,
          provider.maxFailures ?? 3,
          provider.cooldownSeconds ?? 60,
        );
        const msg = error instanceof Error ? error.message : String(error);
        console.log(
          `synapse: provider "${provider.name}" error for model "${model}": ${msg}, trying next`,
        );
      }
    }

    return {
      provider: null,
      result: null,
      attempted,
      skipped,
      error: `All providers exhausted for model "${model}". Attempted: [${attempted.join(", ")}], Skipped: [${skipped.join(", ")}]`,
    };
  }

  /**
   * Aggregate models from all healthy providers.
   * Deduplicates by model ID — first provider in config order wins.
   */
  async listAllModels(): Promise<
    { id: string; object: string; owned_by: string }[]
  > {
    const healthyProviders = this.config.providers.filter((p) =>
      this.health.isHealthy(p.name),
    );

    const results = await Promise.allSettled(
      healthyProviders.map((provider) => listModels(provider)),
    );

    // Process in config order so first provider always wins dedup
    const seen = new Set<string>();
    const allModels: { id: string; object: string; owned_by: string }[] = [];

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status === "fulfilled") {
        for (const model of result.value) {
          if (!seen.has(model.id)) {
            seen.add(model.id);
            allModels.push(model);
          }
        }
      }
    }

    return allModels;
  }
}
