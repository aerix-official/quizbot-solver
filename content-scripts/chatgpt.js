// QuizBot — ChatGPT tab content script
// Receives a question, types it into ChatGPT, waits for JSON response, sends it back.

let hasResponded = false;
let messageCountAtQuestion = 0;
let observationStartTime = 0;
let observationTimeout = null;
let observer = null;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "receiveQuestion") {
    resetObservation();
    const msgs = document.querySelectorAll('[data-message-author-role="assistant"]');
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
    text += '\n\nMatch each prompt with the correct choice. Set "answer" to an array of strings using the exact format \'Prompt -> Choice\'. Include one entry per prompt, use exact text, and use each choice at most once.';
  } else if (type === "fill_in_the_blank") {
    text += "\n\nFill in the blank question. If multiple blanks, provide answers as an array in order. For single blank, provide a string.";
  } else if (options && options.length > 0) {
    text += "\nOptions:\n" + options.map((o, i) => `${i + 1}. ${o}`).join("\n");
    text += "\n\nIMPORTANT: Your answer must EXACTLY match one of the above options. Do not include numbers. If there are periods, include them.";
  }

  text += '\n\nProvide your answer in JSON format with keys "answer" and "explanation". Explanation: one sentence. DO NOT acknowledge the correction, only answer the new question.';

  return new Promise((resolve, reject) => {
    const inputArea = document.getElementById("prompt-textarea");
    if (!inputArea) { reject(new Error("ChatGPT input not found")); return; }
    setTimeout(() => {
      inputArea.focus();
      inputArea.innerHTML = `<p>${text}</p>`;
      inputArea.dispatchEvent(new Event("input", { bubbles: true }));
      setTimeout(() => {
        const sendBtn = document.querySelector('[data-testid="send-button"]');
        if (!sendBtn) { reject(new Error("ChatGPT send button not found")); return; }
        sendBtn.click();
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
    const msgs = document.querySelectorAll('[data-message-author-role="assistant"]');
    if (!msgs.length || msgs.length <= messageCountAtQuestion) return;
    const latest = msgs[msgs.length - 1];

    let responseText = "";
    const codeBlocks = latest.querySelectorAll("pre code");
    for (const block of codeBlocks) {
      if (block.className.includes("language-json")) { responseText = block.textContent.trim(); break; }
    }
    if (!responseText) {
      const raw = latest.textContent.trim();
      const m = raw.match(/\{[\s\S]*\}/);
      if (m) responseText = m[0];
    }
    if (!responseText) return;

    responseText = responseText.replace(/[​-‍﻿]/g, "").replace(/\n\s*/g, " ").trim();

    try {
      const parsed = JSON.parse(responseText);
      if (parsed.answer !== undefined && !hasResponded) {
        hasResponded = true;
        chrome.runtime.sendMessage({ type: "chatGPTResponse", response: responseText })
          .then(() => resetObservation())
          .catch(() => {});
      }
    } catch {
      const isGenerating = latest.querySelector(".result-streaming");
      if (!isGenerating && Date.now() - observationStartTime > 30000) {
        const fallback = latest.textContent.trim().match(/\{[\s\S]*?"answer"[\s\S]*?"explanation"[\s\S]*?\}/);
        if (fallback && !hasResponded) {
          hasResponded = true;
          chrome.runtime.sendMessage({ type: "chatGPTResponse", response: fallback[0] });
          resetObservation();
        }
      }
    }
  });

  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
}
