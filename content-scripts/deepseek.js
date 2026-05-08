// QuizBot — DeepSeek tab content script

let hasResponded = false;
let messageCountAtQuestion = 0;
let observationStartTime = 0;
let observationTimeout = null;
let checkIntervalId = null;
let observer = null;

const MESSAGE_SELECTORS = [
  "[data-testid='chat-message-assistant']",
  "[data-testid='message-content']",
  "model-response",
  ".ds-markdown",
  ".f9bf7997",
];
const CHAT_INPUT_SELECTORS = [
  "#chat-input",
  'textarea[data-testid="chat_input_input"]',
  "textarea",
  '[role="textbox"][contenteditable="true"]',
];
const SEND_BUTTON_SELECTORS = [
  '[data-testid="submit-button"]',
  '[data-testid="send-button"]',
  '[data-testid="chat_input_send_button"]',
  '[role="button"].f6d670',
  ".f6d670",
  'button[type="submit"]',
  '[aria-label="Send message"]',
  '[aria-label*="Send"]',
  ".bf38813a button",
];

function getMessageNodes() {
  for (const sel of MESSAGE_SELECTORS) {
    const nodes = document.querySelectorAll(sel);
    if (nodes.length) return Array.from(nodes);
  }
  return [];
}

function findChatInput() {
  for (const sel of CHAT_INPUT_SELECTORS) {
    const el = document.querySelector(sel);
    if (el) return el;
  }
  return null;
}

function isButtonUsable(btn) {
  if (!btn) return false;
  if (btn.disabled) return false;
  if (btn.getAttribute("aria-disabled") === "true") return false;
  return true;
}

function findSendButton() {
  for (const sel of SEND_BUTTON_SELECTORS) {
    try {
      const btn = document.querySelector(sel);
      if (isButtonUsable(btn)) return btn;
    } catch {}
  }
  const container = document.querySelector(".bf38813a");
  if (container) {
    const candidates = Array.from(container.querySelectorAll("button, [role='button']")).reverse();
    const last = candidates.find(isButtonUsable);
    if (last) return last;
  }
  return null;
}

function updateChatInputValue(input, text) {
  input.focus();
  if (input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement) {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")?.set;
    if (setter) setter.call(input, text);
    else input.value = text;
  } else if (input.isContentEditable) {
    input.textContent = text;
  } else {
    return false;
  }
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "receiveQuestion") {
    resetObservation();
    messageCountAtQuestion = getMessageNodes().length;
    hasResponded = false;
    insertQuestion(message.question)
      .then(() => sendResponse({ received: true, status: "processing" }))
      .catch((e) => sendResponse({ received: false, error: e.message }));
    return true;
  }
});

function resetObservation() {
  hasResponded = false;
  if (observationTimeout) { clearTimeout(observationTimeout); observationTimeout = null; }
  if (checkIntervalId) { clearInterval(checkIntervalId); checkIntervalId = null; }
  if (observer) { observer.disconnect(); observer = null; }
}

async function insertQuestion(questionData) {
  const { type, question, options, previousCorrection } = questionData;
  let text = `Type: ${type}\nQuestion: ${question}`;

  if (previousCorrection?.question && previousCorrection?.correctAnswer) {
    text =
      `CORRECTION FROM PREVIOUS ANSWER: For the question "${previousCorrection.question}", ` +
      `your answer was incorrect. The correct answer was: ${JSON.stringify(previousCorrection.correctAnswer)}\n\n` +
      `Now answer this new question:\n\n` + text;
  }

  if (type === "matching") {
    text += "\nPrompts:\n" + options.prompts.map((p, i) => `${i + 1}. ${p}`).join("\n");
    text += "\nChoices:\n" + options.choices.map((c, i) => `${i + 1}. ${c}`).join("\n");
    text += '\n\nMatch each prompt. Set "answer" to array of \'Prompt -> Choice\' strings.';
  } else if (type === "fill_in_the_blank") {
    text += "\n\nFill in blank(s). Multiple = array in order. Single = string.";
  } else if (options && options.length > 0) {
    text += "\nOptions:\n" + options.map((o, i) => `${i + 1}. ${o}`).join("\n");
    text += "\n\nIMPORTANT: Answer must EXACTLY match one option. No numbers. Include periods.";
  }

  text += '\n\nProvide answer in JSON: {"answer": "...", "explanation": "one sentence"}. DO NOT acknowledge any correction.';

  return new Promise((resolve, reject) => {
    const input = findChatInput();
    if (!input) { reject(new Error("DeepSeek input not found")); return; }
    setTimeout(() => {
      if (!updateChatInputValue(input, text)) { reject(new Error("Could not fill DeepSeek input")); return; }
      setTimeout(() => {
        const btn = findSendButton();
        if (!btn) { reject(new Error("DeepSeek send button not found")); return; }
        btn.click();
        startObserving();
        resolve();
      }, 300);
    }, 300);
  });
}

function processResponse(responseText) {
  const cleaned = responseText.replace(/[​-‍﻿]/g, "").replace(/\n\s*/g, " ").trim();
  try {
    const parsed = JSON.parse(cleaned);
    if (parsed?.answer !== undefined && !hasResponded) {
      hasResponded = true;
      chrome.runtime.sendMessage({ type: "deepseekResponse", response: cleaned })
        .then(() => resetObservation()).catch(() => {});
      return true;
    }
  } catch {}
  return false;
}

function checkForResponse() {
  if (hasResponded) return;
  const msgs = getMessageNodes();
  if (msgs.length <= messageCountAtQuestion) return;

  const newMsgs = msgs.slice(messageCountAtQuestion);
  for (const msg of newMsgs) {
    // Try code blocks first
    for (const sel of [".md-code-block pre", "pre code", "pre", ".code-block pre", ".ds-markdown pre"]) {
      for (const block of msg.querySelectorAll(sel)) {
        const parent = block.closest(".md-code-block, .code-block, .ds-markdown");
        if (parent) {
          const infoEls = parent.querySelectorAll('.d813de27, .md-code-block-infostring, [class*="json"], [class*="language"]');
          const isJson = Array.from(infoEls).some((e) => e.textContent.toLowerCase().includes("json"));
          if (isJson || !infoEls.length) {
            const t = block.textContent.trim();
            if (t.includes("{") && t.includes('"answer"') && processResponse(t)) return;
          }
        }
      }
    }
    // Fallback: regex in full message text
    const m = msg.textContent.trim().match(/\{[\s\S]*?"answer"[\s\S]*?\}/);
    if (m && processResponse(m[0])) return;

    if (Date.now() - observationStartTime > 30000) {
      const m2 = msg.textContent.trim().match(/\{[\s\S]*?"answer"[\s\S]*?"explanation"[\s\S]*?\}/);
      if (m2 && !hasResponded) {
        hasResponded = true;
        chrome.runtime.sendMessage({ type: "deepseekResponse", response: m2[0] });
        resetObservation();
        return;
      }
    }
  }
}

function startObserving() {
  observationStartTime = Date.now();
  observationTimeout = setTimeout(() => { if (!hasResponded) resetObservation(); }, 180000);
  observer = new MutationObserver(() => checkForResponse());
  observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true });
  checkIntervalId = setInterval(checkForResponse, 1000);
}
