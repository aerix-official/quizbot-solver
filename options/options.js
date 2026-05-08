// QuizBot Options Page

const KEYS = [
  "anthropicApiKey", "model", "maxTokens",
  "doubleCreditMode", "randomConfidence", "pauseBeforeSubmit", "confidenceLevel",
  "usage",
];

// ── Load settings ─────────────────────────────
chrome.storage.local.get(KEYS, (data) => {
  if (data.anthropicApiKey) {
    document.getElementById("api-key-input").value = data.anthropicApiKey;
    setKeyHint("ok", "API key saved.");
  }
  document.getElementById("model-select").value    = data.model || "claude-sonnet-4-6";
  document.getElementById("max-tokens-input").value = data.maxTokens || 1024;
  document.getElementById("double-credit-toggle").checked = !!data.doubleCreditMode;
  document.getElementById("random-conf-toggle").checked   = !!data.randomConfidence;
  document.getElementById("pause-toggle").checked         = !!data.pauseBeforeSubmit;
  setConfOpt(data.confidenceLevel || "high");
  renderUsage(data.usage);
});

// ── Usage stats ───────────────────────────────
function renderUsage(usage) {
  const u = usage || {};
  document.getElementById("stat-requests").textContent = (u.requests || 0).toLocaleString();
  document.getElementById("stat-input").textContent    = fmt(u.inputTokens);
  document.getElementById("stat-output").textContent   = fmt(u.outputTokens);
  document.getElementById("stat-cost").textContent     = "$" + ((u.estimatedCostUsd || 0)).toFixed(6);
}

function fmt(n) {
  n = n || 0;
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000)     return (n / 1_000).toFixed(1) + "k";
  return String(n);
}

// ── API key ───────────────────────────────────
function setKeyHint(type, msg) {
  const el = document.getElementById("api-key-status");
  el.textContent = msg;
  el.className = "field-hint" + (type ? " hint-" + type : "");
}

document.getElementById("save-key-btn").addEventListener("click", () => {
  const key = document.getElementById("api-key-input").value.trim();
  if (!key)                      { setKeyHint("err",  "Please enter an API key."); return; }
  if (!key.startsWith("sk-ant-")){ setKeyHint("warn", "Doesn't look like an Anthropic key (should start with sk-ant-)."); return; }
  chrome.storage.local.set({ anthropicApiKey: key }, () => {
    setKeyHint("ok", "Saved!");
    showToast("API key saved");
  });
});

document.getElementById("test-key-btn").addEventListener("click", () => {
  const key = document.getElementById("api-key-input").value.trim();
  if (!key) { setKeyHint("err", "Enter a key to test."); return; }
  setKeyHint("", "Testing…");
  chrome.runtime.sendMessage({ action: "testApiKey", apiKey: key }, (res) => {
    if (chrome.runtime.lastError) { setKeyHint("err", chrome.runtime.lastError.message); return; }
    if (res?.success) setKeyHint("ok", "Key is valid ✓");
    else setKeyHint("err", "Invalid: " + (res?.error || "unknown error"));
  });
});

document.getElementById("clear-key-btn").addEventListener("click", () => {
  if (!confirm("Clear your saved API key?")) return;
  chrome.storage.local.remove("anthropicApiKey", () => {
    document.getElementById("api-key-input").value = "";
    setKeyHint("warn", "Key cleared.");
  });
});

document.getElementById("toggle-show-key").addEventListener("click", function () {
  const input = document.getElementById("api-key-input");
  const show  = input.type === "password";
  input.type  = show ? "text" : "password";
  this.textContent = show ? "Hide" : "Show";
});

// ── Model / tokens ────────────────────────────
document.getElementById("model-select").addEventListener("change", (e) => {
  chrome.storage.local.set({ model: e.target.value }, () => showToast("Model saved"));
});

document.getElementById("max-tokens-input").addEventListener("change", (e) => {
  const val = Math.max(256, Math.min(4096, parseInt(e.target.value, 10) || 1024));
  e.target.value = val;
  chrome.storage.local.set({ maxTokens: val }, () => showToast("Token limit saved"));
});

// ── Behavior toggles ──────────────────────────
document.getElementById("double-credit-toggle").addEventListener("change", (e) => {
  chrome.storage.local.set({ doubleCreditMode: e.target.checked });
});
document.getElementById("random-conf-toggle").addEventListener("change", (e) => {
  chrome.storage.local.set({ randomConfidence: e.target.checked });
});
document.getElementById("pause-toggle").addEventListener("change", (e) => {
  chrome.storage.local.set({ pauseBeforeSubmit: e.target.checked });
});

// ── Confidence option buttons ─────────────────
document.querySelectorAll(".conf-opt").forEach((btn) => {
  btn.addEventListener("click", () => {
    const level = btn.dataset.level;
    chrome.storage.local.set({ confidenceLevel: level });
    setConfOpt(level);
  });
});

function setConfOpt(level) {
  document.querySelectorAll(".conf-opt").forEach((b) => {
    b.classList.toggle("active", b.dataset.level === level);
  });
}

// ── Reset usage ───────────────────────────────
document.getElementById("reset-usage-btn").addEventListener("click", () => {
  if (!confirm("Reset all usage statistics?")) return;
  const empty = { requests: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 };
  chrome.storage.local.set({ usage: empty }, () => { renderUsage(empty); showToast("Usage reset"); });
});

// ── Sidebar nav ───────────────────────────────
document.querySelectorAll(".nav-link").forEach((link) => {
  link.addEventListener("click", (e) => {
    e.preventDefault();
    document.querySelectorAll(".nav-link").forEach((l) => l.classList.remove("active"));
    link.classList.add("active");
    const sec = document.getElementById(link.dataset.section);
    if (sec) sec.scrollIntoView({ behavior: "smooth", block: "start" });
  });
});

// ── Toast ─────────────────────────────────────
function showToast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => t.classList.add("hidden"), 2200);
}
