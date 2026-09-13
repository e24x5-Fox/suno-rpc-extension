// content.js — читает данные плеера со страницы suno.com

const UNKNOWN_TITLE = "Неизвестный трек";
const POLL_MS       = 2000;
const RETRY_MS      = 400;   // быстрые повторы, пока название не прочиталось
const RETRY_LIMIT   = 8;

let sendInterval = null;
let retryTimer   = null;
let retriesLeft  = 0;

// Название иногда не читается, хотя обложка и исполнитель на месте: Suno
// переверстывает заголовок плеера (например, оборачивает длинное название в
// бегущую строку и теряет <a aria-label="Playbar: Title for ...">), и держится
// это до следующей перерисовки — отсюда «то работает, то нет». Поэтому мы
// помним последнее удачно прочитанное название для того же трека и отдаём его,
// вместо того чтобы затирать реальный трек словами «Неизвестный трек».
let lastTrackKey  = "";
let lastGoodTitle = "";
let warnedFor     = "";

function collapse(str) {
  return String(str || "").replace(/\s+/g, " ").trim();
}

// Бегущая строка дублирует текст внутри одного узла: "название название".
// Схлопываем только длинные точные повторы, чтобы не покалечить настоящие
// названия вроде «Boom Boom».
function dedupeMarquee(text) {
  if (text.length < 12) return text;
  const half = Math.floor(text.length / 2);
  const head = text.slice(0, half).trim();
  const tail = text.slice(text.length - half).trim();
  if (head.length > 3 && head === tail) return head;
  return text;
}

function cleanTitle(str) {
  const text = dedupeMarquee(collapse(str));
  return text && text !== UNKNOWN_TITLE ? text : "";
}

// На странице Suno два <audio>: настоящий плеер (blob-источник от MediaSource)
// и служебный с тишиной, cdn-o.suno.com/sil-100.mp3 — сайт держит им системный
// медиа-сеанс. querySelector('audio') берёт первый попавшийся и однажды
// прочитает тишину: нулевую длительность и вечную паузу. Выбираем осознанно.
function pickAudio() {
  const all = [...document.querySelectorAll('audio')]
    .filter((a) => !/\/sil-|silence/i.test(a.currentSrc || a.src || ''));
  if (!all.length) return document.querySelector('audio');
  return all.find((a) => !a.paused)
      || all.find((a) => (a.duration || 0) > 1)
      || all[0];
}

function coverImage() {
  return document.querySelector('img[aria-label^="Playbar: Cover image"]');
}

// Зона плеера: поднимаемся от обложки вверх, пока не найдём предка, внутри
// которого лежат и название, и исполнитель. Нужно, чтобы не хватать
// span.line-clamp-1 из списка треков на странице.
function playbarScope(cover) {
  let el = cover;
  for (let i = 0; el && i < 8; i++) {
    if (el.querySelectorAll('span.line-clamp-1').length >= 2) return el;
    el = el.parentElement;
  }
  return null;
}

function readTitle(cover, scope) {
  // 1. Основной путь: aria-label "Playbar: Title for <название>".
  //    Селектор намеренно без тега — Suno меняла <a> на другой элемент.
  for (const el of document.querySelectorAll('[aria-label^="Playbar: Title for"]')) {
    const found = cleanTitle((el.getAttribute('aria-label') || "").replace(/^.*Title for\s*/i, ""));
    if (found) return found;
  }

  // 2. Название продублировано в aria-label обложки — она переживает
  //    переверстку заголовка, поэтому это самый надёжный запасной источник.
  const label = cover?.getAttribute('aria-label') || "";
  const fromCover = cleanTitle(label.replace(/^.*Cover image for\s*/i, ""));
  if (fromCover && !/^Playbar/i.test(fromCover)) return fromCover;

  // 3. Media Session — то же название, что Suno отдаёт системному плееру.
  try {
    const fromMedia = cleanTitle(navigator.mediaSession?.metadata?.title);
    if (fromMedia) return fromMedia;
  } catch {}

  // 4. Первая строка в зоне плеера.
  const span = scope?.querySelector('span.line-clamp-1');
  const fromSpan = cleanTitle(span?.textContent);
  if (fromSpan) return fromSpan;

  return "";
}

function readArtist(scope) {
  const link =
    document.querySelector('a[aria-label^="Playbar: Artist"]') ||
    document.querySelector('[data-testid="playbar-artist"]');
  const fromLink = collapse(link?.textContent);
  if (fromLink) return dedupeMarquee(fromLink);

  const root = scope || document;
  const spans = root.querySelectorAll('span.line-clamp-1.w-full, span.line-clamp-1');
  const picked = spans.length >= 2 ? spans[1] : spans[0];
  const fromSpan = collapse(picked?.textContent);
  return fromSpan ? dedupeMarquee(fromSpan) : "Suno AI";
}

function getTrackData() {
  try {
    const audio = pickAudio();
    if (!audio) return null;

    const cover = coverImage();
    const scope = playbarScope(cover);

    let coverUrl = "";
    if (cover) {
      // .src (свойство) в content script может вернуть пустую строку —
      // читаем именно атрибуты, data-src это версия в большом разрешении.
      coverUrl = cover.getAttribute('data-src') || cover.getAttribute('src') || "";
      coverUrl = coverUrl.replace(/\?.*$/, "");
    }

    let trackUrl = "";
    const songLink =
      document.querySelector('[aria-label^="Playbar: Title for"][href^="/song/"]') ||
      scope?.querySelector('a[href^="/song/"]');
    if (songLink) trackUrl = "https://suno.com" + songLink.getAttribute('href');
    if (!trackUrl && coverUrl) {
      const m = coverUrl.match(/image(?:_large)?_([a-f0-9-]{36})/i);
      if (m) trackUrl = "https://suno.com/song/" + m[1];
    }

    // Ключ трека — по чему понимаем, что запомненное название всё ещё про него.
    const trackKey = trackUrl || coverUrl || String(Math.round(audio.duration || 0));
    let title = readTitle(cover, scope);

    if (title) {
      lastTrackKey  = trackKey;
      lastGoodTitle = title;
    } else if (trackKey && trackKey === lastTrackKey && lastGoodTitle) {
      title = lastGoodTitle;
    } else {
      title = UNKNOWN_TITLE;
      if (warnedFor !== trackKey) {
        warnedFor = trackKey;
        console.warn("[Suno RPC] Не удалось прочитать название трека.",
          "aria-label заголовка:", document.querySelector('[aria-label^="Playbar: Title for"]')?.getAttribute('aria-label'),
          "| aria-label обложки:", cover?.getAttribute('aria-label'),
          "| зона плеера найдена:", !!scope);
      }
    }

    return {
      // Сервер различает источники активности по этому полю: параллельно к
      // нему подключается youtube-расширение (youtube-extension/), которое
      // шлёт source: "youtube". Без поля сервер считает данные суновскими —
      // старые сборки расширения из-за этого продолжают работать.
      source: "suno",
      title,
      artist: readArtist(scope),
      coverUrl, trackUrl,
      duration: Math.floor(audio.duration) || 0,
      elapsed: Math.floor(audio.currentTime) || 0,
      isPaused: audio.paused,
      timestamp: Date.now()
    };
  } catch (e) { return null; }
}

// Один и тот же файл едет и в Chrome (manifest v3, chrome.*), и в Firefox
// (manifest v2, browser.*) — берём то, что есть в этом браузере.
const runtimeApi = (typeof browser !== "undefined" ? browser : chrome).runtime;

function sendToBackground(data) {
  try { runtimeApi.sendMessage({ type: "TRACK_UPDATE", data }); } catch {}
}

function tick() {
  const data = getTrackData();
  if (!data) return;
  sendToBackground(data);

  // Пока название не прочиталось, перечитываем чаще обычного цикла: чаще
  // всего заголовок дорисовывается через доли секунды после смены трека.
  if (data.title === UNKNOWN_TITLE) {
    if (retriesLeft <= 0) retriesLeft = RETRY_LIMIT;
    if (!retryTimer) {
      retryTimer = setInterval(() => {
        if (retriesLeft-- <= 0) { clearInterval(retryTimer); retryTimer = null; return; }
        const retryData = getTrackData();
        if (retryData && retryData.title !== UNKNOWN_TITLE) {
          clearInterval(retryTimer); retryTimer = null; retriesLeft = 0;
          sendToBackground(retryData);
        }
      }, RETRY_MS);
    }
  } else {
    retriesLeft = 0;
  }
}

function startTracking() {
  if (sendInterval) clearInterval(sendInterval);
  sendInterval = setInterval(tick, POLL_MS);
  tick();
}

// Ждём появления плеера на странице
const observer = new MutationObserver(() => {
  if (document.querySelector('audio')) {
    startTracking();
    observer.disconnect();
  }
});
observer.observe(document.body, { childList: true, subtree: true });
if (document.querySelector('audio')) startTracking();
