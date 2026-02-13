import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import {
  interpolateEnvVars,
  loadConfig,
  type SynapseConfig,
} from "../src/config";

describe("interpolateEnvVars", () => {
  test("replaces ${VAR} with env value", () => {
    process.env.TEST_KEY = "secret-123";
    expect(interpolateEnvVars("Bearer ${TEST_KEY}")).toBe("Bearer secret-123");
    delete process.env.TEST_KEY;
  });

  test("replaces multiple vars", () => {
    process.env.HOST = "localhost";
    process.env.PORT_VAR = "8080";
    expect(interpolateEnvVars("http://${HOST}:${PORT_VAR}/v1")).toBe(
      "http://localhost:8080/v1",
    );
    delete process.env.HOST;
    delete process.env.PORT_VAR;
  });

  test("throws on missing env var", () => {
    expect(() => interpolateEnvVars("${MISSING_VAR_XYZ}")).toThrow(
      "MISSING_VAR_XYZ",
    );
  });

  test("returns string unchanged if no vars", () => {
    expect(interpolateEnvVars("plain string")).toBe("plain string");
  });
});

describe("loadConfig", () => {
  const tmpDir = join(import.meta.dir, ".tmp-config-test");

  beforeEach(() => {
    mkdirSync(tmpDir, { recursive: true });
  });

  const savedSynapsePort = process.env.SYNAPSE_PORT;

  afterEach(() => {
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true });
    }
    // Restore SYNAPSE_PORT to avoid env pollution between tests
    if (savedSynapsePort === undefined) {
      delete process.env.SYNAPSE_PORT;
    } else {
      process.env.SYNAPSE_PORT = savedSynapsePort;
    }
  });

  test("returns defaults when config file does not exist", () => {
    const config = loadConfig({
      configPath: join(tmpDir, "nonexistent.json"),
      quiet: true,
    });
    expect(config.port).toBe(7750);
    expect(config.providers).toHaveLength(1);
    expect(config.providers[0].name).toBe("ollama");
  });

  test("loads config from file", () => {
    const configPath = join(tmpDir, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        port: 9000,
        providers: [
          {
            name: "test-provider",
            baseUrl: "http://localhost:1234/v1",
            models: ["gpt-4"],
          },
        ],
      }),
    );

    const config = loadConfig({ configPath, quiet: true });
    expect(config.port).toBe(9000);
    expect(config.providers[0].name).toBe("test-provider");
    expect(config.providers[0].maxFailures).toBe(3); // default applied
  });

  test("interpolates env vars in config file", () => {
    process.env.TEST_API_KEY = "sk-test-123";
    const configPath = join(tmpDir, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        providers: [
          {
            name: "cloud",
            baseUrl: "https://api.openai.com/v1",
            apiKey: "${TEST_API_KEY}",
            models: ["gpt-4"],
          },
        ],
      }),
    );

    const config = loadConfig({ configPath, quiet: true });
    expect(config.providers[0].apiKey).toBe("sk-test-123");
    delete process.env.TEST_API_KEY;
  });

  test("SYNAPSE_PORT env overrides config file port", () => {
    process.env.SYNAPSE_PORT = "8888";
    const configPath = join(tmpDir, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        port: 9000,
        providers: [
          {
            name: "test",
            baseUrl: "http://localhost:1234/v1",
            models: ["*"],
          },
        ],
      }),
    );

    const config = loadConfig({ configPath, quiet: true });
    expect(config.port).toBe(8888);
    delete process.env.SYNAPSE_PORT;
  });

  test("rejects config with empty providers", () => {
    const configPath = join(tmpDir, "config.json");
    writeFileSync(configPath, JSON.stringify({ providers: [] }));

    expect(() => loadConfig({ configPath, quiet: true })).toThrow("non-empty");
  });

  test("validates provider fields", () => {
    const configPath = join(tmpDir, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        providers: [{ name: "", baseUrl: "http://x", models: ["*"] }],
      }),
    );

    expect(() => loadConfig({ configPath, quiet: true })).toThrow(
      "non-empty string",
    );
  });
});
