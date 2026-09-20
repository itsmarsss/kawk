/* Remember PWA client: SSE live card feed + Web Push subscribe flow.
   Talks only to the hub's PwaServer (same origin) — no external services. */

const $ = (id) => document.getElementById(id);

// ---- helpers ---------------------------------------------------------------------

function urlB64ToUint8Array(b64) {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent);
const standalone =
  window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;

// ---- live card feed (SSE) ----------------------------------------------------------

function renderCard(ev) {
  $("card-tpl").textContent = ev.template;
  $("card-title").textContent = ev.title || "—";
  $("card-body").textContent = ev.body || "";
  document.body.dataset.template = ev.template;
  if (ev.template !== "idle") {
    const li = document.createElement("li");
    const t = new Date((ev.ts || Date.now() / 1000) * 1000);
    li.innerHTML = `<span class="tpl">${ev.template}</span> <b></b> <span class="body"></span>
      <time>${t.toLocaleTimeString()}</time>`;
    li.querySelector("b").textContent = ev.title || "";
    li.querySelector(".body").textContent = ev.body || "";
    const hist = $("history");
    hist.prepend(li);
    while (hist.children.length > 30) hist.lastChild.remove();
  }
}

function connectSSE() {
  const es = new EventSource("/api/events");
  es.onopen = () => {
    $("conn").textContent = "live";
    $("conn").className = "chip ok";
  };
  es.onerror = () => {
    $("conn").textContent = "reconnecting…";
    $("conn").className = "chip bad";
  };
  es.onmessage = (msg) => {
    try {
      renderCard(JSON.parse(msg.data));
    } catch {}
  };
}

// ---- push subscribe flow -------------------------------------------------------------

async function currentSubscription() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return null;
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

async function enablePush() {
  const hint = $("hint");
  hint.textContent = "";
  try {
    if (isIOS && !standalone) {
      $("install-hint").hidden = false;
      hint.textContent = "Install to Home Screen first (iOS requirement).";
      return;
    }
    if (!("serviceWorker" in navigator)) throw new Error("no service worker support");
    const reg = await navigator.serviceWorker.register("/sw.js");
    await navigator.serviceWorker.ready;

    const res = await fetch("/api/vapid-key");
    if (!res.ok) throw new Error("hub has no VAPID keys — run scripts/gen_vapid.py");
    const { key } = await res.json();

    const permission = await Notification.requestPermission();
    if (permission !== "granted") throw new Error("notification permission denied");

    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlB64ToUint8Array(key),
    });
    const ok = await fetch("/api/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(sub.toJSON()),
    });
    if (!ok.ok) throw new Error("hub rejected the subscription");
    setPushChip(true);
    hint.textContent = "Subscribed — lock your phone and hit Send test; the watch mirrors it.";
  } catch (err) {
    setPushChip(false);
    hint.textContent = `Push setup failed: ${err.message}`;
  }
}

function setPushChip(on) {
  $("push").textContent = on ? "push: on" : "push: off";
  $("push").className = on ? "chip ok" : "chip";
}

// ---- boot ------------------------------------------------------------------------------

$("enable").addEventListener("click", enablePush);
$("test").addEventListener("click", () => fetch("/api/test", { method: "POST" }));

if (isIOS && !standalone) $("install-hint").hidden = false;
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
  currentSubscription().then((sub) => setPushChip(!!sub));
}
connectSSE();
