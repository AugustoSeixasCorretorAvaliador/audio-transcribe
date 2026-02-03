const PREFIX = '[HERO-AUDIO]';
const PRIMARY_MODEL = 'gpt-4o-mini-transcribe';
const FALLBACK_MODEL = 'whisper-1';
const REQUEST_TIMEOUT_MS = 60000;
const MAX_FILE_BYTES = 24 * 1024 * 1024; // ~24MB safety cap
const RECENT_DOWNLOAD_MS = 10 * 60 * 1000; // 10 minutos

function log(...args) {
  console.debug(PREFIX, ...args);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) return;

  if (message.type === 'TRANSCRIBE_WHATSAPP_AUDIO') {
    handleTranscription(message).then(sendResponse);
    return true;
  }

  if (message.type === 'SET_API_KEY') {
    setApiKey(message.apiKey)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err?.message || 'Falha ao salvar a chave.' }));
    return true;
  }

  if (message.type === 'GET_API_KEY') {
    getApiKey().then((key) => sendResponse({ ok: Boolean(key), apiKey: key || null }));
    return true;
  }

  if (message.type === 'GET_LAST_AUDIO_DOWNLOAD') {
    findLastAudioDownload()
      .then((item) => sendResponse(item))
      .catch((err) => sendResponse({ ok: false, error: err?.message || 'Falha ao ler downloads.' }));
    return true;
  }
});

async function getApiKey() {
  const stored = await chrome.storage.local.get(['openaiApiKey']);
  return stored.openaiApiKey || null;
}

async function setApiKey(apiKey) {
  if (!apiKey || typeof apiKey !== 'string' || !apiKey.trim().startsWith('sk-')) {
    throw new Error('API key inválida (esperado formato sk-...).');
  }
  await chrome.storage.local.set({ openaiApiKey: apiKey.trim() });
  log('API key salva.');
}

function base64ToUint8Array(base64) {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i += 1) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

async function fetchArrayBufferWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { signal: controller.signal, credentials: 'include' });
    if (!resp.ok) {
      throw new Error(`Falha ao baixar áudio (${resp.status})`);
    }
    const contentType = resp.headers.get('content-type') || undefined;
    const buffer = await resp.arrayBuffer();
    return { buffer, contentType };
  } finally {
    clearTimeout(timer);
  }
}

async function handleTranscription(message) {
  try {
    const apiKey = await getApiKey();
    if (!apiKey) {
      return { ok: false, error: 'API key não configurada.', needsKey: true };
    }

    let audioBytes;
    let mimeType = message.mimeType || 'audio/ogg';

    if (message.audioBase64) {
      log('Recebido áudio em base64');
      audioBytes = base64ToUint8Array(message.audioBase64);
    } else if (message.audioUrl) {
      log('Fetch do áudio via URL', message.audioUrl.slice(0, 80));
      try {
        const { buffer, contentType } = await fetchArrayBufferWithTimeout(message.audioUrl, REQUEST_TIMEOUT_MS);
        audioBytes = new Uint8Array(buffer);
        if (contentType) mimeType = contentType;
      } catch (err) {
        log('Fetch remoto falhou', err?.message || err);
        throw err;
      }
    } else {
      return { ok: false, error: 'Payload de áudio ausente.' };
    }

    if (audioBytes.byteLength > MAX_FILE_BYTES) {
      log('Áudio excede limite, mas tentando mesmo assim', audioBytes.byteLength);
    }

    const transcription = await callOpenAiTranscription({ apiKey, audioBytes, mimeType });
    return { ok: true, text: transcription };
  } catch (err) {
    const message = err?.message || 'Erro inesperado na transcrição.';
    log('Erro na transcrição', message);
    return { ok: false, error: message };
  }
}

function looksLikeAudioFilename(name = '') {
  return /(\.opus|\.ogg|\.oga|\.mp3|\.m4a|\.aac|\.wav)$/i.test(name);
}

function guessMimeFromFilename(name = '') {
  const lower = name.toLowerCase();
  if (lower.endsWith('.opus')) return 'audio/ogg';
  if (lower.endsWith('.ogg') || lower.endsWith('.oga')) return 'audio/ogg';
  if (lower.endsWith('.mp3')) return 'audio/mpeg';
  if (lower.endsWith('.m4a')) return 'audio/mp4';
  if (lower.endsWith('.aac')) return 'audio/aac';
  if (lower.endsWith('.wav')) return 'audio/wav';
  return undefined;
}

async function findLastAudioDownload() {
  return new Promise((resolve, reject) => {
    try {
      chrome.downloads.search({ orderBy: ['-startTime'], limit: 8, state: 'complete' }, (items) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        const now = Date.now();
        const candidate = items.find((item) => {
          const started = new Date(item.startTime).getTime();
          if (!Number.isFinite(started) || now - started > RECENT_DOWNLOAD_MS) return false;
          const mime = item.mime || '';
          if (mime.toLowerCase().startsWith('audio/')) return true;
          if (looksLikeAudioFilename(item.filename || item.finalUrl || item.url || '')) return true;
          return false;
        });
        if (!candidate) {
          resolve({ ok: false, error: 'Nenhum download de áudio recente encontrado.' });
          return;
        }
        resolve({
          ok: true,
          downloadUrl: candidate.url,
          filePath: candidate.filename,
          mimeType: candidate.mime || guessMimeFromFilename(candidate.filename) || 'audio/ogg',
        });
      });
    } catch (err) {
      reject(err);
    }
  });
}

async function callOpenAiTranscription({ apiKey, audioBytes, mimeType }) {
  const fileBlob = new Blob([audioBytes], { type: mimeType || 'audio/ogg' });
  const form = new FormData();
  form.append('file', fileBlob, `whatsapp-audio-${Date.now()}.ogg`);
  form.append('model', PRIMARY_MODEL);
  form.append('language', 'pt');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    let resp = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: controller.signal,
    });

    if (!resp.ok) {
      // Try fallback model if primary failed (e.g., model not available)
      log('Primary model failed, status', resp.status);
      const bodyText = await resp.text();
      log('Primary error body', bodyText.slice(0, 500));
      const fallbackForm = new FormData();
      fallbackForm.append('file', fileBlob, `whatsapp-audio-${Date.now()}.ogg`);
      fallbackForm.append('model', FALLBACK_MODEL);
      fallbackForm.append('language', 'pt');
      resp = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}` },
        body: fallbackForm,
        signal: controller.signal,
      });
    }

    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`Falha na transcrição: ${resp.status} ${errText.slice(0, 300)}`);
    }

    const data = await resp.json();
    const text = data?.text?.trim();
    if (!text) {
      throw new Error('OpenAI retornou resposta vazia.');
    }
    return text;
  } finally {
    clearTimeout(timer);
  }
}
