import { describe, expect, test } from "bun:test";
import type { ProviderConfig } from "../src/config";
import { HealthTracker } from "../src/health";

function makeProviders(count: number): ProviderConfig[] {
  return Array.from({ length: count }, (_, i) => ({
    name: `provider-${i}`,
    baseUrl: `http://localhost:${11434 + i}/v1`,
    models: ["*"],
    maxFailures: 3,
    cooldownSeconds: 60,
  }));
}

describe("HealthTracker", () => {
  test("all providers start healthy", () => {
    const tracker = new HealthTracker(makeProviders(3));
    expect(tracker.isHealthy("provider-0")).toBe(true);
    expect(tracker.isHealthy("provider-1")).toBe(true);
    expect(tracker.isHealthy("provider-2")).toBe(true);
  });

  test("unknown provider returns false", () => {
    const tracker = new HealthTracker(makeProviders(1));
    expect(tracker.isHealthy("nonexistent")).toBe(false);
  });

  test("recordSuccess resets failure count", () => {
    const tracker = new HealthTracker(makeProviders(1));
    tracker.recordFailure("provider-0", 3, 60);
    tracker.recordFailure("provider-0", 3, 60);
    tracker.recordSuccess("provider-0");
    const health = tracker.get("provider-0")!;
    expect(health.consecutiveFailures).toBe(0);
    expect(health.healthy).toBe(true);
  });

  test("marks unhealthy after maxFailures consecutive failures", () => {
    const tracker = new HealthTracker(makeProviders(1));
    tracker.recordFailure("provider-0", 3, 60);
    expect(tracker.isHealthy("provider-0")).toBe(true);
    tracker.recordFailure("provider-0", 3, 60);
    expect(tracker.isHealthy("provider-0")).toBe(true);
    tracker.recordFailure("provider-0", 3, 60);
    expect(tracker.isHealthy("provider-0")).toBe(false);
  });

  test("auto-recovers after cooldown expires", () => {
    const tracker = new HealthTracker(makeProviders(1));
    // Mark unhealthy with a long cooldown
    for (let i = 0; i < 3; i++) {
      tracker.recordFailure("provider-0", 3, 300);
    }
    expect(tracker.isHealthy("provider-0")).toBe(false);

    // Simulate cooldown expiry by setting cooldownUntil to past
    const health = tracker.get("provider-0")!;
    health.cooldownUntil = Date.now() - 1;

    expect(tracker.isHealthy("provider-0")).toBe(true);
    expect(tracker.get("provider-0")!.consecutiveFailures).toBe(0);
  });

  test("getAll returns all providers", () => {
    const tracker = new HealthTracker(makeProviders(3));
    const all = tracker.getAll();
    expect(all).toHaveLength(3);
    expect(all.map((h) => h.name)).toEqual([
      "provider-0",
      "provider-1",
      "provider-2",
    ]);
  });
});
