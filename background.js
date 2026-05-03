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

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'rw-settings') {
    chrome.runtime.openOptionsPage();
    return;
  }
  if (typeof info.menuItemId !== 'string' || !info.menuItemId.startsWith('rw-')) return;
  const actionId = info.menuItemId.slice(3);
  const action = ACTIONS.find(a => a.id === actionId);
  if (!action) return;

  const text = (info.selectionText || '').trim();
  if (!text || !tab?.id) return;

  const settings = await getSettings();
  if (!settings.onboarded || !settings.apiKey) {
    chrome.tabs.create({ url: chrome.runtime.getURL('onboarding.html') });
    return;
  }

  // Tell the content script to open a streaming preview. The content script
  // owns the saved selection range, so it kicks off the stream itself via a
  // long-lived port.
  try {
    await chrome.tabs.sendMessage(
      tab.id,
      { action: 'startPreview', actionId: action.id, actionLabel: action.title, text },
      { frameId: info.frameId },
    );
  } catch (err) {
    console.error('[Voice Rewriter] startPreview failed', err);
  }
});

chrome.action.onClicked.addListener(async () => {
  const s = await getSettings();
  if (!s.onboarded) chrome.tabs.create({ url: chrome.runtime.getURL('onboarding.html') });
  else chrome.runtime.openOptionsPage();
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
      '# Anti-AI guardrails',
      '- Never produce text that reads as machine-generated.',
      '- Avoid these AI tells: "delve", "leverage", "navigate", "tapestry", "in conclusion", "moreover", "furthermore", "it\'s important to note", "in today\'s fast-paced world", "embark on a journey", "game-changer", "robust", "seamless".',
      '- Avoid em-dash overuse and avoid the "not X, but Y" rhetorical pattern.',
      '- Avoid stacked tricolons and parallel three-part lists unless the original had them.',
      '- Vary sentence length naturally; mix short and long. Do not pad.',
      '- Do not start with "Sure," "Here is," "Certainly," or any meta-comment. Do not end with a summary.',
      '- Keep the original\'s contraction usage and informality level. Do not over-correct casual writing.',
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
