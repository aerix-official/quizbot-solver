<div align="center">

# 🤖 QuizBot — SmartBook Solver

[![Releases](https://img.shields.io/badge/Releases-Latest-blue?style=flat-square&logo=github)](https://github.com/aerix-official/smartbook-solver/releases)
[![License](https://img.shields.io/badge/License-MIT-green?style=flat-square)](https://github.com/aerix-official/smartbook-solver/blob/main/LICENSE)
[![Downloads](https://img.shields.io/github/downloads/aerix-official/smartbook-solver/total?style=flat-square&label=Downloads&color=orange)](https://github.com/aerix-official/smartbook-solver/releases)

*A powerful Chrome extension that automatically solves **McGraw-Hill SmartBook** assignments using Claude API or free AI tabs.*

[Features](#-features) • [Supported Types](#-supported-question-types) • [Installation](#-installation) • [Setup](#-setup) • [Usage](#-usage)

</div>

---

> # ⚠️ IMPORTANT DISCLAIMER — READ BEFORE USE
>
> ### **This extension is provided strictly for educational, research, and demonstration purposes.**
>
> Using QuizBot to complete graded assignments, quizzes, or any work submitted for academic credit is **almost certainly a violation of your school's academic integrity / honor code** and can result in serious disciplinary action — including failing grades, course removal, suspension, or expulsion.
>
> - **You are solely responsible** for how you use this software.
> - **The author(s) accept no liability** for any consequences arising from use or misuse, including academic penalties, lost credentials, account bans, or violations of any third-party Terms of Service (McGraw-Hill, OpenAI, Google, DeepSeek, Anthropic, etc.).
> - **Do not use this tool to cheat.** If you would not be comfortable showing your instructor exactly what this extension does in real time, **do not use it**.
> - This project is an **independent experiment** and is **not affiliated with, endorsed by, or sponsored by** McGraw Hill, OpenAI, Google, DeepSeek, or Anthropic.
>
> **By downloading, installing, or running this extension, you acknowledge that you have read and accepted the above terms.**

---

## 🚀 Features

* **⚡ Dual AI Mode** — Use high-speed Anthropic API keys or leverage free ChatGPT, Gemini, and DeepSeek tabs.
* **🤖 Full Automation** — Detects questions, submits answers, selects confidence, and advances automatically.
* **✅ Universal Support** — Handles all SmartBook types: Multiple Choice, T/F, Multi-Select, Fill-in-the-Blank, and Text Selection.
* **🧩 Matching Specialist** — Fully automated matching questions via keyboard-based drag-and-drop simulation.
* **📈 Double Credit Mode** — Unique feature that duplicates the tab to answer questions twice for maximum credit.
* **🧠 Correction Recovery** — Learns from mistakes. If an answer is marked wrong, QuizBot uses that feedback for the next attempt.
* **⚙️ Customizable Workflow** — Randomize confidence levels or use "Pause Before Submit" for manual oversight.
* **🛡 Alt+Z Stealth Toggle** — Instantly hide the in-page QuizBot button on SmartBook; press again to bring it back.

---

## 🛠 Supported Question Types

| Type | Description |
|---|---|
| **Multiple Choice** | Selects the correct radio button |
| **True / False** | Clicks True or False |
| **Multiple Select** | Checks all correct checkboxes |
| **Fill in the Blank** | Types answer(s) into the input field(s) |
| **Select Text** | Clicks the correct highlighted text segment |
| **Matching** | Keyboard drag-and-drop to align prompts with choices |

---

## 📥 Installation

1. **Download** or clone this repository to your local machine.
2. Open Chrome and navigate to `chrome://extensions/`.
3. Enable **Developer mode** (toggle in the top-right corner).
4. Click **Load unpacked** and select the `QuizBot - Extension` folder.
5. The extension will now appear in your toolbar as **QuizBot — SmartBook Solver**.

---

## 🤖 AI Modes & Cost

| Mode | How it works | Cost |
|---|---|---|
| **Claude API** | Direct background calls (Fastest) | Anthropic API Rates |
| **ChatGPT** | Automated typing into ChatGPT tab | **Free** |
| **Gemini** | Automated typing into Gemini tab | **Free** |
| **DeepSeek** | Automated typing into DeepSeek tab | **Free** |

---

## ⚙️ Setup

### 1. Claude API Mode (Recommended)
*Fastest performance, no tab switching required.*
1. Get an API key from [console.anthropic.com](https://console.anthropic.com).
2. Click the **QuizBot** toolbar icon, then click the **Settings ⚙** button.
3. Paste your key (starts with `sk-ant-`) and click **Save Key**.
4. Set the mode to **Claude** in the main popup.

### 2. Tab AI Mode (Free)
1. Open [ChatGPT](https://chatgpt.com), [Gemini](https://gemini.google.com), or [chat.deepseek.com](https://chat.deepseek.com) and log in.
2. Click the **QuizBot Icon** and select your active AI provider.
3. The status bar will confirm the tab is detected.

---

## 📖 Usage

1. Open a **McGraw-Hill SmartBook** assignment.
2. Look for the **QuizBot** button in the header bar.
3. Click **QuizBot** to start automation.
4. To stop at any time, click the button again (labeled **Stop QuizBot**).

### ⌨ Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Alt + S` | Open the QuizBot popup |
| `Alt + Z` | Hide / show the in-page QuizBot button on SmartBook |

---

## 🛡 Disclaimer

This tool is for educational purposes only. Use it responsibly and be aware of your institution's academic integrity policies. QuizBot is an independent project and is not affiliated with or endorsed by McGraw Hill.

---

<div align="center">
  <sub>Built for efficiency. Use responsibly.</sub>
</div>
