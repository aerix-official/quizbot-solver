// QuizBot — Gemini tab content script

let hasResponded = false;
let messageCountAtQuestion = 0;
let observationStartTime = 0;
let observationTimeout = null;
let observer = null;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "receiveQuestion") {
    resetObservation();
    const msgs = document.querySelectorAll("model-response");
    messageCountAtQuestion = msgs.length;
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
  if (observer) { observer.disconnect(); observer = null; }
}

function waitForIdle(timeout = 120000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const iv = setInterval(() => {
      const btn = document.querySelector(".send-button");
      if (!btn || !btn.classList.contains("stop")) { clearInterval(iv); resolve(); }
      else if (Date.now() - start > timeout) { clearInterval(iv); reject(new Error("Gemini response timeout")); }
    }, 500);
  });
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
    text += '\n\nMatch each prompt with the correct choice. Set "answer" to an array using exact format \'Prompt -> Choice\'.';
  } else if (type === "fill_in_the_blank") {
    text += "\n\nFill in the blank. Multiple blanks = array in order. Single blank = string.";
  } else if (options && options.length > 0) {
    text += "\nOptions:\n" + options.map((o, i) => `${i + 1}. ${o}`).join("\n");
    text += "\n\nIMPORTANT: Answer must EXACTLY match the above options. No numbers. Include all correct selections.";
  }

  text += '\n\nProvide answer in JSON: {"answer": "...", "explanation": "one sentence"}. DO NOT acknowledge any correction.';

  await waitForIdle();
  return new Promise((resolve, reject) => {
    const input = document.querySelector(".ql-editor");
    if (!input) { reject(new Error("Gemini input not found")); return; }
    setTimeout(() => {
      input.focus();
      input.innerHTML = `<p>${text}</p>`;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      setTimeout(() => {
        const btn = document.querySelector(".send-button");
        if (!btn) { reject(new Error("Gemini send button not found")); return; }
        btn.click();
        startObserving();
        resolve();
      }, 300);
    }, 300);
  });
}

function startObserving() {
  observationStartTime = Date.now();
  observationTimeout = setTimeout(() => { if (!hasResponded) resetObservation(); }, 180000);

  observer = new MutationObserver(() => {
    if (hasResponded) return;
    const msgs = document.querySelectorAll("model-response");
    if (!msgs.length || msgs.length <= messageCountAtQuestion) return;
    const latest = msgs[msgs.length - 1];

    let responseText = "";
    for (const block of latest.querySelectorAll("pre code")) {
      if (block.className.includes("hljs-") || block.closest(".code-block")) {
        responseText = block.textContent.trim(); break;
      }
    }
    if (!responseText) {
      const m = latest.textContent.trim().match(/\{[\s\S]*\}/);
      if (m) responseText = m[0];
    }
    if (!responseText) return;

    responseText = responseText.replace(/[​-‍﻿]/g, "").replace(/\n\s*/g, " ").trim();

    try {
      const parsed = JSON.parse(responseText);
      if (parsed.answer !== undefined && !hasResponded) {
        hasResponded = true;
        chrome.runtime.sendMessage({ type: "geminiResponse", response: responseText })
          .then(() => resetObservation()).catch(() => {});
      }
    } catch {
      const generating = latest.querySelector(".cursor") || latest.classList.contains("generating");
      if (!generating && Date.now() - observationStartTime > 30000) {
        const m = latest.textContent.trim().match(/\{[\s\S]*?"answer"[\s\S]*?"explanation"[\s\S]*?\}/);
        if (m && !hasResponded) {
          hasResponded = true;
          chrome.runtime.sendMessage({ type: "geminiResponse", response: m[0] });
          resetObservation();
        }
      }
    }
  });

  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
}
