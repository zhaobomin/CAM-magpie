import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onRequest } from "../src/hooks.ts";
import { fetchImages } from "../src/tool.ts";
import { materializeToolPayloads, PAYLOAD_PREFIX, redactPayloadsEverywhere } from "../src/payload.ts";
import { keyFor } from "../src/store.ts";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "magpie-cam-protocol-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

async function payload() {
  await onRequest({ input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "image" }, { type: "input_image", image_url: `data:image/png;base64,${PNG}` }] }], tools: [{ name: "cam_view_image" }] }, {
    protocol: "responses", path: "/responses", origin: "local", agent: "codex", session: "shared", options: { dataDir: root }, report() {},
  });
  return fetchImages({ ids: ["IMG-001"], session: keyFor("codex", "shared") }, { agent: "codex", abort: new AbortController().signal }, { dataDir: root, language: "en" });
}

describe("tool payload protocol adapters", () => {
  test("Chat Completions tool message becomes text and image_url parts", async () => {
    const result = materializeToolPayloads({ messages: [{ role: "tool", content: await payload() }] }, "chat", "codex", keyFor("codex", "shared"), root);
    expect(result.count).toBe(1);
    expect(result.body.messages[0].content[1].image_url.url).toContain("base64," + PNG);
  });

  test("Anthropic tool_result becomes text and native base64 image blocks", async () => {
    const result = materializeToolPayloads({ messages: [{ role: "user", content: [{ type: "tool_result", content: await payload() }] }] }, "anthropic", "codex", keyFor("codex", "shared"), root);
    expect(result.count).toBe(1);
    expect(result.body.messages[0].content[0].content[1].source.data).toBe(PNG);
  });

  test("Codex code-mode input_text output arrays are materialized", async () => {
    const result = materializeToolPayloads({ input: [{ type: "custom_tool_call_output", output: [{ type: "input_text", text: await payload() }] }] }, "responses", "codex", keyFor("codex", "shared"), root);
    expect(result.count).toBe(1);
    expect(result.body.input[0].output[1].type).toBe("input_image");
  });

  test("ordinary text output is untouched", () => {
    const original = { input: [{ type: "function_call_output", output: "plain result" }] };
    const result = materializeToolPayloads(original, "responses", "codex", keyFor("codex", "shared"), root);
    expect(result.count).toBe(0);
    expect(result.body).toEqual(original);
  });

  test("mixed tool-output parts cannot smuggle an encoded payload", async () => {
    const result = materializeToolPayloads({ input: [{ type: "custom_tool_call_output", output: [{ type: "input_text", text: "before" }, { type: "input_text", text: await payload() }] }] }, "responses", "codex", keyFor("codex", "shared"), root);
    expect(result.count).toBe(1);
    expect(JSON.stringify(result.body)).not.toContain(PAYLOAD_PREFIX);
    expect(JSON.stringify(result.body)).toContain("split or mixed");
  });

  test("a missing session redacts rather than forwards the payload", async () => {
    const value = await payload();
    const result = materializeToolPayloads({ input: [{ type: "function_call_output", output: value }] }, "responses", "codex", null, root);
    expect(result.count).toBe(1);
    expect(JSON.stringify(result.body)).not.toContain(PAYLOAD_PREFIX);
    expect(JSON.stringify(result.body)).toContain("payload removed");
  });

  test("last-resort error handling removes nested payloads", async () => {
    const value = await payload();
    const result = redactPayloadsEverywhere({ input: [{ output: value }, { text: "ordinary" }] });
    expect(result.count).toBe(1);
    expect(JSON.stringify(result.value)).not.toContain(PAYLOAD_PREFIX);
    expect(JSON.stringify(result.value)).toContain("processing error");
  });
});

describe("other history protocols", () => {
  test("Chat Completions omits an old image", async () => {
    const context = () => ({ protocol: "chat", path: "/v1/chat/completions", origin: "local", agent: "codex", session: "chat-history", options: { dataDir: root, language: "en" }, report() {} });
    const first = { messages: [{ role: "user", content: [{ type: "text", text: "one" }, { type: "image_url", image_url: { url: `data:image/png;base64,${PNG}` } }] }], tools: [{ name: "cam_view_image" }] };
    await onRequest(first, context());
    const second = structuredClone(first);
    second.messages.push({ role: "user", content: [{ type: "text", text: "two" }] });
    const next = await onRequest(second, context());
    expect(JSON.stringify(next)).not.toContain(PNG);
    expect(JSON.stringify(next)).toContain("IMG-001");
  });

  test("Anthropic Messages omits an old image", async () => {
    const context = () => ({ protocol: "anthropic", path: "/v1/messages", origin: "local", agent: "claude", session: "anthropic-history", options: { dataDir: root, language: "en" }, report() {} });
    const first = { messages: [{ role: "user", content: [{ type: "text", text: "one" }, { type: "image", source: { type: "base64", media_type: "image/png", data: PNG } }] }], tools: [{ name: "cam_view_image" }] };
    await onRequest(first, context());
    const second = structuredClone(first);
    second.messages.push({ role: "user", content: [{ type: "text", text: "two" }] });
    const next = await onRequest(second, context());
    expect(JSON.stringify(next)).not.toContain(PNG);
    expect(JSON.stringify(next)).toContain("IMG-001");
  });
});
