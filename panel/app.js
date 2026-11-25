const $ = (id) => document.getElementById(id);
let current = null;
let saving = false;
let observer = null;
let detailSequence = 0;
let live = { sessions: [], details: {} };

function toast(message, error = false) {
  const el = $("toast");
  el.textContent = message;
  el.className = "toast show" + (error ? " error" : "");
  clearTimeout(el.timer);
  el.timer = setTimeout(() => (el.className = "toast"), 2600);
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
    script.onerror = () => {
      clearTimeout(timer);
      script.remove();
      if (!live.sessions.length) resolve();
      else reject(new Error("live.js 加载失败"));
    };
    document.head.append(script);
  });
}

function effectivePolicy(detail, options) {
  const legacy = detail.legacyPolicy || { pinnedContentIds: [] };
  const base = { ...legacy, auto: typeof legacy.auto === "boolean" ? legacy.auto : options.auto !== false };
  const override = options.sessionPolicies?.[detail.session.key];
  if (!override || typeof override !== "object" || Array.isArray(override)) return base;
  const nativeTime = typeof override.updatedAt === "string" ? Date.parse(override.updatedAt) : NaN;
  if (override.version !== 2 && (Number.isFinite(nativeTime) ? Date.parse(base.updatedAt) >= nativeTime : base.overridesLegacyNative)) return base;
  return {
    auto: typeof override.auto === "boolean" ? override.auto : base.auto,
    pinnedContentIds: Array.isArray(override.pinnedContentIds)
      ? [...new Set(override.pinnedContentIds.filter((id) => typeof id === "string" && /^[0-9a-f]{64}$/.test(id)))]
      : base.pinnedContentIds,
  };
}

async function readHostOptions() {
  let timer;
  try {
    const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(null), 3000); });
    const options = await Promise.race([magpie.options.get(), timeout]);
    return options && typeof options === "object" && !Array.isArray(options) ? options : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function date(value) {
  try { return new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value)); }
  catch { return ""; }
}

async function loadSessions(select) {
  try {
    await loadLive();
    const sessions = live.sessions;
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
      button.onclick = () => openSession(item.key);
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
  $("auto").indeterminate = false;
  $("auto").disabled = true;
  $("auto-help").textContent = "关闭后保留历史原图。新附件仍会被索引。";
  gridEmpty(title, note);
}

async function loadDetail(key) {
  const sequence = ++detailSequence;
  try {
    const detail = live.details[key];
    const options = await readHostOptions();
    if (sequence !== detailSequence) return;
    if (!detail) throw new Error("会话不存在");
    current = { ...detail, policy: options ? effectivePolicy(detail, options) : null, agentPaused: options?.agentAuto?.[detail.session.platform] === false };
    location.hash = key;
    document.querySelectorAll(".session").forEach((el) => el.classList.toggle("active", el.dataset.key === key));
    renderDetail();
  } catch (error) {
    if (sequence === detailSequence) renderEmpty("会话不可用", error.message);
  }
}

function renderDetail() {
  if (!current) return;
  const { session, policy, images, agentPaused } = current;
  $("count").textContent = images.length;
  $("pinned").textContent = policy?.pinnedContentIds.length ?? "—";
  $("session-name").textContent = session.title || session.platform + " · " + session.key.slice(0, 8);
  $("auto").checked = !agentPaused && (policy?.auto ?? false);
  $("auto").indeterminate = !policy;
  $("auto").disabled = !policy || saving || agentPaused;
  $("auto-help").textContent = agentPaused ? "此 Agent 已在插件设置中暂停自动省略。" : policy ? "关闭后保留历史原图。新附件仍会被索引。" : "无法读取 Magpie 策略，刷新后可重试。";
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
    const showThumb = image.stored && image.thumbnail !== null;
    thumb.textContent = showThumb ? "等待载入" : image.stored ? "暂无缩略图" : "原图未缓存";
    thumb.dataset.image = image.id;
    thumb.dataset.session = session.key;
    if (image.thumbnail) thumb.dataset.thumbnail = image.thumbnail;
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
    const pinned = policy?.pinnedContentIds.includes(image.contentId);
    pin.disabled = !policy || saving;
    if (policy) pin.setAttribute("aria-pressed", String(pinned));
    pin.textContent = !policy ? "策略暂不可用" : pinned ? "已固定 · 点击取消" : "固定随请求发送";
    pin.onclick = () => togglePin(image.contentId);
    body.append(id, meta, pin);
    card.append(thumb, body);
    grid.append(card);
    if (showThumb) observer.observe(thumb);
  }
}

function loadThumb(el) {
  const img = document.createElement("img");
  img.alt = el.dataset.image;
  img.onerror = () => { el.textContent = "缩略图不可用"; };
  const image = current?.images.find((item) => item.id === el.dataset.image);
  const extension = image?.mime === "image/jpeg" ? "jpg" : image?.mime === "image/gif" ? "gif" : image?.mime === "image/webp" ? "webp" : "png";
  img.src = el.dataset.thumbnail || `images/${el.dataset.session}/${el.dataset.image}.${extension}`;
  el.replaceChildren(img);
}

async function save(change) {
  if (!current?.policy) return;
  if (saving) {
    renderDetail();
    toast("上一项选择仍在保存，请稍候", true);
    return;
  }
  const detail = current;
  const key = detail.session.key;
  saving = true;
  $("auto").disabled = true;
  document.querySelectorAll(".pin").forEach((button) => (button.disabled = true));
  try {
    const latest = await readHostOptions();
    if (!latest) {
      if (current?.session.key === key) current.policy = null;
      throw new Error("无法读取 Magpie 策略，刷新后可重试。");
    }
    const next = { ...change(effectivePolicy(detail, latest)), version: 2 };
    const sessionPolicies = { ...(latest.sessionPolicies || {}), [key]: next };
    const saved = await magpie.options.set({ ...latest, sessionPolicies });
    if (!current || current.session.key !== key) return;
    current.policy = effectivePolicy(detail, saved ?? { ...latest, sessionPolicies });
    toast("选择已保存，下一次请求生效");
  } catch (error) {
    toast(error.message, true);
  } finally {
    saving = false;
    if (current) renderDetail();
  }
}

function togglePin(contentId) {
  return save((policy) => {
    const pinned = new Set(policy.pinnedContentIds);
    pinned.has(contentId) ? pinned.delete(contentId) : pinned.add(contentId);
    return { auto: policy.auto, pinnedContentIds: [...pinned] };
  });
}

$("auto").onchange = (event) => {
  const auto = event.target.checked;
  return save((policy) => ({ auto, pinnedContentIds: policy.pinnedContentIds }));
};
$("refresh").onclick = () => loadSessions(current?.session.key);

function renderSettings(options) {
  $("settings-fields").disabled = !options;
  $("settings-status").textContent = options ? "" : "无法读取设置，请重新打开设置页重试。";
  if (!options) return;
  $("settings-language").value = options.language === "en" ? "en" : "zh";
  $("settings-image-limit").value = Number.isInteger(options.maxFetchImages) ? Math.min(8, Math.max(1, options.maxFetchImages)) : 4;
  $("settings-size-limit").value = Number.isInteger(options.maxFetchBytes) ? Math.min(33554432, Math.max(1024, options.maxFetchBytes)) : 12582912;
  document.querySelectorAll("[data-agent]").forEach((input) => {
    input.checked = options.agentAuto?.[input.dataset.agent] !== false;
  });
}

function showSettings(visible) {
  $("attachments").hidden = visible;
  $("settings").hidden = !visible;
  $("show-attachments").setAttribute("aria-pressed", String(!visible));
  $("show-settings").setAttribute("aria-pressed", String(visible));
  if (visible) {
    $("settings-fields").disabled = true;
    return readHostOptions().then(renderSettings);
  }
}

function openSession(key) {
  showSettings(false);
  if (key) return loadDetail(key);
}

async function saveSettings(event) {
  event.preventDefault();
  if (saving || $("settings-fields").disabled || !$("settings-form").reportValidity()) return;
  const agentChoices = Object.fromEntries([...document.querySelectorAll("[data-agent]")].map((input) => [input.dataset.agent, input.checked]));
  const language = $("settings-language").value;
  const maxFetchImages = $("settings-image-limit").valueAsNumber;
  const maxFetchBytes = $("settings-size-limit").valueAsNumber;
  saving = true;
  $("settings-fields").disabled = true;
  let latest;
  try {
    latest = await readHostOptions();
    if (!latest) throw new Error("无法读取 Magpie 设置，请重试。");
    const next = { ...latest, agentAuto: { ...latest.agentAuto, ...agentChoices }, language, maxFetchImages, maxFetchBytes };
    const saved = await magpie.options.set(next);
    if (current) current.agentPaused = (saved?.agentAuto ?? next.agentAuto)[current.session.platform] === false;
    $("settings-status").textContent = "设置已保存。";
  } catch (error) {
    $("settings-status").textContent = error.message;
  } finally {
    $("settings-fields").disabled = !latest;
    saving = false;
    if (current) renderDetail();
  }
}

$("show-settings").onclick = () => showSettings(true);
$("show-attachments").onclick = () => openSession();
$("settings-form").onsubmit = saveSettings;
magpie.ready.then(async () => {
  await loadSessions();
}).catch((error) => renderEmpty("Magpie 页面连接失败", String(error)));
