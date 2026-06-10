// Service worker: context menus + streaming LLM calls via gateway proxies.

importScripts('defaults.js');
const { ACTIONS, DEFAULT_PROMPTS, PROVIDERS, DEFAULT_SETTINGS } = self.VR;

// ---------------- install / first run ----------------

chrome.runtime.onInstalled.addListener(async (details) => {
  await ensureDefaults();
  setupMenus();

  if (details.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('onboarding.html') });
  }
});

chrome.runtime.onStartup.addListener(setupMenus);

async function ensureDefaults() {
  const cur = await chrome.storage.local.get(null);
  const updates = {};
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
    if (cur[k] === undefined) updates[k] = v;
  }
  if (cur.prompts && typeof cur.prompts === 'object') {
    const merged = { ...DEFAULT_PROMPTS, ...cur.prompts };
    if (JSON.stringify(merged) !== JSON.stringify(cur.prompts)) updates.prompts = merged;
  }
  if (Object.keys(updates).length) await chrome.storage.local.set(updates);
}

// ---------------- context menus ----------------

function setupMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'rewriter-root',
      title: 'Rewrite',
      contexts: ['selection', 'editable'],
    });
    for (const a of ACTIONS) {
      chrome.contextMenus.create({
        id: `rw-${a.id}`,
        parentId: 'rewriter-root',
        title: a.title,
        contexts: ['selection', 'editable'],
      });
    }
    chrome.contextMenus.create({
      id: 'rw-sep',
      parentId: 'rewriter-root',
      type: 'separator',
      contexts: ['selection', 'editable'],
    });
    chrome.contextMenus.create({
      id: 'rw-settings',
      parentId: 'rewriter-root',
      title: 'Settings…',
      contexts: ['selection', 'editable'],
    });
  });
}

async function openOptions() {
  const url = chrome.runtime.getURL('options.html');
  try {
    // Focus an existing options tab if one is already open.
    const tabs = await chrome.tabs.query({ url });
    if (tabs && tabs.length) {
      const t = tabs[0];
      try { await chrome.tabs.update(t.id, { active: true }); } catch {}
      if (t.windowId != null) {
        try { await chrome.windows.update(t.windowId, { focused: true }); } catch {}
      }
      return;
    }
  } catch {}
  try { await chrome.tabs.create({ url }); } catch (err) {
    console.error('[Voice Rewriter] failed to open options', err);
  }
}

async function dispatchStartPreview({ tabId, frameId, actionId, text }) {
  const action = ACTIONS.find(a => a.id === actionId);
  if (!action || !tabId) return;

  const settings = await getSettings();
  if (!settings.onboarded || !settings.apiKey) {
    chrome.tabs.create({ url: chrome.runtime.getURL('onboarding.html') });
    return;
  }

  const message = { action: 'startPreview', actionId: action.id, actionLabel: action.title, text };
  const sendOpts = frameId != null ? { frameId } : undefined;
  try {
    await chrome.tabs.sendMessage(tabId, message, sendOpts);
  } catch {
    // Tab predates the current content-script registration — inject and retry.
    try {
      await chrome.scripting.executeScript({
        target: { tabId, ...(frameId != null ? { frameIds: [frameId] } : { allFrames: true }) },
        files: ['content.js'],
      });
      await chrome.tabs.sendMessage(tabId, message, sendOpts);
    } catch (err2) {
      console.error('[Voice Rewriter] startPreview failed', err2);
      try {
        await chrome.tabs.sendMessage(tabId, {
          action: 'showStatus',
          kind: 'error',
          text: 'Voice Rewriter could not attach to this page. Try reloading the tab.',
        });
      } catch {}
    }
  }
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'rw-settings') {
    openOptions();
    return;
  }
  if (typeof info.menuItemId !== 'string' || !info.menuItemId.startsWith('rw-')) return;
  const actionId = info.menuItemId.slice(3);
  const text = (info.selectionText || '').trim();
  if (!text || !tab?.id) return;
  await dispatchStartPreview({ tabId: tab.id, frameId: info.frameId, actionId, text });
});

// ---------------- keyboard shortcut ----------------

// Returns { frameId, text } for the frame in the active tab that currently
// owns a non-empty selection (page selection or input/textarea selection).
async function findSelectionFrame(tabId) {
  let results;
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => {
        const sel = (window.getSelection?.()?.toString() || '').trim();
        if (sel) return sel;
        const a = document.activeElement;
        if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA')) {
          const s = a.selectionStart, e = a.selectionEnd;
          if (s != null && e != null && e > s) return a.value.slice(s, e);
        }
        return '';
      },
    });
  } catch (err) {
    console.error('[Voice Rewriter] selection probe failed', err);
    return null;
  }
  for (const r of results || []) {
    const t = (r?.result || '').trim();
    if (t) return { frameId: r.frameId, text: t };
  }
  return null;
}

chrome.commands.onCommand.addListener(async (command) => {
  if (!command.startsWith('rw-')) return;
  const actionId = command.slice(3);
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;

  const hit = await findSelectionFrame(tab.id);
  if (!hit) {
    try {
      await chrome.tabs.sendMessage(tab.id, {
        action: 'showStatus',
        kind: 'error',
        text: 'Select some text first, then trigger the shortcut.',
      });
    } catch {}
    return;
  }
  await dispatchStartPreview({ tabId: tab.id, frameId: hit.frameId, actionId, text: hit.text });
});

chrome.action.onClicked.addListener(async () => {
  const s = await getSettings();
  if (!s.onboarded) chrome.tabs.create({ url: chrome.runtime.getURL('onboarding.html') });
  else openOptions();
});

// ---------------- streaming over a port ----------------

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'rewrite-stream') return;

  const abort = new AbortController();
  let inFlight = false;

  port.onMessage.addListener(async (msg) => {
    if (msg?.type === 'start' && !inFlight) {
      inFlight = true;
      try {
        const settings = await getSettings();
        const prompt = (settings.prompts || DEFAULT_PROMPTS)[msg.actionId] || DEFAULT_PROMPTS[msg.actionId];
        if (!prompt) throw new Error(`Unknown action: ${msg.actionId}`);

        let full = '';
        for await (const chunk of streamRewrite({
          settings,
          prompt,
          text: msg.text,
          signal: abort.signal,
        })) {
          full += chunk;
          safePost(port, { type: 'chunk', text: chunk });
        }
        safePost(port, { type: 'done', text: cleanOutput(full) });
      } catch (err) {
        if (err?.name !== 'AbortError') {
          console.error('[Voice Rewriter] stream error', err);
          safePost(port, { type: 'error', error: err?.message || String(err) });
        }
      } finally {
        inFlight = false;
      }
    }
    if (msg?.type === 'abort') abort.abort();
  });

  port.onDisconnect.addListener(() => abort.abort());
});

function safePost(port, msg) {
  try { port.postMessage(msg); } catch {}
}

// ---------------- LLM call ----------------

async function getSettings() {
  const stored = await chrome.storage.local.get(null);
  return { ...DEFAULT_SETTINGS, ...stored };
}

function buildSystemPrompt(settings) {
  const voice = (settings.voice || '').trim();
  const antiAI = settings.antiAI !== false;
  let s = [
    'You rewrite text on behalf of the user.',
    'Output ONLY the rewritten text. No preamble, no explanation, no surrounding quotes, no markdown fences.',
    'Preserve the user\'s intent. Preserve any names, numbers, code, URLs, or technical terms exactly.',
    'Match the original language and the original capitalization/punctuation habits unless the instruction requires otherwise.',
  ].join(' ');

  if (voice) {
    s += `\n\n# User voice profile\nMimic this style — vocabulary, rhythm, sentence shape, quirks. If the profile contains writing samples, study them; do not quote them.\n${voice}`;
  }
  if (antiAI) {
    s += [
      '',
      '',
      '# Humanizer guardrails',
      'Make the output read as if written by a specific person, not a model. Apply these only where they do not fight the original voice.',
      '- Avoid inflated AI vocabulary: "delve", "leverage", "navigate", "tapestry", "testament", "pivotal", "crucial", "intricate", "robust", "seamless", "vibrant", "showcase", "underscore", "foster", "garner", "landscape" (figurative), "realm", "embark".',
      '- Avoid promotional filler: "nestled", "in the heart of", "boasts", "rich/vibrant tapestry", "breathtaking", "must-visit", "groundbreaking", "renowned", "game-changer".',
      '- Prefer plain "is"/"has" over copula avoidance ("serves as", "stands as", "represents", "boasts", "features", "offers").',
      '- Drop the "not X, but Y" / "it\'s not just X, it\'s Y" negative-parallelism pattern and tailing negations.',
      '- Do not force rule-of-three triplets or fake "from X to Y" ranges unless the original had them.',
      '- Use one consistent term for a thing; do not cycle synonyms for elegant variation.',
      '- Name the actor instead of defaulting to passive voice or subjectless fragments.',
      '- Cut filler ("in order to" -> "to", "due to the fact that" -> "because", "it\'s important to note that", "has the ability to" -> "can").',
      '- Cut stacked hedges ("could potentially possibly"); state the claim once.',
      '- No signposting or meta-announcements ("let\'s dive in", "here\'s what you need to know", "without further ado"). Start with the content.',
      '- No manufactured drama (runs of short punchy fragments), aphorism formulas ("X is the language of Y"), or fake-candid openers ("Honestly?", "Look,", "Here\'s the thing").',
      '- No chatbot artifacts or sycophancy ("Great question!", "I hope this helps", "Certainly!", "You\'re absolutely right"), and no knowledge-cutoff disclaimers.',
      '- Do not introduce em or en dashes (—, –) that the original lacked; rephrase, or use commas, periods, colons, or parentheses. Keep any dashes the user already wrote.',
      '- Do not add decorative boldface, emojis, title-case headings, or curly quotes the original did not use.',
      '- Preserve genuine human signal: specific concrete detail, real asides and self-corrections, mixed register. Do not sand the text into generic smoothness.',
      '- Vary sentence length naturally; mix short and long. Do not pad. Do not over-correct casual or informal writing.',
      '- Do not start with "Sure", "Here is", or any preamble. Do not end with a summary or a generic upbeat conclusion.',
    ].join('\n');
  }
  return s;
}

function endpointFor(settings) {
  if (settings.provider === 'custom') {
    const url = (settings.customEndpoint || '').trim();
    if (!url) throw new Error('Custom endpoint not configured. Open settings.');
    return url;
  }
  const p = PROVIDERS[settings.provider];
  if (!p) throw new Error(`Unknown provider: ${settings.provider}`);
  return p.endpoint;
}

async function* streamRewrite({ settings, prompt, text, signal }) {
  if (!settings.apiKey) throw new Error('No API key configured.');
  const url = endpointFor(settings);
  const provider = settings.provider;
  const model = (settings.model || '').trim() || PROVIDERS[provider]?.defaultModel || '';
  if (!model) throw new Error('No model configured.');

  const headers = {
    'content-type': 'application/json',
    authorization: `Bearer ${settings.apiKey}`,
  };
  if (provider === 'openrouter') {
    headers['HTTP-Referer'] = 'https://github.com/voice-rewriter';
    headers['X-Title'] = 'Voice Rewriter';
  }

  const body = {
    model,
    stream: true,
    temperature: typeof settings.temperature === 'number' ? settings.temperature : 0.7,
    messages: [
      { role: 'system', content: buildSystemPrompt(settings) },
      { role: 'user', content: `${prompt}\n\nRewrite the text between the markers. Output only the rewrite.\n<<<TEXT\n${text}\nTEXT>>>` },
    ],
  };

  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
  if (!res.ok || !res.body) {
    const t = await res.text().catch(() => res.statusText);
    throw new Error(`${provider} ${res.status}: ${(t || '').slice(0, 300)}`);
  }
  yield* parseSSE(res.body);
}

async function* parseSSE(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const event = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        for (const line of event.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const data = trimmed.slice(5).trim();
          if (!data || data === '[DONE]') {
            if (data === '[DONE]') return;
            continue;
          }
          let parsed;
          try { parsed = JSON.parse(data); } catch { continue; }
          const delta =
            parsed.choices?.[0]?.delta?.content ??
            parsed.choices?.[0]?.message?.content ??
            '';
          if (delta) yield delta;
        }
      }
    }
  } finally {
    try { reader.releaseLock(); } catch {}
  }
}

function cleanOutput(s) {
  let t = (s || '').trim();
  const fence = t.match(/^```[a-zA-Z]*\n([\s\S]*?)\n```$/);
  if (fence) t = fence[1].trim();
  const pairs = [['"','"'], ['“','”'], ["'","'"]];
  for (const [l, r] of pairs) {
    if (t.length >= 2 && t.startsWith(l) && t.endsWith(r) && !t.slice(1, -1).includes(l)) {
      t = t.slice(1, -1);
      break;
    }
  }
  return t;
}
