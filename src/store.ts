import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { openRequestIndex, seenImage } from "../vendor/cam/core/request-index.ts";
import { SESSION_KEY, sessionKeyOf } from "../vendor/cam/core/selection.ts";
import { sessionTitle } from "./session-titles.ts";

export type SessionPolicy = { auto: boolean; pinnedContentIds: string[]; updatedAt?: string; overridesLegacyNative?: boolean };
export type SessionInfo = {
  key: string;
  platform: string;
  named: string;
  protocol: string;
  model: string;
  title?: string;
  firstSeen: string;
  lastSeen: string;
};

const DIGEST = /^[0-9a-f]{64}$/;
const JSON_ID = /^[A-Za-z0-9_-]{1,128}$/;

function atomicJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
  renameSync(temporary, file);
}

function readJson<T>(file: string, fallback: T): T {
  try { return JSON.parse(readFileSync(file, "utf8")) as T; } catch { return fallback; }
}

export function keyFor(platform: string, named: string): string {
  return sessionKeyOf(`${platform}\n${named}`);
}

const policyFile = (root: string, key: string) => join(root, "policies", `${key}.json`);
const sessionFile = (root: string, key: string) => join(root, "sessions", `${key}.json`);

export function getPolicy(root: string, key: string, automatic = true): SessionPolicy {
  if (!SESSION_KEY.test(key)) return { auto: automatic, pinnedContentIds: [] };
  const value = readJson<Partial<SessionPolicy>>(policyFile(root, key), {});
  return {
    auto: typeof value.auto === "boolean" ? value.auto : automatic,
    pinnedContentIds: Array.isArray(value.pinnedContentIds) ? [...new Set(value.pinnedContentIds.filter((id) => typeof id === "string" && DIGEST.test(id)))] : [],
    ...(typeof value.updatedAt === "string" ? { updatedAt: value.updatedAt } : {}),
    ...(value.overridesLegacyNative === true ? { overridesLegacyNative: true } : {}),
  };
}

export function getPolicyWithOptions(root: string, key: string, automatic = true, options?: Record<string, unknown>): SessionPolicy {
  const base = getPolicy(root, key, automatic);
  const table = options?.sessionPolicies;
  const candidate = table && typeof table === "object" && !Array.isArray(table) ? (table as Record<string, any>)[key] : null;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return base;
  const nativeTime = typeof candidate.updatedAt === "string" ? Date.parse(candidate.updatedAt) : NaN;
  const fileTime = Date.parse(base.updatedAt ?? "");
  if (Number.isFinite(nativeTime) ? fileTime >= nativeTime : base.overridesLegacyNative) return base;
  return {
    auto: typeof candidate.auto === "boolean" ? candidate.auto : base.auto,
    pinnedContentIds: Array.isArray(candidate.pinnedContentIds) ? [...new Set(candidate.pinnedContentIds.filter((id: unknown) => typeof id === "string" && DIGEST.test(id)))] : base.pinnedContentIds,
    ...(Number.isFinite(nativeTime) ? { updatedAt: candidate.updatedAt } : {}),
  };
}

export function savePolicy(root: string, key: string, policy: SessionPolicy): SessionPolicy {
  if (!SESSION_KEY.test(key)) throw new Error("invalid session");
  const previous = Date.parse(policy.updatedAt ?? "") || 0;
  const next = {
    auto: policy.auto !== false,
    pinnedContentIds: [...new Set(policy.pinnedContentIds.filter((id) => DIGEST.test(id)))],
    updatedAt: new Date(Math.max(Date.now(), previous + 1)).toISOString(),
    ...(policy.overridesLegacyNative ? { overridesLegacyNative: true } : {}),
  };
  atomicJson(policyFile(root, key), next);
  return next;
}

export function recordSession(root: string, value: Omit<SessionInfo, "firstSeen" | "lastSeen"> & { at?: string; titleSource?: "index" | "query" | null }): void {
  if (!SESSION_KEY.test(value.key) || !JSON_ID.test(value.platform)) return;
  const file = sessionFile(root, value.key);
  const earlier = readJson<Partial<SessionInfo>>(file, {});
  const now = value.at ?? new Date().toISOString();
  const { at: _at, titleSource, ...info } = value;
  const title = titleSource === "index" ? value.title : earlier.title ?? value.title;
  atomicJson(file, { ...info, ...(title ? { title } : {}), firstSeen: earlier.firstSeen ?? now, lastSeen: now });
}

export function listSessions(root: string): SessionInfo[] {
  const dir = join(root, "sessions");
  try {
    return readdirSync(dir).filter((name) => /^[0-9a-f]{32}\.json$|^[0-9a-f-]{36}\.json$/.test(name))
      .map((name) => readJson<SessionInfo | null>(join(dir, name), null))
      .filter((value): value is SessionInfo => !!value && SESSION_KEY.test(value.key) && JSON_ID.test(value.platform))
      .map((value) => {
        const original = sessionTitle(value.platform, value.named).title;
        return original ? { ...value, title: original } : value;
      })
      .sort((a, b) => b.lastSeen.localeCompare(a.lastSeen)).slice(0, 100);
  } catch { return []; }
}

export function getSession(root: string, key: string): SessionInfo | null {
  if (!SESSION_KEY.test(key)) return null;
  const value = readJson<SessionInfo | null>(sessionFile(root, key), null);
  if (!value || value.key !== key || !JSON_ID.test(value.platform)) return null;
  const original = sessionTitle(value.platform, value.named).title;
  return original ? { ...value, title: original } : value;
}

export function sessionDetail(root: string, key: string, automatic = true, options?: Record<string, unknown>) {
  const session = getSession(root, key);
  if (!session) return null;
  const policy = getPolicyWithOptions(root, key, automatic, options);
  const pinned = new Set(policy.pinnedContentIds);
  const index = openRequestIndex(session.platform, key, root);
  const images = [...index.images.entries()].map(([contentId, seen]) => {
    let storedChars = 0;
    try { storedChars = statSync(join(root, "platforms", session.platform, "images", contentId)).size; } catch { /* gone */ }
    return { contentId, ...seen, pinned: pinned.has(contentId), stored: storedChars > 0 };
  }).sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
  return { session, policy, images };
}

export function imageForPanel(root: string, key: string, id: string): { mime: string; data: string } | null {
  const session = getSession(root, key);
  if (!session || !/^IMG-\d{3,}$/.test(id)) return null;
  const index = openRequestIndex(session.platform, key, root);
  const found = seenImage(index, id, root);
  if (!found?.data) return null;
  return { mime: found.seen.mime ?? "image/png", data: found.data };
}
