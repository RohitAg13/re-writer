# Contributing

Thanks for considering a contribution. Voice Rewriter is intentionally small and dependency-free — if you can read JavaScript, you can ship a fix.

## Local setup

```bash
git clone https://github.com/<your-handle>/voice-rewriter.git
cd voice-rewriter
```

1. Open `chrome://extensions`, toggle **Developer mode**.
2. **Load unpacked** → select the cloned directory.
3. Edit any file. Hit the **circular reload arrow** on the extension card to pick up changes.
4. Click **service worker** under "Inspect views" to open DevTools on the background script. The content script logs to the page's DevTools console.

There is no build step. No bundler. No transpilation.

## What's where

| File | Purpose |
| --- | --- |
| `manifest.json` | Manifest V3 declaration. |
| `background.js` | Service worker. Owns context menus and the streaming LLM call. |
| `content.js` | Tracks the selection, renders the Shadow-DOM preview popover, replaces text. |
| `defaults.js` | Shared constants (actions, prompts, providers). Loaded into the SW via `importScripts` and into pages via `<script>`. Wrapped in an IIFE so its consts don't leak into worker globals. |
| `options.{html,css,js}` | Settings page. |
| `onboarding.{html,css,js}` | First-run wizard. |

## Tests

There is no automated test suite (yet). Manual checks before sending a PR:

- Does the right-click menu still appear with selected text and inside editable fields?
- Does the popover anchor near the selection on a long page (top, middle, bottom)?
- Does **Accept** preserve native `Cmd/Ctrl-Z` undo?
- Does **Esc** abort the in-flight fetch (check the gateway billing/usage)?
- Does it still work inside iframes (e.g., the Gmail compose iframe)?

Syntax check JS locally:

```bash
for f in *.js; do node --check "$f"; done
```

CI runs this on every PR.

## Style

- Vanilla JS, no frameworks.
- Comments for *why*, not *what*. If the code is self-explanatory, no comment.
- Avoid adding dependencies. If you really need one, justify it in the PR.
- Keep features behind clear settings rather than hardcoded.

## PR checklist

- [ ] Manually tested on at least two sites (e.g. a textarea site + a contenteditable site like Gmail or Notion).
- [ ] No new dependencies.
- [ ] If you added a setting, it has sensible defaults and is plumbed through onboarding when relevant.
- [ ] Updated `README.md` if user-facing behavior changed.

## Reporting bugs

Open an issue. Include:

- Chrome version and OS.
- The site you were on.
- What you selected.
- Provider + model.
- Any error from the service worker DevTools console.

Don't include your API key.
