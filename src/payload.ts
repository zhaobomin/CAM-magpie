import { createHash } from "node:crypto";
import { openRequestIndex } from "../vendor/cam/core/request-index.ts";

export const PAYLOAD_PREFIX = "MAGPIE_CAM_IMAGE_PAYLOAD_V1:";
const MAX_PAYLOAD_CHARS = 32 * 1024 * 1024;

type TextContent = { type: "text"; text: string };
type ImageContent = { type: "image"; id: string; data: string; mimeType: string };
export type PayloadContent = TextContent | ImageContent;
type Payload = { version: 1; content: PayloadContent[] };

const text = (value: unknown): value is TextContent => !!value && typeof value === "object" && (value as PayloadContent).type === "text" && typeof (value as TextContent).text === "string" && (value as TextContent).text.length <= 16_384;
const image = (value: unknown): value is ImageContent => !!value && typeof value === "object" && (value as PayloadContent).type === "image"
  && /^IMG-\d{3,}$/.test(String((value as ImageContent).id)) && /^image\/[a-z0-9.+-]+$/i.test(String((value as ImageContent).mimeType))
  && typeof (value as ImageContent).data === "string" && (value as ImageContent).data.length > 0 && (value as ImageContent).data.length <= MAX_PAYLOAD_CHARS;

export function encodePayload(content: PayloadContent[]): string {
  return PAYLOAD_PREFIX + JSON.stringify({ version: 1, content });
}

function decode(value: string): Payload | null {
  if (!value.startsWith(PAYLOAD_PREFIX) || value.length > MAX_PAYLOAD_CHARS + PAYLOAD_PREFIX.length + 1024) return null;
  try {
    const parsed = JSON.parse(value.slice(PAYLOAD_PREFIX.length));
    if (parsed?.version !== 1 || !Array.isArray(parsed.content) || parsed.content.length > 17) return null;
    if (!parsed.content.every((part: unknown) => text(part) || image(part))) return null;
    return parsed;
  } catch { return null; }
}

// A payload is accepted only when every image still belongs to this session and
// its bytes hash to the content id recorded when the original request was seen.
function trusted(payload: Payload, platform: string, session: string, root: string): Payload | null {
  try {
    const index = openRequestIndex(platform, session, root);
    for (const part of payload.content) {
      if (part.type !== "image") continue;
      const match = [...index.images.entries()].find(([contentId, seen]) => seen.id === part.id && createHash("sha256").update(part.data).digest("hex") === contentId);
      if (!match || (match[1].mime && match[1].mime !== part.mimeType)) return null;
    }
    return payload;
  } catch { return null; }
}

function materialized(value: unknown, platform: string, session: string | null, root: string): PayloadContent[] | null {
  if (typeof value !== "string" || !session) return null;
  const payload = decode(value);
  return payload ? trusted(payload, platform, session, root)?.content ?? null : null;
}

function responsesParts(content: PayloadContent[]) {
  return content.map((part) => part.type === "text" ? { type: "input_text", text: part.text } : { type: "input_image", image_url: `data:${part.mimeType};base64,${part.data}` });
}

function chatParts(content: PayloadContent[]) {
  return content.map((part) => part.type === "text" ? { type: "text", text: part.text } : { type: "image_url", image_url: { url: `data:${part.mimeType};base64,${part.data}` } });
}

function anthropicParts(content: PayloadContent[]) {
  return content.map((part) => part.type === "text" ? { type: "text", text: part.text } : { type: "image", source: { type: "base64", media_type: part.mimeType, data: part.data } });
}

export function annotateFetchText(text: string, session: string, toolName: string): string {
  if (!text.includes("cam_view_image")) return text;
  const instruction = text.replaceAll("cam_view_image", () => toolName);
  return /IMG-\d{3,}/.test(instruction)
    ? `${instruction}\n[Magpie CAM session: ${session}] Pass this session value when calling ${toolName}.`
    : instruction;
}

export function redactPayloadsEverywhere(value: unknown): { value: any; count: number } {
  let count = 0;
  const visit = (input: unknown): any => {
    if (typeof input === "string") {
      if (!input.startsWith(PAYLOAD_PREFIX)) return input;
      count++;
      return "[Magpie CAM: image payload dropped after a processing error]";
    }
    if (Array.isArray(input)) return input.map(visit);
    if (input && typeof input === "object") return Object.fromEntries(Object.entries(input).map(([key, child]) => [key, visit(child)]));
    return input;
  };
  return { value: visit(value), count };
}

export type MaterializeResult = { body: Record<string, any>; count: number };

// Only tool-output positions are inspected. A user message containing the same
// prefix can never manufacture an image or enter the fetched-copy path.
export function materializeToolPayloads(original: Record<string, any>, protocol: string, platform: string, session: string | null, root: string): MaterializeResult {
  let count = 0;
  const body = structuredClone(original);
  const convert = (holder: Record<string, any>, key: string, parts: (content: PayloadContent[]) => unknown) => {
    const original = holder[key];
    const raw = typeof original === "string" ? original : Array.isArray(original) && original.length === 1 && ["text", "input_text", "output_text"].includes(original[0]?.type) && typeof original[0]?.text === "string" ? original[0].text : null;
    if (!raw?.startsWith(PAYLOAD_PREFIX)) {
      const split = Array.isArray(original) && original.some((part) => typeof part?.text === "string" && part.text.startsWith(PAYLOAD_PREFIX));
      if (split) {
        holder[key] = parts([{ type: "text", text: "[Magpie CAM: split or mixed image payload removed]" }]);
        count++;
      }
      return;
    }
    const content = materialized(raw, platform, session, root) ?? [{ type: "text" as const, text: "[Magpie CAM: unavailable or untrusted image payload removed]" }];
    // Never forward an encoded payload as prompt text, even when validation
    // fails or the client supplied no stable session identity.
    holder[key] = parts(content);
    count++;
  };
  if (protocol === "responses" && Array.isArray(body.input)) {
    for (const item of body.input) {
      if (!item || !["function_call_output", "custom_tool_call_output"].includes(item.type)) continue;
      convert(item, "output", responsesParts);
    }
  } else if (protocol === "chat" && Array.isArray(body.messages)) {
    for (const message of body.messages) if (message?.role === "tool") convert(message, "content", chatParts);
  } else if (protocol === "anthropic" && Array.isArray(body.messages)) {
    for (const message of body.messages) {
      if (!Array.isArray(message?.content)) continue;
      for (const block of message.content) if (block?.type === "tool_result") convert(block, "content", anthropicParts);
    }
  }
  return { body, count };
}
