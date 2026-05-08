// QuizBot SmartBook Content Script

let isAutomating = false;
let lastIncorrectQuestion = null;
let lastCorrectAnswer = null;
let doubleCreditMode = false;
let randomConfidence = false;
let pauseBeforeSubmit = false;
let confidenceLevel = "high";
let waitingForDuplicateCompletion = false;
let currentResponse = null;
let matchingPauseIntervalId = null;
const LOG_PREFIX = "[QuizBot]";

// Load settings on startup
chrome.storage.local.get(
  ["doubleCreditMode", "randomConfidence", "pauseBeforeSubmit", "confidenceLevel"],
  (data) => {
    doubleCreditMode = data.doubleCreditMode || false;
    randomConfidence = data.randomConfidence || false;
    pauseBeforeSubmit = data.pauseBeforeSubmit || false;
    confidenceLevel = data.confidenceLevel || "high";
  }
);

chrome.storage.onChanged.addListener((changes) => {
  if (changes.doubleCreditMode) doubleCreditMode = changes.doubleCreditMode.newValue;
  if (changes.randomConfidence) randomConfidence = changes.randomConfidence.newValue;
  if (changes.pauseBeforeSubmit) pauseBeforeSubmit = changes.pauseBeforeSubmit.newValue;
  if (changes.confidenceLevel) confidenceLevel = changes.confidenceLevel.newValue;
});

// ============================================================
// CONFIDENCE BUTTON
// ============================================================

function getConfidenceLevel() {
  if (!randomConfidence) return confidenceLevel || "high";
  const levels = ["high", "medium", "low"];
  return levels[Math.floor(Math.random() * levels.length)];
}

// Poll until the correct confidence button exists AND is not disabled.
async function waitForConfidenceButton(timeout = 12000) {
  const level = getConfidenceLevel();
  const start = Date.now();

  function isEnabled(btn) {
    if (!btn) return false;
    if (btn.disabled) return false;
    if (btn.getAttribute("disabled") !== null) return false;
    if (btn.getAttribute("aria-disabled") === "true") return false;
    return true;
  }

  // Confirmed primary selector from live DOM inspection
  const primarySelector = `[data-automation-id="confidence-buttons--${level}_confidence"]`;

  return new Promise((resolve) => {
    const check = () => {
      // Primary: exact data-automation-id, must be enabled
      const primary = document.querySelector(primarySelector);
      if (isEnabled(primary)) return resolve(primary);

      // Fallback 1: by class + aria-label
      const byAria = document.querySelector(`button.btn-confidence[aria-label*="${level}" i]`);
      if (isEnabled(byAria)) return resolve(byAria);

      // Fallback 2: any .btn-confidence with matching text
      for (const btn of document.querySelectorAll("button.btn-confidence")) {
        if (isEnabled(btn) && btn.textContent.trim().toLowerCase() === level) {
          return resolve(btn);
        }
      }

      // Fallback 3: text-content match in a sibling group
      const levelExact = { high: /^high$/i, medium: /^medium$/i, low: /^low$/i }[level];
      if (levelExact) {
        for (const btn of document.querySelectorAll("button")) {
          if (!isEnabled(btn) || !levelExact.test(btn.textContent.trim())) continue;
          const siblings = btn.parentElement?.querySelectorAll("button") || [];
          const texts = Array.from(siblings).map((s) => s.textContent.trim().toLowerCase());
          if (texts.includes("high") || texts.includes("medium") || texts.includes("low")) {
            return resolve(btn);
          } 
        }
      }

      if (Date.now() - start >= timeout) {
        // Log what we found to help debug future issues
        const found = document.querySelector(primarySelector);
        console.warn(LOG_PREFIX, `Confidence button timeout. Button exists: ${!!found}, disabled: ${found?.disabled}, aria-disabled: ${found?.getAttribute("aria-disabled")}`);
        return resolve(null);
      }
      setTimeout(check, 200);
    };

    check();
  });
}

// ============================================================
// UTILITY FUNCTIONS
// ============================================================

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function waitForElement(selector, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const interval = setInterval(() => {
      const el = document.querySelector(selector);
      if (el) {
        clearInterval(interval);
        resolve(el);
      } else if (Date.now() - start > timeout) {
        clearInterval(interval);
        reject(new Error("Element not found: " + selector));
      }
    }, 100);
  });
}

// Angular requires the full mousedown→mouseup→click sequence.
// A bare .click() is often swallowed by Angular's zone without triggering
// the (click) handler on the component.
function simulateClick(el) {
  if (!el) return;
  try { el.scrollIntoView({ block: "center", behavior: "instant" }); } catch {}
  try { el.focus(); } catch {}
  const opts = { bubbles: true, cancelable: true, view: window, detail: 1 };
  el.dispatchEvent(new MouseEvent("mouseenter", opts));
  el.dispatchEvent(new MouseEvent("mouseover",  opts));
  el.dispatchEvent(new MouseEvent("mousedown",  opts));
  el.dispatchEvent(new MouseEvent("mouseup",    opts));
  el.dispatchEvent(new MouseEvent("click",      opts));
  // Native click as final fallback in case Angular missed the synthetic event
  el.click();
}

function normalizeChoiceText(text) {
  if (typeof text !== "string") return "";
  return text
    .replace(/ /g, " ")
    .replace(/&amp;/gi, "&")
    .replace(/['']/g, "'")
    .replace(/[""]/g, '"')
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\.$/, "");
}

function stripWrappingQuotes(text) {
  if (typeof text !== "string") return "";
  const trimmed = text.trim();
  if (trimmed.length < 2) return trimmed;
  const f = trimmed[0], l = trimmed[trimmed.length - 1];
  if (f !== l || !/["'`]/.test(f)) return trimmed;
  return trimmed.slice(1, -1).trim();
}

function isAnswerMatch(choiceText, answerText) {
  if (!choiceText || answerText === null || answerText === undefined) return false;
  const choice = String(choiceText).trim();
  const answer = String(answerText).trim();
  if (!choice || !answer) return false;
  if (choice === answer) return true;
  if (choice.replace(/\.$/, "") === answer.replace(/\.$/, "")) return true;
  if (choice === answer + ".") return true;
  const nc = normalizeChoiceText(choice), na = normalizeChoiceText(answer);
  if (nc === na) return true;
  return (
    normalizeChoiceText(stripWrappingQuotes(choice)) ===
    normalizeChoiceText(stripWrappingQuotes(answer))
  );
}

// ============================================================
// QUESTION TYPE DETECTION
// ============================================================

function detectQuestionType(container) {
  if (container.querySelector(".awd-probe-type-multiple_choice")) return "multiple_choice";
  if (container.querySelector(".awd-probe-type-true_false")) return "true_false";
  if (container.querySelector(".awd-probe-type-multiple_select")) return "multiple_select";
  if (container.querySelector(".awd-probe-type-fill_in_the_blank")) return "fill_in_the_blank";
  if (container.querySelector(".awd-probe-type-select_text")) return "select_text";
  if (container.querySelector(".awd-probe-type-matching")) return "matching";
  return "";
}

// ============================================================
// ANSWER PARSING HELPERS
// ============================================================

function tryParseAnswerArrayString(value) {
  if (typeof value !== "string") return null;
  const t = value.trim();
  if (!(t.startsWith("[") && t.endsWith("]"))) return null;
  try {
    const p = JSON.parse(t);
    return Array.isArray(p) ? p : null;
  } catch { return null; }
}

function flattenAnswerValues(value, out = []) {
  if (value === null || value === undefined) return out;
  if (Array.isArray(value)) { value.forEach((v) => flattenAnswerValues(v, out)); return out; }
  if (typeof value === "string") {
    const arr = tryParseAnswerArrayString(value);
    if (arr) { flattenAnswerValues(arr, out); return out; }
    if (value.trim()) out.push(value.trim());
    return out;
  }
  out.push(String(value));
  return out;
}

function splitCompoundAnswer(text) {
  if (typeof text !== "string") return [];
  const t = text.trim();
  if (!t) return [];
  let parts = t.split(/\n|;|,/).map((p) =>
    p.trim().replace(/^[-*•]\s*/, "").replace(/^\d+[\).\-\s]+/, "").replace(/^["'`]|["'`]$/g, "").trim()
  ).filter(Boolean);
  if (parts.length <= 1 && /\band\b/i.test(t)) {
    parts = t.split(/\band\b/i).map((p) => p.trim().replace(/^[-*•]\s*/, "").trim()).filter(Boolean);
  }
  return parts;
}

function dedupeAnswers(answers) {
  const seen = new Set();
  return answers.filter((a) => {
    const n = normalizeChoiceText(a).toLowerCase();
    if (!n || seen.has(n)) return false;
    seen.add(n);
    return true;
  });
}

function getQuestionChoices(container, questionType) {
  if (questionType === "select_text") {
    return Array.from(container.querySelectorAll(".select-text-component .choice.-interactive"))
      .map((el) => el.textContent.trim()).filter(Boolean);
  }
  return Array.from(container.querySelectorAll(".choiceText"))
    .map((el) => el.textContent.trim()).filter(Boolean);
}

function extractChoicesFromCombinedAnswer(answerText, questionChoices) {
  if (typeof answerText !== "string" || !questionChoices.length) return [];
  const norm = normalizeChoiceText(answerText).toLowerCase();
  if (!norm) return [];
  return questionChoices.filter((c) => {
    const nc = normalizeChoiceText(c).toLowerCase();
    return nc && norm.includes(nc);
  });
}

function normalizeResponseAnswers(rawAnswer, questionType, container) {
  if (questionType === "matching") return formatMatchingTargetsForAlert(container, rawAnswer);
  const flat = flattenAnswerValues(rawAnswer);
  if (!flat.length) return [];
  const isMulti = questionType === "multiple_select" || questionType === "select_text";
  if (isMulti && flat.length === 1) {
    const choices = getQuestionChoices(container, questionType);
    const extracted = extractChoicesFromCombinedAnswer(flat[0], choices);
    if (extracted.length > 0) return dedupeAnswers(extracted);
    const split = splitCompoundAnswer(flat[0]);
    if (split.length > 1) return dedupeAnswers(split);
  }
  return dedupeAnswers(flat);
}

// ============================================================
// ANSWER EXTRACTION (for correction feedback)
// ============================================================

function extractCorrectAnswer() {
  const container = document.querySelector(".probe-container");
  if (!container) return null;
  if (!container.querySelector(".awd-probe-correctness.incorrect")) return null;
  const questionType = detectQuestionType(container);
  if (questionType === "matching") return null;

  let questionText = "";
  const promptEl = container.querySelector(".prompt");
  if (questionType === "fill_in_the_blank" && promptEl) {
    const clone = promptEl.cloneNode(true);
    clone.querySelectorAll("span.fitb-span, span.blank-label, span.correctness, span._visuallyHidden").forEach((s) => s.remove());
    clone.querySelectorAll("input.fitb-input").forEach((inp) => {
      inp.parentNode.replaceChild(document.createTextNode("[BLANK]"), inp);
    });
    questionText = clone.textContent.trim();
  } else {
    questionText = promptEl ? promptEl.textContent.trim() : "";
  }

  let correctAnswer = null;
  try {
    if (questionType === "multiple_choice" || questionType === "true_false") {
      const el =
        container.querySelector(".answer-container .choiceText") ||
        container.querySelector(".correct-answer-container .choiceText") ||
        container.querySelector(".correct-answer-container .choice");
      if (el) correctAnswer = el.textContent.trim();
    } else if (questionType === "multiple_select") {
      const els = container.querySelectorAll(".correct-answer-container .choice");
      if (els.length) {
        correctAnswer = Array.from(els).map((e) => {
          const ct = e.querySelector(".choiceText");
          return ct ? ct.textContent.trim() : e.textContent.trim();
        });
      }
    } else if (questionType === "fill_in_the_blank") {
      const fields = container.querySelectorAll(".correct-answers");
      if (fields.length === 1) {
        const ca = fields[0].querySelector(".correct-answer");
        if (ca) {
          correctAnswer = ca.textContent.trim();
        } else {
          const t = fields[0].textContent.trim();
          const m = t.match(/:\s*(.+)$/);
          correctAnswer = m ? m[1].trim() : t;
        }
      } else if (fields.length > 1) {
        correctAnswer = Array.from(fields).map((f) => {
          const ca = f.querySelector(".correct-answer");
          if (ca) return ca.textContent.trim();
          const t = f.textContent.trim();
          const m = t.match(/:\s*(.+)$/);
          return m ? m[1].trim() : t;
        });
      }
    } else if (questionType === "select_text") {
      const els = Array.from(
        container.querySelectorAll(
          ".correct-answer-container .choice.-interactive, .correct-answer-container .choiceText, .correct-answer-container .choice"
        )
      ).map((e) => e.textContent.trim()).filter(Boolean);
      correctAnswer = els.length === 1 ? els[0] : els.length > 1 ? els : null;
    }
  } catch (e) {
    console.error(LOG_PREFIX, "Error extracting correct answer:", e);
  }

  if (!correctAnswer) return null;
  return { question: questionText, answer: correctAnswer, type: questionType };
}

function cleanAnswer(answer) {
  if (!answer) return answer;
  if (Array.isArray(answer)) return answer.map(cleanAnswer);
  if (typeof answer === "string") {
    let a = answer.trim().replace(/^Field \d+:\s*/, "");
    if (a.includes(" or ")) a = a.split(" or ")[0].trim();
    return a;
  }
  return answer;
}

function checkForCorrectAnswer(container) {
  if (container.querySelector(".awd-probe-correctness.incorrect")) {
    const data = extractCorrectAnswer();
    if (data?.answer) {
      lastIncorrectQuestion = data.question;
      lastCorrectAnswer = cleanAnswer(data.answer);
    }
  }
}

// ============================================================
// FILL IN ANSWERS
// ============================================================

function fillInAnswers(answers, container) {
  if (container.querySelector(".awd-probe-type-fill_in_the_blank")) {
    const inputs = container.querySelectorAll("input.fitb-input");
    inputs.forEach((input, i) => {
      if (answers[i] !== undefined) {
        input.value = answers[i];
        input.dispatchEvent(new Event("input",  { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });
    return;
  }

  // For radio/checkbox: use native .click() on the input element.
  // This is the only reliable method — it both sets checked=true AND fires
  // the native change event that Angular's model binding listens for.
  // Synthetic MouseEvent dispatches alone don't set the checked property.
  const choices = container.querySelectorAll('input[type="radio"], input[type="checkbox"]');
  choices.forEach((choice) => {
    const label = choice.closest("label");
    if (!label) return;
    const choiceText = label.querySelector(".choiceText")?.textContent.trim();
    if (!choiceText) return;
    if (answers.some((ans) => isAnswerMatch(choiceText, ans))) {
      choice.click();
      // Belt-and-suspenders: explicit change event for Angular's (change) binding
      choice.dispatchEvent(new Event("change", { bubbles: true }));
    }
  });
}

// ============================================================
// QUESTION PARSING
// ============================================================

function parseQuestion() {
  const container = document.querySelector(".probe-container");
  if (!container) {
    alert("QuizBot: No question found on the page.");
    return null;
  }

  const questionType = detectQuestionType(container);
  let questionText = "";
  const promptEl = container.querySelector(".prompt");

  if (questionType === "fill_in_the_blank" && promptEl) {
    const clone = promptEl.cloneNode(true);
    clone.querySelectorAll("span.fitb-span, span.blank-label, span.correctness, span._visuallyHidden").forEach((s) => s.remove());
    clone.querySelectorAll("input.fitb-input").forEach((inp) => {
      inp.parentNode.replaceChild(document.createTextNode("[BLANK]"), inp);
    });
    questionText = clone.textContent.trim();
  } else {
    questionText = promptEl ? promptEl.textContent.trim() : "";
  }

  let options = [];
  if (questionType === "matching") {
    const prompts = getMatchingRows(container).map((r) => getMatchingPromptText(r)).filter(Boolean);
    const choices = dedupeAnswers(
      getMatchingChoiceItems(container).map((item) => getMatchingChoiceText(item)).filter(Boolean)
    );
    options = { prompts, choices };
  } else if (questionType === "select_text") {
    options = Array.from(container.querySelectorAll(".select-text-component .choice.-interactive"))
      .map((el) => el.textContent.trim()).filter(Boolean);
  } else if (questionType !== "fill_in_the_blank") {
    container.querySelectorAll(".choiceText").forEach((el) => {
      options.push(el.textContent.trim());
    });
  }

  return {
    type: questionType,
    question: questionText,
    options,
    previousCorrection: lastIncorrectQuestion
      ? { question: lastIncorrectQuestion, correctAnswer: lastCorrectAnswer }
      : null,
  };
}

// ============================================================
// MATCHING QUESTION LOGIC
// ============================================================

const MATCHING_ALL_CHOICE_SELECTOR =
  '.choice-item-wrapper:not(.-placeholder)[id^="choices:"], .choice-item-wrapper:not(.-placeholder)[id^="response:"]';
const MATCHING_POOL_CHOICE_SELECTOR =
  '.choices-container .choice-item-wrapper:not(.-placeholder)[id^="choices:"]';
const MATCHING_ROW_CHOICE_SELECTOR =
  '.match-single-response-wrapper .choice-item-wrapper:not(.-placeholder)[id^="choices:"], .match-single-response-wrapper .choice-item-wrapper:not(.-placeholder)[id^="response:"]';

function getMatchingComponent(container) {
  return container?.querySelector(".matching-component") || null;
}
function getMatchingRows(container) {
  const mc = getMatchingComponent(container);
  return mc ? Array.from(mc.querySelectorAll(".responses-container .match-row")) : [];
}
function getMatchingPromptText(row) {
  const el = row?.querySelector(".match-prompt .content") || row?.querySelector(".match-prompt");
  return normalizeChoiceText(el?.textContent || "");
}
function getMatchingChoiceText(item) {
  const el = item?.querySelector(".content") || item?.querySelector("p");
  return normalizeChoiceText((el ? el.textContent : item?.textContent) || "");
}
function getMatchingChoiceItems(container) {
  const mc = getMatchingComponent(container);
  return mc ? Array.from(mc.querySelectorAll(MATCHING_ALL_CHOICE_SELECTOR)) : [];
}
function getMatchingDragHandle(item) {
  if (!item) return null;
  if (item.matches?.("[data-react-beautiful-dnd-drag-handle]")) return item;
  return item.querySelector("[data-react-beautiful-dnd-drag-handle]") || item;
}
function getMatchingPoolChoiceItems(container) {
  const mc = getMatchingComponent(container);
  return mc ? Array.from(mc.querySelectorAll(MATCHING_POOL_CHOICE_SELECTOR)) : [];
}
function getMatchingRowChoiceItem(row) {
  return row?.querySelector(MATCHING_ROW_CHOICE_SELECTOR) || null;
}
function getMatchingChoiceLocation(container, choiceText) {
  const rows = getMatchingRows(container);
  for (let i = 0; i < rows.length; i++) {
    const rc = getMatchingRowChoiceItem(rows[i]);
    if (rc && isAnswerMatch(getMatchingChoiceText(rc), choiceText)) {
      return { area: "row", rowIndex: i, poolIndex: -1, item: rc };
    }
  }
  const pool = getMatchingPoolChoiceItems(container);
  for (let i = 0; i < pool.length; i++) {
    if (isAnswerMatch(getMatchingChoiceText(pool[i]), choiceText)) {
      return { area: "pool", rowIndex: -1, poolIndex: i, item: pool[i] };
    }
  }
  return null;
}

function parseMatchingAnswerReference(ref, candidates, label = "") {
  if (!candidates?.length) return "";
  const norm = normalizeChoiceText(String(ref || ""));
  if (!norm) return "";
  const numMatch = norm.match(/^#?(\d+)$/);
  if (numMatch) {
    const idx = Number(numMatch[1]) - 1;
    if (idx >= 0 && idx < candidates.length) return candidates[idx];
  }
  const prefixRe = label === "prompt" ? /^(?:prompt|row|left)\s*#?\s*/i : /^(?:choice|option|item|right|match)\s*#?\s*/i;
  const stripped = norm.replace(prefixRe, "").trim();
  const numMatch2 = stripped.match(/^#?(\d+)$/);
  if (numMatch2) {
    const idx = Number(numMatch2[1]) - 1;
    if (idx >= 0 && idx < candidates.length) return candidates[idx];
  }
  const variants = dedupeAnswers([stripped, stripWrappingQuotes(stripped)]).filter(Boolean);
  for (const v of variants) {
    const exact = candidates.find((c) => isAnswerMatch(c, v));
    if (exact) return exact;
  }
  for (const v of variants) {
    const nl = normalizeChoiceText(v).toLowerCase();
    if (!nl) continue;
    const partial = candidates.find((c) => {
      const cn = normalizeChoiceText(c).toLowerCase();
      return cn && (cn.includes(nl) || nl.includes(cn));
    });
    if (partial) return partial;
  }
  return "";
}

function splitMatchingAnswerSegments(text) {
  const segs = text.split(/\n|;/).map((s) => s.trim().replace(/^[-*•]\s*/, "").trim()).filter(Boolean);
  const out = [];
  segs.forEach((seg) => {
    const dc = (seg.match(/->|=>|:/g) || []).length;
    if (seg.includes(",") && dc > 1) {
      seg.split(",").map((p) => p.trim()).filter(Boolean).forEach((p) => out.push(p));
    } else {
      out.push(seg);
    }
  });
  return out;
}

function parseMatchingPairString(text) {
  let t = text.trim().replace(/^[-*•]\s*/, "").trim();
  if (!/(?:->|=>|:)/.test(t)) t = t.replace(/^\d+[\.)]\s+/, "").trim();
  if (!t) return null;
  const arrow = t.match(/^(.*?)\s*(?:->|=>)\s*(.+)$/);
  if (arrow) return { promptRef: arrow[1].trim(), choiceRef: arrow[2].trim() };
  const colon = t.match(/^(.*?)\s*:\s*(.+)$/);
  if (colon) return { promptRef: colon[1].trim(), choiceRef: colon[2].trim() };
  return null;
}

function collectMatchingAnswerEntries(raw, out) {
  if (!out || raw == null) return;
  if (Array.isArray(raw)) { raw.forEach((e) => collectMatchingAnswerEntries(e, out)); return; }
  if (typeof raw === "object") {
    const pc = raw.prompt ?? raw.left ?? raw.source ?? raw.from ?? raw.key;
    const cc = raw.choice ?? raw.match ?? raw.right ?? raw.target ?? raw.to ?? raw.answer ?? raw.value;
    if (pc !== undefined && cc !== undefined) { out.pairs.push({ promptRef: String(pc), choiceRef: String(cc) }); return; }
    Object.entries(raw).forEach(([k, v]) => out.pairs.push({ promptRef: String(k), choiceRef: String(v) }));
    return;
  }
  if (typeof raw === "string") {
    const arr = tryParseAnswerArrayString(raw);
    if (arr) { collectMatchingAnswerEntries(arr, out); return; }
    const segs = splitMatchingAnswerSegments(raw);
    if (!segs.length) {
      const c = normalizeChoiceText(raw);
      if (c) { out.rawStrings.push(c); out.sequentialChoices.push(c); }
      return;
    }
    segs.forEach((seg) => {
      const pair = parseMatchingPairString(seg);
      if (pair) { out.pairs.push(pair); } else {
        const c = normalizeChoiceText(seg);
        if (c) { out.rawStrings.push(c); out.sequentialChoices.push(c); }
      }
    });
    return;
  }
  const n = normalizeChoiceText(String(raw));
  if (n) { out.rawStrings.push(n); out.sequentialChoices.push(n); }
}

function normalizeMatchingTargets(container, rawAnswer) {
  const rows = getMatchingRows(container);
  if (!rows.length) return [];
  const prompts = rows.map((r) => getMatchingPromptText(r));
  const choices = dedupeAnswers(getMatchingChoiceItems(container).map((i) => getMatchingChoiceText(i)).filter(Boolean));
  if (!prompts.length || !choices.length) return [];

  const collected = { pairs: [], sequentialChoices: [], rawStrings: [] };
  collectMatchingAnswerEntries(rawAnswer, collected);

  const byRow = new Map();
  collected.pairs.forEach((pair) => {
    const pt = parseMatchingAnswerReference(pair.promptRef, prompts, "prompt");
    const ct = parseMatchingAnswerReference(pair.choiceRef, choices, "choice");
    if (!pt || !ct) return;
    const ri = prompts.findIndex((p) => isAnswerMatch(p, pt));
    if (ri < 0 || byRow.has(ri)) return;
    byRow.set(ri, { rowIndex: ri, promptText: prompts[ri], choiceText: ct });
  });

  if (!byRow.size && collected.sequentialChoices.length === prompts.length) {
    const ordered = collected.sequentialChoices
      .map((cr) => parseMatchingAnswerReference(cr, choices, "choice"))
      .filter(Boolean);
    if (ordered.length === prompts.length) {
      ordered.forEach((ct, ri) => byRow.set(ri, { rowIndex: ri, promptText: prompts[ri], choiceText: ct }));
    }
  }

  return prompts.map((pt, ri) => {
    const t = byRow.get(ri);
    return { rowIndex: ri, promptText: pt, choiceText: t ? t.choiceText : "" };
  });
}

function formatMatchingTargetsForAlert(container, rawAnswer) {
  const resolved = normalizeMatchingTargets(container, rawAnswer);
  const lines = resolved.filter((t) => t.choiceText).map((t) => `${t.promptText} -> ${t.choiceText}`);
  if (lines.length) return lines;
  const collected = { pairs: [], sequentialChoices: [], rawStrings: [] };
  collectMatchingAnswerEntries(rawAnswer, collected);
  const pairLines = collected.pairs.map((p) => {
    const pr = normalizeChoiceText(p.promptRef), cr = normalizeChoiceText(p.choiceRef);
    return pr && cr ? `${pr} -> ${cr}` : "";
  }).filter(Boolean);
  return dedupeAnswers([...pairLines, ...collected.sequentialChoices, ...collected.rawStrings].filter(Boolean));
}

function getMatchingSnapshot(container) {
  return getMatchingRows(container).map((row, ri) => {
    const rc = getMatchingRowChoiceItem(row);
    return { rowIndex: ri, promptText: getMatchingPromptText(row), choiceText: rc ? getMatchingChoiceText(rc) : "" };
  });
}

function isMatchingAligned(container, targets) {
  if (!container || !Array.isArray(targets) || !targets.length) return false;
  const rows = getMatchingRows(container);
  if (rows.length !== targets.length) return false;
  for (let i = 0; i < rows.length; i++) {
    const t = targets[i];
    if (!t?.choiceText) return false;
    if (!isAnswerMatch(getMatchingChoiceText(getMatchingRowChoiceItem(rows[i])), t.choiceText)) return false;
  }
  return true;
}

function createKeyboardEvent(type, key, code, keyCode) {
  const e = new KeyboardEvent(type, { key, code, bubbles: true, cancelable: true, composed: true, keyCode, which: keyCode });
  try { Object.defineProperty(e, "keyCode", { get: () => keyCode }); Object.defineProperty(e, "which", { get: () => keyCode }); } catch {}
  return e;
}
function dispatchKeyboardSequence(target, key, code, keyCode) {
  if (!target) return;
  target.dispatchEvent(createKeyboardEvent("keydown", key, code, keyCode));
  target.dispatchEvent(createKeyboardEvent("keyup", key, code, keyCode));
}

async function moveMatchingChoiceToRow(container, choiceText, targetRowIndex, liftConfig = { key: " ", code: "Space", keyCode: 32 }) {
  if (!container || !choiceText || targetRowIndex < 0) return false;
  const rows = getMatchingRows(container);
  const loc = getMatchingChoiceLocation(container, choiceText);
  if (!loc) return false;
  if (loc.rowIndex === targetRowIndex) return true;
  const handle = getMatchingDragHandle(loc.item);
  if (!handle) return false;
  try { handle.focus({ preventScroll: true }); } catch { handle.focus(); }
  await delay(40);
  dispatchKeyboardSequence(handle, liftConfig.key, liftConfig.code, liftConfig.keyCode);
  await delay(80);
  let moveKey = "ArrowUp", moveCode = "ArrowUp", moveKC = 38, count = 0;
  if (loc.area === "row") {
    const delta = targetRowIndex - loc.rowIndex;
    count = Math.abs(delta);
    if (delta > 0) { moveKey = "ArrowDown"; moveCode = "ArrowDown"; moveKC = 40; }
  } else {
    count = loc.poolIndex + (rows.length - targetRowIndex);
  }
  for (let i = 0; i < count; i++) {
    dispatchKeyboardSequence(handle, moveKey, moveCode, moveKC);
    await delay(70);
  }
  dispatchKeyboardSequence(handle, liftConfig.key, liftConfig.code, liftConfig.keyCode);
  await delay(120);
  const final = getMatchingChoiceLocation(container, choiceText);
  return Boolean(final && final.rowIndex === targetRowIndex);
}

async function applyMatchingAnswer(container, rawAnswer) {
  const rows = getMatchingRows(container);
  if (!rows.length) return false;
  const targets = normalizeMatchingTargets(container, rawAnswer);
  if (!targets.length || targets.some((t) => !t.choiceText)) return false;

  const liftStrategies = [
    { key: " ", code: "Space", keyCode: 32 },
    { key: "Enter", code: "Enter", keyCode: 13 },
  ];

  for (let pass = 1; pass <= 4; pass++) {
    if (isMatchingAligned(container, targets)) return true;
    for (let ri = 0; ri < targets.length; ri++) {
      const t = targets[ri];
      if (!t.choiceText) continue;
      const loc = getMatchingChoiceLocation(container, t.choiceText);
      if (!loc || loc.rowIndex === ri) continue;
      for (const strat of liftStrategies) {
        const cur = getMatchingChoiceLocation(container, t.choiceText);
        if (!cur) break;
        if (cur.rowIndex === ri) break;
        if (await moveMatchingChoiceToRow(container, t.choiceText, ri, strat)) break;
      }
    }
  }
  return isMatchingAligned(container, targets);
}

// ============================================================
// NAVIGATION HELPERS
// ============================================================

function handleTopicOverview() {
  const btn = document.querySelector("awd-topic-overview-button-bar .next-button, .button-bar-wrapper .next-button");
  if (btn && btn.textContent.trim().toLowerCase().includes("continue")) {
    btn.click();
    if (isAutomating) setTimeout(() => checkForNextStep(), 1000);
    return true;
  }
  return false;
}

function handleForcedLearning() {
  const alert = document.querySelector(".forced-learning .alert-error");
  if (alert) {
    const readBtn = document.querySelector('[data-automation-id="lr-tray_reading-button"]');
    if (readBtn) {
      readBtn.click();
      waitForElement('[data-automation-id="reading-questions-button"]', 10000)
        .then((b) => { b.click(); return waitForElement(".next-button", 10000); })
        .then((b) => { b.click(); if (isAutomating) setTimeout(() => checkForNextStep(), 1000); })
        .catch((e) => {
          console.error(LOG_PREFIX, "Forced learning error:", e);
          isAutomating = false;
          clearMatchingPauseWatcher();
          updateButtonState();
        });
      return true;
    }
  }
  return false;
}

function getQuestionSignature(container) {
  if (!container) return "";
  const qt = detectQuestionType(container);
  const pt = container.querySelector(".prompt")?.textContent?.trim() || "";
  if (qt === "matching") {
    const prompts = Array.from(container.querySelectorAll(".match-prompt .content"))
      .map((e) => normalizeChoiceText(e.textContent)).filter(Boolean).join("|");
    return `${qt}::${normalizeChoiceText(pt)}::${prompts}`;
  }
  return `${qt}::${normalizeChoiceText(pt)}`;
}

function pauseForManualMatchingAndResume(sig) {
  clearMatchingPauseWatcher();
  matchingPauseIntervalId = setInterval(() => {
    if (!isAutomating) { clearMatchingPauseWatcher(); return; }
    const c = document.querySelector(".probe-container");
    if (!c) return;
    if (getQuestionSignature(c) !== sig) {
      clearMatchingPauseWatcher();
      if (isAutomating) setTimeout(() => checkForNextStep(), 500);
    }
  }, 400);
}

function clearMatchingPauseWatcher() {
  if (matchingPauseIntervalId !== null) {
    clearInterval(matchingPauseIntervalId);
    matchingPauseIntervalId = null;
  }
}

// ============================================================
// SEND QUESTION TO AI (unified for both API and tab modes)
// ============================================================

function sendQuestionToAI(questionData) {
  return new Promise((resolve, reject) => {
    let resolved = false;
    const TIMEOUT = 150000;

    const timeoutId = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        chrome.runtime.onMessage.removeListener(msgHandler);
        reject(new Error("AI response timeout (150s)"));
      }
    }, TIMEOUT);

    // Handler for tab mode: background sends back "questionAnswered"
    const msgHandler = (msg) => {
      if (msg.action === "questionAnswered" && !resolved) {
        resolved = true;
        clearTimeout(timeoutId);
        chrome.runtime.onMessage.removeListener(msgHandler);
        if (msg.success) {
          resolve({ answer: msg.answer, explanation: msg.explanation || "" });
        } else {
          reject(new Error(msg.error || "AI error"));
        }
      }
    };
    chrome.runtime.onMessage.addListener(msgHandler);

    // Send the question
    chrome.runtime.sendMessage({ action: "processQuestion", question: questionData }, (res) => {
      if (chrome.runtime.lastError) {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeoutId);
          chrome.runtime.onMessage.removeListener(msgHandler);
          reject(new Error(chrome.runtime.lastError.message));
        }
        return;
      }
      // API mode: direct response with answer
      if (res && res.success === true && !resolved) {
        resolved = true;
        clearTimeout(timeoutId);
        chrome.runtime.onMessage.removeListener(msgHandler);
        resolve({ answer: res.answer, explanation: res.explanation || "" });
        return;
      }
      if (res && res.success === false && !resolved) {
        resolved = true;
        clearTimeout(timeoutId);
        chrome.runtime.onMessage.removeListener(msgHandler);
        reject(new Error(res.error || "API error"));
        return;
      }
      // Tab mode: {received: true} — keep waiting for questionAnswered message
    });
  });
}

// ============================================================
// PROCESS AI RESPONSE
// ============================================================

async function processAIResponse(result) {
  if (handleTopicOverview()) return;
  if (handleForcedLearning()) return;

  const container = document.querySelector(".probe-container");
  if (!container) return;

  const questionType = detectQuestionType(container);
  const answers = normalizeResponseAnswers(result.answer, questionType, container);

  lastIncorrectQuestion = null;
  lastCorrectAnswer = null;

  if (questionType === "matching") {
    const applied = await applyMatchingAnswer(container, result.answer);
    if (!applied) {
      const sig = getQuestionSignature(container);
      alert(
        "QuizBot Matching Solution:\n\n" +
          (answers.length ? answers.join("\n") : "No confident matches parsed.") +
          "\n\nPlease input these matches manually, then click a confidence button and Next.\n" +
          "Automation will resume after you advance to the next question."
      );
      if (isAutomating) pauseForManualMatchingAndResume(sig);
      return;
    }
  } else if (questionType === "select_text") {
    container.querySelectorAll(".select-text-component .choice.-interactive").forEach((choice) => {
      if (answers.some((a) => isAnswerMatch(choice.textContent.trim(), a))) simulateClick(choice);
    });
  } else {
    fillInAnswers(answers, container);
  }

  if (!isAutomating) return;

  if (pauseBeforeSubmit) {
    waitForElement(".next-button", 120000)
      .then((nextBtn) => {
        const obs = new MutationObserver(() => {
          if (nextBtn.offsetParent === null) {
            obs.disconnect();
            setTimeout(() => { if (isAutomating) checkForNextStep(); }, 1000);
          }
        });
        obs.observe(document.body, { childList: true, subtree: true });
      })
      .catch(() => {});
    return;
  }

  // Give Angular time to process the filled answer before attempting to click
  await delay(600);

  // Click confidence button
  const confBtn = await waitForConfidenceButton(12000);
  if (confBtn) {
    simulateClick(confBtn);
    console.log(LOG_PREFIX, "Clicked confidence button:", confBtn.getAttribute("data-automation-id") || confBtn.textContent.trim());
  } else {
    console.warn(LOG_PREFIX, "Could not find confidence button after 12s — continuing anyway");
  }

  // Wait for SmartBook to register the confidence click and reveal the next button
  await delay(1200);
  checkForCorrectAnswer(container);

  try {
    const nextBtn = await waitForElement(".next-button", 12000);
    simulateClick(nextBtn);
    setTimeout(() => { if (isAutomating) checkForNextStep(); }, 1200);
  } catch {
    console.error(LOG_PREFIX, "Could not find .next-button after confidence click");
    isAutomating = false;
    clearMatchingPauseWatcher();
    updateButtonState();
  }
}

// ============================================================
// DOUBLE CREDIT MODE
// ============================================================

function processDoubleCreditResponse(responseObj) {
  if (handleTopicOverview()) return;
  if (handleForcedLearning()) return;

  const answers = Array.isArray(responseObj.answer)
    ? responseObj.answer
    : [responseObj.answer];

  const container = document.querySelector(".probe-container");
  if (!container) return;

  if (container.querySelector(".awd-probe-type-matching")) {
    alert("Matching questions are not supported in double credit mode. Please complete manually.");
    isAutomating = false;
    updateButtonState();
    return;
  }

  fillInAnswers(answers, container);

  waitingForDuplicateCompletion = true;
  chrome.runtime.sendMessage({
    type: "createDuplicateTab",
    response: JSON.stringify(responseObj),
  });
}

function processDuplicateTabAnswering(responseText) {
  let response;
  try {
    response = JSON.parse(responseText);
  } catch (e) {
    console.error(LOG_PREFIX, "Failed to parse duplicate tab response:", e);
    return;
  }

  const answers = Array.isArray(response.answer) ? response.answer : [response.answer];

  waitForElement(".probe-container", 5000)
    .then(async (container) => {
      await delay(600);
      fillInAnswers(answers, container);
      await delay(600);

      const confBtn = await waitForConfidenceButton(5000);
      if (confBtn) {
        simulateClick(confBtn);
      } else {
        console.warn(LOG_PREFIX, "Duplicate tab: no confidence button found");
      }

      await delay(1000);
      chrome.runtime.sendMessage({ type: "finishDoubleCredit" });
      setTimeout(() => chrome.runtime.sendMessage({ type: "closeDuplicateTab" }), 300);
    })
    .catch((e) => console.error(LOG_PREFIX, "Duplicate tab error:", e));
}

function completeDoubleCreditFlow() {
  waitingForDuplicateCompletion = false;
  const container = document.querySelector(".probe-container");
  if (!container) return;

  waitForConfidenceButton(5000).then(async (confBtn) => {
    if (confBtn) simulateClick(confBtn);
    await delay(1200);
    checkForCorrectAnswer(container);

    try {
      const nextBtn = await waitForElement(".next-button", 8000);
      simulateClick(nextBtn);
      chrome.runtime.sendMessage({ type: "resetTabTracking" });
      if (isAutomating) setTimeout(() => checkForNextStep(), 800);
    } catch (e) {
      console.error(LOG_PREFIX, "Double credit: next button not found:", e);
      isAutomating = false;
      updateButtonState();
    }
  });
}

// ============================================================
// MAIN AUTOMATION LOOP
// ============================================================

async function checkForNextStep() {
  if (!isAutomating) return;
  if (handleTopicOverview()) return;
  if (handleForcedLearning()) return;

  const container = document.querySelector(".probe-container");
  if (!container || container.querySelector(".forced-learning")) return;

  const qData = parseQuestion();
  if (!qData) return;

  try {
    const result = await sendQuestionToAI(qData);
    if (!isAutomating) return;

    if (doubleCreditMode && !waitingForDuplicateCompletion) {
      currentResponse = result;
      processDoubleCreditResponse(result);
    } else {
      await processAIResponse(result);
    }
  } catch (err) {
    console.error(LOG_PREFIX, "Automation error:", err);
    // Show user-friendly alert for common errors
    if (err.message.includes("No API key") || err.message.includes("no") || err.message.includes("tab found")) {
      alert("QuizBot: " + err.message);
    }
    isAutomating = false;
    clearMatchingPauseWatcher();
    updateButtonState();
  }
}

// ============================================================
// UI BUTTON INJECTION
// ============================================================

let extensionUiHidden = false;

function applyHiddenState() {
  const container = document.querySelector(".quizbot-btn-container");
  if (container) container.style.display = extensionUiHidden ? "none" : "flex";
}

document.addEventListener("keydown", (e) => {
  if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
  if (e.code !== "KeyZ" && e.key !== "z" && e.key !== "Z") return;
  e.preventDefault();
  extensionUiHidden = !extensionUiHidden;
  applyHiddenState();
}, true);

function updateButtonState() {
  const btn = document.querySelector(".quizbot-btn");
  if (!btn) return;
  btn.textContent = isAutomating ? "Stop QuizBot" : "QuizBot";
  btn.style.background = isAutomating ? "#e53935" : "#1565c0";
}

function addAssistantButton() {
  waitForElement("awd-header .header__navigation").then((nav) => {
    if (document.querySelector(".quizbot-btn-container")) return;

    const container = document.createElement("div");
    container.className = "quizbot-btn-container";
    container.style.cssText = "display:flex;margin-left:10px;";

    const btn = document.createElement("button");
    btn.className = "btn btn-secondary quizbot-btn";
    btn.textContent = "QuizBot";
    btn.style.cssText =
      "background:#1565c0;color:#fff;border:none;border-radius:4px 0 0 4px;" +
      "padding:6px 14px;cursor:pointer;font-weight:600;font-size:13px;transition:background 0.2s;";

    btn.addEventListener("click", () => {
      if (isAutomating) {
        isAutomating = false;
        waitingForDuplicateCompletion = false;
        clearMatchingPauseWatcher();
        chrome.runtime.sendMessage({ type: "resetTabTracking" });
        updateButtonState();
      } else {
        const ok = confirm("Start QuizBot automation?\n\nClick OK to begin automatically answering questions, or Cancel to stop.");
        if (ok) {
          isAutomating = true;
          clearMatchingPauseWatcher();
          updateButtonState();
          checkForNextStep();
        }
      }
    });

    const settingsBtn = document.createElement("button");
    settingsBtn.className = "btn btn-secondary";
    settingsBtn.title = "QuizBot Settings";
    settingsBtn.style.cssText =
      "background:#1565c0;color:#fff;border:none;border-left:1px solid rgba(255,255,255,0.3);" +
      "border-radius:0 4px 4px 0;padding:6px 10px;cursor:pointer;transition:background 0.2s;";
    settingsBtn.innerHTML =
      `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">` +
      `<circle cx="12" cy="12" r="3"></circle>` +
      `<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path>` +
      `</svg>`;
    settingsBtn.addEventListener("click", () => chrome.runtime.sendMessage({ type: "openSettings" }));

    container.appendChild(btn);
    container.appendChild(settingsBtn);
    nav.appendChild(container);
    applyHiddenState();
  });
}

// ============================================================
// MESSAGE LISTENER
// ============================================================

let messageListener = null;
function setupMessageListener() {
  if (messageListener) chrome.runtime.onMessage.removeListener(messageListener);

  messageListener = (message, sender, sendResponse) => {
    if (message.type === "ping") {
      sendResponse({ received: true, ready: !!document.querySelector(".probe-container") });
      return true;
    }

    // Double credit: this tab IS the duplicate
    if (message.type === "processDuplicateTab") {
      processDuplicateTabAnswering(message.response);
      sendResponse({ received: true });
      return true;
    }

    // Double credit: original tab finishes after duplicate done
    if (message.type === "completeDoubleCredit") {
      completeDoubleCreditFlow();
      sendResponse({ received: true });
      return true;
    }

    if (message.type === "alertMessage") {
      alert(message.message);
      sendResponse({ received: true });
      return true;
    }

    if (message.type === "stopAutomation") {
      isAutomating = false;
      clearMatchingPauseWatcher();
      updateButtonState();
      sendResponse({ received: true });
      return true;
    }
  };

  chrome.runtime.onMessage.addListener(messageListener);
}

// ============================================================
// INIT
// ============================================================

setupMessageListener();
addAssistantButton();
