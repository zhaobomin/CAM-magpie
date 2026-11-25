import { openRequestIndex, seenImage } from "../vendor/cam/core/request-index.ts";
import { SESSION_KEY } from "../vendor/cam/core/selection.ts";
import { fetchedLabel } from "../vendor/cam/core/words.ts";
import { resolveOptions } from "./options.ts";
import { encodePayload, type PayloadContent } from "./payload.ts";
import { getPolicyWithOptions, getSession } from "./store.ts";

export type ToolArgs = { ids?: unknown; session?: unknown };
export type ToolContext = { agent?: string; abort: AbortSignal };

function platformName(value: unknown): string {
  const cleaned = String(value || "other").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);
  return /^[a-z][a-z0-9-]{1,31}$/.test(cleaned) ? cleaned : "other";
}

export async function fetchImages(args: ToolArgs, ctx: ToolContext, rawOptions: Record<string, unknown> = {}): Promise<string> {
  const options = resolveOptions(rawOptions);
  const platform = platformName(ctx.agent);
  const session = typeof args.session === "string" ? args.session.trim() : "";
  const english = options.language === "en";
  if (!SESSION_KEY.test(session)) return english ? "Pass the session value shown beside the omitted image, for example session=\"0123456789abcdef0123456789abcdef\". Magpie does not expose the calling session to tools, so this explicit value prevents cross-conversation fetches." : "请传入占位符旁的 session 值。Magpie 不会把调用会话传给工具，这个显式值用于防止跨会话取图。";
  const info = getSession(options.dataDir, session);
  if (!info || info.platform !== platform) return english ? "This attachment session is unavailable for the calling agent. Use the session value from this conversation's own placeholder." : "当前 agent 无法使用这个附件会话，请传入本会话占位符中显示的 session 值。";
  const policy = getPolicyWithOptions(options.dataDir, session, options.auto, rawOptions);
  if (!policy.auto) return english ? "Automatic attachment selection is off. Enable it in Magpie → Attachments, or send the original image again." : "自动附件管理已暂停。可在 Magpie 的“上下文附件”页面重新开启，或重新发送原图。";
  const ids = Array.isArray(args.ids) ? [...new Set(args.ids.map(String).map((id) => id.trim().toUpperCase()).filter(Boolean))] : [];
  if (!ids.length) return english ? "Pass one or more image ids, for example [\"IMG-001\"]." : "请传入至少一个图片编号，例如 [\"IMG-001\"]。";
  if (ids.length > options.maxFetchImages) return english ? `Fetch at most ${options.maxFetchImages} images at once.` : `每次最多取回 ${options.maxFetchImages} 张图片。`;
  const index = openRequestIndex(platform, session, options.dataDir);
  const content: PayloadContent[] = [];
  let found = 0;
  let bytes = 0;
  for (const id of ids) {
    if (!/^IMG-\d{3,}$/.test(id)) {
      content.push({ type: "text", text: english ? `${id}: invalid image id.` : `${id}：图片编号无效。` });
      continue;
    }
    const image = seenImage(index, id, options.dataDir);
    if (!image) {
      content.push({ type: "text", text: english ? `${id} is not in this conversation.` : `${id} 不在当前会话中。` });
      continue;
    }
    if (!image.data) {
      content.push({ type: "text", text: english ? `${id} is no longer available locally; upload it again.` : `${id} 的原图已不在本地，请重新上传。` });
      continue;
    }
    bytes += image.data.length;
    if (bytes > options.maxFetchBytes) {
      content.push({ type: "text", text: english ? `${id} exceeds the fetch size budget; request fewer images.` : `${id} 超出本次取图大小限制，请减少一次取回的图片数量。` });
      continue;
    }
    content.push(
      { type: "text", text: fetchedLabel({ id, name: null, label: null, kind: image.seen.kind, turn: image.seen.turn, width: image.seen.width, height: image.seen.height }, options.language) },
      { type: "image", id, data: image.data, mimeType: image.seen.mime ?? "image/png" },
    );
    found++;
  }
  if (!found) return content.map((part) => part.type === "text" ? part.text : "").filter(Boolean).join("\n");
  // Magpie's tool transport is text-only. The request hook validates this
  // payload against the session index and materializes it on the next turn.
  return encodePayload(content);
}
