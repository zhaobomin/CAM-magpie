import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { imageForPanel, listSessions, sessionDetail } from "./store.ts";

const PANEL_DIR = process.env.MAGPIE_CAM_PANEL_DIR ? resolve(process.env.MAGPIE_CAM_PANEL_DIR) : join(import.meta.dirname, "..", "panel");
const LIVE_FILE = join(PANEL_DIR, "live.js");
let lastWrite = 0;

function atomic(file: string, data: Buffer | string): void {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, data, { mode: 0o600 });
  renameSync(temporary, file);
}

function extension(mime: string): string {
  if (mime === "image/jpeg") return "jpg";
  if (mime === "image/gif") return "gif";
  if (mime === "image/webp") return "webp";
  return "png";
}

// Native Magpie pages can load their plugin's files but cannot fetch a service.
// Keep the durable state outside the package and publish only this transient view.
export function writeLiveData(root: string, force = false, automatic = true): void {
  const now = Date.now();
  if (!force && now - lastWrite < 1500) return;
  lastWrite = now;
  const sessions = listSessions(root).slice(0, 50);
  const details: Record<string, unknown> = {};
  for (const session of sessions) {
    const detail = sessionDetail(root, session.key, automatic);
    if (!detail) continue;
    details[session.key] = detail;
    for (const image of detail.images.slice(0, 200)) {
      if (!image.stored) continue;
      const file = join(PANEL_DIR, "images", session.key, `${image.id}.${extension(image.mime ?? "image/png")}`);
      if (existsSync(file)) continue;
      const original = imageForPanel(root, session.key, image.id);
      if (original) atomic(file, Buffer.from(original.data, "base64"));
    }
  }
  atomic(LIVE_FILE, `globalThis.__MAGPIE_CAM_LIVE__=${JSON.stringify({ at: new Date().toISOString(), sessions, details })};\n`);
}
