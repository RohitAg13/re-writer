const { PROVIDERS, DEFAULT_SETTINGS } = self.VR;

const STEPS = ['welcome', 'provider', 'key', 'voice', 'done'];
let currentStep = 0;
let pickedProvider = 'vercel';

const $ = (id) => document.getElementById(id);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function showStep(idx) {
  currentStep = Math.max(0, Math.min(STEPS.length - 1, idx));
  const name = STEPS[currentStep];
  $$('.step').forEach((el) => { el.hidden = el.dataset.step !== name; });
  $$('.steps li').forEach((li, i) => {
    li.classList.toggle('active', i === currentStep);
    li.classList.toggle('done', i < currentStep);
  });
  if (name === 'key') applyProviderToKeyStep();
  window.scrollTo({ top: 0 });
}

function buildProviderCards() {
  const wrap = $('providerCards');
  wrap.innerHTML = '';
  const meta = {
    vercel: {
      desc: 'Single key, every major model. Great default if you already use Vercel. Includes observability and provider failover.',
      tag: 'Recommended',
    },
    openrouter: {
      desc: 'Pay-as-you-go access to hundreds of models. Useful if you want to experiment with non-mainstream providers.',
    },
    custom: {
      desc: 'Bring your own OpenAI-compatible endpoint (self-hosted proxy, LiteLLM, etc.). You provide the URL.',
    },
  };
  for (const [id, p] of Object.entries(PROVIDERS)) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'card';
    card.dataset.providerId = id;
    card.innerHTML = `
      <div class="title">${escapeHtml(p.label)}${meta[id]?.tag ? ` <span class="hint">· ${meta[id].tag}</span>` : ''}</div>
      <div class="desc">${escapeHtml(meta[id]?.desc || '')}</div>
      <div class="meta">Default model: <code>${escapeHtml(p.defaultModel || '—')}</code></div>
    `;
    card.addEventListener('click', () => {
      pickedProvider = id;
      $$('.card', wrap).forEach((c) => c.classList.toggle('selected', c === card));
    });
    wrap.appendChild(card);
  }
  // pre-select first
  const first = wrap.querySelector('.card');
  if (first) first.click();
}

function applyProviderToKeyStep() {
  const p = PROVIDERS[pickedProvider];
  $('keyTitle').textContent = `Add your ${p.label} key.`;
  if (p.keyUrl) {
    $('keySub').innerHTML = `${escapeHtml(p.keyHelp)} → <a href="${p.keyUrl}" target="_blank" rel="noopener">${p.keyUrl}</a>`;
  } else {
    $('keySub').textContent = p.keyHelp || '';
  }
  $('endpointField').hidden = pickedProvider !== 'custom';
  $('modelHint').textContent = p.modelHint || '';
  if (!$('model').value || !$('model').dataset.userEdited) {
    $('model').value = p.defaultModel || '';
  }
}

async function loadExisting() {
  const s = { ...DEFAULT_SETTINGS, ...(await chrome.storage.local.get(null)) };
  pickedProvider = PROVIDERS[s.provider] ? s.provider : 'vercel';
  $('apiKey').value = s.apiKey || '';
  $('model').value = s.model || PROVIDERS[pickedProvider].defaultModel;
  $('customEndpoint').value = s.customEndpoint || '';
  $('voice').value = s.voice || '';
  $('antiAI').checked = s.antiAI !== false;
}

async function saveCurrent() {
  const provider = pickedProvider;
  const updates = {
    provider,
    model: $('model').value.trim() || PROVIDERS[provider].defaultModel,
    customEndpoint: $('customEndpoint').value.trim(),
    apiKey: $('apiKey').value.trim(),
  };
  await chrome.storage.local.set(updates);
}

async function saveVoice() {
  await chrome.storage.local.set({
    voice: $('voice').value,
    antiAI: $('antiAI').checked,
  });
}

async function testConnection() {
  const errEl = $('keyError');
  errEl.hidden = true;
  const apiKey = $('apiKey').value.trim();
  const model = $('model').value.trim() || PROVIDERS[pickedProvider].defaultModel;
  if (!apiKey) {
    errEl.hidden = false;
    errEl.textContent = 'Enter an API key first.';
    return false;
  }
  const url = pickedProvider === 'custom'
    ? $('customEndpoint').value.trim()
    : PROVIDERS[pickedProvider].endpoint;
  if (!url) {
    errEl.hidden = false;
    errEl.textContent = 'Enter the endpoint URL.';
    return false;
  }
  const btn = $('testBtn');
  btn.disabled = true;
  const orig = btn.textContent;
  btn.textContent = 'Testing…';
  try {
    const headers = { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` };
    if (pickedProvider === 'openrouter') {
      headers['HTTP-Referer'] = 'https://github.com/voice-rewriter';
      headers['X-Title'] = 'Voice Rewriter';
    }
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        max_tokens: 8,
        messages: [{ role: 'user', content: 'Say "ok".' }],
      }),
    });
    if (!res.ok) {
      const body = (await res.text().catch(() => '')).slice(0, 280);
      throw new Error(`${res.status} ${res.statusText}${body ? ` — ${body}` : ''}`);
    }
    btn.textContent = '✓ Works';
    setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 1500);
    return true;
  } catch (err) {
    errEl.hidden = false;
    errEl.textContent = `Test failed: ${err.message || err}`;
    btn.textContent = orig;
    btn.disabled = false;
    return false;
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}

async function next() {
  const name = STEPS[currentStep];
  if (name === 'provider') { /* selection lives in pickedProvider */ }
  if (name === 'key') {
    const apiKey = $('apiKey').value.trim();
    if (!apiKey) {
      const err = $('keyError');
      err.hidden = false;
      err.textContent = 'Add an API key to continue.';
      return;
    }
    if (pickedProvider === 'custom' && !$('customEndpoint').value.trim()) {
      const err = $('keyError');
      err.hidden = false;
      err.textContent = 'Add the custom endpoint URL.';
      return;
    }
    await saveCurrent();
  }
  if (name === 'voice') {
    await saveVoice();
  }
  showStep(currentStep + 1);
}

async function finish() {
  await chrome.storage.local.set({ onboarded: true });
  try {
    const tab = await chrome.tabs.getCurrent();
    if (tab?.id != null) {
      await chrome.tabs.remove(tab.id);
      return;
    }
  } catch {}
  window.close();
}

document.addEventListener('DOMContentLoaded', async () => {
  buildProviderCards();
  await loadExisting();
  showStep(0);

  $$('[data-next]').forEach((b) => b.addEventListener('click', next));
  $$('[data-back]').forEach((b) => b.addEventListener('click', () => showStep(currentStep - 1)));
  $('testBtn').addEventListener('click', testConnection);
  $('finish').addEventListener('click', finish);
  $('openSettings').addEventListener('click', async () => {
    await chrome.storage.local.set({ onboarded: true });
    chrome.runtime.openOptionsPage();
  });
  $('model').addEventListener('input', () => { $('model').dataset.userEdited = '1'; });
});
