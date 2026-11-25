import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { writeLiveData } from "./live-data.ts";
import { resolveOptions } from "./options.ts";
import { getSession, imageForPanel, listSessions, savePolicy, sessionDetail } from "./store.ts";

const PANEL_DIR = join(import.meta.dirname, "..", "panel");
const PANEL_HTML = join(PANEL_DIR, "index.html");
const JSON_LIMIT = 64 * 1024;

function loopbackHost(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(`http://${value}`);
    if (url.username || url.password) return false;
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
  } catch { return false; }
}

function trustedRequest(req: IncomingMessage): boolean {
  if (!loopbackHost(req.headers.host)) return false;
  const origin = req.headers.origin;
  if (origin && origin !== "null" && !loopbackHost(new URL(origin).host)) return false;
  const site = req.headers["sec-fetch-site"];
  if (site !== "cross-site") return true;
  // Sandboxed native plugin frames have an opaque origin and may mark the
  // loopback service as cross-site. A missing Origin is not given that pass.
  return origin === "null" || (!!origin && loopbackHost(new URL(origin).host));
}

function send(res: ServerResponse, status: number, value: unknown, type = "application/json; charset=utf-8"): void {
  const body = Buffer.isBuffer(value) ? value : Buffer.from(type.startsWith("application/json") ? JSON.stringify(value) : String(value), "utf8");
  res.writeHead(status, {
    "content-type": type,
    "content-length": body.length,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; object-src 'none'; base-uri 'none'",
  });
  res.end(body);
}

async function jsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > JSON_LIMIT) throw new Error("request too large");
    chunks.push(chunk);
  }
  const value = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid JSON");
  return value;
}

export function createPanelServer(rawOptions: Record<string, unknown> = {}) {
  const options = resolveOptions(rawOptions);
  return createServer(async (req, res) => {
    try {
      if (!trustedRequest(req)) {
        send(res, 403, { error: "forbidden" });
        return;
      }
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        send(res, 200, readFileSync(PANEL_HTML, "utf8"), "text/html; charset=utf-8");
        return;
      }
      if (req.method === "GET" && (url.pathname === "/app.js" || url.pathname === "/live.js")) {
        send(res, 200, readFileSync(join(PANEL_DIR, url.pathname.slice(1)), "utf8"), "text/javascript; charset=utf-8");
        return;
      }
      const imageFile = /^\/images\/([0-9a-f-]+)\/(IMG-\d{3,}\.(?:png|jpg|gif|webp))$/.exec(url.pathname);
      if (req.method === "GET" && imageFile) {
        const mime = imageFile[2].endsWith(".jpg") ? "image/jpeg" : imageFile[2].endsWith(".gif") ? "image/gif" : imageFile[2].endsWith(".webp") ? "image/webp" : "image/png";
        send(res, 200, readFileSync(join(PANEL_DIR, "images", imageFile[1], imageFile[2])), mime);
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/health") {
        send(res, 200, { ok: true, service: "magpie-cam" });
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/sessions") {
        send(res, 200, { sessions: listSessions(options.dataDir) });
        return;
      }
      const match = /^\/api\/sessions\/([0-9a-f-]+)(?:\/(policy|images\/IMG-\d{3,}))?$/.exec(url.pathname);
      if (!match || !getSession(options.dataDir, match[1])) {
        send(res, 404, { error: "not found" });
        return;
      }
      const key = match[1];
      if (req.method === "GET" && !match[2]) {
        send(res, 200, sessionDetail(options.dataDir, key, options.auto, rawOptions));
        return;
      }
      if (req.method === "PUT" && match[2] === "policy") {
        const body = await jsonBody(req);
        const current = sessionDetail(options.dataDir, key, options.auto, rawOptions);
        const pinned = Array.isArray(body.pinnedContentIds) ? body.pinnedContentIds.map(String) : current?.policy.pinnedContentIds ?? [];
        const valid = new Set(current?.images.map((image) => image.contentId) ?? []);
        const policy = savePolicy(options.dataDir, key, {
          auto: typeof body.auto === "boolean" ? body.auto : current?.policy.auto ?? options.auto,
          pinnedContentIds: pinned.filter((id) => valid.has(id)),
          updatedAt: current?.policy.updatedAt,
          overridesLegacyNative: true,
        });
        try { writeLiveData(options.dataDir, true, options.auto); } catch { /* keep the API response */ }
        send(res, 200, { policy });
        return;
      }
      if (req.method === "GET" && match[2]?.startsWith("images/")) {
        const image = imageForPanel(options.dataDir, key, match[2].slice("images/".length));
        if (!image) send(res, 404, { error: "image unavailable" });
        else send(res, 200, { dataUrl: `data:${image.mime};base64,${image.data}` });
        return;
      }
      send(res, 405, { error: "method not allowed" });
    } catch (error) {
      send(res, 400, { error: error instanceof Error ? error.message : "bad request" });
    }
  });
}

export const PageService = async (_input: unknown, options: Record<string, unknown> = {}) => {
  const resolved = resolveOptions(options);
  writeLiveData(resolved.dataDir, true, resolved.auto);
  const server = createPanelServer(options);
  await new Promise<void>((resolve, reject) => {
    server.once("error", async (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") {
        try {
          const response = await fetch(`http://127.0.0.1:${resolved.panelPort}/api/health`, { signal: AbortSignal.timeout(1500) });
          const health = await response.json();
          // A plugin reload may leave the previous host's service alive for a
          // moment. Reuse only our own healthy service, never another app's port.
          if (health?.service === "magpie-cam") return resolve();
        } catch { /* another service, or one that is shutting down */ }
      }
      reject(error);
    });
    server.listen(resolved.panelPort, "127.0.0.1", resolve);
  });
  return {};
};
