// picker.js — редактор привязок: навёл мышь на элемент плеера, кликнул —
// и расширение читает параметр из этого элемента.
//
// Зачем: Suno регулярно переверстывает плеер, и встроенные селекторы
// content.js однажды перестают находить обложку или название. Привязка даёт
// починить это прямо на странице, не дожидаясь новой версии расширения.
//
// Работает в одном мире с content.js (тот же список content_scripts), поэтому
// пользуется его bindings, boundValue() и BIND_KEY напрямую.

(() => {
  const FIELDS = { title: "Название", artist: "Исполнитель", cover: "Обложка" };
  const Z = "2147483647";

  let field = null;     // какой параметр сейчас привязываем
  let hovered = null;   // элемент под курсором
  let level = 0;        // на сколько предков поднялись стрелкой ↑
  let box = null, tip = null;

  // ── Селектор ──────────────────────────────────────────────────────────────
  // Селектор должен пережить смену трека и перерисовку страницы. Поэтому
  // классы не используем вовсе (у Suno это Tailwind и сгенерированные имена),
  // а опираемся на data-testid, осмысленный id и подписи. Подписи Suno
  // содержат само название трека («Playbar: Title for <название>») — его
  // отрезаем и сравниваем только по неизменному началу.

  const cssStr = (s) => String(s).replace(/["\\]/g, "\\$&");

  function dynamicStrings() {
    const out = [];
    try {
      const md = navigator.mediaSession?.metadata;
      for (const s of [md?.title, md?.artist]) if (s && s.trim().length > 1) out.push(s.trim());
    } catch {}
    return out;
  }

  function labelMatch(value) {
    let v = value.trim();
    for (const dyn of dynamicStrings()) {
      const i = v.indexOf(dyn);
      if (i === 0) return null;                 // подпись — это и есть название
      if (i > 0) { v = v.slice(0, i).trimEnd(); return { op: "^=", v }; }
    }
    // «Playbar: Title for » бывает и с пустым названием — тогда пробел в
    // конце уже срезан trim(), поэтому допускаем и конец строки.
    const m = /^(.*?\bfor)(\s|$)/i.exec(v);
    if (m) return { op: "^=", v: m[1] };
    if (v.length <= 40) return { op: "=", v };
    return { op: "^=", v: v.slice(0, 30) };
  }

  function stablePart(el) {
    const tag = el.tagName.toLowerCase();
    const testId = el.getAttribute("data-testid");
    if (testId) return `${tag}[data-testid="${cssStr(testId)}"]`;
    // id без цифр — скорее всего написан руками, а не сгенерирован фреймворком.
    if (el.id && /^[a-z][a-z_-]{2,}$/i.test(el.id)) return `#${CSS.escape(el.id)}`;
    for (const attr of ["aria-label", "alt", "title"]) {
      const raw = el.getAttribute(attr);
      if (!raw || !raw.trim()) continue;
      const m = labelMatch(raw);
      if (m && m.v) return `${tag}[${attr}${m.op}"${cssStr(m.v)}"]`;
    }
    return null;
  }

  function nthPart(el) {
    const tag = el.tagName.toLowerCase();
    let i = 1;
    for (let s = el.previousElementSibling; s; s = s.previousElementSibling) {
      if (s.tagName === el.tagName) i++;
    }
    return `${tag}:nth-of-type(${i})`;
  }

  function unique(sel, el) {
    try {
      const all = document.querySelectorAll(sel);
      return all.length === 1 && all[0] === el;
    } catch { return false; }
  }

  // content.js читает через querySelector, то есть берёт первое совпадение.
  function firstIs(sel, el) {
    try { return document.querySelector(sel) === el; } catch { return false; }
  }

  // Цепочка от предка (не включая его) до элемента.
  function pathBetween(ancestor, el) {
    const parts = [];
    for (let cur = el; cur && cur !== ancestor; cur = cur.parentElement) {
      parts.unshift(stablePart(cur) || nthPart(cur));
    }
    return parts.join(" > ");
  }

  // Кандидаты — от самых устойчивых к самым хрупким. Короткое «якорь +
  // потомок» (`a[aria-label^="Playbar: Title for"] img`) переживает почти
  // любую переверстку; полный путь от body с nth-of-type ломается от первой же
  // правки и берётся, только если ничего лучше нет. Сначала ищем селектор,
  // находящий ровно этот элемент, затем — хотя бы первым совпадением.
  //
  // Одна подпись у Suno бывает на нескольких элементах: «Playbar: Title for»
  // стоит и на ссылке-названии, и на ссылке-обложке рядом. Различаются они
  // содержимым, поэтому к каждому кандидату пробуем уточнения через :has().
  const REFINE = ["", ":not(:has(img))", ":has(img)"];

  function buildSelector(el) {
    const own = stablePart(el);
    const ownLoose = own || el.tagName.toLowerCase();
    const anchored = [];
    if (own) anchored.push(own);
    for (let a = el.parentElement; a && a !== document.body && a !== document.documentElement; a = a.parentElement) {
      const anchor = stablePart(a);
      if (!anchor) continue;
      anchored.push(`${anchor} ${ownLoose}`);
      anchored.push(`${anchor} > ${pathBetween(a, el)}`);
    }
    const refined = anchored.flatMap((s) => REFINE.map((r) => s + r));
    return refined.find((s) => unique(s, el))
        || refined.find((s) => firstIs(s, el))
        || `body > ${pathBetween(document.body, el)}`;
  }

  // ── Подсветка ─────────────────────────────────────────────────────────────

  function ensureUi() {
    if (box) return;
    box = document.createElement("div");
    tip = document.createElement("div");
    Object.assign(box.style, {
      position: "fixed", zIndex: Z, pointerEvents: "none",
      border: "2px solid #eb459e", background: "rgba(235, 69, 158, 0.12)",
      borderRadius: "4px", boxSizing: "border-box", transition: "all 60ms linear",
    });
    Object.assign(tip.style, {
      position: "fixed", zIndex: Z, pointerEvents: "none", maxWidth: "460px",
      background: "#0d0d0f", color: "#e8e8e8", border: "1px solid #5865f2",
      borderRadius: "6px", padding: "6px 9px", lineHeight: "1.45",
      font: "12px ui-monospace, 'Cascadia Mono', Consolas, monospace",
      boxShadow: "0 4px 16px rgba(0,0,0,.5)", whiteSpace: "pre-wrap", wordBreak: "break-all",
    });
    document.documentElement.append(box, tip);
  }

  function removeUi() {
    box?.remove(); tip?.remove();
    box = tip = null;
  }

  // Для обложки удобнее целиться не точно в <img>: часто сверху лежит
  // прозрачная кнопка. Берём картинку внутри или саму наведённую область.
  function target() {
    let el = hovered;
    for (let i = 0; el && i < level && el.parentElement && el.parentElement !== document.body; i++) {
      el = el.parentElement;
    }
    if (field === "cover" && el && el.tagName !== "IMG") {
      el = el.querySelector("img") || el;
    }
    return el;
  }

  function render() {
    const el = target();
    if (!el || !box) return;
    const r = el.getBoundingClientRect();
    Object.assign(box.style, {
      left: r.left + "px", top: r.top + "px", width: r.width + "px", height: r.height + "px",
    });
    const value = boundValue(field, el) || "— пусто —";
    tip.textContent =
      `${FIELDS[field]}: ${value.length > 90 ? value.slice(0, 90) + "…" : value}\n` +
      `${buildSelector(el)}\n` +
      `клик — привязать · ↑ ↓ — шире/уже · Esc — отмена`;
    const below = r.bottom + 8;
    const top = below + 90 < innerHeight ? below : Math.max(8, r.top - 98);
    Object.assign(tip.style, {
      left: Math.min(Math.max(8, r.left), Math.max(8, innerWidth - 470)) + "px",
      top: top + "px",
    });
  }

  function toast(text, ok = true) {
    const t = document.createElement("div");
    t.textContent = text;
    Object.assign(t.style, {
      position: "fixed", zIndex: Z, left: "50%", bottom: "28px", transform: "translateX(-50%)",
      background: ok ? "#1a3a1a" : "#3a1a1a", color: ok ? "#3ba55d" : "#ed4245",
      border: `1px solid ${ok ? "#3ba55d" : "#ed4245"}`, borderRadius: "6px",
      padding: "8px 14px", font: "12px ui-monospace, Consolas, monospace", maxWidth: "80vw",
    });
    document.documentElement.append(t);
    setTimeout(() => t.remove(), 3500);
  }

  // ── Режим выбора ──────────────────────────────────────────────────────────

  function onMove(e) {
    const el = e.target;
    if (!(el instanceof Element) || el === box || el === tip) return;
    if (el !== hovered) { hovered = el; level = 0; }
    render();
  }

  // Клик по плееру сам по себе что-то делает (пауза, переход на трек) —
  // в режиме выбора глушим всю цепочку событий мыши.
  function swallow(e) {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  }

  function onClick(e) {
    swallow(e);
    // Если мышь не двигалась после включения выбора (курсор уже стоял над
    // плеером), mousemove не было — берём элемент прямо из клика.
    if (!hovered && e.target instanceof Element) hovered = e.target;
    const el = target();
    const f = field;
    stop();
    if (!el) return;
    const sel = buildSelector(el);
    const value = boundValue(f, el);
    extApi.storage.local.get(BIND_KEY, (r) => {
      const next = { ...(r?.[BIND_KEY] || {}), [f]: sel };
      extApi.storage.local.set({ [BIND_KEY]: next }, () => {
        toast(value
          ? `✓ Привязано — ${FIELDS[f]}: ${value.slice(0, 80)}`
          : `Привязано — ${FIELDS[f]}, но элемент сейчас пустой. Проверь в окне расширения`, !!value);
      });
    });
  }

  function onKey(e) {
    if (e.key === "Escape") { swallow(e); stop(); toast("Выбор отменён", false); return; }
    if (e.key === "ArrowUp")   { swallow(e); level++; render(); }
    if (e.key === "ArrowDown") { swallow(e); level = Math.max(0, level - 1); render(); }
  }

  const MOUSE = ["mousedown", "mouseup", "pointerdown", "pointerup", "dblclick", "contextmenu"];

  function start(f) {
    if (field) stop();
    field = f; hovered = null; level = 0;
    ensureUi();
    box.style.width = box.style.height = "0px";
    tip.textContent = `${FIELDS[f]}: наведи мышь на элемент плеера`;
    Object.assign(tip.style, { left: "16px", top: "16px" });
    addEventListener("mousemove", onMove, true);
    addEventListener("click", onClick, true);
    addEventListener("keydown", onKey, true);
    for (const t of MOUSE) addEventListener(t, swallow, true);
    addEventListener("scroll", render, true);
  }

  function stop() {
    field = null;
    removeUi();
    removeEventListener("mousemove", onMove, true);
    removeEventListener("click", onClick, true);
    removeEventListener("keydown", onKey, true);
    for (const t of MOUSE) removeEventListener(t, swallow, true);
    removeEventListener("scroll", render, true);
  }

  // ── Связь с окном расширения ──────────────────────────────────────────────

  extApi.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === "START_PICK" && FIELDS[msg.field]) {
      start(msg.field);
      sendResponse({ ok: true });
    } else if (msg?.type === "GET_BINDINGS") {
      const out = {};
      for (const f of Object.keys(FIELDS)) {
        const el = boundElement(f);
        out[f] = { selector: bindings[f] || "", found: !!el, value: el ? boundValue(f, el) : "" };
      }
      sendResponse(out);
    }
  });
})();
