# Architecture

A short tour of how Voice Rewriter is wired up. The whole extension is around 700 lines of vanilla JS with no build step, so this doc is meant as a map, not a substitute for reading the code.

## High-level flow

```
                             ┌─────────────────────────────────┐
   user selects text         │  context menu (Chrome native)   │
   right-click ──────────────▶  Rewrite → Refine               │
                             └────────────────┬────────────────┘
                                              │ chrome.contextMenus.onClicked
                                              ▼
                              ┌──────────────────────────────┐
                              │  background.js (service      │
                              │  worker)                     │
                              │                              │
                              │  ─ owns context menus        │
                              │  ─ owns LLM fetch + SSE      │
                              │  ─ knows storage settings    │
                              └──────────────┬───────────────┘
                                             │ chrome.tabs.sendMessage
                                             │ {action:'startPreview'}
                                             ▼
                              ┌──────────────────────────────┐
                              │  content.js (per frame)      │
                              │                              │
                              │  ─ tracked the selection on  │
                              │    contextmenu/mouseup       │
                              │  ─ opens a Shadow-DOM        │
                              │    popover anchored to it    │
                              │  ─ replaces text on Accept   │
                              └──────────────┬───────────────┘
                                             │ chrome.runtime.connect
                                             │ name: "rewrite-stream"
                                             ▼
                              ┌──────────────────────────────┐
                              │  long-lived port             │
                              │                              │
                              │   {type:'start', actionId,    │
                              │    text}                     │
                              │                              │
                              │   ◀── {type:'chunk', text}   │
                              │   ◀── {type:'chunk', text}   │
                              │   ◀── {type:'done', text}    │
                              │   ◀── {type:'error', error}  │
                              │                              │
                              │   ──▶ {type:'abort'}         │
                              └──────────────────────────────┘
```

## Why the split?

Service workers in Manifest V3 can't directly poke the DOM, and content scripts can't make cross-origin fetches without CORS pain. So:

- `background.js` owns the network call. It has `<all_urls>` host permissions, which means fetches to `ai-gateway.vercel.sh` and `openrouter.ai/api` succeed regardless of the page's CORS policy.
- `content.js` owns everything DOM-related: tracking the selection, painting the popover, and writing the accepted text back into the page.

A long-lived port (`chrome.runtime.connect`) ties them together. Ports beat one-shot messages here because:

- The stream can be many chunks, often fast. One port message per chunk avoids the overhead of opening a new channel each time.
- `port.onDisconnect` gives us free abort semantics. If the user closes the popover (or even the tab), the worker fires `abortController.abort()` on the side and the underlying fetch unwinds.

## Selection tracking

Chrome doesn't hand the content script a `Range` when the user opens a context menu — only the background script gets `info.selectionText`, which is a normalized string with no positional info. So the content script registers a `contextmenu` listener with `useCapture: true` that runs *before* the native menu opens, snapshots the active selection, and stashes it:

```js
document.addEventListener('contextmenu', captureSelection, true);
```

We capture two cases:

- **Inputs and textareas:** save `{ element, selectionStart, selectionEnd, text }`.
- **Everything else (including contenteditable):** save `range.cloneRange()`.

When the user later clicks Accept, we either restore `setSelectionRange` and call `execCommand('insertText')`, or restore the saved range and call `execCommand('insertText')` on the contenteditable. Both paths preserve native browser undo (`Cmd/Ctrl-Z`). The fallback path only triggers when `execCommand` returns false (very old browsers, rare quirks) and uses raw `range.deleteContents()` + `insertNode`.

## SSE parsing

Both Vercel AI Gateway and OpenRouter speak the OpenAI streaming wire format: `text/event-stream` with `data:` lines, double-newline-delimited events, and a final `data: [DONE]`. The parser in `background.js`:

1. Reads from the response body's `ReadableStreamDefaultReader`.
2. Buffers bytes through a `TextDecoder({ stream: true })` to handle multi-byte characters at chunk boundaries.
3. Splits on `\n\n`, stashing any partial event back into the buffer for the next read.
4. For each `data:` line, parses JSON and yields `delta.content`.

The whole thing is an `async function*`, so the port handler can just `for await` and post each delta.

## Shadow DOM for the popover

The page can have any CSS — `* { all: revert !important }` rules, custom fonts, weird stacking contexts. To avoid getting clobbered, the popover lives inside a host element with `attachShadow({ mode: 'open' })`, all styles inline-scoped to the shadow root. We also `:host { all: initial }` to wipe inherited cascades from the page.

Positioning: `range.getBoundingClientRect()` gives the selection's location; we anchor the popover below if there's room, above otherwise. For inputs/textareas (where per-character geometry is hidden), we fall back to the element's bounding rect — close enough.

## Anti-AI guardrails

The system prompt has two layers:

1. A baseline contract: *"Output only the rewrite. Preserve names, numbers, code, URLs. Match capitalization and punctuation habits."*
2. A toggleable rule list: avoid known AI tells (the "delve / leverage / tapestry" set), em-dash overuse, the "not X, but Y" pattern, summary endings, "Sure," / "Here is," openers.

The rules are negative, not positive. We don't tell the model how to write — that's the user's voice profile's job. We tell it what *not* to do, because that's where current models default to bad behavior.

## Settings

All settings live in `chrome.storage.local` (not `.sync`) so API keys never leave the device. `defaults.js` is shared across the service worker (`importScripts`) and the option/onboarding pages (`<script>`), wrapped in an IIFE so its `const`s don't pollute global scope and collide with anything declared at the top level of the worker.

## What's deliberately not here

- **No bundler.** Chrome ships modern JS; nothing this codebase does needs Babel or webpack.
- **No framework.** Five small surfaces (background, content, options, onboarding, defaults) — React would be heavier than the app.
- **No telemetry.** No backend. The extension talks to one URL: the gateway you pointed it at.
- **No prompt injection mitigations beyond the basics.** The user's selected text is wrapped in `<<<TEXT … TEXT>>>` markers and passed as the user message; the system prompt asks for output only. Sufficient for a personal tool, not battle-tested for adversarial input.
