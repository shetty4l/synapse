import { describe, expect, test } from "bun:test";
import { VERSION } from "../src/version";

describe("version", () => {
  test("exports a version string", () => {
    expect(typeof VERSION).toBe("string");
    expect(VERSION.length).toBeGreaterThan(0);
  });
});
