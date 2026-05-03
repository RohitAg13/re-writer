const { ACTIONS, DEFAULT_PROMPTS, PROVIDERS, DEFAULT_SETTINGS } = self.VR;

const $ = (id) => document.getElementById(id);

function buildProviderOptions() {
  const sel = $('provider');
  sel.innerHTML = '';
  for (const [id, p] of Object.entries(PROVIDERS)) {
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = p.label;
    sel.appendChild(opt);
  }
}

function buildPromptInputs(prompts) {
  const wrap = $('prompts');
  wrap.innerHTML = '';
  for (const a of ACTIONS) {
    const row = document.createElement('div');
    row.className = 'prompt-row';
    const label = document.createElement('label');
    label.textContent = a.title;
    label.setAttribute('for', `prompt-${a.id}`);
    const ta = document.createElement('textarea');
    ta.id = `prompt-${a.id}`;
    ta.rows = 3;
    ta.value = prompts?.[a.id] ?? DEFAULT_PROMPTS[a.id];
    row.appendChild(label);
    row.appendChild(ta);
    wrap.appendChild(row);
  }
}

function readPrompts() {
  const out = {};
  for (const a of ACTIONS) {
    const v = $(`prompt-${a.id}`).value.trim();
    out[a.id] = v || DEFAULT_PROMPTS[a.id];
  }
  return out;
}

function applyProviderHints() {
  const id = $('provider').value;
  const p = PROVIDERS[id];
  $('endpointRow').hidden = id !== 'custom';
  $('modelHint').textContent = p.modelHint || '';
  if (p.keyUrl) {
    $('keyHint').innerHTML = `${escapeHtml(p.keyHelp)} → <a href="${p.keyUrl}" target="_blank" rel="noopener">${p.keyUrl}</a>`;
  } else {
    $('keyHint').textContent = p.keyHelp || '';
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}

async function load() {
  const s = { ...DEFAULT_SETTINGS, ...(await chrome.storage.local.get(null)) };
  buildProviderOptions();
  $('provider').value = PROVIDERS[s.provider] ? s.provider : 'vercel';
  $('model').value = s.model || PROVIDERS[$('provider').value].defaultModel;
  $('customEndpoint').value = s.customEndpoint || '';
  $('apiKey').value = s.apiKey || '';
  $('temperature').value = typeof s.temperature === 'number' ? s.temperature : 0.7;
  $('voice').value = s.voice || '';
  $('antiAI').checked = s.antiAI !== false;
  buildPromptInputs(s.prompts || DEFAULT_PROMPTS);
  applyProviderHints();
}

async function save() {
  const provider = $('provider').value;
  const payload = {
    provider,
    model: $('model').value.trim() || PROVIDERS[provider].defaultModel,
    customEndpoint: $('customEndpoint').value.trim(),
    apiKey: $('apiKey').value.trim(),
    temperature: clampNum(parseFloat($('temperature').value), 0, 2, 0.7),
    voice: $('voice').value,
    antiAI: $('antiAI').checked,
    prompts: readPrompts(),
  };
  await chrome.storage.local.set(payload);
  flash('Saved.', 'ok');
}

function clampNum(n, lo, hi, fallback) {
  if (Number.isNaN(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}

let flashTimer;
function flash(msg, kind) {
  const el = $('status');
  el.textContent = msg;
  el.className = kind || '';
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { el.textContent = ''; el.className = ''; }, 2200);
}

document.addEventListener('DOMContentLoaded', () => {
  load();
  $('save').addEventListener('click', save);
  $('provider').addEventListener('change', () => {
    applyProviderHints();
    const p = PROVIDERS[$('provider').value];
    if (!$('model').value.trim() || $('model').value === '') {
      $('model').value = p.defaultModel;
    }
  });
  $('resetPrompts').addEventListener('click', () => {
    buildPromptInputs(DEFAULT_PROMPTS);
    flash('Prompts reset (not saved yet).', '');
  });
  $('rerunOnboarding').addEventListener('click', async () => {
    await chrome.storage.local.set({ onboarded: false });
    chrome.tabs.create({ url: chrome.runtime.getURL('onboarding.html') });
  });
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 's') {
      e.preventDefault();
      save();
    }
  });
});
