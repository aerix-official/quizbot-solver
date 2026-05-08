// QuizBot Popup

const STORAGE_KEYS = [
  "aiMode", "doubleCreditMode", "randomConfidence",
  "pauseBeforeSubmit", "confidenceLevel",
];

// Load all settings and render
chrome.storage.local.get([...STORAGE_KEYS, "anthropicApiKey", "usage"], (data) => {
  const mode = data.aiMode || "api";
  setActiveMode(mode);
  setConfidencePill(data.confidenceLevel || "high");
  document.getElementById("toggle-double-credit").checked = !!data.doubleCreditMode;
  document.getElementById("toggle-random-conf").checked   = !!data.randomConfidence;
  document.getElementById("toggle-pause").checked         = !!data.pauseBeforeSubmit;
  updateStatusUI(mode, data.anthropicApiKey, data.usage);
  syncRandomConf(!!data.randomConfidence);
});

// ── Mode buttons ──────────────────────────────────────
document.querySelectorAll(".mode-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const mode = btn.dataset.mode;
    chrome.storage.local.set({ aiMode: mode });
    setActiveMode(mode);
    refreshStatus(mode);
  });
});

function setActiveMode(mode) {
  document.querySelectorAll(".mode-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.mode === mode);
  });
  document.getElementById("cost-section").classList.toggle("hidden", mode !== "api");
}

// ── Status ────────────────────────────────────────────
function refreshStatus(mode) {
  chrome.storage.local.get(["anthropicApiKey", "usage"], (data) => {
    updateStatusUI(mode, data.anthropicApiKey, data.usage);
  });
}

function updateStatusUI(mode, apiKey, usage) {
  const dot     = document.getElementById("status-dot");
  const text    = document.getElementById("status-text");
  const warning = document.getElementById("api-warning");

  dot.className = "status-dot";

  if (mode === "api") {
    if (apiKey) {
      dot.classList.add("ok");
      text.textContent = "Claude API ready";
      warning.classList.add("hidden");
    } else {
      dot.classList.add("err");
      text.textContent = "No API key configured";
      warning.classList.remove("hidden");
    }
    const u = usage || {};
    document.getElementById("cost-requests").textContent = (u.requests || 0).toLocaleString();
    document.getElementById("cost-usd").textContent =
      "$" + ((u.estimatedCostUsd || 0)).toFixed(4);
  } else {
    warning.classList.add("hidden");
    const names = { chatgpt: "chatgpt.com", gemini: "gemini.google.com", deepseek: "chat.deepseek.com" };
    const urlPattern = {
      chatgpt:  "https://chatgpt.com/*",
      gemini:   "https://gemini.google.com/*",
      deepseek: ["https://chat.deepseek.com/*", "https://deepseek.chat/*"],
    }[mode];

    if (urlPattern) {
      chrome.tabs.query({ url: urlPattern }, (tabs) => {
        if (tabs && tabs.length > 0) {
          dot.classList.add("ok");
          text.textContent = capitalize(mode) + " tab found";
        } else {
          dot.classList.add("warn");
          text.textContent = "Open " + (names[mode] || mode) + " first";
        }
      });
    }
  }
}

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// Auto-refresh status every 3s
setInterval(() => {
  chrome.storage.local.get(["aiMode", "anthropicApiKey", "usage"], (d) => {
    updateStatusUI(d.aiMode || "api", d.anthropicApiKey, d.usage);
  });
}, 3000);

// ── Confidence pills ──────────────────────────────────
document.querySelectorAll(".conf-pill").forEach((pill) => {
  pill.addEventListener("click", () => {
    const level = pill.dataset.level;
    chrome.storage.local.set({ confidenceLevel: level });
    setConfidencePill(level);
  });
});

function setConfidencePill(level) {
  document.querySelectorAll(".conf-pill").forEach((p) => {
    p.classList.toggle("active", p.dataset.level === level);
  });
}

// ── Toggles ───────────────────────────────────────────
document.getElementById("toggle-double-credit").addEventListener("change", (e) => {
  chrome.storage.local.set({ doubleCreditMode: e.target.checked });
});

document.getElementById("toggle-random-conf").addEventListener("change", (e) => {
  chrome.storage.local.set({ randomConfidence: e.target.checked });
  syncRandomConf(e.target.checked);
});

document.getElementById("toggle-pause").addEventListener("change", (e) => {
  chrome.storage.local.set({ pauseBeforeSubmit: e.target.checked });
});

function syncRandomConf(random) {
  const pills = document.getElementById("conf-pills");
  pills.style.opacity       = random ? "0.35" : "1";
  pills.style.pointerEvents = random ? "none"  : "auto";
}

// ── Settings / nav ────────────────────────────────────
document.getElementById("settings-btn").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
  window.close();
});

document.getElementById("go-settings").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
  window.close();
});
