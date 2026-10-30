const enabledToggle = document.getElementById('enabledToggle');
const whitelistToggle = document.getElementById('whitelistToggle');
const statusMain = document.getElementById('statusMain');
const statusSub = document.getElementById('statusSub');
const statusIcon = document.getElementById('statusIcon');
const listEl = document.getElementById('list');
const urlInput = document.getElementById('urlInput');
const addBtn = document.getElementById('addBtn');
const whitelistBody = document.getElementById('whitelistBody');
const versionEl = document.querySelector('.version');
const pairUI = document.getElementById('pairUI');
const pairedUI = document.getElementById('pairedUI');
const codeBoxes = document.querySelectorAll('#codeBoxes input');
const pairBtn = document.getElementById('pairBtn');
const unpairBtn = document.getElementById('unpairBtn');
const pairError = document.getElementById('pairError');
const nameInput = document.getElementById('nameInput');
const urlInput2 = document.getElementById('urlInput2');
const idleHours = document.getElementById('idleHours');
const maxFails = document.getElementById('maxFails');
const cursorToggle = document.getElementById('cursorToggle');
const settingsError = document.getElementById('settingsError');
const pairedName = document.getElementById('pairedName');
const pairedServer = document.getElementById('pairedServer');
const DEFAULT_WS_URL = 'ws://127.0.0.1:52853/ext';

let whitelist = [];
let statusPollTimer = null;

function generateDefaultName() {
  const ua = navigator.userAgent;
  let browser = 'Browser';
  if (ua.includes('Edg/')) browser = 'Edge';
  else if (ua.includes('Chrome/')) browser = 'Chrome';
  else if (ua.includes('Firefox/')) browser = 'Firefox';
  let os = 'Desktop';
  if (ua.includes('Windows')) os = 'Win';
  else if (ua.includes('Mac OS')) os = 'Mac';
  else if (ua.includes('Linux')) os = 'Linux';
  const id = Math.random().toString(36).slice(2, 6);
  return `${os}-${browser}-${id}`;
}

versionEl.textContent = 'v' + chrome.runtime.getManifest().version;

async function loadState() {
  const state = await chrome.storage.local.get([
    'enabled', 'whitelistEnabled', 'whitelist', 'pairingToken', 'wsUrl', 'clientName',
    'idleTimeout', 'maxFailures', 'showOperationCursor',
  ]);
  enabledToggle.checked = state.enabled === true;
  whitelistToggle.checked = state.whitelistEnabled === true;
  whitelist = state.whitelist || [];
  urlInput2.value = state.wsUrl || DEFAULT_WS_URL;
  cursorToggle.checked = state.showOperationCursor !== false;
  nameInput.value = state.clientName || generateDefaultName();
  idleHours.value = Math.round((state.idleTimeout || 86400000) / 3600000);
  maxFails.value = state.maxFailures || 10;
  renderList();
  updateWhitelistVisibility();
  refreshStatus();
  startPolling();
}

function startPolling() {
  if (statusPollTimer) clearInterval(statusPollTimer);
  statusPollTimer = setInterval(refreshStatus, 2000);
}

async function refreshStatus() {
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'getStatus' });
    if (resp && resp.connected && resp.paired) {
      statusIcon.className = 'status-icon on';
      statusMain.textContent = 'Connected';
      statusSub.textContent = 'Bridge server active';
    } else if (resp && resp.connected && !resp.paired) {
      statusIcon.className = 'status-icon warn';
      statusMain.textContent = 'Not Paired';
      statusSub.textContent = 'Enter pairing code';
    } else if (resp && resp.enabled) {
      statusIcon.className = 'status-icon off';
      statusMain.textContent = 'Connecting...';
      statusSub.textContent = 'Waiting for bridge server';
    } else {
      statusIcon.className = 'status-icon off';
      statusMain.textContent = 'Disabled';
      statusSub.textContent = 'Click switch to enable';
    }
    if (resp) {
      enabledToggle.checked = resp.enabled === true;
      updatePairingUI(resp.paired);
    }
  } catch {
    statusIcon.className = 'status-icon off';
    statusMain.textContent = 'Error';
    statusSub.textContent = 'Service worker inactive';
  }
}

function updatePairingUI(isPaired) {
  if (isPaired) {
    pairUI.style.display = 'none';
    pairedUI.style.display = 'block';
    pairError.style.display = 'none';
    pairedName.textContent = nameInput.value;
    pairedServer.textContent = urlInput2.value || DEFAULT_WS_URL;
  } else {
    pairUI.style.display = 'block';
    pairedUI.style.display = 'none';
  }
}

function renderList() {
  listEl.innerHTML = '';
  if (whitelist.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = whitelistToggle.checked ? 'Page actions are blocked until you add a pattern.' : 'No patterns added';
    listEl.appendChild(empty);
    return;
  }
  for (let i = 0; i < whitelist.length; i++) {
    const item = document.createElement('div');
    item.className = 'item';
    const span = document.createElement('span');
    span.textContent = whitelist[i];
    const btn = document.createElement('button');
    btn.className = 'remove-btn';
    btn.textContent = 'Remove';
    btn.setAttribute('aria-label', `Remove ${whitelist[i]}`);
    btn.addEventListener('click', () => removeItem(i));
    item.appendChild(span);
    item.appendChild(btn);
    listEl.appendChild(item);
  }
}

function updateWhitelistVisibility() {
  whitelistBody.classList.toggle('collapsed', !whitelistToggle.checked);
}

async function saveWhitelist() {
  await chrome.storage.local.set({ whitelist });
  chrome.runtime.sendMessage({ type: 'whitelistUpdated' });
  renderList();
  updateWhitelistVisibility();
}

async function removeItem(index) {
  whitelist.splice(index, 1);
  await saveWhitelist();
}

// --- Event listeners ---

enabledToggle.addEventListener('change', async () => {
  const enabled = enabledToggle.checked;
  await chrome.storage.local.set({ enabled });
  await chrome.runtime.sendMessage({ type: enabled ? 'enable' : 'disable' });
  await refreshStatus();
});

whitelistToggle.addEventListener('change', async () => {
  const whitelistEnabled = whitelistToggle.checked;
  await chrome.storage.local.set({ whitelistEnabled });
  chrome.runtime.sendMessage({ type: 'whitelistUpdated' });
  renderList();
  updateWhitelistVisibility();
});

// Code boxes
function getCode() {
  return Array.from(codeBoxes).map(b => b.value).join('');
}

function updatePairBtn() {
  pairBtn.disabled = getCode().length !== 6;
  codeBoxes.forEach(b => b.classList.toggle('filled', b.value.length > 0));
}

codeBoxes.forEach((box, i) => {
  box.addEventListener('input', () => {
    box.value = box.value.replace(/\D/g, '').slice(-1);
    updatePairBtn();
    if (box.value && i < 5) codeBoxes[i + 1].focus();
  });
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Backspace' && !box.value && i > 0) {
      codeBoxes[i - 1].focus();
      codeBoxes[i - 1].value = '';
      updatePairBtn();
    }
    if (e.key === 'Enter') pairBtn.click();
  });
  box.addEventListener('paste', (e) => {
    e.preventDefault();
    const text = (e.clipboardData.getData('text') || '').replace(/\D/g, '').slice(0, 6);
    for (let j = 0; j < 6; j++) codeBoxes[j].value = text[j] || '';
    updatePairBtn();
    if (text.length === 6) pairBtn.focus();
    else codeBoxes[Math.min(text.length, 5)].focus();
  });
});

pairBtn.addEventListener('click', async () => {
  const code = getCode();
  if (code.length !== 6 || pairBtn.disabled) return;
  pairBtn.disabled = true;
  pairBtn.textContent = 'Pairing...';
  pairError.style.display = 'none';
  const fields = [...codeBoxes, nameInput, urlInput2];
  fields.forEach(field => field.disabled = true);
  try {
    const resp = await chrome.runtime.sendMessage({
      type: 'pair', code,
      name: nameInput.value.trim() || undefined,
      wsUrl: urlInput2.value.trim() || undefined,
    });
    if (!resp?.success) throw new Error(resp?.error || 'Pairing failed');
    codeBoxes.forEach(box => box.value = '');
    await loadState();
  } catch (error) {
    pairError.textContent = error.message || 'Pairing failed. Please try again.';
    pairError.style.display = 'block';
    codeBoxes.forEach(box => box.value = '');
  } finally {
    fields.forEach(field => field.disabled = false);
    pairBtn.textContent = 'Pair browser';
    updatePairBtn();
    if (pairError.style.display === 'block') codeBoxes[0].focus();
  }
});

unpairBtn.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'unpair' });
  await loadState();
});

addBtn.addEventListener('click', async () => {
  const val = urlInput.value.trim();
  if (!val) return;
  if (!whitelist.includes(val)) {
    whitelist.push(val);
    await saveWhitelist();
  }
  urlInput.value = '';
});

urlInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') addBtn.click();
});

async function saveSettings(values) {
  settingsError.hidden = true;
  try {
    await chrome.storage.local.set(values);
    const result = await chrome.runtime.sendMessage({ type: 'settingsUpdated' });
    if (!result?.ok) throw new Error(result?.error || 'Settings could not be applied');
  } catch {
    settingsError.textContent = 'Could not apply settings. Please try again.';
    settingsError.hidden = false;
  }
}

cursorToggle.addEventListener('change', async () => {
  cursorToggle.disabled = true;
  try { await saveSettings({ showOperationCursor: cursorToggle.checked }); }
  finally { cursorToggle.disabled = false; }
});

idleHours.addEventListener('change', async () => {
  const entered = parseInt(idleHours.value);
  const hours = Math.min(720, Math.max(1, Number.isFinite(entered) ? entered : 24));
  idleHours.value = String(hours);
  await saveSettings({ idleTimeout: hours * 3600000 });
});

maxFails.addEventListener('change', async () => {
  const entered = parseInt(maxFails.value);
  const value = Math.min(100, Math.max(1, Number.isFinite(entered) ? entered : 10));
  maxFails.value = String(value);
  await saveSettings({ maxFailures: value });
});

loadState();
