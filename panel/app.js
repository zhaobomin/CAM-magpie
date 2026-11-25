const $ = (id) => document.getElementById(id);
let current = null;
let saving = false;
let observer = null;
let detailSequence = 0;
let serviceBase = "";
let staticMode = true;
let live = { sessions: [], details: {} };
let pluginOptions = {};

function toast(message, error = false) {
  const el = $("toast");
  el.textContent = message;
  el.className = "toast show" + (error ? " error" : "");
  clearTimeout(el.timer);
  el.timer = setTimeout(() => (el.className = "toast"), 2600);
}

function fallbackAfter(promise, ms, fallback) {
  return Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(fallback), ms))]);
}

async function api(path, options) {
  const response = await fetch(serviceBase.replace(/\/$/, "") + path, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "请求失败");
  return data;
}

function loadLive() {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    const timer = setTimeout(() => { script.remove(); reject(new Error("live.js 加载超时")); }, 5000);
    script.src = "live.js?" + Date.now();
    script.onload = () => {
      clearTimeout(timer);
      live = globalThis.__MAGPIE_CAM_LIVE__ || { sessions: [], details: {} };
      script.remove();
      resolve();
    };
    script.onerror = () => { clearTimeout(timer); script.remove(); reject(new Error("live.js 加载失败")); };
    document.head.append(script);
  });
}

function effectivePolicy(key, options = pluginOptions) {
  const base = live.details[key]?.policy || { auto: options.auto !== false, pinnedContentIds: [] };
  const override = options.sessionPolicies?.[key];
  if (!override) return base;
  const nativeTime = Date.parse(override.updatedAt);
  if (Number.isFinite(nativeTime) ? Date.parse(base.updatedAt) >= nativeTime : base.overridesLegacyNative) return base;
  return {
    auto: typeof override?.auto === "boolean" ? override.auto : base.auto,
    pinnedContentIds: Array.isArray(override?.pinnedContentIds) ? override.pinnedContentIds : base.pinnedContentIds,
    updatedAt: override.updatedAt,
  };
}

function date(value) {
  try { return new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value)); }
  catch { return ""; }
}

async function loadSessions(select) {
  try {
    const sessions = staticMode ? (await loadLive(), live.sessions) : (await api("/api/sessions")).sessions;
    const root = $("sessions");
    root.replaceChildren();
    if (!sessions.length) {
      const p = document.createElement("p");
      p.className = "rail-note";
      p.textContent = "还没有附件会话";
      root.append(p);
      renderEmpty("等待第一次请求", "Magpie 处理带附件的对话后，会在这里建立索引。");
      return;
    }
    for (const item of sessions) {
      const button = document.createElement("button");
      button.className = "session" + (item.key === select ? " active" : "");
      button.dataset.key = item.key;
      const strong = document.createElement("strong");
      strong.textContent = item.title || item.platform + " · " + item.key.slice(0, 8);
      const small = document.createElement("small");
      small.textContent = item.platform + " · " + date(item.lastSeen);
      button.append(strong, small);
      button.onclick = () => loadDetail(item.key);
      root.append(button);
    }
    const wanted = select || location.hash.slice(1) || sessions[0].key;
    await loadDetail(sessions.some((item) => item.key === wanted) ? wanted : sessions[0].key);
  } catch (error) {
    renderEmpty("无法读取会话", error.message);
  }
}

function gridEmpty(title, note) {
  const grid = $("grid");
  grid.replaceChildren();
  const empty = document.createElement("div");
  empty.className = "empty";
  const strong = document.createElement("strong");
  strong.textContent = title;
  empty.append(strong, document.createTextNode(note));
  grid.append(empty);
}

function renderEmpty(title, note) {
  current = null;
  $("count").textContent = "0";
  $("pinned").textContent = "0";
  $("session-name").textContent = "—";
  $("auto").checked = false;
  $("auto").disabled = true;
  gridEmpty(title, note);
}

async function loadDetail(key) {
  const sequence = ++detailSequence;
  try {
    const detail = staticMode ? live.details[key] : await api("/api/sessions/" + key);
    if (sequence !== detailSequence) return;
    if (!detail) throw new Error("会话不存在");
    current = { ...detail, policy: staticMode ? effectivePolicy(key) : detail.policy };
    location.hash = key;
    document.querySelectorAll(".session").forEach((el) => el.classList.toggle("active", el.dataset.key === key));
    renderDetail();
  } catch (error) {
    if (sequence === detailSequence) renderEmpty("会话不可用", error.message);
  }
}

function renderDetail() {
  if (!current) return;
  const { session, policy, images } = current;
  $("count").textContent = images.length;
  $("pinned").textContent = policy.pinnedContentIds.length;
  $("session-name").textContent = session.title || session.platform + " · " + session.key.slice(0, 8);
  $("auto").checked = policy.auto;
  $("auto").disabled = false;
  const grid = $("grid");
  grid.replaceChildren();
  observer?.disconnect();
  observer = new IntersectionObserver((entries) => {
    for (const entry of entries) if (entry.isIntersecting) {
      loadThumb(entry.target);
      observer.unobserve(entry.target);
    }
  }, { rootMargin: "150px" });
  if (!images.length) {
    gridEmpty("这个会话还没有附件", "发送图片后，附件会自动出现在这里。");
    return;
  }
  for (const image of images) {
    const card = document.createElement("article");
    card.className = "card";
    const thumb = document.createElement("div");
    thumb.className = "thumb";
    thumb.textContent = image.stored ? "等待载入" : "原图未缓存";
    thumb.dataset.image = image.id;
    thumb.dataset.session = session.key;
    const body = document.createElement("div");
    body.className = "card-body";
    const id = document.createElement("div");
    id.className = "id";
    id.textContent = image.id;
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = [image.kind, "第 " + image.turn + " 轮", image.width && image.height ? image.width + " × " + image.height : ""].filter(Boolean).join(" · ");
    const pin = document.createElement("button");
    pin.className = "pin";
    pin.dataset.content = image.contentId;
    const pinned = policy.pinnedContentIds.includes(image.contentId);
    pin.setAttribute("aria-pressed", String(pinned));
    pin.textContent = pinned ? "已固定 · 点击取消" : "固定随请求发送";
    pin.onclick = () => togglePin(image.contentId);
    body.append(id, meta, pin);
    card.append(thumb, body);
    grid.append(card);
    if (image.stored) observer.observe(thumb);
  }
}

function loadThumb(el) {
  const img = document.createElement("img");
  img.alt = el.dataset.image;
  img.onerror = () => { el.textContent = "缩略图不可用"; };
  if (staticMode) {
    const image = current?.images.find((item) => item.id === el.dataset.image);
    const extension = image?.mime === "image/jpeg" ? "jpg" : image?.mime === "image/gif" ? "gif" : image?.mime === "image/webp" ? "webp" : "png";
    img.src = `images/${el.dataset.session}/${el.dataset.image}.${extension}`;
    el.replaceChildren(img);
    return;
  }
  api(`/api/sessions/${el.dataset.session}/images/${el.dataset.image}`).then(({ dataUrl }) => {
    img.src = dataUrl;
    el.replaceChildren(img);
  }).catch(() => { el.textContent = "缩略图不可用"; });
}

async function save(patch) {
  if (!current) return;
  if (saving) {
    renderDetail();
    toast("上一项选择仍在保存，请稍候", true);
    return;
  }
  const key = current.session.key;
  saving = true;
  $("auto").disabled = true;
  document.querySelectorAll(".pin").forEach((button) => (button.disabled = true));
  try {
    let policy;
    if (staticMode) {
      const [latest] = await Promise.all([magpie.options.get(), loadLive()]);
      const previous = effectivePolicy(key, latest);
      const next = {
        auto: previous.auto,
        pinnedContentIds: previous.pinnedContentIds,
        ...patch,
        updatedAt: new Date(Math.max(Date.now(), (Date.parse(previous.updatedAt) || 0) + 1)).toISOString(),
      };
      const sessionPolicies = { ...(latest.sessionPolicies || {}), [key]: next };
      const saved = await magpie.options.set({ ...latest, sessionPolicies });
      pluginOptions = saved || { ...latest, sessionPolicies };
      policy = next;
    } else {
      policy = (await api("/api/sessions/" + key + "/policy", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      })).policy;
    }
    if (!current || current.session.key !== key) return;
    current.policy = policy;
    renderDetail();
    toast("选择已保存，下一次请求生效");
  } catch (error) {
    if (current?.session.key === key) renderDetail();
    toast(error.message, true);
  } finally {
    saving = false;
    if (current?.session.key === key) {
      $("auto").disabled = false;
      document.querySelectorAll(".pin").forEach((button) => (button.disabled = false));
    }
  }
}

function togglePin(contentId) {
  const pinned = new Set(current.policy.pinnedContentIds);
  pinned.has(contentId) ? pinned.delete(contentId) : pinned.add(contentId);
  save({ pinnedContentIds: [...pinned] });
}

$("auto").onchange = (event) => save({ auto: event.target.checked });
$("refresh").onclick = () => loadSessions(current?.session.key);
magpie.ready.then(async () => {
  staticMode = !magpie.service;
  serviceBase = magpie.service;
  if (staticMode) pluginOptions = await fallbackAfter(magpie.options.get(), 3000, {});
  await loadSessions();
}).catch((error) => renderEmpty("Magpie 页面连接失败", String(error)));
