// popup.js

function formatTime(sec) {
  if (!sec || isNaN(sec)) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function updateUI(data, isConnected) {
  const serverEl = document.getElementById('server-status');
  const playerEl = document.getElementById('player-status');
  const container = document.getElementById('track-container');

  if (isConnected) {
    serverEl.textContent = 'Подключён ✓';
    serverEl.className = 'badge connected';
  } else {
    serverEl.textContent = 'Не подключён';
    serverEl.className = 'badge disconnected';
  }

  if (!data) {
    playerEl.textContent = 'Ожидание';
    playerEl.className = 'badge idle';
    container.innerHTML = `
      <div class="no-track">
        <div class="no-track-icon">🎵</div>
        <p>Открой suno.com<br>и начни воспроизведение</p>
      </div>`;
    return;
  }

  playerEl.textContent = data.isPaused ? '⏸ Пауза' : '▶ Играет';
  playerEl.className = 'badge ' + (data.isPaused ? 'paused' : 'playing');

  const progress = data.duration > 0 ? (data.elapsed / data.duration * 100) : 0;
  const coverHtml = data.coverUrl
    ? `<img class="cover" src="${data.coverUrl}" alt="cover">`
    : `<div class="cover-placeholder">🎵</div>`;

  container.innerHTML = `
    <div class="track-section">
      <div class="cover-row">
        ${coverHtml}
        <div class="track-info">
          <div class="track-title">${escHtml(data.title)}</div>
          <div class="track-artist">${escHtml(data.artist)}</div>
        </div>
      </div>
      <div class="progress-bar">
        <div class="progress-fill" style="width: ${progress.toFixed(1)}%"></div>
      </div>
      <div class="time-row">
        <span>${formatTime(data.elapsed)}</span>
        <span>${formatTime(data.duration)}</span>
      </div>
    </div>`;
}

chrome.runtime.sendMessage({ type: "GET_STATE" }, (response) => {
  if (chrome.runtime.lastError) { updateUI(null, false); return; }
  if (response) {
    updateUI(response.lastData, response.isConnected);
  }
});

// ── Ручная подстройка задержки звука ────────────────────────────────────────
const delaySlider = document.getElementById('delay-offset');
const delayValEl  = document.getElementById('delay-val');

function refreshDelayInfo() {
  chrome.runtime.sendMessage({ type: "GET_DELAY_INFO" }, (info) => {
    if (chrome.runtime.lastError || !info) return;
    delaySlider.value = info.delayOffsetMs;
    const known = typeof info.targetDelayMs === "number" && info.emaLatencyMs !== null;
    delayValEl.textContent = known ? `${info.targetDelayMs}мс` : 'авто (нет замера)';
  });
}

delaySlider.addEventListener('input', () => {
  const offsetMs = parseInt(delaySlider.value, 10);
  chrome.runtime.sendMessage({ type: "SET_DELAY_OFFSET", offsetMs }, () => refreshDelayInfo());
});

refreshDelayInfo();

// ── Привязки «откуда читать» (редактор живёт в picker.js на странице) ──────
const BIND_KEY = "bindings";
const BIND_FIELDS = [
  ["title",  "Название"],
  ["artist", "Исполнитель"],
  ["cover",  "Обложка"],
];
const bindRows = document.getElementById('bind-rows');
const bindHint = document.getElementById('bind-hint');

// Suno часто открыта отдельным окном-приложением, а не активной вкладкой —
// поэтому ищем её среди всех вкладок, предпочитая ту, что играет.
async function findSunoTab() {
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (active && /^https:\/\/(www\.)?suno\.com\//.test(active.url || "")) return active;
  const all = await chrome.tabs.query({ url: ["https://suno.com/*", "https://www.suno.com/*"] });
  return all.find((t) => t.audible) || all[0] || null;
}

function showHint(text, warn) {
  bindHint.textContent = text;
  bindHint.className = 'bind-hint' + (warn ? ' warn' : '');
}

function renderBindings(stored, live) {
  bindRows.innerHTML = "";
  for (const [field, name] of BIND_FIELDS) {
    const selector = stored[field] || "";
    const info = live?.[field];
    let text = "авто", cls = "";
    if (selector) {
      if (!live)              { text = selector; }
      else if (info?.value)   { text = "✓ " + info.value; cls = "ok"; }
      else if (info?.found)   { text = "элемент найден, но пуст"; cls = "miss"; }
      else                    { text = "элемент не найден — работает авто"; cls = "miss"; }
    }
    const row = document.createElement('div');
    row.className = 'bind-row';
    row.innerHTML = `
      <div class="bind-info">
        <div class="bind-name">${name}</div>
        <div class="bind-value ${cls}"></div>
      </div>
      <button class="bind-btn pick" title="Выбрать элемент на странице">🎯</button>
      <button class="bind-btn reset" title="Сбросить привязку" ${selector ? "" : "hidden"}>✕</button>`;
    const valueEl = row.querySelector('.bind-value');
    valueEl.textContent = text;
    valueEl.title = selector;
    row.querySelector('.pick').addEventListener('click', () => startPick(field));
    row.querySelector('.reset').addEventListener('click', () => resetBinding(field));
    bindRows.appendChild(row);
  }
}

async function refreshBindings() {
  const stored = (await chrome.storage.local.get(BIND_KEY))[BIND_KEY] || {};
  const tab = await findSunoTab();
  let live = null;
  if (tab) {
    try { live = await chrome.tabs.sendMessage(tab.id, { type: "GET_BINDINGS" }); } catch {}
  }
  renderBindings(stored, live);
}

async function startPick(field) {
  const tab = await findSunoTab();
  if (!tab) { showHint("Сначала открой suno.com.", true); return; }
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "START_PICK", field });
  } catch {
    // Вкладка открыта до установки/обновления расширения — в ней старый
    // content script без редактора.
    showHint("Обнови страницу Suno (F5) — она открыта до обновления расширения.", true);
    return;
  }
  await chrome.tabs.update(tab.id, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
  window.close();
}

async function resetBinding(field) {
  const stored = (await chrome.storage.local.get(BIND_KEY))[BIND_KEY] || {};
  delete stored[field];
  await chrome.storage.local.set({ [BIND_KEY]: stored });
  refreshBindings();
}

refreshBindings();
