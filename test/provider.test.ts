import { describe, expect, test } from "bun:test";
import { translateRequestBody } from "../src/provider";

describe("translateRequestBody", () => {
  test("OpenAI: passes response_format unchanged", () => {
    const body = JSON.stringify({
      model: "gpt-4",
      messages: [{ role: "user", content: "Hello" }],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "response",
          schema: {
            type: "object",
            properties: {
              answer: { type: "string" },
            },
            required: ["answer"],
          },
        },
      },
    });

    const result = translateRequestBody(body, "openai");
    expect(result).toBe(body);
  });

  test("Ollama: translates response_format.json_schema.schema to format", () => {
    const body = JSON.stringify({
      model: "llama3",
      messages: [{ role: "user", content: "Hello" }],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "response",
          schema: {
            type: "object",
            properties: {
              answer: { type: "string" },
            },
            required: ["answer"],
          },
        },
      },
    });

    const result = translateRequestBody(body, "ollama");
    const parsed = JSON.parse(result) as Record<string, unknown>;

    // response_format should be removed
    expect(parsed.response_format).toBeUndefined();

    // format should contain the schema
    expect(parsed.format).toEqual({
      type: "object",
      properties: {
        answer: { type: "string" },
      },
      required: ["answer"],
    });

    // Other fields preserved
    expect(parsed.model).toBe("llama3");
    expect(parsed.messages).toEqual([{ role: "user", content: "Hello" }]);
  });

  test("Ollama: without response_format passes through unchanged", () => {
    const body = JSON.stringify({
      model: "llama3",
      messages: [{ role: "user", content: "Hello" }],
    });

    const result = translateRequestBody(body, "ollama");
    expect(result).toBe(body);
  });

  test("request with format field (not response_format) passes through for both", () => {
    const body = JSON.stringify({
      model: "llama3",
      messages: [{ role: "user", content: "Hello" }],
      format: {
        type: "object",
        properties: {
          answer: { type: "string" },
        },
      },
    });

    // OpenAI passes through
    const openaiResult = translateRequestBody(body, "openai");
    expect(openaiResult).toBe(body);

    // Ollama also passes through (no response_format to translate)
    const ollamaResult = translateRequestBody(body, "ollama");
    expect(ollamaResult).toBe(body);
  });

  test("invalid JSON body gracefully returns original", () => {
    const invalidBody = "{ invalid json }";

    // OpenAI passes through (no parsing attempted)
    const openaiResult = translateRequestBody(invalidBody, "openai");
    expect(openaiResult).toBe(invalidBody);

    // Ollama also returns original (catch block)
    const ollamaResult = translateRequestBody(invalidBody, "ollama");
    expect(ollamaResult).toBe(invalidBody);
  });
});
