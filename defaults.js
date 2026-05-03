// Shared defaults. Loaded into the service worker via importScripts and into
// option/onboarding pages via a regular <script> tag.
//
// Wrapped in an IIFE so the inner consts don't leak into global scope —
// otherwise `importScripts('defaults.js')` would clash with any top-level
// `const ACTIONS = ...` later in the worker.

(function () {
  const ACTIONS = [
    { id: 'refine',    title: 'Refine' },
    { id: 'formalize', title: 'Formalize' },
    { id: 'elaborate', title: 'Elaborate' },
    { id: 'shorten',   title: 'Shorten' },
    { id: 'casual',    title: 'Make casual' },
    { id: 'fix',       title: 'Fix grammar & spelling' },
  ];

  const DEFAULT_PROMPTS = {
    refine:    'Refine this text for clarity, flow, and word choice while keeping the original meaning, tone, and length roughly intact.',
    formalize: 'Rewrite this text in a more formal, professional register, without becoming stiff or corporate-bland.',
    elaborate: 'Expand this text with concrete supporting detail and reasoning, while preserving the core idea and the author\'s voice.',
    shorten:   'Rewrite this text to be more concise. Cut redundancy and filler without losing meaning or voice.',
    casual:    'Rewrite this text in a casual, conversational tone, as if speaking to a friend.',
    fix:       'Fix grammar, spelling, and punctuation only. Do not change wording, tone, or structure beyond what is required for correctness.',
  };

  const PROVIDERS = {
    vercel: {
      label: 'Vercel AI Gateway',
      endpoint: 'https://ai-gateway.vercel.sh/v1/chat/completions',
      defaultModel: 'anthropic/claude-sonnet-4',
      keyHelp: 'Get a key at vercel.com/dashboard → AI Gateway → API Keys',
      keyUrl: 'https://vercel.com/dashboard/ai-gateway/api-keys',
      modelHint: 'Format: provider/model (e.g. anthropic/claude-sonnet-4, openai/gpt-4o-mini)',
    },
    openrouter: {
      label: 'OpenRouter',
      endpoint: 'https://openrouter.ai/api/v1/chat/completions',
      defaultModel: 'anthropic/claude-sonnet-4',
      keyHelp: 'Get a key at openrouter.ai/keys',
      keyUrl: 'https://openrouter.ai/keys',
      modelHint: 'Format: provider/model (browse models at openrouter.ai/models)',
    },
    custom: {
      label: 'Custom (OpenAI-compatible)',
      endpoint: '',
      defaultModel: '',
      keyHelp: 'Use any OpenAI-compatible /v1/chat/completions endpoint that supports streaming.',
      keyUrl: '',
      modelHint: 'Whatever model id your endpoint expects.',
    },
  };

  const DEFAULT_SETTINGS = {
    provider: 'vercel',
    model: PROVIDERS.vercel.defaultModel,
    customEndpoint: '',
    apiKey: '',
    voice: '',
    antiAI: true,
    prompts: DEFAULT_PROMPTS,
    temperature: 0.7,
    onboarded: false,
  };

  self.VR = { ACTIONS, DEFAULT_PROMPTS, PROVIDERS, DEFAULT_SETTINGS };
})();
