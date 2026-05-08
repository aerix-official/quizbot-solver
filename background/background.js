// QuizBot Background Service Worker
// Handles both Claude API mode (direct) and Tab AI mode (ChatGPT/Gemini/DeepSeek)

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

const SYSTEM_PROMPT =
  "You are an expert academic assistant solving McGraw-Hill SmartBook questions.\n\n" +
  "CRITICAL: Respond ONLY with valid JSON. No markdown, no code fences, no text before or after.\n\n" +
  "Response format: {\"answer\": \"...\", \"explanation\": \"one sentence\"}\n\n" +
  "Rules by question type:\n" +
  "- multiple_choice: answer must exactly match one provided option (no number prefix, preserve all punctuation)\n" +
  "- true_false: answer must be exactly \"True\" or \"False\"\n" +
  "- multiple_select: answer must be a JSON array of ALL correct options, e.g. [\"Option A\", \"Option B\"]\n" +
  "- fill_in_the_blank: single blank = string value; multiple blanks = array of strings in order\n" +
  "- matching: answer must be array of \"Prompt -> Choice\" strings, one per pair, using exact option text\n" +
  "- select_text: answer must be the exact phrase/text to select\n\n" +
  "Always choose the most academically accurate answer.";

const PRICING = {
  "claude-sonnet-4-6": { input: 3, output: 15, cacheRead: 0.3 },
  "claude-opus-4-7": { input: 15, output: 75, cacheRead: 1.5 },
};

// --- State ---
let mheTabId = null;
let aiTabId = null;
let aiType = null;
let mheWindowId = null;
let aiWindowId = null;
let pendingMheTabId = null;
let pendingMheWindowId = null;
let lastActiveTabId = null;

// Double credit state
let duplicateTabId = null;
let originalTabId = null;
let pendingResponse = null;
let isProcessingDuplicate = false;

chrome.tabs.onActivated.addListener((info) => {
  lastActiveTabId = info.tabId;
});

// --- Settings ---
async function getSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get(
      ["anthropicApiKey", "aiMode", "model", "maxTokens", "usage"],
      resolve
    );
  });
}

// --- Claude API ---
function buildQuestionPrompt(questionData) {
  const { type, question, options, previousCorrection } = questionData;
  let prompt = "";

  if (previousCorrection?.question && previousCorrection?.correctAnswer) {
    prompt +=
      `CORRECTION: For the question "${previousCorrection.question}", ` +
      `your previous answer was incorrect. The correct answer was: ` +
      `${JSON.stringify(previousCorrection.correctAnswer)}\n\nNow answer this new question:\n\n`;
  }

  prompt += `Question Type: ${type}\nQuestion: ${question}\n`;

  if (type === "matching" && options?.prompts) {
    prompt +=
      "\nPrompts:\n" +
      options.prompts.map((p, i) => `${i + 1}. ${p}`).join("\n");
    prompt +=
      "\n\nChoices:\n" +
      options.choices.map((c, i) => `${i + 1}. ${c}`).join("\n");
    prompt +=
      '\n\nMatch each prompt to the correct choice. ' +
      'Answer format: {"answer": ["Prompt -> Choice", ...], "explanation": "..."}';
  } else if (Array.isArray(options) && options.length > 0) {
    prompt += "\nOptions:\n" + options.map((o, i) => `${i + 1}. ${o}`).join("\n");
    if (type === "multiple_select") {
      prompt +=
        '\n\nSelect ALL correct options. ' +
        'Answer format: {"answer": ["Option 1", "Option 2"], "explanation": "..."}';
    } else if (type === "fill_in_the_blank") {
      const blanks = (question.match(/\[BLANK\]/g) || []).length;
      if (blanks > 1) {
        prompt +=
          `\n\nFill all ${blanks} blanks in order. ` +
          'Answer format: {"answer": ["val1", "val2"], "explanation": "..."}';
      }
    } else {
      prompt +=
        '\n\nAnswer must EXACTLY match one option (no number prefix). ' +
        'Format: {"answer": "option text", "explanation": "..."}';
    }
  } else if (type === "fill_in_the_blank") {
    prompt +=
      '\n\nFormat: {"answer": "value", "explanation": "..."}';
  }

  return prompt;
}

async function trackUsage(usage, model) {
  const p = PRICING[model] || { input: 3, output: 15, cacheRead: 0.3 };
  const cost =
    ((usage.input_tokens || 0) * p.input) / 1_000_000 +
    ((usage.output_tokens || 0) * p.output) / 1_000_000 +
    ((usage.cache_read_input_tokens || 0) * p.cacheRead) / 1_000_000;

  const stored = await new Promise((r) => chrome.storage.local.get("usage", r));
  const u = stored.usage || {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    estimatedCostUsd: 0,
  };

  chrome.storage.local.set({
    usage: {
      requests: u.requests + 1,
      inputTokens: u.inputTokens + (usage.input_tokens || 0),
      outputTokens: u.outputTokens + (usage.output_tokens || 0),
      estimatedCostUsd: Number((u.estimatedCostUsd + cost).toFixed(6)),
    },
  });
}

async function callClaudeAPI(questionData) {
  const settings = await getSettings();
  const apiKey = settings.anthropicApiKey;

  if (!apiKey) {
    return {
      success: false,
      error:
        "No API key configured. Open QuizBot settings (⚙) to add your Anthropic API key.",
    };
  }

  const model = settings.model || "claude-sonnet-4-6";
  const maxTokens = settings.maxTokens || 1024;
  const userMessage = buildQuestionPrompt(questionData);

  let response;
  try {
    response = await fetch(ANTHROPIC_API_URL, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
        "content-type": "application/json",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        system: [
          {
            type: "text",
            text: SYSTEM_PROMPT,
            cache_control: { type: "ephemeral" },
          },
        ],
        messages: [{ role: "user", content: userMessage }],
      }),
    });
  } catch (err) {
    return { success: false, error: "Network error: " + (err.message || err) };
  }

  let data;
  try {
    data = await response.json();
  } catch {
    return { success: false, error: "Invalid response from Anthropic API" };
  }

  if (!response.ok || data.error) {
    return {
      success: false,
      error: (data?.error?.message) || `API error ${response.status}`,
    };
  }

  if (data.usage) {
    trackUsage(data.usage, model);
  }

  const text = (data.content?.[0]?.text || "").trim();

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        parsed = JSON.parse(match[0]);
      } catch {
        return { success: false, error: "Failed to parse Claude response as JSON" };
      }
    } else {
      return { success: false, error: "Claude response was not valid JSON" };
    }
  }

  if (!parsed?.answer && parsed?.answer !== 0) {
    return { success: false, error: "Claude response missing answer field" };
  }

  return {
    success: true,
    answer: parsed.answer,
    explanation: parsed.explanation || "",
    rawResponse: JSON.stringify(parsed),
  };
}

// --- Tab AI routing ---
function isDeepSeekUrl(url = "") {
  return url.includes("chat.deepseek.com") || url.includes("deepseek.chat");
}

async function findAITab(aiMode) {
  const patterns = {
    chatgpt: "https://chatgpt.com/*",
    gemini: "https://gemini.google.com/*",
    deepseek: ["https://chat.deepseek.com/*", "https://deepseek.chat/*"],
  };

  const pattern = patterns[aiMode];
  if (!pattern) return null;

  const tabs = await chrome.tabs.query({ url: pattern });
  if (!tabs.length) return null;

  if (aiMode === "deepseek") {
    return tabs.find((t) => t.url?.includes("chat.deepseek.com")) || tabs[0];
  }
  return tabs[0];
}

async function focusTab(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    await chrome.windows.update(tab.windowId, { focused: true });
    await chrome.tabs.update(tabId, { active: true });
    return true;
  } catch {
    return false;
  }
}

function sendMessageWithRetry(tabId, message, maxAttempts = 3, delayMs = 1000) {
  return new Promise((resolve, reject) => {
    let attempts = 0;
    function attempt() {
      attempts++;
      chrome.tabs.sendMessage(tabId, message, (response) => {
        if (chrome.runtime.lastError) {
          if (attempts < maxAttempts) {
            setTimeout(attempt, delayMs);
          } else {
            reject(chrome.runtime.lastError);
          }
        } else {
          resolve(response);
        }
      });
    }
    attempt();
  });
}

async function routeToAITab(questionData, aiMode) {
  const tab = await findAITab(aiMode);
  if (!tab) return false;

  aiTabId = tab.id;
  aiWindowId = tab.windowId;

  const sameWindow = mheWindowId === aiWindowId;

  if (sameWindow) {
    await focusTab(aiTabId);
    await new Promise((r) => setTimeout(r, 300));
  }

  try {
    await sendMessageWithRetry(aiTabId, {
      type: "receiveQuestion",
      question: questionData,
    });

    if (sameWindow && lastActiveTabId && lastActiveTabId !== aiTabId) {
      setTimeout(() => focusTab(lastActiveTabId), 1000);
    }

    return true;
  } catch (err) {
    console.error("[QuizBot] Failed to send question to AI tab:", err);
    return false;
  }
}

// --- Handle AI tab response ---
async function handleAITabResponse(responseText) {
  // Check for double credit duplicate tab scenario
  if (duplicateTabId && isProcessingDuplicate) {
    try {
      await sendMessageWithRetry(duplicateTabId, {
        type: "processChatGPTResponse",
        response: responseText,
        isDuplicateTab: true,
      });
    } catch (err) {
      console.error("[QuizBot] Failed to send to duplicate tab:", err);
    }
    return;
  }

  if (originalTabId) {
    try {
      await sendMessageWithRetry(originalTabId, {
        type: "processChatGPTResponse",
        response: responseText,
        isDuplicateTab: false,
      });
    } catch (err) {
      console.error("[QuizBot] Failed to send to original tab:", err);
    }
    return;
  }

  if (!pendingMheTabId) return;

  // Parse the response
  let parsed;
  try {
    const cleaned = responseText
      .replace(/[​-‍﻿]/g, "")
      .replace(/\n\s*/g, " ")
      .trim();
    parsed = JSON.parse(cleaned);
  } catch {
    const match = responseText.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        parsed = JSON.parse(match[0]);
      } catch {
        sendAnswerToMheTab({
          success: false,
          error: "Failed to parse AI response",
        });
        return;
      }
    } else {
      sendAnswerToMheTab({ success: false, error: "No JSON in AI response" });
      return;
    }
  }

  if (!parsed?.answer && parsed?.answer !== 0) {
    sendAnswerToMheTab({ success: false, error: "AI response missing answer" });
    return;
  }

  sendAnswerToMheTab({
    success: true,
    answer: parsed.answer,
    explanation: parsed.explanation || "",
    rawResponse: JSON.stringify(parsed),
  });
}

async function sendAnswerToMheTab(result) {
  if (!pendingMheTabId) return;

  const tabId = pendingMheTabId;
  pendingMheTabId = null;

  // Refocus MHE tab if it was in the same window as the AI tab
  if (mheWindowId === aiWindowId) {
    await focusTab(tabId);
    await new Promise((r) => setTimeout(r, 300));
  }

  try {
    chrome.tabs.sendMessage(tabId, {
      action: "questionAnswered",
      ...result,
    });
  } catch (err) {
    console.error("[QuizBot] Failed to deliver answer to SmartBook tab:", err);
  }
}

// --- Double credit: wait for duplicate tab to be ready ---
async function waitForTabReady(tabId, maxAttempts = 8) {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      await sendMessageWithRetry(tabId, { type: "ping" }, 1, 300);
      const tab = await chrome.tabs.get(tabId);
      if (tab.status === "complete") {
        await new Promise((r) => setTimeout(r, 300));
        return true;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

// --- Main message router ---
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Track which tab is which based on URL
  if (sender.tab) {
    const url = sender.tab.url || "";
    if (
      url.includes("learning.mheducation.com") ||
      url.includes("ezto.mheducation.com")
    ) {
      if (!originalTabId && !duplicateTabId) {
        mheTabId = sender.tab.id;
        mheWindowId = sender.tab.windowId;
      }
    } else if (url.includes("chatgpt.com")) {
      aiTabId = sender.tab.id;
      aiWindowId = sender.tab.windowId;
      aiType = "chatgpt";
    } else if (url.includes("gemini.google.com")) {
      aiTabId = sender.tab.id;
      aiWindowId = sender.tab.windowId;
      aiType = "gemini";
    } else if (isDeepSeekUrl(url)) {
      aiTabId = sender.tab.id;
      aiWindowId = sender.tab.windowId;
      aiType = "deepseek";
    }
  }

  // --- Ping ---
  if (message.type === "ping") {
    sendResponse({ received: true });
    return true;
  }

  // --- Main question handler (API or Tab mode) ---
  if (message.action === "processQuestion") {
    (async () => {
      const settings = await getSettings();
      const mode = settings.aiMode || "api";

      if (mode === "api") {
        const result = await callClaudeAPI(message.question);
        sendResponse(result);
      } else {
        // Tab AI mode
        pendingMheTabId = sender.tab?.id || mheTabId;
        pendingMheWindowId = sender.tab?.windowId || mheWindowId;

        const found = await routeToAITab(message.question, mode);
        if (found) {
          sendResponse({ received: true, mode: "tab" });
        } else {
          const names = { chatgpt: "ChatGPT (chatgpt.com)", gemini: "Gemini (gemini.google.com)", deepseek: "DeepSeek (chat.deepseek.com)" };
          pendingMheTabId = null;
          sendResponse({
            success: false,
            error: `No ${names[mode] || mode} tab found. Please open it first.`,
          });
        }
      }
    })();
    return true;
  }

  // --- AI tab responses (from chatgpt.js / gemini.js / deepseek.js) ---
  if (
    message.type === "chatGPTResponse" ||
    message.type === "geminiResponse" ||
    message.type === "deepseekResponse"
  ) {
    pendingResponse = message.response;
    handleAITabResponse(message.response);
    sendResponse({ received: true });
    return true;
  }

  // --- Status query from popup ---
  if (message.action === "getStatus") {
    (async () => {
      const settings = await getSettings();
      sendResponse({
        aiMode: settings.aiMode || "api",
        hasApiKey: !!(settings.anthropicApiKey),
        model: settings.model || "claude-sonnet-4-6",
        usage: settings.usage || { requests: 0, estimatedCostUsd: 0 },
      });
    })();
    return true;
  }

  // --- API key test from options page ---
  if (message.action === "testApiKey") {
    fetch(ANTHROPIC_API_URL, {
      method: "POST",
      headers: {
        "x-api-key": message.apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
        "content-type": "application/json",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 10,
        messages: [{ role: "user", content: "Hi" }],
      }),
    })
      .then((r) => r.json())
      .then((data) => {
        sendResponse({ success: !data.error, error: data.error?.message });
      })
      .catch((err) => {
        sendResponse({ success: false, error: err.message });
      });
    return true;
  }

  // --- Double credit: create duplicate tab ---
  if (message.type === "createDuplicateTab") {
    originalTabId = sender.tab.id;
    const storedResp = message.response || pendingResponse;

    chrome.tabs.duplicate(sender.tab.id, async (newTab) => {
      duplicateTabId = newTab.id;
      const ready = await waitForTabReady(duplicateTabId);
      if (ready) {
        try {
          await sendMessageWithRetry(duplicateTabId, {
            type: "processDuplicateTab",
            response: storedResp,
          });
        } catch (err) {
          console.error("[QuizBot] Error sending to duplicate tab:", err);
        }
      }
    });
    sendResponse({ received: true });
    return true;
  }

  // --- Double credit: close duplicate tab ---
  if (message.type === "closeDuplicateTab") {
    if (duplicateTabId) {
      if (originalTabId) focusTab(originalTabId);
      chrome.tabs.remove(duplicateTabId, () => {
        duplicateTabId = null;
        isProcessingDuplicate = false;
      });
    }
    sendResponse({ received: true });
    return true;
  }

  // --- Double credit: duplicate finished, tell original to complete ---
  if (message.type === "finishDoubleCredit") {
    if (originalTabId) {
      sendMessageWithRetry(originalTabId, { type: "completeDoubleCredit" });
    }
    sendResponse({ received: true });
    return true;
  }

  // --- Double credit: reset tracking ---
  if (message.type === "resetTabTracking") {
    duplicateTabId = null;
    originalTabId = null;
    pendingResponse = null;
    isProcessingDuplicate = false;
    sendResponse({ received: true });
    return true;
  }

  // --- Open settings ---
  if (message.type === "openSettings" || message.action === "openSettings") {
    chrome.runtime.openOptionsPage();
    sendResponse({ received: true });
    return true;
  }

  // --- Alert passthrough ---
  if (message.type === "alertMessage") {
    if (mheTabId) {
      sendMessageWithRetry(mheTabId, {
        type: "alertMessage",
        message: message.message,
      }).catch(() => {});
    }
    sendResponse({ received: true });
    return true;
  }

  // --- Stop automation ---
  if (message.type === "stopAutomation") {
    sendResponse({ received: true });
    return true;
  }

  sendResponse({ received: false });
  return false;
});

// Clean up on tab close
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === mheTabId) mheTabId = null;
  if (tabId === aiTabId) aiTabId = null;
  if (tabId === pendingMheTabId) pendingMheTabId = null;
  if (tabId === duplicateTabId) {
    duplicateTabId = null;
    isProcessingDuplicate = false;
  }
  if (tabId === originalTabId) {
    originalTabId = null;
    pendingResponse = null;
  }
});

// Open options on first install if no API key set
chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === "install") {
    const settings = await getSettings();
    if (!settings.anthropicApiKey) {
      chrome.runtime.openOptionsPage();
    }
  }
});
