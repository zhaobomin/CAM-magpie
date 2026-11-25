import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { onRequest } from "../src/hooks.ts";
import { createPanelServer, PageService } from "../src/panel-service.ts";
import { getPolicyWithOptions, keyFor, recordSession } from "../src/store.ts";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
let root: string;
let server: ReturnType<typeof createPanelServer> | null = null;
let base = "";

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "magpie-cam-panel-"));
  await onRequest({ model: "test/model", input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }, { type: "input_image", image_url: `data:image/png;base64,${PNG}` }] }], tools: [{ name: "cam_view_image" }] }, {
    protocol: "responses", path: "/responses", origin: "local", agent: "codex", session: "panel-thread", options: { dataDir: root }, report() {},
  });
  server = createPanelServer({ dataDir: root, sessionPolicies: nativePolicies });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
  rmSync(root, { recursive: true, force: true });
});

const panelKey = keyFor("codex", "panel-thread");
const nativePolicies: Record<string, { auto: boolean; updatedAt?: string }> = {};

describe("panel service", () => {
  test("web reads a native policy and its next save becomes effective", async () => {
    nativePolicies[panelKey] = { auto: false };
    try {
      const url = `${base}/api/sessions/${panelKey}`;
      expect((await (await fetch(url)).json()).policy.auto).toBeFalse();
      const saved = await fetch(`${url}/policy`, { method: "PUT", body: JSON.stringify({ auto: true }) });
      expect(saved.status).toBe(200);
      expect((await (await fetch(url)).json()).policy.auto).toBeTrue();
      expect(getPolicyWithOptions(root, panelKey, true, { sessionPolicies: nativePolicies }).auto).toBeTrue();
      nativePolicies[panelKey] = { auto: false, updatedAt: new Date(Date.now() + 1000).toISOString() };
      expect((await (await fetch(url)).json()).policy.auto).toBeFalse();
    } finally {
      delete nativePolicies[panelKey];
    }
  });

  test("serves the page, session detail, image and policy", async () => {
    const page = await fetch(base + "/");
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("上下文附件");
    const sessions = await (await fetch(base + "/api/sessions")).json();
    expect(sessions.sessions).toHaveLength(1);
    const key = sessions.sessions[0].key;
    const detail = await (await fetch(base + "/api/sessions/" + key)).json();
    expect(detail.images).toHaveLength(1);
    expect(detail.images[0].id).toBe("IMG-001");
    const changed = await fetch(base + `/api/sessions/${key}/policy`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ auto: false, pinnedContentIds: [detail.images[0].contentId, "not-a-digest"] }) });
    expect(changed.status).toBe(200);
    const updated = await (await fetch(base + "/api/sessions/" + key)).json();
    expect(updated.policy.auto).toBeFalse();
    expect(updated.policy.pinnedContentIds).toEqual([detail.images[0].contentId]);
    const image = await (await fetch(base + `/api/sessions/${key}/images/IMG-001`)).json();
    expect(image.dataUrl).toBe(`data:image/png;base64,${PNG}`);
  });

  test("returns complete UTF-8 JSON for Chinese session titles", async () => {
    const first = await (await fetch(base + "/api/sessions")).json();
    const info = first.sessions[0];
    recordSession(root, { ...info, title: "中文会话标题" });
    const response = await fetch(base + "/api/sessions");
    const data = await response.json();
    expect(data.sessions[0].title).toBe("中文会话标题");
    expect(Number(response.headers.get("content-length"))).toBe(Buffer.byteLength(JSON.stringify(data)));
  });

  test("reuses an existing healthy service during plugin reload", async () => {
    const port = (server!.address() as AddressInfo).port;
    await expect(PageService({}, { dataDir: root, panelPort: port })).resolves.toEqual({});
  });

  test("publishes native live data and static thumbnails", async () => {
    const sessions = await (await fetch(base + "/api/sessions")).json();
    const key = sessions.sessions[0].key;
    const dir = process.env.MAGPIE_CAM_PANEL_DIR!;
    expect(existsSync(join(dir, "live.js"))).toBeTrue();
    expect(readFileSync(join(dir, "live.js"), "utf8")).toContain(key);
    expect(existsSync(join(dir, "images", key, "IMG-001.png"))).toBeTrue();
    const app = await fetch(base + "/app.js");
    expect(app.status).toBe(200);
    expect(await app.text()).toContain("staticMode");
  });

  test("rejects DNS-rebinding hosts and cross-site browser requests", async () => {
    const sessions = await (await fetch(base + "/api/sessions")).json();
    const key = sessions.sessions[0].key;
    const response = await fetch(base + `/api/sessions/${key}/images/IMG-001`, { headers: { host: "evil.example", origin: "https://evil.example", "sec-fetch-site": "cross-site" } });
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain("base64,");
  });

  test("does not expose another session's image", async () => {
    const response = await fetch(base + "/api/sessions/00000000000000000000000000000000/images/IMG-001");
    expect(response.status).toBe(404);
  });
});
