# Jury.ai

A Chrome extension that sends one prompt to **ChatGPT, Claude, Grok, and Gemini** simultaneously, then has an independent AI jury panel score and rank the responses.

---

## What it does

1. You type a prompt once
2. All four LLMs answer in parallel (in your logged-in browser tabs — no API keys needed)
3. A jury panel of AI judges scores each response independently
4. You get a verdict: winner, per-criterion scores, synthesis, and judge consensus stats

---

## Features

- **4-model arena** — ChatGPT, Claude, Grok, Gemini all answer your prompt
- **Research-backed jury panel** — independent panel judges with bias mitigations from LLM-as-a-judge literature:
  - Position bias → responses anonymized as A/B/C/D, order randomized per judge
  - Verbosity bias → Pass-1 compression normalizes length before scoring
  - Self-preference bias → a judge never scores its own arena response
  - Independent panel, not debate (debate amplifies bias)
- **Auto-judge** — verdict runs automatically when all responses land, even if you close the popup
- **Verdict persisted** — reopen the popup anytime and the result is still there
- **Resilient pipeline** — fallback chains for inject/send/capture; per-model retry + watchdog timeout; partial results if one model fails
- **Diagnose tool** — dry-run selector health check without sending a prompt
- **Debug log panel** — structured logs for every strategy attempt
- **No API keys** — drives your existing logged-in browser sessions via Chrome DevTools Protocol

---

## Scoring criteria

| Penalise (lower is better) | Reward (higher is better) |
|---|---|
| Sycophancy | Clarity |
| Padding | Specific facts |
| Disclaimers | Actionable |
| Hallucination | Faithfulness |
| Hedging | Completeness |
| Irrelevance | Conciseness |

Each response is scored YES/NO on all 12 criteria. The jury aggregates by majority vote with minority-veto tie-breaking.

---

## Installation

1. Clone or download this repo
2. Open Chrome → `chrome://extensions`
3. Enable **Developer mode** (top right)
4. Click **Load unpacked** → select the `jury-ai-v12` folder
5. Pin the extension and click it to open

**Requirements:** You must be logged in to ChatGPT, Claude, Grok, and Gemini in Chrome before running.

---

## Usage

1. Click the Jury.ai icon in your toolbar
2. Type your prompt and click **Deliberate**
3. Watch all four models respond in real time
4. The jury runs automatically — verdict appears when done
5. Expand **Full criteria breakdown** for the per-model scoring table

---

## Architecture

| File | Role |
|---|---|
| `background.js` | Thin orchestrator + message router; owns auto-judge lifecycle |
| `providers.js` | Declarative provider registry — adding a new LLM = one config object |
| `jury.js` | Panel judging: anonymize, 2-pass score, aggregate, self-vote guard |
| `strategies.js` | Fallback chains for inject / send / done-signal / capture |
| `cdp.js` | Chrome DevTools Protocol helpers |
| `detect.js` | Block detection (rate limits, login walls, captchas) + notifications |
| `logger.js` | Structured logging + ring buffer (surfaced in debug panel) |
| `popup.js/html/css` | UI: cards, verdict panel, jury stats, diagnose, debug log |
| `content/*.js` | Per-site content scripts |

---

## Settings

| Option | Default | Description |
|---|---|---|
| Auto-run judge | On | Automatically judge when all responses arrive |
| Show synthesis | On | Show the jury's synthesized ideal answer |
| Jury panel | On | Use all reachable judges, not just Gemini |

---

## Adding a new LLM provider

Add one entry to `PROVIDERS` in `providers.js`:

```js
mymodel: {
  id: 'mymodel', url: 'https://mymodel.com/', roles: ['arena', 'judge'],
  input: ['selector-for-input'],
  send: ['selector-for-send-button'],
  capture: {
    copy: 'selector-for-copy-button',
    dom: ['selector-for-response-text'],
  },
  rateText: ['rate limit text to detect'],
}
```

No other files need to change.

---

## License

MIT
