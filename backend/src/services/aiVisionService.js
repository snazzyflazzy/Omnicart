const config = require('../config');

const metrics = {
  attempts: 0,
  successes: 0,
  failures: 0,
  lastRequestAt: null,
  lastResponseRequestId: null,
  lastHTTPStatus: null,
  lastError: null,
  lastNormalizedConfidence: null
};

let lastDebug = null;

function isEnabled() {
  return Boolean(config.enableAIRecognition && config.openaiApiKey);
}

function getAIMetrics() {
  return { ...metrics };
}

function getLastAIDebug() {
  return lastDebug || {};
}

function normalizeWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function extractOutputText(payload) {
  const output = Array.isArray(payload?.output) ? payload.output : [];
  for (const item of output) {
    if (item?.type !== 'message') continue;
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const c of content) {
      if (c?.type === 'output_text' && typeof c?.text === 'string') {
        return c.text;
      }
    }
  }
  return '';
}

function tryParseJson(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    // Attempt to salvage a JSON object substring.
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start >= 0 && end > start) {
      const slice = raw.slice(start, end + 1);
      try {
        return JSON.parse(slice);
      } catch {
        return null;
      }
    }
    return null;
  }
}

async function callOpenAIResponses(body, timeoutMs) {
  const base = String(config.openaiApiBaseUrl || 'https://api.openai.com').replace(/\/+$/g, '');
  const url = `${base}/v1/responses`;

  metrics.attempts += 1;
  metrics.lastRequestAt = new Date().toISOString();
  metrics.lastError = null;
  metrics.lastHTTPStatus = null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(2000, Number(timeoutMs) || config.aiRecognitionTimeoutMs || 9000));

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.openaiApiKey}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });

    metrics.lastHTTPStatus = res.status;
    const payload = await res.json().catch(() => ({}));
    metrics.lastResponseRequestId = payload?.id || payload?.request_id || payload?.response_id || null;
    if (!res.ok) {
      const err = new Error(payload?.error?.message || `OpenAI HTTP ${res.status}`);
      err.httpStatus = res.status;
      err.payload = payload;
      throw err;
    }
    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

async function pingOpenAI() {
  if (!isEnabled()) {
    return { ok: false, enabled: false, reason: 'OPENAI_API_KEY not set' };
  }
  const payload = await callOpenAIResponses(
    {
      model: config.openaiVisionModel,
      input: [
        {
          role: 'user',
          content: [{ type: 'input_text', text: 'ping' }]
        }
      ],
      max_output_tokens: 64
    },
    Math.min(6000, config.aiRecognitionTimeoutMs)
  );
  return {
    ok: true,
    enabled: true,
    requestId: payload?.id || null,
    status: payload?.status || null
  };
}

async function analyzeProductPhoto({ imageBase64, ocrHints = [] }) {
  if (!isEnabled()) {
    return {
      ok: false,
      reason: 'disabled',
      rawModelOutput: '',
      parsedModelOutput: null
    };
  }

  const prompt = [
    'Analyze this shopping product photo. Return ONLY JSON with keys:',
    '{',
    '  "title": string,',
    '  "brand": string,',
    '  "upc": string | null,',
    '  "model": string,',
    '  "keywords": string[],',
    '  "confidence": number',
    '}',
    'Rules:',
    '- No markdown',
    '- If unsure, leave fields empty',
    '- confidence is 0..1'
  ].join('\n');

  const cleanedHints = Array.isArray(ocrHints)
    ? ocrHints.map((h) => normalizeWhitespace(h)).filter(Boolean).slice(0, 12)
    : [];

  const body = {
    model: config.openaiVisionModel,
    max_output_tokens: Math.max(256, Number(config.openaiVisionMaxOutputTokens) || 1200),
    text: { format: { type: 'json_object' } },
    ...(config.openaiVisionReasoningEffort
      ? { reasoning: { effort: String(config.openaiVisionReasoningEffort) } }
      : {}),
    input: [
      {
        role: 'user',
        content: [
          { type: 'input_text', text: prompt },
          ...(cleanedHints.length
            ? [
                {
                  type: 'input_text',
                  text: `OCR hints (may be partial/noisy): ${cleanedHints.join(', ')}`
                }
              ]
            : []),
          {
            type: 'input_image',
            image_url: `data:image/jpeg;base64,${imageBase64}`
          }
        ]
      }
    ]
  };

  const payload = await callOpenAIResponses(body, config.aiRecognitionTimeoutMs);
  const rawModelOutput = extractOutputText(payload);
  const parsedModelOutput = tryParseJson(rawModelOutput);
  const confidence =
    parsedModelOutput && typeof parsedModelOutput.confidence === 'number'
      ? clamp(parsedModelOutput.confidence, 0, 1)
      : null;

  metrics.lastNormalizedConfidence = confidence;
  metrics.successes += 1;

  lastDebug = {
    model: config.openaiVisionModel,
    reasoningEffort: config.openaiVisionReasoningEffort || null,
    confidence,
    lastRequestAt: metrics.lastRequestAt,
    lastResponseRequestId: metrics.lastResponseRequestId,
    prompt,
    ocrHints: cleanedHints,
    rawModelOutput,
    parsedModelOutput,
    payloadPreview: JSON.stringify(payload).slice(0, 1800),
    lastError: null,
    lastHTTPStatus: metrics.lastHTTPStatus
  };

  return {
    ok: true,
    rawModelOutput,
    parsedModelOutput,
    confidence
  };
}

module.exports = {
  isEnabled,
  getAIMetrics,
  getLastAIDebug,
  pingOpenAI,
  analyzeProductPhoto
};

