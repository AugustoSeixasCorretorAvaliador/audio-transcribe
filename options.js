const statusEl = document.getElementById('status');
const inputEl = document.getElementById('apiKey');
const saveBtn = document.getElementById('saveBtn');

function showStatus(msg, isError = false) {
  statusEl.textContent = msg;
  statusEl.style.color = isError ? '#b00020' : '#0a7cff';
}

async function load() {
  const stored = await chrome.storage.local.get(['openaiApiKey']);
  if (stored.openaiApiKey) inputEl.value = stored.openaiApiKey;
}

saveBtn.addEventListener('click', async () => {
  const key = inputEl.value.trim();
  if (!key.startsWith('sk-')) {
    showStatus('API key inválida (esperado formato sk-...).', true);
    return;
  }
  await chrome.storage.local.set({ openaiApiKey: key });
  showStatus('API key salva localmente.');
});

load().catch((e) => showStatus(e?.message || 'Erro ao carregar chave.', true));
