// Content script: tracks the active selection, opens a streaming preview
// popover, and replaces the selection with the accepted rewrite.

(() => {
  let lastSelection = null;
  let activePreview = null;

  // ---------------- selection tracking ----------------

  const captureSelection = () => {
    const active = document.activeElement;
    if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) {
      const start = active.selectionStart;
      const end = active.selectionEnd;
      if (start != null && end != null && end > start) {
        lastSelection = {
          type: 'input',
          element: active,
          start,
          end,
          text: active.value.slice(start, end),
          rect: getInputCaretRect(active, start, end),
        };
        return;
      }
    }
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0 && !sel.isCollapsed) {
      const range = sel.getRangeAt(0);
      lastSelection = {
        type: 'range',
        range: range.cloneRange(),
        text: sel.toString(),
        rect: range.getBoundingClientRect(),
      };
      return;
    }
    lastSelection = null;
  };

  document.addEventListener('contextmenu', captureSelection, true);
  document.addEventListener('mouseup', captureSelection, true);
  document.addEventListener('keyup', (e) => {
    if (e.shiftKey || e.key === 'Shift') captureSelection();
  }, true);

  function getInputCaretRect(el, start, end) {
    // Best-effort: use the element's bounding rect. Inputs/textareas don't
    // expose per-character geometry without a measurement hack, and the
    // element rect is good enough to anchor the popover.
    return el.getBoundingClientRect();
  }

  // ---------------- messaging ----------------

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.action === 'startPreview') {
      try {
        if (!lastSelection) {
          // No tracked selection in this frame; another frame likely owns it.
          sendResponse({ ok: false, reason: 'no-selection' });
          return true;
        }
        openPreview({
          actionId: msg.actionId,
          actionLabel: msg.actionLabel,
          originalText: lastSelection.text,
          anchorRect: lastSelection.rect,
        });
        sendResponse({ ok: true });
      } catch (err) {
        console.error('[Voice Rewriter] startPreview error', err);
        sendResponse({ ok: false, error: String(err) });
      }
      return true;
    }
    if (msg?.action === 'showStatus') {
      showToast(msg.text, msg.kind);
      sendResponse({ ok: true });
      return true;
    }
  });

  // ---------------- replacement ----------------

  function replaceSelection(newText) {
    if (!lastSelection) {
      showToast('Lost the original selection — nothing to replace.', 'error');
      return false;
    }

    if (lastSelection.type === 'input') {
      const el = lastSelection.element;
      el.focus();
      try {
        el.setSelectionRange(lastSelection.start, lastSelection.end);
        const ok = document.execCommand('insertText', false, newText);
        if (!ok) throw new Error('execCommand returned false');
      } catch {
        const v = el.value;
        el.value = v.slice(0, lastSelection.start) + newText + v.slice(lastSelection.end);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
      const caret = lastSelection.start + newText.length;
      try { el.setSelectionRange(caret, caret); } catch {}
      return true;
    }

    if (lastSelection.type === 'range') {
      const range = lastSelection.range;
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);

      const editable = findEditableAncestor(range.startContainer);
      if (editable) {
        editable.focus?.();
        try {
          if (document.execCommand('insertText', false, newText)) return true;
        } catch {}
      }
      range.deleteContents();
      const node = document.createTextNode(newText);
      range.insertNode(node);
      const after = document.createRange();
      after.setStartAfter(node);
      after.collapse(true);
      sel.removeAllRanges();
      sel.addRange(after);
      return true;
    }
    return false;
  }

  function findEditableAncestor(node) {
    while (node) {
      if (node.nodeType === 1 && node.isContentEditable) return node;
      node = node.parentNode;
    }
    return null;
  }

  // ---------------- streaming preview popover ----------------

  function openPreview({ actionId, actionLabel, originalText, anchorRect }) {
    closeActivePreview();

    const host = document.createElement('div');
    host.setAttribute('data-voice-rewriter', 'preview');
    Object.assign(host.style, {
      position: 'fixed',
      zIndex: '2147483647',
      top: '0',
      left: '0',
      width: '0',
      height: '0',
      pointerEvents: 'none',
    });
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>
        :host { all: initial; }
        .panel {
          position: fixed;
          width: min(440px, 92vw);
          max-height: min(520px, 80vh);
          background: #ffffff;
          color: #111827;
          border: 1px solid #e5e7eb;
          border-radius: 12px;
          box-shadow: 0 12px 32px rgba(0,0,0,0.18), 0 2px 6px rgba(0,0,0,0.08);
          font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
          display: flex;
          flex-direction: column;
          pointer-events: auto;
          overflow: hidden;
        }
        @media (prefers-color-scheme: dark) {
          .panel { background: #0f1216; color: #e5e7eb; border-color: #1f2937; }
          .out, .footer { background: #0b0d10; }
          .out { border-color: #1f2937; }
        }
        .header {
          display: flex; align-items: center; gap: 8px;
          padding: 10px 12px; border-bottom: 1px solid currentColor;
          border-bottom-color: rgba(0,0,0,0.06);
        }
        .title { font-weight: 600; font-size: 13px; }
        .badge {
          font-size: 11px; padding: 2px 6px; border-radius: 999px;
          background: rgba(37, 99, 235, 0.12); color: #2563eb;
        }
        .spacer { flex: 1; }
        .x {
          appearance: none; border: 0; background: transparent; cursor: pointer;
          font-size: 16px; line-height: 1; padding: 4px 6px; color: inherit; opacity: 0.6;
          border-radius: 6px;
        }
        .x:hover { opacity: 1; background: rgba(0,0,0,0.06); }
        .out {
          padding: 12px; overflow: auto; white-space: pre-wrap; word-wrap: break-word;
          font-size: 13px; flex: 1; min-height: 80px;
          background: #fafafa; border-top: 1px solid #f3f4f6; border-bottom: 1px solid #f3f4f6;
        }
        .out.empty::before {
          content: attr(data-placeholder);
          color: #9ca3af; font-style: italic;
        }
        .cursor::after {
          content: '▍'; opacity: 0.5; animation: blink 1s steps(2, start) infinite;
          margin-left: 1px;
        }
        @keyframes blink { to { visibility: hidden; } }
        .footer {
          display: flex; align-items: center; gap: 8px;
          padding: 8px 10px; background: #fafafa;
        }
        .status { font-size: 11px; color: #6b7280; }
        .status.err { color: #dc2626; }
        .status.ok { color: #16a34a; }
        button.btn {
          appearance: none; cursor: pointer; font: inherit;
          padding: 6px 12px; border-radius: 8px; border: 1px solid transparent;
        }
        button.primary { background: #2563eb; color: #fff; border-color: #2563eb; }
        button.primary:hover { filter: brightness(1.05); }
        button.primary:disabled { opacity: 0.5; cursor: not-allowed; }
        button.ghost { background: transparent; color: inherit; border-color: rgba(0,0,0,0.1); }
        button.ghost:hover { background: rgba(0,0,0,0.04); }
        @media (prefers-color-scheme: dark) {
          button.ghost { border-color: #374151; }
          button.ghost:hover { background: rgba(255,255,255,0.06); }
          .header { border-bottom-color: #1f2937; }
          .out { background: #0b0d10; border-color: #1f2937; }
          .footer { background: #0b0d10; }
        }
        kbd {
          font: 11px ui-monospace, "SF Mono", Menlo, monospace;
          padding: 1px 5px; border-radius: 4px;
          background: rgba(0,0,0,0.06); border: 1px solid rgba(0,0,0,0.08);
        }
        @media (prefers-color-scheme: dark) {
          kbd { background: #1f2937; border-color: #374151; }
        }
      </style>
      <div class="panel" role="dialog" aria-label="Rewrite preview">
        <div class="header">
          <span class="badge"></span>
          <span class="title">Rewrite</span>
          <span class="spacer"></span>
          <button class="x" data-act="close" title="Close (Esc)">×</button>
        </div>
        <div class="out empty" data-placeholder="Streaming…"></div>
        <div class="footer">
          <span class="status">Connecting…</span>
          <span class="spacer"></span>
          <button class="btn ghost" data-act="retry" disabled>Retry</button>
          <button class="btn ghost" data-act="discard">Discard</button>
          <button class="btn primary" data-act="accept" disabled>Accept</button>
        </div>
      </div>
    `;
    document.body.appendChild(host);

    const panel  = root.querySelector('.panel');
    const out    = root.querySelector('.out');
    const status = root.querySelector('.status');
    const badge  = root.querySelector('.badge');
    const btnAccept  = root.querySelector('[data-act="accept"]');
    const btnDiscard = root.querySelector('[data-act="discard"]');
    const btnRetry   = root.querySelector('[data-act="retry"]');
    const btnClose   = root.querySelector('[data-act="close"]');

    badge.textContent = actionLabel || 'Rewrite';
    positionPanel(panel, anchorRect);

    let port = null;
    let buffer = '';
    let finalText = '';
    let finished = false;

    const startStream = () => {
      buffer = '';
      finalText = '';
      finished = false;
      out.textContent = '';
      out.classList.add('empty', 'cursor');
      out.dataset.placeholder = 'Streaming…';
      btnAccept.disabled = true;
      btnRetry.disabled = true;
      status.className = 'status';
      status.textContent = 'Connecting…';

      try {
        port = chrome.runtime.connect({ name: 'rewrite-stream' });
      } catch (err) {
        showError(`Could not connect: ${err.message || err}`);
        return;
      }
      port.onMessage.addListener(handlePortMessage);
      port.onDisconnect.addListener(() => {
        if (!finished) showError('Connection closed');
      });
      port.postMessage({ type: 'start', actionId, text: originalText });
    };

    const handlePortMessage = (m) => {
      if (m.type === 'chunk') {
        if (out.classList.contains('empty')) {
          out.classList.remove('empty');
          status.textContent = 'Streaming…';
        }
        buffer += m.text;
        out.textContent = buffer;
        out.scrollTop = out.scrollHeight;
      } else if (m.type === 'done') {
        finished = true;
        finalText = m.text || buffer;
        out.textContent = finalText;
        out.classList.remove('cursor', 'empty');
        status.className = 'status ok';
        status.textContent = 'Ready. Press Enter to accept, Esc to discard.';
        btnAccept.disabled = false;
        btnRetry.disabled = false;
        btnAccept.focus({ preventScroll: true });
      } else if (m.type === 'error') {
        showError(m.error || 'Unknown error');
      }
    };

    const showError = (errText) => {
      finished = true;
      out.classList.remove('cursor');
      status.className = 'status err';
      status.textContent = errText;
      btnRetry.disabled = false;
    };

    const teardown = () => {
      try { port?.disconnect(); } catch {}
      document.removeEventListener('keydown', onKey, true);
      activePreview = null;
      if (host.parentNode) host.parentNode.removeChild(host);
    };

    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault(); e.stopPropagation();
        try { port?.postMessage({ type: 'abort' }); } catch {}
        teardown();
      } else if ((e.key === 'Enter') && !btnAccept.disabled && (e.metaKey || e.ctrlKey || document.activeElement === host || isShadowFocus(root))) {
        e.preventDefault(); e.stopPropagation();
        accept();
      }
    };

    const accept = () => {
      const text = finalText || buffer;
      if (!text) return;
      const ok = replaceSelection(text);
      teardown();
      if (ok) showToast('Replaced.', 'success');
    };

    // Buttons: prevent focus theft from the underlying editable on mousedown
    // so execCommand still has a focused target if the user clicks Accept.
    [btnAccept, btnDiscard, btnRetry, btnClose].forEach((b) => {
      b.addEventListener('mousedown', (e) => e.preventDefault());
    });
    btnAccept.addEventListener('click', accept);
    btnDiscard.addEventListener('click', () => {
      try { port?.postMessage({ type: 'abort' }); } catch {}
      teardown();
    });
    btnClose.addEventListener('click', () => {
      try { port?.postMessage({ type: 'abort' }); } catch {}
      teardown();
    });
    btnRetry.addEventListener('click', () => {
      try { port?.postMessage({ type: 'abort' }); } catch {}
      try { port?.disconnect(); } catch {}
      port = null;
      startStream();
    });

    document.addEventListener('keydown', onKey, true);

    activePreview = { teardown };
    startStream();
  }

  function isShadowFocus(root) {
    let el = document.activeElement;
    while (el) {
      if (el.shadowRoot && el.shadowRoot.contains(root.activeElement)) return true;
      el = el.parentNode;
    }
    return false;
  }

  function closeActivePreview() {
    if (activePreview) {
      try { activePreview.teardown(); } catch {}
      activePreview = null;
    }
  }

  function positionPanel(panel, rect) {
    const margin = 8;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    // Render once to get measured size.
    panel.style.visibility = 'hidden';
    panel.style.left = '0px';
    panel.style.top = '0px';
    requestAnimationFrame(() => {
      const pw = panel.offsetWidth;
      const ph = panel.offsetHeight;
      let left, top;
      if (rect && (rect.width || rect.height)) {
        left = Math.min(Math.max(margin, rect.left), vw - pw - margin);
        const below = rect.bottom + margin;
        const above = rect.top - ph - margin;
        top = (below + ph + margin <= vh) ? below : (above >= margin ? above : Math.max(margin, vh - ph - margin));
      } else {
        left = (vw - pw) / 2;
        top = (vh - ph) / 2;
      }
      panel.style.left = `${Math.round(left)}px`;
      panel.style.top = `${Math.round(top)}px`;
      panel.style.visibility = 'visible';
    });
  }

  // ---------------- toast ----------------

  let toastEl = null;
  let toastTimer = null;
  function showToast(text, kind = 'info') {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.setAttribute('data-voice-rewriter', 'toast');
      Object.assign(toastEl.style, {
        position: 'fixed',
        bottom: '24px',
        right: '24px',
        zIndex: '2147483647',
        padding: '10px 14px',
        borderRadius: '10px',
        font: '13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
        color: '#fff',
        boxShadow: '0 6px 20px rgba(0,0,0,0.18)',
        maxWidth: '320px',
        pointerEvents: 'none',
        transition: 'opacity 150ms ease',
        opacity: '0',
      });
      (document.body || document.documentElement).appendChild(toastEl);
    }
    const colors = { info: '#374151', success: '#16a34a', error: '#dc2626' };
    toastEl.style.background = colors[kind] || colors.info;
    toastEl.textContent = text;
    toastEl.style.opacity = '1';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { if (toastEl) toastEl.style.opacity = '0'; }, 2800);
  }
})();
