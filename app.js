"use strict";

// Декларации ДТ: себестоимость техники по таможенным декларациям. Интерфейс программы на портале:
// данные — через index.php?action=… (lib.php). Оформление и приёмы — как у «Перегона техники».
// Каждое действие сотрудника пишется в журнал (Audit).

const BOOT = window.DT_APP || {};
const USER = BOOT.user || {id: 0, name: "", owner: false, canUse: false};
const IS_OWNER = Boolean(USER.owner);
const DEMO = window.DT_DEMO || null;
const MIN_QUERY = BOOT.minQuery || 3;

const $ = (id) => document.getElementById(id);
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g,
  (c) => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]));

function debounce(fn, ms) {
  let timer = null;
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
}

// Не crypto.randomUUID: на тестовом портале http, а там его нет.
function newId() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  const word = m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
  return `${n} ${word}`;
}

// Совпадение с запросом — подсветкой. VIN вставляют то с пробелами, то без.
function highlight(text, query) {
  const source = String(text ?? "");
  const lower = source.toLowerCase();
  const needles = [query, String(query || "").replace(/\s+/g, "")]
    .map((needle) => String(needle || "").trim().toLowerCase()).filter(Boolean);
  for (const needle of needles) {
    const at = lower.indexOf(needle);
    if (at >= 0) {
      return escapeHtml(source.slice(0, at)) + `<mark>${escapeHtml(source.slice(at, at + needle.length))}</mark>`
        + escapeHtml(source.slice(at + needle.length));
    }
  }
  return escapeHtml(source);
}

// Скачать файл. Фрейм приложения Битрикс бывает в песочнице без права скачивать —
// тогда ссылку жмём в окне портала (он на том же адресе), как в «Перегоне».
function saveFile(href, name) {
  let doc = document;
  try {
    if (window.top !== window && window.top.document.body) doc = window.top.document;
  } catch (e) { /* портал на другом адресе */ }
  const link = doc.createElement("a");
  link.href = new URL(href, location.href).href;
  link.download = name;
  link.hidden = true;
  link.setAttribute("data-slider-ignore-autobinding", "true");
  doc.body.appendChild(link);
  link.click();
  link.remove();
}

// Удобства этого браузера (что свёрнуто, очередь журнала). Недоступно хранилище — просто не помним.
const store = {
  get(key, fallback) {
    try { const value = localStorage.getItem(key); return value == null ? fallback : JSON.parse(value); } catch (_) { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) { /* хранилище недоступно */ }
  },
};

const pad = (n) => String(n).padStart(2, "0");
function fmtTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function fmtDate(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ""));
  return m ? `${m[3]}.${m[2]}.${m[1]}` : String(value || "");
}

const ICON = {
  plus: '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M8 3v10M3 8h10"/></svg>',
  copy: '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5V4A1.5 1.5 0 0 0 9 2.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5"/></svg>',
  chevron: '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5"/></svg>',
  trash: '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 4.5h11M6.5 4.5V3h3v1.5M4 4.5l.7 8.6a1 1 0 0 0 1 .9h4.6a1 1 0 0 0 1-.9l.7-8.6"/></svg>',
  edit: '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.8 2.7a1.5 1.5 0 0 1 2.1 2.1L5.5 12.2 2.5 13l.8-3z"/></svg>',
};


// ---------- колонки и формулы ----------

/*
 * Колонки таблицы — в порядке листа «Себестоимость после 01.26» (VIN вынесен первым, ДТ — в названии декларации).
 * kind: vin — VIN с подсказками; model — из товара, только чтение; text; select — список портала (LISTS); date;
 * money — сумма до 2 знаков; param — общее значение декларации (курс), меняется в заголовке колонки;
 * auto — считается формулой calc (как в Excel). inSum — входит в «Сумму».
 * Обновилась таблица — меняется только этот список.
 */
const FIELDS = [
  {key: "vin", label: "VIN", kind: "vin", required: true, width: 220},
  // Из свойства товара «Модификация» (MODIFIKATSIYA): встаёт с выбором VIN и стирается вместе с ним.
  {key: "model", label: "Марка модель", kind: "model", width: 170},
  {key: "contract", label: "Контракт", kind: "text", width: 120, hint: "Например, КМ-26018"},
  {key: "reserve", label: "Резерв (где растоможили)", kind: "select", width: 230},
  // Графа 29 ДТ: при загрузке XML подбирается из списка сама.
  {key: "organ", label: "Орган въезда/выезда", kind: "select", width: 260},
  {key: "dateExit", label: "Дата выезда с границы", kind: "date", width: 150},
  {key: "dateArrival", label: "Дата прибытия на пост", kind: "date", width: 150},
  {key: "amountY", label: "Отправка в Китай $Y", kind: "money", required: true, width: 140,
    hint: "Сумма отправки в валюте, например 470 500"},
  // Курс один на всю декларацию: задаётся при её создании, меняется в заголовке этой колонки.
  {key: "rate", label: "Курс по ДТ", kind: "param", required: true, width: 150},
  {key: "cost", label: "Стоимость в рублях", kind: "auto", width: 150, inSum: true,
    formula: "Отправка в Китай × Курс по ДТ",
    calc: (v) => (v.amountY != null && v.rate != null ? v.amountY * v.rate : null)},
  {key: "delivery", label: "Доставка до таможни", kind: "money", width: 140, inSum: true},
  {key: "fees", label: "Сборы", kind: "money", width: 120, inSum: true},
  {key: "duty", label: "Пошлина", kind: "money", width: 130, inSum: true},
  {key: "vat", label: "НДС", kind: "money", width: 140, inSum: true},
  {key: "util", label: "Утиль сбор", kind: "money", width: 140},
  {key: "utilVat", label: "Утиль сбор с НДС", kind: "auto", pct: "utilPct", width: 205, inSum: true,
    formula: "(Утиль сбор × %) + Утиль сбор, как в Excel",
    calc: (v, p) => (v.util != null ? v.util * p.utilPct / 100 + v.util : null)},
  {key: "broker", label: "Брокерские", kind: "money", width: 120, inSum: true},
  {key: "svh", label: "СВХ", kind: "money", width: 120, inSum: true},
  {key: "parking", label: "Стоянка", kind: "money", width: 120, inSum: true},
  // «Доп. расходы» — общая шапка над тремя колонками.
  // «Сумма» — как в Excel: из доп. расходов в неё входит только «ЖД в России».
  {key: "rail", label: "ЖД в России", kind: "money", group: "extra", width: 130, inSum: true},
  {key: "pts", label: "ПТС ПСМ быстрота", kind: "money", group: "extra", width: 140},
  {key: "loading", label: "Доп. расходы с погрузкой/выгрузкой", kind: "money", group: "extra", width: 170},
  {key: "sum", label: "Сумма", kind: "auto", width: 160,
    formula: "Стоимость в рублях + расходы + ЖД в России (как в Excel)",
    calc: (v, p, invalid) => {
      if (invalid) return null;
      let total = 0, any = false;
      for (const key of SUM_KEYS) if (v[key] != null) { total += v[key]; any = true; }
      return any ? total : null;
    }},
  // В Excel — «НДС ОТ МАРЖИ =2,64%»: сумма плюс НДС от маржи.
  {key: "total", label: "НДС от маржи", kind: "auto", pct: "extraPct", width: 200,
    formula: "Сумма × % + Сумма",
    calc: (v, p) => (v.sum != null ? v.sum * p.extraPct / 100 + v.sum : null)},
];
const GROUPS = {extra: "Доп. расходы"};
const FIELD = Object.fromEntries(FIELDS.map((field) => [field.key, field]));
// Что хранится в строке. Марка модель — из товара, курс и проценты — у декларации.
// «Авто» тоже хранятся: пусто — считается формулой, число — вписано вручную и формулу заменяет.
const INPUT_FIELDS = FIELDS.filter((field) => ["vin", "text", "select", "date", "money", "auto"].includes(field.kind));
const AUTO_FIELDS = FIELDS.filter((field) => field.kind === "auto");
const SUM_KEYS = FIELDS.filter((field) => field.inSum).map((field) => field.key);
const isNumeric = (field) => field.kind === "money" || field.kind === "rate";
const RATE = {key: "rate", label: "Курс по ДТ", kind: "rate", required: true};

// Проценты в названиях колонок. Задаются при создании декларации, меняются прямо в заголовке.
const PCT = {
  utilPct: {label: "НДС для утиль сбора", column: "Утиль сбор с НДС", def: 22},
  extraPct: {label: "НДС от маржи", column: "НДС от маржи", def: 2.64},
};

/*
 * Колонки-списки — «Резерв (где растоможили)» и «Орган въезда/выезда»: значения полей-списков портала
 * (коды полей — во вкладке «Проверка»). В строке хранится ID значения.
 * Если при загрузке XML значение не подобралось из списка, колонка этой строки открыта для ручного
 * ввода (row.free): в ней поле с подсказками из списка, и можно вписать свой текст.
 */
const LIST_KEYS = FIELDS.filter((field) => field.kind === "select").map((field) => field.key);
const LISTS = Object.fromEntries(LIST_KEYS.map((key) => {
  const options = BOOT.lists?.[key]?.options;
  return [key, (Array.isArray(options) ? options : []).map((option) => ({id: String(option.id), name: String(option.name ?? option.id)}))];
}));
const listName = (key, id) => (LISTS[key] || []).find((option) => option.id === String(id ?? ""))?.name || "";
const listNorm = (value) => String(value ?? "").toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ").trim();
// Значения списков на портале — с кодом таможни: «10504080, Г.ЧЕЛЯБИНСК», «10719110 Т/П "МАПП ЗАБАЙКАЛЬСК"».
const listCodes = (value) => String(value ?? "").split(/\D+/).filter((part) => part.length === 8);
const LIST_GENERIC = new Set(["г", "гор", "город", "т", "п", "тп", "край", "обл", "область", "респ", "республика", "район"]);
/** Слова названия без кодов и общих слов: «10504080, Г.ЧЕЛЯБИНСК» → «челябинск». */
const listCore = (value) => String(value ?? "").toLowerCase().replace(/ё/g, "е").replace(/[^a-zа-я0-9]+/g, " ").trim()
  .split(" ").filter((word) => word && !/^\d+$/.test(word) && !LIST_GENERIC.has(word)).join(" ");
const listByCode = (key, code) => (/^\d{8}$/.test(code || "") ? (LISTS[key] || []).find((option) => listCodes(option.name).includes(code)) || null : null);
/** Набранное в ячейке: значение из списка (название, его суть «челябинск» или код таможни) — ID значения, иначе сам текст. */
function listValue(key, text) {
  const value = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!value) return "";
  const options = LISTS[key] || [];
  const norm = listNorm(value), core = listCore(value);
  const found = options.find((option) => option.id === value || listNorm(option.name) === norm)
    || (core ? options.find((option) => listCore(option.name) === core) : null)
    || listByCode(key, value);
  return found ? found.id : value;
}
const isFree = (row, key) => Array.isArray(row.free) && row.free.includes(key);
const freeOf = (value) => (Array.isArray(value) ? LIST_KEYS.filter((key) => value.includes(key)) : []);

const TOOLS_WIDTH = 110;
const REMOVE_WIDTH = 52;
const TABLE_WIDTH = TOOLS_WIDTH + REMOVE_WIDTH + FIELDS.reduce((sum, field) => sum + field.width, 0);


// ---------- числа ----------

const compact = (value) => String(value ?? "").replace(/[\s  ]/g, "");
const NUM2 = new Intl.NumberFormat("ru-RU", {minimumFractionDigits: 2, maximumFractionDigits: 2});
const NUM_INT = new Intl.NumberFormat("ru-RU", {maximumFractionDigits: 0});

/** Число из «1 243 014,32» или «1243014.32». Пусто — null, не число — NaN. */
function parseNum(value) {
  const text = compact(value).replace(",", ".");
  if (!text) return null;
  return /^\d+(\.\d+)?$/.test(text) ? Number(text) : NaN;
}
function decimals(value) {
  const text = compact(value).replace(",", ".");
  const at = text.indexOf(".");
  return at < 0 ? 0 : text.length - at - 1;
}
const money = (n) => (typeof n === "number" && Number.isFinite(n) ? NUM2.format(n) : "—");

function parsePct(value) {
  const n = parseNum(value);
  return n !== null && !Number.isNaN(n) && n <= 100 && decimals(value) <= 4 ? n : null;
}
const pctText = (n) => String(n ?? "").replace(".", ",");

/** Как значение выглядит в ячейке после ввода: суммы с пробелами, курс с запятой, VIN заглавными. */
function formatInput(field, value) {
  const raw = String(value ?? "").trim();
  if (field.kind === "vin") {
    // Похоже на VIN — заглавными и без пробелов; иначе это название товара из каталога, его не трогаем.
    const text = raw.replace(/\s+/g, " ");
    return /^[A-Za-z0-9 -]+$/.test(text) ? compact(text).toUpperCase() : text;
  }
  if (field.kind === "money" || field.kind === "auto") {
    const n = parseNum(raw);
    if (n === null || Number.isNaN(n) || decimals(raw) > 2) return raw;
    return decimals(raw) ? NUM2.format(n) : NUM_INT.format(n);
  }
  if (field.kind === "rate") {
    const text = compact(raw).replace(".", ",");
    return /^\d+(,\d+)?$/.test(text) ? text : raw;
  }
  return raw;
}
function shownValue(field, value) {
  if (field && field.kind === "date") return fmtDate(value);
  if (field && field.kind === "select") return listName(field.key, value) || String(value ?? "");
  return String(value ?? "");
}


// ---------- проверки ----------

const vinKey = (value) => compact(value).replace(/-/g, "").toUpperCase();

function dtProblem(value) {
  const text = compact(value);
  if (!text) return "Укажите номер ДТ";
  if (/[^\d/]/.test(text)) return "Только цифры и дроби «/»";
  // Дробей сколько угодно — лишь бы между ними были цифры: 10009100/100326/5031568, 10009100/100326/5031568/2.
  if (text.split("/").some((part) => !part)) return "До, между и после дробей должны быть цифры";
  return "";
}


// ---------- что можно набрать ----------
// В номере ДТ — только цифры и дроби «/», в числовых ячейках — только цифры, запятая и точка.
// Буквы и прочие знаки просто не вводятся (и при вставке тоже), над полем на миг появляется подсказка.

const TYPING = [
  {match: (input) => input.matches(".dt-input, #dlg-dt, #dlg-xml-dt"), hint: "В номере ДТ только цифры и дроби «/»",
    clean: (value) => value.replace(/\\/g, "/").replace(/[^\d/]/g, "")},
  {match: (input) => input.inputMode === "decimal", hint: "Только число: цифры и запятая — 470 500 или 8 548,50",
    clean: (value) => value.replace(/[^\d,.\s]/g, "")},
];
const typedBefore = new WeakMap();
let typingHint = null, typingTimer = 0;

function showTypingHint(input, text) {
  if (!typingHint) {
    typingHint = document.createElement("div");
    typingHint.className = "typing-hint";
    typingHint.setAttribute("role", "status");
  }
  // В открытом окне подсказка должна быть внутри него, иначе окно её перекроет.
  (input.closest("dialog") || document.body).appendChild(typingHint);
  const rect = input.getBoundingClientRect();
  typingHint.textContent = text;
  typingHint.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - 320))}px`;
  typingHint.style.top = `${rect.top - 6}px`;
  typingHint.hidden = false;
  clearTimeout(typingTimer);
  typingTimer = setTimeout(() => { typingHint.hidden = true; }, 1800);
}

function setupTyping() {
  const ruleOf = (input) => (input instanceof HTMLInputElement && !input.readOnly ? TYPING.find((rule) => rule.match(input)) : null);
  document.addEventListener("beforeinput", (event) => { if (ruleOf(event.target)) typedBefore.set(event.target, event.target.value); }, true);
  // Ловим раньше всех остальных обработчиков — подсказки, проверки и сохранение видят уже очищенное значение.
  document.addEventListener("input", (event) => {
    const input = event.target;
    const rule = ruleOf(input);
    if (!rule) return;
    const before = typedBefore.get(input);
    typedBefore.delete(input);
    const value = input.value;
    const clean = rule.clean(value);
    if (clean === value) return;
    const caret = rule.clean(value.slice(0, input.selectionStart ?? value.length)).length;
    input.value = clean;
    input.setSelectionRange(caret, caret);
    showTypingHint(input, rule.hint);
    // Набрали только запрещённое — значение не изменилось, остальным обработчикам знать об этом незачем.
    if (clean === before) event.stopImmediatePropagation();
  }, true);
}

/** Средняя часть ДТ — дата ДДММГГ: «100326» → 10.03.2026. */
function dtDate(dt) {
  const m = /^\d+\/(\d{2})(\d{2})(\d{2})\/\d+$/.exec(compact(dt));
  if (!m) return "";
  const day = Number(m[1]), month = Number(m[2]), year = 2000 + Number(m[3]);
  const date = new Date(year, month - 1, day);
  return date.getMonth() === month - 1 && date.getDate() === day ? `${m[1]}.${m[2]}.${year}` : "";
}

function numberProblem(field, value) {
  const raw = compact(value);
  if (!raw) return field.required ? (field.kind === "rate" ? "Укажите курс" : "Укажите сумму") : "";
  const n = parseNum(raw);
  if (Number.isNaN(n)) return field.kind === "rate" ? "Курс — число, например 11,4368" : "Только число: 470 500 или 8 548,50";
  if (field.kind === "rate") {
    const d = decimals(raw);
    if (d !== 4) return `Нужно ровно 4 знака после запятой${d ? ` (сейчас ${d})` : ""}: 11,4368`;
    if (n === 0) return "Курс не может быть нулевым";
  } else if (decimals(raw) > 2) {
    return "Не больше 2 знаков после запятой";
  }
  if (field.required && n === 0) return "Сумма должна быть больше нуля";
  return "";
}

/**
 * VIN: повтор, формат и предупреждения. loud — ошибки, которые видны сразу, ещё до правки строки.
 * Выбран товар из каталога — формат не проверяем: в каталоге не только техника, у товара может не быть VIN.
 */
function vinIssues(value, duplicateText, lookup, product) {
  const vin = vinKey(value);
  if (!vin) return {error: "Укажите VIN"};
  if (duplicateText) return {error: duplicateText, loud: true};
  if (product) return {};
  if (/[А-ЯЁ]/i.test(vin) && /^[A-ZА-ЯЁ0-9]+$/i.test(vin)) {
    return {error: "В VIN кириллица — наберите латиницей или выберите товар из подсказок", loud: true};
  }
  if (!/^[A-Z0-9]+$/.test(vin)) return {warning: "Не похоже на VIN — выберите товар из подсказок"};
  if (vin.length !== 17) return {warning: `В VIN обычно 17 знаков, здесь ${vin.length}`};
  if (/[IOQ]/.test(vin)) return {warning: "В VIN не бывает букв I, O и Q — проверьте"};
  if (lookup === "missing") return {warning: "Нет в каталоге — проверьте VIN"};
  return {};
}

function rowIssues(row, decl, dups) {
  const errors = {}, warnings = {}, loud = new Set();
  const first = dups.dup.get(row.id);
  const duplicate = first
    ? (first.decl === decl ? `Повтор VIN — он уже в строке ${first.index + 1}` : `Повтор VIN — он уже в ДТ ${first.decl.dt}, строка ${first.index + 1}`)
    : "";
  const vin = vinIssues(row.vin, duplicate, state.lookups.get(row.id), row.product);
  if (vin.error) errors.vin = vin.error;
  if (vin.loud) loud.add("vin");
  if (vin.warning) warnings.vin = vin.warning;
  // У товара заполнено свойство DECLARACIA — VIN уже был в декларации: видно сразу, отправить нельзя.
  if (row.product?.declaration && vinKey(row.vin)) {
    errors.vin = `Уже был в декларации ${row.product.declaration} — повторно не отправить`;
    loud.add("vin");
    delete warnings.vin;
  }
  for (const field of INPUT_FIELDS) {
    if (!isNumeric(field)) continue;
    const problem = numberProblem(field, row[field.key]);
    if (problem) errors[field.key] = problem;
  }
  for (const field of AUTO_FIELDS) {
    const raw = compact(row[field.key]);
    if (!raw) continue;
    if (Number.isNaN(parseNum(raw))) errors[field.key] = "Только число: 470 500 или 8 548,50";
    else if (decimals(raw) > 2) errors[field.key] = "Не больше 2 знаков после запятой";
  }
  // Списки: значение не из списка — ошибка, кроме колонок, открытых для ручного ввода после XML.
  for (const key of LIST_KEYS) {
    const value = String(row[key] ?? "").trim();
    if (value && !listName(key, value) && !isFree(row, key)) { errors[key] = "Нет в списке — выберите заново"; loud.add(key); }
  }
  if (row.dateExit && row.dateArrival && row.dateArrival < row.dateExit) warnings.dateArrival = "Раньше даты выезда с границы";
  return {errors, warnings, loud};
}

/** Формулы строки — как в Excel. Курс и проценты — декларации. Пустая ячейка считается нулём; нечисло — итогов нет. */
function compute(row, decl) {
  const values = {};
  let invalid = false;
  for (const field of INPUT_FIELDS) {
    if (!isNumeric(field)) continue;
    const n = parseNum(row[field.key]);
    if (Number.isNaN(n)) invalid = true;
    values[field.key] = n === null || Number.isNaN(n) ? null : n;
  }
  const rate = parseNum(decl.rate);
  if (Number.isNaN(rate)) invalid = true;
  values.rate = rate === null || Number.isNaN(rate) ? null : rate;
  for (const field of AUTO_FIELDS) {
    // Вписано вручную — это значение вместо формулы, и дальше считается уже от него (как перезаписанная ячейка Excel).
    const manual = parseNum(row[field.key]);
    if (Number.isNaN(manual)) { invalid = true; values[field.key] = null; continue; }
    if (manual !== null) { values[field.key] = manual; continue; }
    const result = field.calc(values, decl, invalid);
    values[field.key] = typeof result === "number" && Number.isFinite(result) ? result : null;
  }
  return values;
}


// ---------- журнал действий ----------

/*
 * Каждое действие — запись: что сделал, где (ДТ, VIN), какое поле, было → стало.
 * Записи копятся в очереди (переживает перезагрузку) и уходят на сервер пачками.
 * У записи свой id: повторная отправка после обрыва связи дубля не даёт.
 * Кто и когда — сервер ставит сам по сессии портала, браузеру не верит.
 */
const Audit = (() => {
  const key = `dt.audit.queue.${USER.id}`;
  let queue = store.get(key, []);
  let timer = null;
  let sending = null;
  let flushed = null;

  function track(action, text, extra = {}) {
    if (!USER.canUse) return;
    const entry = {id: newId(), ts: new Date().toISOString(), action, text, user: {id: USER.id, name: USER.name}};
    for (const name of ["dt", "vin", "field", "from", "to"]) {
      const value = extra[name];
      if (value !== undefined && value !== null && value !== "") entry[name] = String(value).slice(0, 500);
    }
    if ("from" in extra || "to" in extra) entry.change = true;
    queue.push(entry);
    if (queue.length > 5000) queue = queue.slice(-5000);
    store.set(key, queue);
    clearTimeout(timer);
    timer = setTimeout(flush, 1200);
  }

  function flush() {
    clearTimeout(timer);
    if (sending) return sending;
    if (!queue.length) return Promise.resolve();
    const batch = queue.slice(0, 200);
    sending = api("log.write", {entries: batch})
      .then(() => {
        const sent = new Set(batch.map((entry) => entry.id));
        queue = queue.filter((entry) => !sent.has(entry.id));
        store.set(key, queue);
        flushed?.();
        if (queue.length) timer = setTimeout(flush, 300);
      })
      .catch(() => { timer = setTimeout(flush, 15000); })
      .finally(() => { sending = null; });
    return sending;
  }

  // Страницу закрывают: ждать ответа некогда — отдаём то, что есть.
  function beacon() {
    if (!queue.length) return;
    if (DEMO) { DEMO.call("log.write", {entries: queue.slice(0, 200)}).catch(() => {}); return; }
    try {
      const body = new Blob([JSON.stringify({entries: queue.slice(0, 200), sessid: BOOT.sessid})], {type: "application/json"});
      navigator.sendBeacon(`${BOOT.api}?action=log.write`, body);
    } catch (_) { /* отправим при следующем входе */ }
  }

  return {track, flush, beacon, set onFlushed(fn) { flushed = fn; }};
})();


// ---------- транспорт ----------

// transport — ответа программы нет (обрыв связи, шлюз не дождался): запрос можно повторить.
const transportError = (message) => Object.assign(new Error(message), {transport: true});

async function api(action, body = {}) {
  if (DEMO) return DEMO.call(action, body);
  let response;
  let text;
  try {
    response = await fetch(`${BOOT.api}?action=${encodeURIComponent(action)}`, {
      method: "POST",
      credentials: "same-origin",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({...body, sessid: BOOT.sessid}),
    });
    text = await response.text();
  } catch (_) {
    throw transportError("Нет связи с порталом — проверьте сеть");
  }
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) { data = null; }
  if (!data) {
    const plain = text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
    throw transportError(`Портал ответил не JSON (HTTP ${response.status})${plain ? `: ${plain}` : ""}`);
  }
  if (!data.ok) throw new Error(data.error || "Ошибка запроса");
  return data.data;
}

function toast(message, kind = "", action = null) {
  document.querySelector(".toast")?.remove();
  const node = document.createElement("div");
  node.className = `toast ${kind}`;
  node.setAttribute("role", kind === "err" ? "alert" : "status");
  const text = document.createElement("span");
  text.textContent = message;
  node.appendChild(text);
  if (action) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "toast-action";
    button.textContent = action.label;
    button.addEventListener("click", () => { node.remove(); action.run(); });
    node.appendChild(button);
  }
  document.body.appendChild(node);
  setTimeout(() => node.remove(), action ? 9000 : kind === "err" ? 9000 : 4500);
}


// ---------- окно подтверждения ----------

/**
 * Одно окно на всё: подтвердить удаление, изменить ДТ, выбрать декларации для отправки.
 * onOk возвращает текст ошибки — окно остаётся открытым и показывает её.
 */
function openDialog({title, desc = "", body = "", ok = "OK", danger = false, onOk, onCancel, onOpen}) {
  const dialog = $("app-dialog");
  const okButton = $("dialog-ok");
  const error = $("dialog-error");
  $("dialog-title").textContent = title;
  $("dialog-desc").textContent = desc;
  $("dialog-body").innerHTML = body;
  error.textContent = "";
  okButton.textContent = ok;
  okButton.classList.toggle("danger", danger);
  okButton.disabled = false;
  let settled = false;

  const cancel = () => {
    if (!settled) { settled = true; onCancel?.(); }
    if (dialog.open) dialog.close();
  };
  okButton.onclick = async () => {
    if (settled) return;
    okButton.disabled = true;
    error.textContent = "";
    try {
      const problem = await onOk?.($("dialog-body"));
      if (problem) { error.textContent = problem; okButton.disabled = false; return; }
      settled = true;
      dialog.close();
    } catch (failure) {
      error.textContent = failure.message;
      okButton.disabled = false;
    }
  };
  $("dialog-cancel").onclick = cancel;
  $("dialog-close").onclick = cancel;
  dialog.oncancel = (event) => { event.preventDefault(); cancel(); };
  $("dialog-body").onkeydown = (event) => {
    if (event.key === "Enter" && event.target.matches("input[type=text], input:not([type])")) { event.preventDefault(); okButton.click(); }
  };
  dialog.showModal();
  onOpen?.($("dialog-body"), okButton);
}


// ---------- поле с поиском по мере набора ----------

/**
 * Поле с подсказками — как VIN в «Перегоне». Выбор хранится отдельно от текста:
 * пока человек не ткнул в вариант, выбранного значения нет.
 */
let activeComboClose = null;
window.addEventListener("scroll", (event) => {
  if (!(event.target instanceof Element) || !event.target.closest(".combo-list")) activeComboClose?.();
}, true);
window.addEventListener("resize", () => activeComboClose?.());

function createCombo(container, {search, render, onPick, minChars = 0, hint = "", delay = 220, empty = "Ничего не найдено"}) {
  const input = container.querySelector(".combo-input");
  const clear = container.querySelector(".combo-clear");
  const listId = `${container.id}-options`;
  let list = null;
  let items = [];
  let active = -1;
  let picked = null;
  let timer = null;
  let seq = 0;

  const syncClear = () => { if (clear) clear.hidden = !input.value; };
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-expanded", "false");
  const close = () => {
    if (list) { list.remove(); list = null; }
    active = -1;
    input.setAttribute("aria-expanded", "false");
    if (activeComboClose === close) activeComboClose = null;
  };

  function ensureList() {
    if (!list) {
      activeComboClose?.();
      activeComboClose = close;
      list = document.createElement("div");
      list.className = "combo-list";
      list.id = listId;
      list.setAttribute("role", "listbox");
      input.setAttribute("aria-controls", list.id);
      input.setAttribute("aria-expanded", "true");
      const rect = input.getBoundingClientRect();
      const width = Math.max(rect.width, 300);
      Object.assign(list.style, {position: "fixed", left: `${Math.min(rect.left, innerWidth - width - 8)}px`, top: `${rect.bottom + 5}px`,
        width: `${width}px`, right: "auto", maxHeight: `${Math.max(100, Math.min(320, innerHeight - rect.bottom - 16))}px`});
      document.body.appendChild(list);
    }
    return list;
  }

  function message(text) {
    ensureList().innerHTML = `<div class="combo-empty">${escapeHtml(text)}</div>`;
  }

  function open() {
    if (!items.length) { message(empty); return; }
    const query = input.value.trim();
    ensureList().innerHTML = items.map((item, index) =>
      `<div role="option" aria-selected="${index === active}" class="combo-option ${index === active ? "active" : ""}" data-index="${index}">
         ${render(item, query)}</div>`).join("");
    list.querySelectorAll(".combo-option").forEach((node) => {
      node.onmousedown = (event) => { event.preventDefault(); pick(items[Number(node.dataset.index)]); };
    });
  }

  function pick(item) {
    if (!item || input.disabled || input.readOnly) return;
    ++seq;
    clearTimeout(timer);
    picked = item;
    input.value = item.label;
    syncClear();
    close();
    onPick?.(item);
  }

  async function refresh() {
    if (input.disabled || input.readOnly) { close(); return; }
    const query = input.value.trim();
    const mine = ++seq;
    if (query.length < minChars) {
      items = [];
      if (hint && document.activeElement === input) message(hint); else close();
      return;
    }
    items = [];
    active = -1;
    message("Ищу…");
    let found;
    try {
      found = await search(query);
    } catch (error) {
      if (mine === seq) message(error.message);
      return;
    }
    if (mine !== seq) return;
    if (document.activeElement !== input) { close(); return; }
    items = found;
    active = items.length ? 0 : -1;
    open();
  }

  input.addEventListener("input", () => {
    syncClear();
    if (picked) { picked = null; onPick?.(null); }
    clearTimeout(timer);
    timer = setTimeout(refresh, delay);
  });
  input.addEventListener("focus", () => { if (!list) refresh(); });
  input.addEventListener("blur", () => setTimeout(close, 120));
  input.addEventListener("keydown", (event) => {
    if (!list || !items.length) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      active = (active + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      open();
      list.querySelector(".combo-option.active")?.scrollIntoView({block: "nearest"});
    } else if (event.key === "Enter") {
      event.preventDefault();
      pick(items[active]);
    } else if (event.key === "Escape") {
      close();
    }
  });
  clear?.addEventListener("click", () => {
    if (input.disabled || input.readOnly) return;
    ++seq;
    clearTimeout(timer);
    const had = picked;
    picked = null;
    input.value = "";
    syncClear();
    close();
    if (had) onPick?.(null);
    input.dispatchEvent(new Event("input", {bubbles: true}));
    input.dispatchEvent(new Event("change", {bubbles: true}));
    input.focus();
  });

  return {
    get value() { return picked; },
    set(item) { ++seq; clearTimeout(timer); picked = item; input.value = item.label; syncClear(); close(); },
    reset() { ++seq; clearTimeout(timer); picked = null; input.value = ""; syncClear(); close(); },
  };
}

// declaration — свойство товара DECLARACIA: заполнено — VIN уже был в декларации, новый элемент по нему не создаётся.
const productOf = (item) => (item ? {id: item.id, vin: item.vin || "", name: item.name || "", model: item.model || "",
  modification: item.modification || "", declaration: item.declaration || "", section: item.section || ""} : null);
// «Марка модель» строки — модификация выбранного товара. Нет товара — пусто.
const modelOf = (row) => (row.product ? String(row.product.modification || "") : "");
// Что встаёт в ячейку VIN: VIN товара, а если его нет (запчасть, навесное) — название товара.
const productLabel = (item) => String(item.vin || item.name || "");

/** Подсказки: все товары каталога по VIN или названию. Уже использованный помечается. */
async function searchVins(query, rowId = null) {
  const data = await api("vin.search", {q: query});
  const seen = duplicateIndex().seen;
  return (data.items || []).map((item) => {
    const at = seen.get(vinKey(productLabel(item)));
    return {...item, label: productLabel(item), usedIn: at && at.row.id !== rowId ? at.decl.dt : ""};
  });
}
function renderVinOption(item, query) {
  const meta = [item.vin ? item.name : "", item.modification || item.model, item.section].filter(Boolean).map(escapeHtml).join(" · ");
  const used = item.usedIn ? ` · <span class="warn">уже в ДТ ${escapeHtml(item.usedIn)}</span>` : "";
  const declared = item.declaration ? `<br><span class="err">Уже был в декларации ${escapeHtml(item.declaration)} — повторно не отправить</span>` : "";
  return `${highlight(productLabel(item), query)}<small>${meta}${used}${declared}</small>`;
}

/**
 * VIN введён руками, без подсказки: ищем точное совпадение в каталоге. В карточке товара VIN бывает
 * не один («4583/X89777222R0EV8014», «VIN1, VIN2») — совпадение с любым из них тоже считается.
 */
async function findVin(vin) {
  try {
    const data = await api("vin.search", {q: vin});
    const parts = (item) => [productLabel(item), ...String(item.vin || "").split(/[\s,;/]+/)].map(vinKey).filter(Boolean);
    const exact = (data.items || []).filter((item) => parts(item).includes(vin));
    return {item: exact.length === 1 ? exact[0] : null};
  } catch (error) {
    return {error: error.message};
  }
}


// ---------- состояние ----------

const EXPANDED_KEY = `dt.ui.expanded.${USER.id}`;
const state = {
  decls: [],              // новые сверху
  loaded: false,
  loadError: "",
  expanded: new Set(),    // развёрнутые декларации
  tried: new Set(),       // нажимали «Отправить» — показываем все ошибки
  touched: new Set(),     // строки, которые правили: в них видны и «пустые обязательные»
  lookups: new Map(),     // строка → checking | missing | error (поиск VIN в каталоге)
  dirty: new Set(),       // декларации с несохранёнными изменениями
  saveTimers: new Map(),
  saveSeq: new Map(),
  inflight: new Map(),
  saving: 0,
  saveError: "",
  savedAt: null,
  sending: false,
  progress: "",           // ход отправки в БП: «ушло 3 из 10 строк»
  query: "",
};

const findDecl = (id) => state.decls.find((decl) => decl.id === id) || null;
const findByDt = (dt) => { const key = compact(dt); return key ? state.decls.find((decl) => decl.dt === key) || null : null; };
// sending — отправка в БП началась, но ушли не все строки: правки закрыты, «Отправить» продолжает.
const locked = (decl) => decl.status !== "draft" || state.sending;
const formatRate = (value) => formatInput(RATE, value);
const persistExpanded = () => store.set(EXPANDED_KEY, [...state.expanded]);

function emptyRow() {
  const row = {id: newId(), product: null, free: []};
  INPUT_FIELDS.forEach((field) => { row[field.key] = ""; });
  return row;
}
const cloneRow = (row) => ({...JSON.parse(JSON.stringify(row)), id: newId()});

const STATUSES = ["draft", "sending", "sent"];

function hydrate(raw) {
  const pct = (value, fallback) => (typeof value === "number" && Number.isFinite(value) ? value : parsePct(String(value ?? "")) ?? fallback);
  // Старые черновики хранили курс в каждой строке — берём первый непустой.
  const rate = raw.rate ?? (raw.rows || []).map((row) => row.rate).find((value) => compact(value)) ?? "";
  const decl = {
    id: String(raw.id || newId()),
    dt: compact(raw.dt),
    rate: formatRate(rate),
    utilPct: pct(raw.utilPct, PCT.utilPct.def),
    extraPct: pct(raw.extraPct, PCT.extraPct.def),
    status: STATUSES.includes(raw.status) ? raw.status : "draft",
    createdAt: raw.createdAt || new Date().toISOString(),
    createdBy: raw.createdBy || null,
    updatedAt: raw.updatedAt || null,
    sentAt: raw.sentAt || null,
    sentBy: raw.sentBy || null,
    rows: (raw.rows || []).map((source) => {
      const row = {id: String(source.id || newId()), product: source.product || null, free: freeOf(source.free)};
      INPUT_FIELDS.forEach((field) => { row[field.key] = formatInput(field, source[field.key] ?? ""); });
      // Строки из XML прежней версии: орган там был текстом — оставляем его вписанным вручную.
      if (!Array.isArray(source.free) && row.organ && !listName("organ", row.organ)) row.free.push("organ");
      return row;
    }),
  };
  return applyProgress(decl, raw);
}

/** Сколько строк уже ушло в БП — из ответа сервера. */
function applyProgress(decl, raw) {
  decl.launched = Number(raw.launched) || 0;
  decl.launchTotal = Number(raw.launchTotal) || 0;
  return decl;
}

function serialize(decl) {
  return {
    id: decl.id, dt: decl.dt, rate: decl.rate, utilPct: decl.utilPct, extraPct: decl.extraPct, status: decl.status,
    createdAt: decl.createdAt, createdBy: decl.createdBy, updatedAt: decl.updatedAt,
    rows: decl.rows.map((row) => {
      const out = {id: row.id, product: row.product, free: freeOf(row.free)};
      INPUT_FIELDS.forEach((field) => { out[field.key] = row[field.key] ?? ""; });
      return out;
    }),
  };
}

/** Где каждый VIN встречается впервые. Отправленные декларации главнее, дальше — по времени создания. */
function duplicateIndex() {
  const seen = new Map(), dup = new Map();
  const ordered = state.decls.map((decl, order) => ({decl, order})).sort((a, b) =>
    (Number(b.decl.status === "sent") - Number(a.decl.status === "sent"))
    || String(a.decl.createdAt || "").localeCompare(String(b.decl.createdAt || ""))
    || a.order - b.order);
  for (const {decl} of ordered) {
    decl.rows.forEach((row, index) => {
      const key = vinKey(row.vin);
      if (!key) return;
      const first = seen.get(key);
      if (first) dup.set(row.id, first); else seen.set(key, {decl, row, index});
    });
  }
  return {seen, dup};
}

function declCheck(decl, dups) {
  // Отправленную и начатую отправку уже проверил сервер: правки закрыты.
  const sent = decl.status !== "draft";
  const reveal = state.tried.has(decl.id);
  const rows = new Map();
  const totals = {};
  let errors = 0, visible = 0;
  // Все ошибки по порядку — их показывает «Отправить», пока декларация не исправлена.
  const problems = [];
  const dtError = dtProblem(decl.dt);
  if (dtError && !sent) { errors++; visible++; problems.push({text: `ДТ: ${dtError}`}); }
  const rateError = sent ? "" : numberProblem(RATE, decl.rate);
  if (rateError) { errors++; visible++; problems.push({text: `Курс по ДТ: ${rateError}`, key: "rate"}); }
  if (!decl.rows.length && !sent) { errors++; visible++; problems.push({text: "нет ни одной строки"}); }
  decl.rows.forEach((row, index) => {
    const values = compute(row, decl);
    const issues = sent ? {errors: {}, warnings: {}, loud: new Set()} : rowIssues(row, decl, dups);
    const show = reveal || state.touched.has(row.id);
    const shown = {};
    for (const [key, text] of Object.entries(issues.errors)) {
      errors++;
      if (show || issues.loud.has(key)) { shown[key] = text; visible++; }
      problems.push({text: `строка ${index + 1}: ${FIELD[key].label} — ${text}`, rowId: row.id, key});
    }
    rows.set(row.id, {values, shown, warnings: issues.warnings});
    for (const field of FIELDS) {
      if (field.kind !== "money" && field.kind !== "auto") continue;
      const value = values[field.key];
      if (typeof value === "number") totals[field.key] = (totals[field.key] || 0) + value;
    }
  });
  const firstProblem = problems[0]?.text || "";
  return {rows, totals, errors, visible, problems, firstProblem, rateError, ok: decl.status === "sending" || (!sent && errors === 0)};
}


// ---------- вкладки ----------

const TAB_NAMES = {decls: "Декларации", access: "Доступ", log: "Журнал действий", check: "Проверка"};
let currentTab = "decls";
const tabsLoaded = new Set();

function setupTabs() {
  document.querySelectorAll(".nav-item").forEach((button) => {
    button.addEventListener("click", () => {
      const tab = button.dataset.tab;
      if (tab === currentTab) return;
      currentTab = tab;
      document.querySelectorAll(".nav-item").forEach((node) => node.classList.toggle("active", node === button));
      document.querySelectorAll("main > section").forEach((node) => node.classList.toggle("hidden", node.id !== `tab-${tab}`));
      Audit.track("tab.open", `Открыл вкладку «${TAB_NAMES[tab]}»`);
      if (tab === "log") loadLog();
      if (tab === "access" && !tabsLoaded.has(tab)) { tabsLoaded.add(tab); loadAccess(); }
      if (tab === "check" && !tabsLoaded.has(tab)) { tabsLoaded.add(tab); runCheck(); loadSettings(); }
    });
  });
}


// ---------- новая декларация ----------

/*
 * Верхний блок — только то, что общее для всей декларации: ДТ, курс и два процента.
 * «Загрузить данные» — декларация с одной пустой строкой; VIN и суммы заполняются уже в ней.
 */
const COMPOSER = [
  {key: "dt", label: "ДТ", required: true, width: 250, placeholder: "00000000/000000/0000000",
    hint: "Только цифры и дроби «/», дробей — сколько нужно", mode: "numeric"},
  {key: "rate", label: "Курс по ДТ", required: true, width: 160, placeholder: "0,0000", num: true,
    hint: "Ровно 4 знака после запятой, например 11,4368"},
  {key: "utilPct", label: "Утиль сбор с НДС, %", width: 180, num: true,
    hint: "Утиль сбор с НДС = (Утиль сбор × %) + Утиль сбор. Обычно 22"},
  {key: "extraPct", label: "НДС от маржи, %", width: 180, num: true,
    hint: "НДС от маржи = Сумма × % + Сумма. Обычно 2,64"},
];
const COMPOSER_FIELD = Object.fromEntries(COMPOSER.map((field) => [field.key, field]));
const COMPOSER_WIDTH = COMPOSER.reduce((sum, field) => sum + field.width, 0);

const formDefaults = () => ({dt: "", rate: "", utilPct: pctText(PCT.utilPct.def), extraPct: pctText(PCT.extraPct.def)});
// picked — выбранная из списка уже существующая (отправленная) декларация: её откроем снова, а не создадим новую.
// portal — такая ДТ уже есть в Битриксе (у товаров заполнено свойство «Декларация»). Её можно загрузить и отправить
// снова; снова не отправить только VIN, которые уже были в декларации.
const form = {values: formDefaults(), tried: false, touched: new Set(), picked: null, portal: null};
let dtCombo = null;

function buildForm() {
  const head = COMPOSER.map((field) => `<th scope="col"${field.num ? ' class="num"' : ""}>${escapeHtml(field.label)}`
    + `${field.required ? '<span class="req" aria-hidden="true">*</span>' : ""}</th>`).join("");
  const cells = COMPOSER.map((field) => {
    const id = `f-${field.key}`;
    if (field.key === "dt") {
      // ДТ — с подсказками: уже существующие декларации. Нет в списке — будет новая.
      return `<td><div class="combo" id="f-dt-combo"><input class="combo-input cell-input dt-input" id="${id}" data-form="dt"`
        + ` aria-label="${escapeHtml(field.label)}" title="${escapeHtml(field.hint)}. Наберите номер — появятся уже существующие декларации"`
        + ` placeholder="${escapeHtml(field.placeholder)}" inputmode="numeric" autocomplete="off" spellcheck="false">`
        + '<button class="combo-clear" type="button" title="Очистить ДТ" hidden>×</button></div>'
        + `<small class="cell-note hidden" data-note="dt" id="${id}-note"></small></td>`;
    }
    return `<td><input class="cell-input${field.num ? " num" : ""}" id="${id}" data-form="${field.key}"`
      + ` value="${escapeHtml(form.values[field.key])}" aria-label="${escapeHtml(field.label)}" title="${escapeHtml(field.hint)}"`
      + `${field.placeholder ? ` placeholder="${escapeHtml(field.placeholder)}"` : ""} inputmode="${field.mode || "decimal"}" autocomplete="off" spellcheck="false">`
      + `<small class="cell-note hidden" data-note="${field.key}" id="${id}-note"></small></td>`;
  }).join("");
  $("form-table").innerHTML = `<table class="table entry-table" style="width:${COMPOSER_WIDTH}px;min-width:${COMPOSER_WIDTH}px">
      <caption class="sr-only">Новая декларация: ДТ, курс и проценты для формул</caption>
      <colgroup>${COMPOSER.map((field) => `<col style="width:${field.width}px">`).join("")}</colgroup>
      <thead><tr>${head}</tr></thead>
      <tbody><tr>${cells}</tr></tbody>
    </table>`;
}

/**
 * Подсказки в поле ДТ: отправленные декларации (сервер, Archive) и те, что уже в работе.
 * Пока источник — отправленные декларации программы; потом — список портала.
 */
async function searchDts(query) {
  const key = compact(query);
  const working = state.decls.filter((decl) => decl.dt.includes(key)).slice(0, 5)
    .map((decl) => ({working: true, id: decl.id, dt: decl.dt, rows: decl.rows.length, label: decl.dt}));
  const data = await api("decl.find", {q: key});
  const known = new Set(working.map((item) => item.dt));
  return [...working, ...(data.items || []).filter((item) => !known.has(item.dt)).map((item) => ({...item, label: item.dt}))];
}

const portalText = (item) => `есть в Битриксе: у ${plural(item.rows, "товара", "товаров", "товаров")} заполнено «Декларация»`
  + `${item.vins?.length ? ` — ${item.vins.slice(0, 3).join(", ")}${item.rows > 3 ? " и др." : ""}` : ""}`;

function renderDtOption(item, query) {
  if (item.portal) return `${highlight(item.dt, compact(query))}<small><span class="warn">${escapeHtml(portalText(item))} · откроется со строками</span></small>`;
  const meta = item.working
    ? `уже в работе — ${plural(item.rows, "строка", "строки", "строк")}, откроется в списке ниже`
    : [`отправлена ${fmtTime(item.sentAt).slice(0, 10)}`, plural(item.rows, "строка", "строки", "строк"),
      item.rate ? `курс ${item.rate}` : "", (item.vins || []).join(", ")].filter(Boolean).join(" · ");
  return `${highlight(item.dt, compact(query))}<small>${escapeHtml(meta)}</small>`;
}

/** Выбрали ДТ из подсказки. В работе — показываем её; отправленная — подставляем её курс и проценты, кнопка «Открыть». */
function pickDt(item, auto = false) {
  if (!item) {
    if (form.picked || form.portal) { form.picked = null; form.portal = null; refreshForm(); }
    return;
  }
  if (item.portal) {
    // Уже есть в Битриксе: выбрали из подсказки — открываем со строками по её VIN;
    // номер набран целиком — кнопка станет «Открыть декларацию».
    form.picked = null;
    form.portal = item;
    form.values.dt = item.dt;
    $("f-dt").value = item.dt;
    if (auto) { refreshForm(); return; }
    openFromPortal(item);
    return;
  }
  if (item.working) {
    // Уже в работе — открываем её: раскрыта, прокручена к ней и подсвечена.
    const decl = findDecl(item.id);
    Audit.track("form.dt.pick", "Открыл декларацию, которая уже в работе", {dt: item.dt});
    resetForm();
    if (decl) showDecl(decl);
    toast(decl ? `Открыл декларацию ДТ ${item.dt}.` : `Декларации ДТ ${item.dt} уже нет в списке — обновите страницу.`, decl ? "ok" : "err");
    return;
  }
  form.picked = item;
  form.values = {dt: item.dt, rate: formatRate(item.rate), utilPct: pctText(item.utilPct), extraPct: pctText(item.extraPct)};
  COMPOSER.forEach((field) => { const input = $(`f-${field.key}`); input.value = form.values[field.key]; input.dataset.before = input.value; });
  Audit.track("form.dt.pick", `Выбрал из списка отправленную декларацию (${plural(item.rows, "строка", "строки", "строк")})`, {dt: item.dt});
  refreshForm();
}

/** Номер набран целиком, но не выбран из подсказки: такая декларация уже есть — подхватываем её. */
async function checkExactDt() {
  const dt = compact(form.values.dt);
  if (form.picked || dtProblem(dt) || findByDt(dt)) return;
  let items = [];
  try { items = (await api("decl.find", {q: dt})).items || []; } catch (_) { return; }
  // Отправленная программой — откроем её; есть только в Битриксе — покажем, что она там есть.
  const exact = items.find((item) => item.dt === dt && !item.portal) || items.find((item) => item.dt === dt);
  if (!exact || compact(form.values.dt) !== dt || form.picked || (form.portal && form.portal.dt === dt)) return;
  dtCombo.set({...exact, label: exact.dt});
  pickDt(exact, true);
}

function setupForm() {
  buildForm();
  const root = $("entry-form");
  dtCombo = createCombo($("f-dt-combo"), {
    minChars: 3, delay: 250, hint: "Наберите хотя бы 3 цифры ДТ — покажу уже существующие декларации",
    search: searchDts,
    render: renderDtOption,
    onPick: pickDt,
    empty: "Такой ДТ в списке нет — будет новая декларация",
  });
  root.addEventListener("focusin", (event) => {
    const key = event.target.dataset.form;
    if (key) event.target.dataset.before = form.values[key] ?? "";
  });
  let dtTimer = 0;
  root.addEventListener("input", (event) => {
    const key = event.target.dataset.form;
    if (!key) return;
    form.values[key] = event.target.value;
    if (key === "dt") {
      clearTimeout(dtTimer);
      if (!dtProblem(form.values.dt)) dtTimer = setTimeout(checkExactDt, 500);
    }
    refreshForm();
  });
  root.addEventListener("change", (event) => {
    const input = event.target;
    const key = input.dataset.form;
    if (!key) return;
    const value = key === "dt" ? compact(input.value) : key === "rate" ? formatRate(input.value) : compact(input.value).replace(".", ",");
    if (value !== input.value) input.value = value;
    form.values[key] = value;
    const before = input.dataset.before ?? "";
    if (before !== value) {
      form.touched.add(key);
      Audit.track("form.edit", `Новая декларация: изменил «${COMPOSER_FIELD[key].label}»`, {
        dt: compact(form.values.dt), field: COMPOSER_FIELD[key].label, from: before, to: value,
      });
    }
    input.dataset.before = value;
    if (key === "dt") checkExactDt();
    refreshForm();
  });
  root.addEventListener("keydown", (event) => {
    // В поле ДТ Enter выбирает вариант из подсказки, пока она открыта.
    if (event.key !== "Enter" || !event.target.dataset.form || event.defaultPrevented) return;
    event.preventDefault();
    event.target.dispatchEvent(new Event("change", {bubbles: true}));
    createFromForm();
  });
  $("add-btn").addEventListener("click", createFromForm);
  $("form-clear").addEventListener("click", () => {
    Audit.track("form.clear", "Очистил блок «Новая декларация»", {dt: compact(form.values.dt)});
    resetForm();
  });
  // XML декларации: из него — новая декларация со строками по VIN.
  $("xml-btn").addEventListener("click", () => {
    if (state.sending) return;
    Audit.track("form.xml.open", "Нажал «Загрузить XML»");
    $("xml-file").click();
  });
  $("xml-file").addEventListener("change", () => {
    const file = $("xml-file").files[0];
    $("xml-file").value = "";
    if (file) loadXml(file);
  });
  refreshForm();
}


// ---------- загрузка XML декларации ----------
// Файл ДТ из программы декларанта: ED_Container → ESADout_CU (тот же файл, что открывается в Excel).
// Префиксы тегов бывают разные (cat_ru:, catESAD_cu:, ns6:…), поэтому теги ищем по имени без префикса.
//   ДТ (графа A)                   — комментарий <!--ND=…--> в конце XML, нет — теги номера, нет — имя файла 10009100_131026_5166277.xml;
//   Курс по ДТ (графа 23)          — ContractCurrencyRate;
//   Орган въезда/выезда (графа 29) — BorderCustomsOffice/OfficeName, нет — DeliveryPlace;
//   Резерв (где растоможили)       — OfficeName / DeliveryPlace, сверенные со списком резерва;
//   Сборы, Пошлина, НДС (графа 47) — PaymentAmount по виду платежа (1… сборы, 2… пошлина, 5… НДС), поровну на все VIN;
//   строки (графа 31.1)            — GoodsAutomobile: VINID, нет — ChassisID. 1 VIN — 1 строка.

const XML_MAX_BYTES = 20 * 1024 * 1024;
const XML_PAYMENTS = [
  {key: "fees", prefix: "1", label: "Сборы"},
  {key: "duty", prefix: "2", label: "Пошлина"},
  {key: "vat", prefix: "5", label: "НДС"},
];

const xmlAll = (root, name) => [...root.getElementsByTagNameNS("*", name)];
const xmlText = (node) => (node ? node.textContent.replace(/\s+/g, " ").trim() : "");
const xmlChild = (node, name) => (node ? [...node.children].find((child) => child.localName === name) || null : null);
/** Первый непустой тег по пути: первое имя — где угодно внутри, остальные — прямо вложенные. */
function xmlFirst(root, ...path) {
  for (const start of xmlAll(root, path[0])) {
    let node = start;
    for (const name of path.slice(1)) { node = xmlChild(node, name); if (!node) break; }
    if (xmlText(node)) return node;
  }
  return null;
}
const xmlInside = (node, pattern) => {
  for (let parent = node.parentElement; parent; parent = parent.parentElement) if (pattern.test(parent.localName)) return true;
  return false;
};
const xmlNum = (value) => { const text = compact(value).replace(",", "."); return /^-?\d+(\.\d+)?$/.test(text) ? Number(text) : null; };
// В ДТ вместо VIN пишут «ОТСУТСТВУЕТ» или прочерк — это не номер.
const xmlId = (value) => { const text = compact(value).toUpperCase(); return /^(ОТСУТСТВУЕТ|НЕТ|НЕ ?УКАЗАН|-+|0+)$/.test(text) ? "" : text; };

/** Текст файла в его кодировке: у таможенных XML бывает windows-1251. */
async function readXmlText(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let encoding = "utf-8";
  if (bytes[0] === 0xFF && bytes[1] === 0xFE) encoding = "utf-16le";
  else if (bytes[0] === 0xFE && bytes[1] === 0xFF) encoding = "utf-16be";
  else if (!(bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF)) {
    const head = String.fromCharCode(...bytes.subarray(0, 200));
    const declared = /^\s*<\?xml[^>]*encoding\s*=\s*["']([\w.:-]+)["']/i.exec(head);
    if (declared) encoding = declared[1];
  }
  try { return new TextDecoder(encoding).decode(bytes); } catch (_) { return new TextDecoder("utf-8").decode(bytes); }
}

/** Номер ДТ из комментария в конце файла: «</ED_Container><!--ND=10009100/131026/5166277-->». Local= — местный номер, не он. */
function xmlNd(text) {
  const found = [...String(text || "").matchAll(/<!--\s*ND\s*=\s*(\d+(?:\s*\/\s*\d+)+)\s*-->/gi)];
  return found.length ? found[found.length - 1][1].replace(/\s+/g, "") : "";
}
/** Номер ДТ в самом XML: код таможни / дата регистрации / номер — не из представленных (гр. 44) и предшествующих (гр. 40) документов. */
function xmlDt(doc) {
  for (const numberNode of xmlAll(doc, "GTDNumber")) {
    if (xmlInside(numberNode, /Presented|Preceding|Previous/i)) continue;
    const parent = numberNode.parentElement;
    const code = xmlText(xmlChild(parent, "CustomsCode"));
    const date = /^(\d{4})-(\d{2})-(\d{2})/.exec(xmlText(xmlChild(parent, "RegistrationDate")));
    const number = xmlText(numberNode);
    if (/^\d+$/.test(code) && date && /^\d+$/.test(number)) return `${code}/${date[3]}${date[2]}${date[1].slice(2)}/${number}`;
  }
  return "";
}
/** Номер ДТ из имени файла: «10009100_131026_5166277.xml» → 10009100/131026/5166277. */
function fileDt(name) {
  const base = String(name || "").replace(/\.[^.]*$/, "");
  const strict = /(\d{8})[_\-\s.](\d{6})[_\-\s.](\d{7})/.exec(base);
  if (strict) return strict.slice(1).join("/");
  const loose = /\d+(?:_\d+){2,}/.exec(base);
  return loose ? loose[0].replace(/_/g, "/") : "";
}

/**
 * Значение списка по названию из XML (коды таможни и общие слова «г.», «т/п», «край» не в счёт):
 * сначала то же название, потом одно внутри другого. Для «Резерва» (место) — ещё и по основе слова:
 * «Т/П МАПП ЗАБАЙКАЛЬСК» → «10719110, ЗАБАЙКАЛЬСКИЙ КРАЙ».
 */
function listByText(key, text) {
  const core = listCore(text);
  if (!core) return null;
  const options = (LISTS[key] || []).map((option) => ({option, core: listCore(option.name)})).filter((item) => item.core.length >= 4);
  const exact = options.find((item) => item.core === core);
  if (exact) return exact.option;
  const pad = (value) => ` ${value} `;
  const inside = options.filter((item) => pad(core).includes(pad(item.core)) || (core.length >= 4 && pad(item.core).includes(pad(core))))
    .sort((a, b) => b.core.length - a.core.length);
  if (inside.length) return inside[0].option;
  if (key !== "reserve") return null;
  return options.find((item) => item.core.split(" ").filter((word) => word.length >= 4)
    .some((word) => core.includes(word.slice(0, Math.max(4, word.length - 2)))))?.option || null;
}

const splitCents = (cents, parts) => {
  const base = Math.floor(cents / parts), rest = cents - base * parts;
  return Array.from({length: parts}, (_, index) => base + (index < rest ? 1 : 0));
};
const centsText = (cents) => formatInput(FIELD.fees, cents % 100 ? (cents / 100).toFixed(2) : String(cents / 100));

/** Разбор XML ДТ. Ошибка — исключение с понятным текстом; то, что не нашлось, — в warnings. */
function parseDtXml(text, fileName) {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.getElementsByTagName("parsererror").length || !doc.documentElement) {
    throw new Error("Файл не читается как XML. Загрузите XML-выгрузку декларации на товары.");
  }
  const esad = xmlAll(doc, "ESADout_CU")[0] || xmlAll(doc, "ESAD_CU")[0];
  if (!esad) throw new Error("В файле нет декларации на товары (ESADout_CU). Загрузите XML-выгрузку ДТ.");
  const warnings = [];

  // ДТ
  // Сначала ND в конце файла, потом теги номера, и только потом имя файла.
  let dt = xmlNd(text) || xmlDt(doc), dtFrom = dt ? "xml" : "";
  if (!dt) { dt = fileDt(fileName); dtFrom = dt ? "file" : ""; }
  if (dt && dtProblem(dt)) { dt = ""; dtFrom = ""; }

  // Курс — ровно 4 знака, как везде в программе
  const rateRaw = xmlText(xmlFirst(esad, "ESADout_CUMainContractTerms", "ContractCurrencyRate") || xmlFirst(esad, "ContractCurrencyRate"));
  const rateNum = xmlNum(rateRaw);
  const rate = rateNum && rateNum > 0 ? rateNum.toFixed(4).replace(".", ",") : "";
  if (!rate) warnings.push("Курса (графа 23, ContractCurrencyRate) в файле нет — впишите его в заголовке колонки «Курс по ДТ».");
  else if (Number(rateNum.toFixed(4)) !== rateNum) warnings.push(`Курс в XML — ${rateRaw}; в декларацию — до 4 знаков: ${rate}.`);
  const currency = xmlText(xmlFirst(esad, "ESADout_CUMainContractTerms", "ContractCurrencyCode"));

  // Орган въезда/выезда и резерв
  const office = xmlText(xmlFirst(esad, "BorderCustomsOffice", "OfficeName"));
  const officeCode = xmlText(xmlFirst(esad, "BorderCustomsOffice", "Code"));
  const places = [...new Set([xmlFirst(esad, "CUESADDeliveryTerms", "DeliveryPlace"), ...xmlAll(doc, "DeliveryPlace")].map(xmlText).filter(Boolean))];
  // Орган (графа 29) — значение списка: по коду поста (10719110), нет — по названию: OfficeName, DeliveryPlace.
  // Не подобралось — в строки встаёт текст из XML (код и название), его можно поправить вручную.
  const organ = office ? [officeCode, office].filter(Boolean).join(" ") : places[0] || "";
  const organOption = listByCode("organ", officeCode)
    || [office, ...places].filter(Boolean).map((source) => listByText("organ", source)).find(Boolean) || null;
  if (!organ) warnings.push("Органа въезда/выезда (графа 29, OfficeName) в файле нет — впишите его в строках вручную или выберите из списка.");
  else if (!organOption && LISTS.organ.length) warnings.push(`Органа «${organ}» нет в списке — в строках он вписан текстом, его можно поправить.`);
  // Резерв (где растоможили) — по коду таможни, где товары (графа 30: 10504080 → Челябинск), или коду из номера ДТ.
  // Такого кода в списке нет — по названию: OfficeName / DeliveryPlace, потом город склада.
  const locationCode = xmlText(xmlFirst(esad, "ESADout_CUGoodsLocation", "CustomsOffice"));
  const city = xmlText(xmlFirst(esad, "ESADout_CUGoodsLocation", "Address", "City"));
  let reserve = listByCode("reserve", locationCode) || listByCode("reserve", compact(dt).split("/")[0]);
  if (!reserve) {
    const found = [office, ...places].filter(Boolean).map((source) => ({source, option: listByText("reserve", source)})).filter((item) => item.option);
    reserve = found[0]?.option || listByText("reserve", city);
    const code = locationCode ? `код таможни в графе 30 — ${locationCode}, в списке такого нет` : "";
    if (!reserve) {
      const seen = [...new Set([code, office, ...places, city].filter(Boolean))].join(", ");
      warnings.push(`Резерв не подобрался из списка${seen ? ` (в XML: ${seen})` : ""} — в строках его можно вписать вручную.`);
    } else if (!found.length) {
      warnings.push(`Резерв — ${reserve.name}: по городу склада «${city}» (графа 30)${code ? `, ${code}` : ""}. Проверьте.`);
    } else if (found.some((item) => item.option.id !== reserve.id)) {
      warnings.push(`В XML разные места: ${found.map((item) => `«${item.source}»`).join(", ")}. Резерв — ${reserve.name}, проверьте.`);
    } else if (code) {
      warnings.push(`Резерв — ${reserve.name} по названию «${found[0].source}»: ${code}. Проверьте.`);
    }
  }

  // Графа 47: платежи по товарам; нет — итоги из графы B
  const payments = xmlAll(esad, "PaymentModeCode").map((codeNode) => {
    const parent = codeNode.parentElement;
    return {code: xmlText(codeNode), amount: xmlNum(xmlText(xmlChild(parent, "PaymentAmount"))),
      currency: xmlText(xmlChild(parent, "PaymentCurrencyCode")), perGoods: xmlInside(codeNode, /Goods$/)};
  }).filter((payment) => payment.code && payment.amount !== null);
  const used = payments.some((payment) => payment.perGoods) ? payments.filter((payment) => payment.perGoods) : payments;
  const totals = {};
  for (const payment of used) {
    const column = XML_PAYMENTS.find((item) => payment.code.startsWith(item.prefix));
    const cents = Math.round(payment.amount * 100);
    if (!column) { warnings.push(`Платёж с кодом ${payment.code} (${centsText(cents)} ₽) не перенесён — для него нет колонки.`); continue; }
    if (payment.currency && !/^(643|RUB)$/i.test(payment.currency)) warnings.push(`Платёж ${payment.code} — в валюте ${payment.currency}, а не в рублях: проверьте «${column.label}».`);
    totals[column.key] = (totals[column.key] || 0) + cents;
  }
  XML_PAYMENTS.forEach((column) => { if (totals[column.key] === undefined) warnings.push(`В графе 47 нет платежа «${column.label}» — колонка останется пустой.`); });

  // Графа 31.1: техника — по строке на VIN
  const rows = [], seenIds = new Set();
  let noId = 0;
  for (const car of xmlAll(esad, "GoodsAutomobile")) {
    const vin = xmlId(xmlText(xmlChild(car, "VINID")));
    const chassis = xmlId(xmlText(xmlChild(car, "ChassisID")));
    const body = xmlId(xmlText(xmlChild(car, "BodyID")));
    const id = vin || chassis || body;
    if (!id) { noId += 1; continue; }
    if (seenIds.has(id)) { warnings.push(`VIN ${id} в XML повторяется — строка одна.`); continue; }
    seenIds.add(id);
    rows.push({vin: id, by: vin ? "" : chassis ? "№ шасси" : "№ кузова",
      name: [xmlText(xmlChild(car, "Mark")), xmlText(xmlChild(car, "Model"))].filter(Boolean).join(" ")});
  }
  if (noId) warnings.push(`${plural(noId, "единица техники", "единицы техники", "единиц техники")} без VIN и № шасси — строки для них не созданы.`);
  if (!rows.length) throw new Error("В файле нет ни одного VIN (графа 31.1, GoodsAutomobile) — декларацию из него не создать.");

  return {fileName, dt, dtFrom, rate, currency, organ, organOption, reserve, totals, rows, warnings};
}

/** «Загрузить XML»: только .xml; разбор, проверка в окне — и новая декларация со строками. */
async function loadXml(file) {
  const fail = (message) => {
    Audit.track("form.xml.fail", `Не загрузил XML «${file.name}»: ${message}`);
    toast(message, "err");
  };
  if (!/\.xml$/i.test(file.name)) { fail("Можно загрузить только XML-файл декларации (.xml)."); return; }
  if (file.size > XML_MAX_BYTES) { fail("Файл больше 20 МБ — это не похоже на XML одной декларации."); return; }
  let parsed;
  try {
    parsed = parseDtXml(await readXmlText(file), file.name);
  } catch (error) {
    fail(error.message || "Файл не прочитался.");
    return;
  }
  Audit.track("form.xml", `Загрузил XML «${file.name}»: ${plural(parsed.rows.length, "VIN", "VIN", "VIN")}`
    + `${parsed.rate ? `, курс ${parsed.rate}` : ""}${parsed.organ ? `, орган ${parsed.organ}` : ""}`, {dt: parsed.dt});
  openXmlDialog(parsed);
}

function openXmlDialog(parsed) {
  const count = parsed.rows.length;
  const perRow = (key) => {
    if (parsed.totals[key] === undefined) return '<span class="muted">нет в XML</span>';
    const parts = splitCents(parsed.totals[key], count);
    const each = parts[0] === parts[count - 1] ? centsText(parts[0]) : `${centsText(parts[count - 1])}–${centsText(parts[0])}`;
    return count > 1 ? `<b>${each}</b> на строку <span class="muted">· всего ${centsText(parsed.totals[key])} ÷ ${count}</span>` : `<b>${each}</b>`;
  };
  const dtNote = parsed.dtFrom === "xml" ? "Номер ДТ — из XML."
    : parsed.dtFrom === "file" ? `Номер ДТ — из имени файла «${parsed.fileName}». Проверьте.`
      : "В файле номера ДТ нет — впишите его.";
  const line = (label, value, where = "") => `<tr><th scope="row">${escapeHtml(label)}${where ? `<small>${escapeHtml(where)}</small>` : ""}</th><td>${value}</td></tr>`;
  const vins = parsed.rows.map((row) => `<li><span class="mono">${escapeHtml(row.vin)}</span>`
    + `${row.by || row.name ? `<small>${escapeHtml([row.by, row.name].filter(Boolean).join(" · "))}</small>` : ""}</li>`).join("");
  openDialog({
    title: "Загрузка XML",
    desc: `Файл «${parsed.fileName}». Проверьте, что взято из декларации: ${plural(count, "строка", "строки", "строк")} — по одной на VIN.`,
    body: `<div class="field"><label for="dlg-xml-dt">ДТ</label>
        <input id="dlg-xml-dt" class="dt-input" type="text" value="${escapeHtml(parsed.dt)}" autocomplete="off" spellcheck="false" inputmode="numeric"
          placeholder="00000000/000000/0000000"><small>${escapeHtml(dtNote)}</small></div>
      <table class="xml-summary"><tbody>
        ${line("Курс по ДТ", parsed.rate ? `<b>${escapeHtml(parsed.rate)}</b>${parsed.currency ? ` <span class="muted">${escapeHtml(parsed.currency)}</span>` : ""}` : '<span class="muted">нет в XML</span>', "графа 23")}
        ${line("Орган въезда/выезда", parsed.organOption ? `<b>${escapeHtml(parsed.organOption.name)}</b> <span class="muted">из списка</span>`
          : parsed.organ ? `${escapeHtml(parsed.organ)} <span class="muted">· ${LISTS.organ.length ? "нет в списке" : "список не задан"} — встанет текстом, можно поправить</span>`
            : '<span class="muted">нет в XML — впишете в строках</span>', "графа 29")}
        ${line("Резерв (где растоможили)", parsed.reserve ? `<b>${escapeHtml(parsed.reserve.name)}</b> <span class="muted">из списка</span>`
          : '<span class="muted">не подобрался — в строках можно вписать вручную</span>')}
        ${XML_PAYMENTS.map((column) => line(column.label, perRow(column.key), "графа 47")).join("")}
        ${line(`VIN — ${count}`, `<ol class="xml-vins">${vins}</ol>`, "графа 31.1")}
      </tbody></table>
      ${parsed.warnings.length ? `<ul class="xml-warn">${parsed.warnings.map((text) => `<li>${escapeHtml(text)}</li>`).join("")}</ul>` : ""}`,
    ok: "Загрузить данные",
    onOpen: (root) => { const input = root.querySelector("#dlg-xml-dt"); input.focus(); if (!input.value) return; input.setSelectionRange(input.value.length, input.value.length); },
    onOk: async (root) => {
      const dt = compact(root.querySelector("#dlg-xml-dt").value);
      const problem = dtProblem(dt);
      if (problem) return problem;
      if (state.sending) return "Идёт отправка — дождитесь её окончания.";
      if (findByDt(dt)) return `Декларация ДТ ${dt} уже в работе — она в списке ниже. Чтобы загрузить XML заново, сначала удалите её.`;
      try {
        const found = (await api("decl.find", {q: dt})).items || [];
        if (found.some((item) => item.dt === dt && !item.portal)) {
          return `ДТ ${dt} уже отправлялась. Её можно открыть снова: наберите номер в «Новой декларации» и выберите из списка.`;
        }
      } catch (_) { /* не проверилось — сервер сам не даст сохранить дубль */ }
      createFromXml(parsed, dt);
      return "";
    },
    onCancel: () => Audit.track("form.xml.cancel", `Закрыл загрузку XML «${parsed.fileName}» без создания декларации`, {dt: parsed.dt}),
  });
}

function createFromXml(parsed, dt) {
  const count = parsed.rows.length;
  const parts = Object.fromEntries(Object.entries(parsed.totals).map(([key, cents]) => [key, splitCents(cents, count)]));
  const rows = parsed.rows.map((car, index) => {
    const row = emptyRow();
    row.vin = car.vin;
    // Подобралось из списка — ID значения; нет — колонка открыта для ручного ввода (орган — с текстом из XML).
    row.organ = parsed.organOption ? parsed.organOption.id : parsed.organ;
    row.reserve = parsed.reserve ? parsed.reserve.id : "";
    row.free = [parsed.reserve ? "" : "reserve", parsed.organOption ? "" : "organ"].filter(Boolean);
    Object.entries(parts).forEach(([key, values]) => { row[key] = centsText(values[index]); });
    return row;
  });
  // Проценты — из блока «Новая декларация» (обычно 22 и 2,64); курс — из XML, нет в XML — из блока, если там верный.
  const rate = parsed.rate || (numberProblem(RATE, form.values.rate) ? "" : formatRate(form.values.rate));
  const decl = {
    id: newId(), dt, rate,
    utilPct: parsePct(form.values.utilPct) ?? PCT.utilPct.def, extraPct: parsePct(form.values.extraPct) ?? PCT.extraPct.def,
    status: "draft", createdAt: new Date().toISOString(), createdBy: {id: USER.id, name: USER.name},
    updatedAt: null, sentAt: null, sentBy: null, launched: 0, launchTotal: 0, rows,
  };
  state.decls.unshift(decl);
  state.expanded.add(decl.id);
  persistExpanded();
  const filled = Object.keys(parts).map((key) => FIELD[key].label.toLowerCase());
  Audit.track("decl.create.xml", `Создал декларацию из XML «${parsed.fileName}»: ${plural(count, "строка", "строки", "строк")}`
    + `, курс ${rate || "—"}, орган ${parsed.organOption ? parsed.organOption.name : parsed.organ ? `${parsed.organ} (текстом)` : "—"}`
    + `, резерв ${parsed.reserve ? parsed.reserve.name : "не подобрался — открыт для ручного ввода"}`
    + `${filled.length ? `, ${filled.join(", ")} — поровну на ${count}` : ""}`, {dt});
  if (state.query && !declMatches(decl, state.query)) { state.query = ""; $("decl-search").value = ""; }
  renderDecls();
  scheduleSave(decl);
  resetForm();
  showDecl(decl);
  toast(`Создана декларация ДТ ${dt} из XML: ${plural(count, "строка", "строки", "строк")}. Остальные колонки заполните вручную.`, "ok");
  // Товар по VIN — как при наборе руками: найдётся в каталоге — встанет «Марка модель».
  // Был ли VIN уже в декларации (свойство товара DECLARACIA) — видно сразу, такие строки не отправятся.
  (async () => {
    for (const row of rows) await checkRowVin(decl, row);
    const declared = rows.filter((row) => row.product?.declaration);
    if (declared.length) {
      toast(`${plural(declared.length, "VIN уже был", "VIN уже были", "VIN уже были")} в декларации: `
        + `${declared.map((row) => `${row.vin} — ${row.product.declaration}`).join("; ")}. Строки подсвечены, отправить их нельзя.`, "err");
    }
  })();
}

function formIssues() {
  const errors = {}, info = {};
  const dt = compact(form.values.dt);
  const dtError = dtProblem(dt);
  const existing = dtError ? null : findByDt(dt);
  const picked = form.picked && form.picked.dt === dt ? form.picked : null;
  const portal = form.portal && form.portal.dt === dt ? form.portal : null;
  // Ошибки, которые видны сразу, ещё до нажатия кнопки.
  const loud = new Set();
  if (dtError) errors.dt = dtError;
  else if (existing) {
    // Набрали номер декларации, которая уже в работе, — кнопка её откроет.
    info.dt = `Декларация ДТ ${dt} уже в работе — ${plural(existing.rows.length, "строка", "строки", "строк")}. «Открыть декларацию» покажет её.`;
  } else if (portal && !picked) {
    info.dt = `ДТ ${portalText(portal)}. «Открыть декларацию» — откроется со строками по этим VIN; они уже были в декларации`
      + " и повторно не уйдут, новые VIN — можно.";
  } else if (picked) {
    info.dt = `Отправленная декларация ${fmtTime(picked.sentAt).slice(0, 10)}, ${plural(picked.rows, "строка", "строки", "строк")}.`
      + " «Открыть декларацию» вернёт её в список со всеми строками — их можно править и отправить снова.";
  } else if (dtDate(dt)) info.dt = `ДТ от ${dtDate(dt)} — будет новая декларация.`;
  const rate = numberProblem(RATE, form.values.rate);
  if (rate) errors.rate = rate;
  for (const key of Object.keys(PCT)) {
    if (parsePct(form.values[key]) === null) errors[key] = compact(form.values[key]) ? "Число от 0 до 100: 22 или 2,64" : "Укажите процент";
  }
  return {errors, info, existing, loud, portal: !dtError && !existing && !picked ? portal : null};
}

function refreshForm() {
  if (!$("entry-form")) return {errors: {}};
  const issues = formIssues();
  document.querySelectorAll("#entry-form [data-note]").forEach((note) => {
    const key = note.dataset.note;
    const show = form.tried || form.touched.has(key) || issues.loud.has(key);
    const text = show ? issues.errors[key] || "" : "";
    note.textContent = text;
    note.className = `cell-note${text ? " err" : " hidden"}`;
    const input = $(`f-${key}`);
    input.setAttribute("aria-invalid", text ? "true" : "false");
    if (text) input.setAttribute("aria-describedby", note.id); else input.removeAttribute("aria-describedby");
  });
  const status = $("form-status");
  const errorKeys = Object.keys(issues.errors).filter((key) => form.tried || issues.loud.has(key));
  if (errorKeys.length) {
    status.textContent = `Исправьте: ${errorKeys.map((key) => `«${COMPOSER_FIELD[key].label}»`).join(", ")}.`;
    status.classList.add("err");
  } else {
    status.textContent = issues.info.dt || "";
    status.classList.remove("err");
  }
  $("add-btn").textContent = form.picked || issues.existing || issues.portal ? "Открыть декларацию" : "Загрузить данные";
  return issues;
}

function resetForm() {
  form.values = formDefaults();
  form.picked = null;
  form.portal = null;
  form.tried = false;
  form.touched.clear();
  dtCombo?.reset();
  COMPOSER.forEach((field) => { const input = $(`f-${field.key}`); input.value = form.values[field.key]; input.dataset.before = input.value; });
  refreshForm();
}

function createFromForm() {
  if (state.sending) return;
  const found = formIssues();
  // Такая ДТ уже в работе — открываем её, курс и проценты тут не нужны.
  if (found.existing) { pickDt({working: true, id: found.existing.id, dt: found.existing.dt}); return; }
  // Есть только в Битриксе — открываем со строками по её VIN.
  if (found.portal) { openFromPortal(found.portal); return; }
  form.tried = true;
  const issues = refreshForm();
  const dt = compact(form.values.dt);
  const problems = Object.keys(issues.errors);
  if (problems.length) {
    Audit.track("form.add.fail", `Не создал декларацию: ${problems.map((key) => `${COMPOSER_FIELD[key].label} — ${issues.errors[key]}`).join("; ")}`, {dt});
    // Такая ДТ уже есть — показываем её, а не заставляем искать.
    if (issues.existing) showDecl(issues.existing);
    $(`f-${problems[0]}`)?.focus({preventScroll: Boolean(issues.existing)});
    return;
  }
  if (form.picked) { reopenFromForm(); return; }
  const decl = {
    id: newId(), dt, rate: formatRate(form.values.rate),
    utilPct: parsePct(form.values.utilPct), extraPct: parsePct(form.values.extraPct),
    status: "draft", createdAt: new Date().toISOString(), createdBy: {id: USER.id, name: USER.name},
    updatedAt: null, sentAt: null, sentBy: null, launched: 0, launchTotal: 0, rows: [emptyRow()],
  };
  state.decls.unshift(decl);
  state.expanded.add(decl.id);
  persistExpanded();
  Audit.track("decl.create", `Создал декларацию: курс ${decl.rate}, утиль сбор с НДС ${pctText(decl.utilPct)} %, НДС от маржи ${pctText(decl.extraPct)} %`, {dt});
  if (state.query && !declMatches(decl, state.query)) { state.query = ""; $("decl-search").value = ""; }
  renderDecls();
  scheduleSave(decl);
  resetForm();
  focusRow(decl.rows[0]);
  toast(`Создана декларация ДТ ${dt}. Заполните строки — VIN и суммы.`, "ok");
}

/**
 * ДТ есть только в Битриксе (у товаров заполнено «Декларация»): открываем её в программе — строка на каждый
 * её VIN, товар подбирается из каталога. Эти VIN уже были в декларации и повторно не уйдут (подсвечены);
 * новые VIN добавляются и отправляются как обычно. Курс и проценты — из блока, если там верные.
 */
function openFromPortal(item) {
  if (state.sending) return;
  const dt = compact(item.dt);
  const existing = findByDt(dt);
  if (existing) { resetForm(); showDecl(existing); return; }
  const vins = (item.vins || []).filter(Boolean);
  const rows = (vins.length ? vins : [""]).map((vin) => { const row = emptyRow(); row.vin = formatInput(FIELD.vin, vin); return row; });
  const decl = {
    id: newId(), dt, rate: numberProblem(RATE, form.values.rate) ? "" : formatRate(form.values.rate),
    utilPct: parsePct(form.values.utilPct) ?? PCT.utilPct.def, extraPct: parsePct(form.values.extraPct) ?? PCT.extraPct.def,
    status: "draft", createdAt: new Date().toISOString(), createdBy: {id: USER.id, name: USER.name},
    updatedAt: null, sentAt: null, sentBy: null, launched: 0, launchTotal: 0, rows,
  };
  state.decls.unshift(decl);
  state.expanded.add(decl.id);
  persistExpanded();
  Audit.track("decl.open.portal", `Открыл ДТ из Битрикса: ${plural(rows.length, "строка", "строки", "строк")} по VIN с заполненной «Декларацией»`,
    {dt, vin: vins.slice(0, 20).join(", ")});
  if (state.query && !declMatches(decl, state.query)) { state.query = ""; $("decl-search").value = ""; }
  renderDecls();
  scheduleSave(decl);
  resetForm();
  showDecl(decl);
  toast(`Открыл ДТ ${dt} из Битрикса: ${plural(rows.length, "строка", "строки", "строк")}. Эти VIN уже были в декларации — повторно не уйдут;`
    + " добавьте новые VIN и заполните курс.", "ok");
  // Товар по VIN — как при наборе руками: встанут «Марка модель» и отметка «уже был в декларации».
  (async () => { for (const row of rows) await checkRowVin(decl, row); })();
}

/** Открыть выбранную отправленную декларацию: она возвращается в список со всеми строками, как была, и правится. */
async function reopenFromForm() {
  const picked = form.picked;
  const button = $("add-btn");
  button.disabled = true;
  try {
    const data = await api("decl.reopen", {
      id: picked.id, rate: formatRate(form.values.rate), utilPct: parsePct(form.values.utilPct), extraPct: parsePct(form.values.extraPct),
    });
    const decl = hydrate(data.item);
    state.decls = [decl, ...state.decls.filter((item) => item.id !== decl.id)];
    state.expanded.add(decl.id);
    persistExpanded();
    Audit.track("decl.reopen", `Открыл отправленную декларацию для правки (${plural(decl.rows.length, "строка", "строки", "строк")})`, {dt: decl.dt});
    if (state.query && !declMatches(decl, state.query)) { state.query = ""; $("decl-search").value = ""; }
    renderDecls();
    resetForm();
    showDecl(decl);
    toast(`Декларация ДТ ${decl.dt} открыта — строки можно править и отправить снова.`, "ok");
    // Свежие «Модификация» и «Декларация» товаров: после отправки БП мог заполнить DECLARACIA.
    refreshProducts();
  } catch (error) {
    Audit.track("decl.reopen.fail", `Не открыл отправленную декларацию: ${error.message}`, {dt: picked.dt});
    toast(error.message, "err");
  } finally {
    button.disabled = false;
  }
}

/** Раскрыть декларацию и подвести к ней. */
function showDecl(decl) {
  if (state.query && !declMatches(decl, state.query)) { state.query = ""; $("decl-search").value = ""; renderDecls(); }
  setOpen(decl, true);
  const node = $(`decl-${decl.id}`);
  if (!node) return;
  activeComboClose?.();
  // Фокус в поле наверху не должен утянуть страницу обратно: убираем его и прокручиваем сразу, без плавности.
  if (document.activeElement instanceof HTMLElement && !node.contains(document.activeElement)) document.activeElement.blur();
  node.scrollIntoView({block: "start"});
  requestAnimationFrame(() => node.scrollIntoView({block: "start"}));
  node.classList.remove("flash");
  void node.offsetWidth;
  node.classList.add("flash");
  setTimeout(() => node.classList.remove("flash"), 1900);
}


// ---------- декларации ----------

function declMatches(decl, query) {
  if (!query) return true;
  const key = compact(query).toUpperCase();
  return decl.dt.includes(key)
    || decl.rows.some((row) => vinKey(row.vin).includes(key) || compact(row.contract).toUpperCase().includes(key));
}

const cols = () => `<col style="width:${TOOLS_WIDTH}px">${FIELDS.map((field) => `<col style="width:${field.width}px">`).join("")}<col style="width:${REMOVE_WIDTH}px">`;

/**
 * Поле в заголовке колонки: курс декларации или процент формулы. Меняется прямо там — пересчитывается вся декларация.
 */
function paramInput(key, decl, readonly) {
  const rate = key === "rate";
  const value = rate ? decl.rate : pctText(decl[key]);
  const label = rate ? "Курс по ДТ для всей декларации" : `${PCT[key].label}, процентов`;
  const title = rate ? "Курс всей декларации — ровно 4 знака после запятой. Можно изменить — всё пересчитается"
    : "Процент можно изменить — всё пересчитается";
  return `<span class="pct"><input class="pct-input${rate ? " rate-input" : ""}" data-param="${key}" value="${escapeHtml(value)}"`
    + ` inputmode="decimal" autocomplete="off" aria-label="${escapeHtml(label)}" title="${escapeHtml(title)}"${rate ? ' placeholder="0,0000"' : ""}`
    + `${readonly ? " readonly" : ""}>${rate ? "" : "%"}</span>`;
}

/** Заголовок колонки: название, поле курса или процента, пометка «авто». */
function headerLabel(field, decl, readonly) {
  const required = field.required ? '<span class="req" aria-hidden="true">*</span>' : "";
  const param = field.kind === "param" ? ` ${paramInput(field.key, decl, readonly)}` : field.pct ? ` ${paramInput(field.pct, decl, readonly)}` : "";
  const auto = field.kind === "auto"
    ? `<span class="auto-tag" title="Считается само: ${escapeHtml(field.formula)}. Можно вписать своё значение — ↺ вернёт формулу">авто</span>` : "";
  const from = field.kind === "model" ? '<span class="auto-tag" title="Из карточки товара: свойство «Модификация»">товар</span>' : "";
  return `${escapeHtml(field.label)}${required}${param}${auto}${from}`;
}

/** Шапка таблицы декларации: № и кнопки слева, «удалить» справа. */
function headHtml(decl, readonly) {
  const th = (field, attrs = "") => {
    const classes = [field.kind === "vin" ? "sticky-l2" : "", isNumeric(field) || field.kind === "auto" || field.kind === "param" ? "num" : "",
      field.kind === "auto" ? "auto" : "", field.group ? "in-group" : ""].filter(Boolean).join(" ");
    const title = field.formula ? ` title="= ${escapeHtml(field.formula)}"` : "";
    return `<th scope="col" class="${classes}"${attrs}${title}>${headerLabel(field, decl, readonly)}</th>`;
  };
  const top = ['<th scope="col" rowspan="2" class="sticky-l1">№<span class="sr-only"> и действия со строкой</span></th>'];
  const sub = [];
  FIELDS.forEach((field, index) => {
    if (!field.group) { top.push(th(field, ' rowspan="2"')); return; }
    // Общая шапка группы — над первой её колонкой.
    if (FIELDS[index - 1]?.group !== field.group) {
      const span = FIELDS.filter((item) => item.group === field.group).length;
      top.push(`<th scope="colgroup" colspan="${span}" class="group">${escapeHtml(GROUPS[field.group])}</th>`);
    }
    sub.push(th(field));
  });
  top.push('<th scope="col" rowspan="2" class="sticky-r"><span class="sr-only">Удалить</span></th>');
  return `<tr>${top.join("")}</tr>${sub.length ? `<tr>${sub.join("")}</tr>` : ""}`;
}

function listOptions(key, value) {
  const current = String(value ?? "");
  const options = LISTS[key] || [];
  const known = !current || options.some((option) => option.id === current);
  return '<option value="">—</option>'
    + options.map((option) => `<option value="${escapeHtml(option.id)}"${option.id === current ? " selected" : ""}>${escapeHtml(option.name)}</option>`).join("")
    // Старое значение не из списка (например, «члб» из прежних черновиков) — видно, пока не выберут из списка.
    + (known ? "" : `<option value="${escapeHtml(current)}" selected>${escapeHtml(current)}</option>`);
}

function cellHtml(row, field, index, readonly) {
  const key = field.key;
  if (field.kind === "auto") {
    // Значение формулы, которое можно переписать. Пусто в строке — формула; вписано — своё значение и кнопка ↺.
    const label = escapeHtml(`${field.label}, строка ${index + 1}`);
    return `<td class="auto${key === "total" ? " grand" : ""}"><div class="auto-box">`
      + `<input class="cell-input num auto-input" data-cell="${key}" data-auto="${key}" inputmode="decimal" autocomplete="off" placeholder="—"`
      + ` aria-label="${label}"${readonly ? " readonly" : ` title="= ${escapeHtml(field.formula)}. Можно вписать своё значение"`}>`
      + `${readonly ? "" : `<button class="auto-reset" type="button" data-act="formula" data-key="${key}" title="Вернуть формулу" aria-label="Вернуть формулу: ${label}" hidden>↺</button>`}`
      + `</div><small class="cell-note hidden" data-note="${key}" id="note-${row.id}-${key}"></small></td>`;
  }
  if (field.kind === "param") return `<td class="auto param"><output data-param-cell="${key}" title="Курс всей декларации — меняется в заголовке колонки">—</output></td>`;
  if (field.kind === "model") {
    return `<td class="from-product"><span class="ro-text" data-ro="model" title="Из карточки товара (свойство «Модификация»). Встаёт с выбором VIN"></span></td>`;
  }
  const label = escapeHtml(`${field.label}, строка ${index + 1}`);
  const value = escapeHtml(row[key] ?? "");
  const ro = readonly ? " readonly" : "";
  const note = `<small class="cell-note hidden" data-note="${key}" id="note-${row.id}-${key}"></small>`;
  if (field.kind === "vin") {
    return `<td class="sticky-l2"><div class="combo" id="vin-${row.id}"><input class="combo-input cell-input vin-input" data-cell="vin" value="${value}"`
      + ` aria-label="${label}" autocomplete="off" spellcheck="false" placeholder="${readonly ? "" : "Укажите VIN"}"${ro}>`
      + `${readonly ? "" : '<button class="combo-clear" type="button" title="Очистить VIN" hidden>×</button>'}</div>`
      + `${note}<div class="cell-meta" data-meta="vin"></div></td>`;
  }
  if (field.kind === "select" && isFree(row, key)) {
    // Из XML не подобралось — можно вписать своё или выбрать из подсказки (значения списка).
    const shown = escapeHtml(shownValue(field, row[key]));
    return `<td class="free"><input class="cell-input free-input" type="text" data-cell="${key}" data-free="${key}" value="${shown}"`
      + `${readonly ? "" : ` list="list-${key}" placeholder="Впишите вручную"`} aria-label="${label}" autocomplete="off"`
      + ` title="Из XML не подобралось из списка — впишите вручную или выберите из подсказки"${ro}>${note}</td>`;
  }
  if (field.kind === "select") {
    return `<td><select class="cell-input cell-select" data-cell="${key}" aria-label="${label}"${readonly ? " disabled" : ""}>`
      + `${listOptions(key, row[key])}</select>${note}</td>`;
  }
  const type = field.kind === "date" ? "date" : "text";
  const mode = isNumeric(field) ? ' inputmode="decimal"' : "";
  const hint = field.hint && !readonly ? ` title="${escapeHtml(field.hint)}"` : "";
  return `<td><input class="cell-input${isNumeric(field) ? " num" : ""}" type="${type}" data-cell="${key}" value="${value}"${mode}`
    + ` aria-label="${label}"${hint} autocomplete="off"${ro}>${note}</td>`;
}

function rowHtml(decl, row, index, readonly) {
  const tools = readonly ? `<span class="row-num">${index + 1}</span>`
    : `<div class="row-tools"><span class="row-num">${index + 1}</span>`
      + `<button class="icon-btn tool" type="button" data-act="plus" title="Добавить пустую строку ниже" aria-label="Добавить пустую строку после строки ${index + 1}">${ICON.plus}</button>`
      + `<button class="icon-btn tool" type="button" data-act="copy" title="Копировать строку" aria-label="Копировать строку ${index + 1}">${ICON.copy}</button></div>`;
  const remove = readonly ? ""
    : `<button class="icon-btn remove-row" type="button" data-act="remove" title="Удалить строку" aria-label="Удалить строку ${index + 1}">×</button>`;
  return `<tr id="row-${row.id}" data-row="${row.id}"><td class="sticky-l1 col-tools">${tools}</td>`
    + FIELDS.map((field) => cellHtml(row, field, index, readonly)).join("")
    + `<td class="sticky-r col-remove">${remove}</td></tr>`;
}

function footHtml() {
  return `<tr><td class="sticky-l1 foot-label" colspan="2">Итого по ДТ</td>`
    + FIELDS.slice(1).map((field) => (field.kind === "money" || field.kind === "auto" ? `<td data-total="${field.key}">—</td>` : "<td></td>")).join("")
    + `<td class="sticky-r"></td></tr>`;
}

function declHtml(decl) {
  const sent = decl.status === "sent";
  const sending = decl.status === "sending";
  const readonly = locked(decl);
  const open = state.expanded.has(decl.id);
  const dt = escapeHtml(decl.dt);
  const tools = decl.status !== "draft" ? "" : `<div class="decl-tools">
      <button class="icon-btn edit decl-edit-dt" type="button" title="Изменить номер ДТ" aria-label="Изменить номер ДТ ${dt}">${ICON.edit}</button>
      <button class="icon-btn decl-remove" type="button" title="Удалить декларацию" aria-label="Удалить декларацию ДТ ${dt}">${ICON.trash}</button></div>`;
  const table = decl.rows.length
    ? `<div class="table-wrap" tabindex="0" role="region" aria-label="Строки декларации ДТ ${dt}">
        <table class="table decl-table" style="width:${TABLE_WIDTH}px;min-width:${TABLE_WIDTH}px">
          <caption class="sr-only">Декларация ДТ ${dt}: строки по машинам, суммы и формулы</caption>
          <colgroup>${cols()}</colgroup>
          <thead>${headHtml(decl, readonly)}</thead>
          <tbody>${decl.rows.map((row, index) => rowHtml(decl, row, index, readonly)).join("")}</tbody>
          <tfoot>${footHtml()}</tfoot>
        </table></div>`
    : '<div class="decl-empty">В декларации нет строк. Нажмите «+ Строка» или удалите декларацию.</div>';
  let foot;
  if (sent) {
    foot = `<span>Отправлена ${escapeHtml(fmtTime(decl.sentAt))}${decl.sentBy ? `, ${escapeHtml(decl.sentBy.name)}` : ""}`
      + ` — ${plural(decl.launchTotal || decl.rows.length, "строка", "строки", "строк")}. Строки не редактируются.</span>`;
  } else if (sending) {
    foot = `<span class="warn">Отправка не закончена: отправлено ${decl.launched} из ${decl.launchTotal} строк.`
      + " Нажмите «Отправить» — отправятся остальные. Правки закрыты.</span>";
  } else {
    foot = `<button class="btn ghost small add-row" type="button">+ Строка</button>
       <span>Слева от строки: ${ICON.plus} — пустая строка ниже, ${ICON.copy} — копия строки. Курс и проценты — в заголовках колонок, их можно менять.
         Ячейки «авто» можно переписать вручную, ↺ вернёт формулу.</span>`;
  }
  return `<article class="decl${open ? " open" : ""}${sent ? " sent" : ""}" id="decl-${decl.id}" data-decl="${decl.id}">
    <header class="decl-head">
      <button class="decl-toggle" type="button" aria-expanded="${open}" aria-controls="decl-body-${decl.id}" title="Свернуть или развернуть">${ICON.chevron}</button>
      <div class="decl-main">
        <div class="decl-title"><span class="decl-dt">ДТ <b data-meta="dt"></b></span><span class="decl-vins" data-meta="vins"></span></div>
        <div class="decl-sub" data-meta="sub"></div>
      </div>
      <div class="decl-sum" data-meta="sum"></div>
      <span class="badge" data-meta="badge"></span>
      ${tools}
    </header>
    <div class="decl-body" id="decl-body-${decl.id}"${open ? "" : " hidden"}>
      <div class="decl-alert hidden" data-meta="alert" role="alert"></div>
      ${table}
      <div class="decl-foot">${foot}</div>
    </div>
  </article>`;
}

function vinsTitle(decl) {
  const vins = [...new Map(decl.rows.filter((row) => vinKey(row.vin)).map((row) => [vinKey(row.vin), String(row.vin).trim()])).values()];
  if (!vins.length) return "VIN не указан";
  if (vins.length <= 2) return `VIN ${vins.join(", ")}`;
  return `VIN ${vins.slice(0, 2).join(", ")} и ещё ${vins.length - 2}`;
}

function declSub(decl) {
  const date = dtDate(decl.dt);
  return [
    date ? `от ${date}` : "",
    decl.rate ? `курс ${decl.rate}` : "курс не указан",
    plural(decl.rows.length, "позиция", "позиции", "позиций"),
    decl.createdBy ? `создал(а) ${decl.createdBy.name}${decl.createdAt ? `, ${fmtTime(decl.createdAt).slice(0, 10)}` : ""}` : "",
  ].filter(Boolean).join(" · ");
}

function badgeOf(decl, check) {
  if (decl.status === "sent") return ["sent", "Отправлена"];
  if (decl.status === "sending") return ["warn", `Отправлено ${decl.launched} из ${decl.launchTotal}`];
  if (!decl.rows.length) return ["err", "Нет строк"];
  if (check.visible) return ["err", plural(check.visible, "ошибка", "ошибки", "ошибок")];
  if (check.errors) return ["warn", "Не заполнена"];
  return ["ok", "Готова к отправке"];
}

function vinMeta(row) {
  if (row.product) {
    const meta = [row.product.name, row.product.modification, `ID товара ${row.product.id}`].filter(Boolean).join(" · ");
    return `<span class="ok">✓</span> <span title="${escapeHtml(meta)}">${escapeHtml(row.product.name)}</span>`;
  }
  const status = state.lookups.get(row.id);
  if (status === "checking") return "Ищу в каталоге…";
  if (status === "error") return '<span class="warn">Каталог недоступен</span>';
  return "";
}

/** Обновить на странице всё, что зависит от значений: формулы, ошибки, итоги, заголовок. */
function paintDecl(decl, check) {
  const node = $(`decl-${decl.id}`);
  if (!node) return;
  node.querySelector('[data-meta="dt"]').textContent = decl.dt;
  node.querySelector('[data-meta="vins"]').textContent = vinsTitle(decl);
  node.querySelector('[data-meta="sub"]').textContent = declSub(decl);
  node.querySelector('[data-meta="sum"]').innerHTML = decl.rows.length
    ? `<b>${money(check.totals.total)} ₽</b><small>с НДС от маржи ${escapeHtml(pctText(decl.extraPct))} %</small>` : "";
  const [kind, text] = badgeOf(decl, check);
  const badge = node.querySelector('[data-meta="badge"]');
  badge.className = `badge ${kind}`;
  badge.textContent = text;
  badge.title = check.firstProblem && decl.status === "draft" ? `Первая проблема: ${check.firstProblem}` : "";
  // Курс — один на декларацию: ошибка видна над таблицей и рамкой поля в заголовке.
  const alert = node.querySelector('[data-meta="alert"]');
  alert.textContent = check.rateError ? `Курс по ДТ: ${check.rateError}. Исправьте его в заголовке колонки «Курс по ДТ».` : "";
  alert.classList.toggle("hidden", !check.rateError);
  node.querySelector('[data-param="rate"]')?.setAttribute("aria-invalid", check.rateError ? "true" : "false");

  for (const row of decl.rows) {
    const tr = node.querySelector(`[data-row="${row.id}"]`);
    const info = check.rows.get(row.id);
    if (!tr || !info) continue;
    tr.querySelectorAll("[data-auto]").forEach((input) => {
      const key = input.dataset.auto;
      const manual = Boolean(compact(row[key]));
      input.closest("td").classList.toggle("manual", manual);
      const reset = input.parentElement.querySelector(".auto-reset");
      if (reset) reset.hidden = !manual;
      // Ячейку, в которой сейчас печатают, не перезаписываем.
      if (document.activeElement === input) return;
      input.value = manual ? row[key] : (typeof info.values[key] === "number" ? money(info.values[key]) : "");
    });
    tr.querySelectorAll("[data-param-cell]").forEach((out) => { out.textContent = decl.rate || "—"; });
    tr.querySelectorAll('[data-ro="model"]').forEach((out) => {
      const model = modelOf(row);
      // Товар найден, а «Модификации» у него нет — говорим об этом прямо, а не ставим прочерк.
      out.textContent = model || (row.product ? "не заполнена в товаре" : "—");
      out.title = model ? "Из карточки товара: свойство «Модификация»"
        : row.product ? `У товара «${row.product.name}» (ID ${row.product.id}) в каталоге не заполнено свойство «Модификация»`
        : "Встанет из карточки товара, когда выберете VIN";
      out.classList.toggle("empty", !model);
    });
    tr.querySelectorAll("[data-note]").forEach((note) => {
      const key = note.dataset.note;
      const error = info.shown[key];
      const warning = info.warnings[key];
      const text = error || warning || "";
      note.textContent = text;
      note.classList.toggle("hidden", !text);
      note.classList.toggle("err", Boolean(error));
      note.classList.toggle("warn", !error && Boolean(warning));
      const input = tr.querySelector(`[data-cell="${key}"]`);
      if (!input) return;
      input.setAttribute("aria-invalid", error ? "true" : "false");
      if (text) input.setAttribute("aria-describedby", note.id); else input.removeAttribute("aria-describedby");
    });
    tr.classList.toggle("bad", Object.keys(info.shown).length > 0);
    tr.querySelector('[data-meta="vin"]').innerHTML = vinMeta(row);
    tr.querySelectorAll(".combo-clear").forEach((button) => { button.hidden = !button.parentElement.querySelector("input").value; });
  }
  node.querySelectorAll("[data-total]").forEach((td) => { td.textContent = money(check.totals[td.dataset.total]); });
}

/** Пересчитать проверки всех деклараций; перерисовать одну (only) или все. */
function refresh(only = null) {
  const dups = duplicateIndex();
  const checks = new Map(state.decls.map((decl) => [decl.id, declCheck(decl, dups)]));
  (only ? [only] : state.decls).forEach((decl) => paintDecl(decl, checks.get(decl.id)));
  renderQueueStatus(checks);
  refreshForm();
  return checks;
}

function renderDecls() {
  activeComboClose?.();
  const list = $("decl-list");
  const visible = state.decls.filter((decl) => declMatches(decl, state.query));
  if (state.loadError) {
    list.innerHTML = `<div class="notice err" style="margin:0">Декларации не загрузились: ${escapeHtml(state.loadError)}
      <button class="btn ghost small" type="button" id="decl-retry" style="margin-left:10px">Повторить</button></div>`;
  } else if (!state.loaded) {
    list.innerHTML = '<div class="decl-empty">Загрузка деклараций…</div>';
  } else if (!state.decls.length) {
    list.innerHTML = '<div class="decl-empty">Деклараций в работе нет. Наберите номер ДТ в блоке «Новая декларация» выше:'
      + ' новую — создадите, уже отправленную — выберете из списка и откроете снова.</div>';
  } else if (!visible.length) {
    list.innerHTML = `<div class="decl-empty">По запросу «${escapeHtml(state.query)}» ничего не найдено.</div>`;
  } else {
    list.innerHTML = visible.map(declHtml).join("");
  }
  visible.forEach(attachDecl);
  return refresh();
}

function renderDecl(decl) {
  const node = $(`decl-${decl.id}`);
  if (!node) { renderDecls(); return; }
  activeComboClose?.();
  node.outerHTML = declHtml(decl);
  attachDecl(decl);
  refresh();
}

function attachDecl(decl) {
  if (locked(decl)) return;
  decl.rows.forEach((row) => attachVinCombo(decl, row));
}

function attachVinCombo(decl, row) {
  const container = $(`vin-${row.id}`);
  if (!container) return;
  const input = container.querySelector("input");
  const combo = createCombo(container, {
    minChars: MIN_QUERY, delay: 300, hint: `Введите минимум ${MIN_QUERY} знака VIN`,
    search: (query) => searchVins(query, row.id),
    render: renderVinOption,
    onPick: (item) => { if (item) pickRowVin(decl, row, item, input); },
  });
  if (row.product && vinKey(productLabel(row.product)) === vinKey(row.vin)) combo.set({...row.product, label: row.vin});
}

/** В журнал — смена «Марки модели»: она идёт за товаром, руками её не правят. */
function trackModel(decl, row, before, why) {
  const after = modelOf(row);
  if (before === after) return;
  Audit.track("row.model", `${why} в строке ${decl.rows.indexOf(row) + 1}`,
    {dt: decl.dt, vin: row.vin, field: FIELD.model.label, from: before, to: after});
}

function pickRowVin(decl, row, item, input) {
  if (locked(decl) || !state.decls.includes(decl)) return;
  const index = decl.rows.indexOf(row);
  const before = input.dataset.before ?? row.vin ?? "";
  const model = modelOf(row);
  const label = productLabel(item);
  row.vin = label;
  row.product = productOf(item);
  state.lookups.delete(row.id);
  state.touched.add(row.id);
  input.dataset.before = label;
  if (before !== label) {
    Audit.track("row.vin.pick", `Выбрал из подсказки в строке ${index + 1} — ${item.name}`, {dt: decl.dt, vin: label, field: "VIN", from: before, to: label});
  }
  trackModel(decl, row, model, "Марка модель подставлена из товара");
  trackDeclared(decl, row);
  refresh();
  scheduleSave(decl);
}

async function checkRowVin(decl, row) {
  const vin = vinKey(row.vin);
  if (vin.length < MIN_QUERY) return;
  state.lookups.set(row.id, "checking");
  refresh(decl);
  const found = await findVin(vin);
  if (vinKey(row.vin) !== vin || row.product || !decl.rows.includes(row) || locked(decl)) return;
  if (found.item) {
    state.lookups.delete(row.id);
    row.product = productOf(found.item);
    trackModel(decl, row, "", "Марка модель подставлена из товара");
    trackDeclared(decl, row);
    scheduleSave(decl);
  } else {
    state.lookups.set(row.id, found.error ? "error" : "missing");
  }
  refresh(decl);
}

function ctxOf(node) {
  const article = node.closest("[data-decl]");
  const decl = article ? findDecl(article.dataset.decl) : null;
  const tr = node.closest("[data-row]");
  const row = decl && tr ? decl.rows.find((item) => item.id === tr.dataset.row) || null : null;
  return {decl, row, index: row ? decl.rows.indexOf(row) : -1};
}

const paramText = (decl, key) => (key === "rate" ? decl.rate : pctText(decl[key]));

const vinTimers = new Map();

/** В журнал — выбран товар, VIN которого уже был в декларации (свойство DECLARACIA). */
function trackDeclared(decl, row) {
  if (!row.product?.declaration) return;
  Audit.track("row.vin.declared", `VIN в строке ${decl.rows.indexOf(row) + 1} уже был в декларации ${row.product.declaration} — строку не отправить`,
    {dt: decl.dt, vin: row.vin});
}

function setupDecls() {
  const list = $("decl-list");
  // Подсказки для ячеек-списков, открытых для ручного ввода: значения списка.
  document.body.insertAdjacentHTML("beforeend", LIST_KEYS.map((key) => `<datalist id="list-${key}">`
    + `${LISTS[key].map((option) => `<option value="${escapeHtml(option.name)}"></option>`).join("")}</datalist>`).join(""));

  list.addEventListener("click", (event) => {
    const target = event.target;
    if (target.closest("#decl-retry")) { loadDecls(); return; }
    const {decl, row, index} = ctxOf(target);
    if (!decl) return;
    const act = target.closest("[data-act]")?.dataset.act;
    if (act && row) {
      if (locked(decl)) return;
      if (act === "plus") insertRow(decl, row, false);
      else if (act === "copy") insertRow(decl, row, true);
      else if (act === "remove") removeRow(decl, row, index);
      else if (act === "formula") resetFormula(decl, row, target.closest("[data-act]").dataset.key);
      return;
    }
    if (target.closest(".decl-remove")) { removeDecl(decl); return; }
    if (target.closest(".decl-edit-dt")) { editDt(decl); return; }
    if (target.closest(".add-row")) { appendRow(decl); return; }
    const head = target.closest(".decl-head");
    if (target.closest(".decl-toggle") || (head && !target.closest("button, input, a") && !String(window.getSelection?.() || ""))) {
      toggleDecl(decl);
    }
  });

  list.addEventListener("focusin", (event) => {
    const input = event.target;
    const {decl, row} = ctxOf(input);
    if (!decl) return;
    if (input.dataset.param) input.dataset.before = paramText(decl, input.dataset.param);
    else if (row && input.dataset.cell) input.dataset.before = row[input.dataset.cell] ?? "";
  });

  list.addEventListener("input", (event) => {
    const input = event.target;
    const {decl, row} = ctxOf(input);
    if (!decl || locked(decl)) return;
    const param = input.dataset.param;
    if (param) {
      if (!("before" in input.dataset)) input.dataset.before = paramText(decl, param);
      if (param === "rate") { decl.rate = input.value; refresh(decl); return; }
      const n = parsePct(input.value);
      if (n !== null) { decl[param] = n; refresh(decl); }
      return;
    }
    if (!row || !input.dataset.cell) return;
    const key = input.dataset.cell;
    if (!("before" in input.dataset)) input.dataset.before = row[key] ?? "";
    // Ячейка-список: название из списка хранится как ID значения, вписанное вручную — текстом.
    row[key] = FIELD[key]?.kind === "select" ? listValue(key, input.value) : input.value;
    if (key === "vin") {
      state.lookups.delete(row.id);
      // VIN стёрли или изменили — товар больше не тот, «Марка модель» стирается вместе с ним.
      if (row.product && vinKey(productLabel(row.product)) !== vinKey(input.value)) {
        const model = modelOf(row);
        row.product = null;
        trackModel(decl, row, model, "VIN изменён — марка модель стёрта");
      }
      // VIN набран целиком (17 знаков) — сразу ищем товар: не был ли этот VIN уже в декларации.
      clearTimeout(vinTimers.get(row.id));
      if (vinKey(input.value).length === 17) vinTimers.set(row.id, setTimeout(() => checkRowVin(decl, row), 400));
      refresh();
    } else {
      refresh(decl);
    }
    scheduleSave(decl);
  });

  list.addEventListener("change", (event) => {
    const input = event.target;
    const {decl, row, index} = ctxOf(input);
    if (!decl || locked(decl)) return;
    if (input.dataset.param) { commitParam(decl, input); return; }
    if (!row || !input.dataset.cell) return;
    if (input.dataset.auto) { commitAuto(decl, row, index, input); return; }
    const field = FIELD[input.dataset.cell];
    const value = field.kind === "select" ? listValue(field.key, input.value) : formatInput(field, input.value);
    // В поле ручного ввода видно название, а не ID значения.
    const display = input.dataset.free ? shownValue(field, value) : value;
    if (display !== input.value) input.value = display;
    row[field.key] = value;
    const before = input.dataset.before ?? "";
    if (before !== value) {
      state.touched.add(row.id);
      Audit.track("row.edit", `Изменил «${field.label}» в строке ${index + 1}`, {
        dt: decl.dt, vin: row.vin, field: field.label, from: shownValue(field, before), to: shownValue(field, value),
      });
    }
    input.dataset.before = value;
    if (field.kind === "vin" && value && !row.product) checkRowVin(decl, row);
    if (field.kind === "vin") refresh(); else refresh(decl);
    scheduleSave(decl);
  });

  // В журнал — каждый запрос, на котором человек задержался; стёртый запрос записи не отменяет.
  let searchTimer = null;
  const logSearch = (query) => {
    if (!query) return;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => Audit.track("search.decls", `Искал декларацию: «${query}»`), 700);
  };
  $("decl-search").addEventListener("input", debounce(() => {
    state.query = $("decl-search").value.trim();
    renderDecls();
    logSearch(state.query);
  }, 200));
  $("expand-all").addEventListener("click", () => setAllOpen(true));
  $("collapse-all").addEventListener("click", () => setAllOpen(false));
  $("send-btn").addEventListener("click", openSend);
}

/** Что даёт формула колонки для строки — без ручного значения этой ячейки. */
const formulaValue = (decl, row, key) => compute({...row, [key]: ""}, decl)[key];
const autoShown = (decl, row, key) => (compact(row[key]) ? row[key] : `по формуле ${money(formulaValue(decl, row, key))}`);

/**
 * Ячейка «авто» переписана руками. Пусто или то же, что даёт формула, — снова формула;
 * иначе своё значение заменяет формулу, и «Сумма» с «НДС от маржи» считаются уже от него.
 */
function commitAuto(decl, row, index, input) {
  const field = FIELD[input.dataset.auto];
  const before = input.dataset.before ?? "";
  let value = formatInput(field, input.value);
  const n = parseNum(value);
  const formula = formulaValue(decl, row, field.key);
  if (value && !Number.isNaN(n) && typeof formula === "number" && Math.abs(formula - n) < 0.005) value = "";
  row[field.key] = value;
  input.value = value || (typeof formula === "number" ? money(formula) : "");
  if (before !== value) {
    state.touched.add(row.id);
    Audit.track(value ? "row.auto" : "row.auto.formula", value ? `Вписал вручную «${field.label}» в строке ${index + 1} вместо формулы`
      : `Вернул формулу в «${field.label}» в строке ${index + 1}`, {
      dt: decl.dt, vin: row.vin, field: field.label,
      from: before ? before : `по формуле`, to: value || `по формуле ${money(formula)}`,
    });
  }
  input.dataset.before = value;
  refresh(decl);
  scheduleSave(decl);
}

/** Кнопка ↺ у ячейки «авто»: убрать своё значение — снова считает формула. */
function resetFormula(decl, row, key) {
  if (!key || !compact(row[key])) return;
  const field = FIELD[key];
  const before = row[key];
  row[key] = "";
  Audit.track("row.auto.formula", `Вернул формулу в «${field.label}» в строке ${decl.rows.indexOf(row) + 1}`,
    {dt: decl.dt, vin: row.vin, field: field.label, from: before, to: autoShown(decl, row, key)});
  const input = $(`row-${row.id}`)?.querySelector(`[data-auto="${key}"]`);
  if (input) input.dataset.before = "";
  refresh(decl);
  scheduleSave(decl);
}

/** Курс или процент в заголовке колонки. Неверный процент откатывается, неверный курс остаётся и подсвечивается. */
function commitParam(decl, input) {
  const key = input.dataset.param;
  const before = input.dataset.before ?? paramText(decl, key);
  if (key === "rate") {
    const value = formatRate(input.value);
    decl.rate = value;
    input.value = value;
    if (before !== value) {
      Audit.track("decl.rate", "Изменил курс по ДТ — пересчитаны все строки", {dt: decl.dt, field: RATE.label, from: before, to: value});
    }
    input.dataset.before = value;
    refresh(decl);
    scheduleSave(decl);
    return;
  }
  const n = parsePct(input.value);
  if (n === null) {
    decl[key] = parsePct(before) ?? PCT[key].def;
    input.value = pctText(decl[key]);
    toast("Процент — число от 0 до 100, например 22 или 2,64.", "err");
    refresh(decl);
    return;
  }
  decl[key] = n;
  input.value = pctText(n);
  if (before !== input.value) {
    Audit.track("decl.pct", `Изменил процент в колонке «${PCT[key].column}» — пересчитаны все строки`,
      {dt: decl.dt, field: PCT[key].label, from: `${before} %`, to: `${input.value} %`});
  }
  input.dataset.before = input.value;
  refresh(decl);
  scheduleSave(decl);
}

function setOpen(decl, open) {
  if (open) state.expanded.add(decl.id); else state.expanded.delete(decl.id);
  persistExpanded();
  const node = $(`decl-${decl.id}`);
  if (!node) return;
  node.classList.toggle("open", open);
  node.querySelector(".decl-body").hidden = !open;
  node.querySelector(".decl-toggle").setAttribute("aria-expanded", String(open));
}

function toggleDecl(decl) {
  const open = !state.expanded.has(decl.id);
  activeComboClose?.();
  setOpen(decl, open);
  Audit.track("decl.toggle", open ? "Развернул декларацию" : "Свернул декларацию", {dt: decl.dt});
}

function setAllOpen(open) {
  const visible = state.decls.filter((decl) => declMatches(decl, state.query));
  visible.forEach((decl) => setOpen(decl, open));
  Audit.track("decl.toggle.all", open ? `Развернул все декларации (${visible.length})` : `Свернул все декларации (${visible.length})`);
}

function focusRow(row, select = false, focus = true) {
  const tr = $(`row-${row.id}`);
  if (!tr) return;
  tr.classList.add("flash");
  setTimeout(() => tr.classList.remove("flash"), 1900);
  tr.scrollIntoView({block: "nearest"});
  if (!focus) return;
  const input = tr.querySelector('[data-cell="vin"]');
  input?.focus({preventScroll: true});
  if (select) input?.select();
}

function insertRow(decl, after, copy) {
  const index = decl.rows.indexOf(after);
  const row = copy ? cloneRow(after) : emptyRow();
  decl.rows.splice(index + 1, 0, row);
  if (copy) {
    state.touched.add(row.id);
    if (state.lookups.has(after.id)) state.lookups.set(row.id, state.lookups.get(after.id));
  }
  Audit.track(copy ? "row.copy" : "row.add",
    copy ? `Скопировал строку ${index + 1} — копия стала строкой ${index + 2}` : `Добавил пустую строку ${index + 2} (кнопка «+» у строки ${index + 1})`,
    {dt: decl.dt, vin: after.vin});
  renderDecl(decl);
  scheduleSave(decl);
  focusRow(row, copy);
}

function appendRow(decl) {
  if (locked(decl)) return;
  const row = emptyRow();
  decl.rows.push(row);
  Audit.track("row.add", `Добавил пустую строку ${decl.rows.length} (кнопка «+ Строка»)`, {dt: decl.dt});
  renderDecl(decl);
  scheduleSave(decl);
  focusRow(row);
}

function rowSummary(row) {
  return [vinKey(row.vin) || "без VIN", modelOf(row), row.amountY ? `${row.amountY} $Y` : ""].filter(Boolean).join(", ");
}

function removeRow(decl, row, index) {
  decl.rows.splice(index, 1);
  Audit.track("row.remove", `Удалил строку ${index + 1}`, {dt: decl.dt, vin: row.vin, field: "Строка", from: rowSummary(row), to: ""});
  renderDecl(decl);
  scheduleSave(decl);
  toast(`Строка ${index + 1} удалена.`, "", {
    label: "Вернуть",
    run: () => {
      if (!state.decls.includes(decl) || locked(decl) || decl.rows.includes(row)) return;
      decl.rows.splice(Math.min(index, decl.rows.length), 0, row);
      Audit.track("row.restore", `Вернул удалённую строку ${index + 1}`, {dt: decl.dt, vin: row.vin, field: "Строка", from: "", to: rowSummary(row)});
      renderDecl(decl);
      scheduleSave(decl);
      focusRow(row, false, false);
    },
  });
}

function editDt(decl) {
  if (locked(decl)) return;
  Audit.track("decl.dt.open", "Открыл изменение номера ДТ", {dt: decl.dt});
  openDialog({
    title: "Номер ДТ",
    desc: "Только цифры и дроби «/», дробей — сколько нужно. Строки декларации останутся на месте.",
    body: `<div class="field"><label for="dlg-dt">ДТ</label>
      <input id="dlg-dt" type="text" value="${escapeHtml(decl.dt)}" autocomplete="off" spellcheck="false" inputmode="numeric"></div>`,
    ok: "Сохранить",
    onOpen: (root) => { const input = root.querySelector("#dlg-dt"); input.focus(); input.select(); },
    onOk: (root) => {
      const value = compact(root.querySelector("#dlg-dt").value);
      const problem = dtProblem(value);
      if (problem) return problem;
      const other = findByDt(value);
      if (other && other !== decl) return `Декларация с ДТ ${value} уже есть`;
      if (value === decl.dt || locked(decl)) return "";
      Audit.track("decl.dt", "Изменил номер ДТ", {dt: value, field: "ДТ", from: decl.dt, to: value});
      decl.dt = value;
      renderDecl(decl);
      scheduleSave(decl);
      toast("Номер ДТ изменён.", "ok");
      return "";
    },
    onCancel: () => Audit.track("decl.dt.cancel", "Закрыл изменение номера ДТ без сохранения", {dt: decl.dt}),
  });
}

function removeDecl(decl) {
  if (locked(decl)) return;
  const count = plural(decl.rows.length, "строка", "строки", "строк");
  Audit.track("decl.remove.open", "Нажал «Удалить декларацию»", {dt: decl.dt});
  openDialog({
    title: "Удалить декларацию?",
    desc: `ДТ ${decl.dt} · ${count}. Восстановить её будет нельзя.`,
    ok: "Удалить",
    danger: true,
    onOk: async () => {
      clearTimeout(state.saveTimers.get(decl.id));
      await state.inflight.get(decl.id);
      await api("decl.delete", {id: decl.id});
      state.decls = state.decls.filter((item) => item !== decl);
      state.dirty.delete(decl.id);
      state.expanded.delete(decl.id);
      persistExpanded();
      Audit.track("decl.remove", `Удалил декларацию (${count})`, {dt: decl.dt, vin: decl.rows.map((row) => vinKey(row.vin)).filter(Boolean).join(", ")});
      renderDecls();
      renderSaveState();
      toast(`Декларация ДТ ${decl.dt} удалена.`, "ok");
      return "";
    },
    onCancel: () => Audit.track("decl.remove.cancel", "Передумал удалять декларацию", {dt: decl.dt}),
  });
}


// ---------- сохранение черновиков ----------

/** Черновик сохраняется сам через полсекунды после правки. Запросы одной декларации идут по очереди. */
function scheduleSave(decl) {
  if (decl.status === "sent") return;
  decl.updatedAt = new Date().toISOString();
  state.dirty.add(decl.id);
  state.saveSeq.set(decl.id, (state.saveSeq.get(decl.id) || 0) + 1);
  clearTimeout(state.saveTimers.get(decl.id));
  state.saveTimers.set(decl.id, setTimeout(() => saveDecl(decl), 700));
  renderSaveState();
}

function saveDecl(decl) {
  clearTimeout(state.saveTimers.get(decl.id));
  state.saveTimers.delete(decl.id);
  const previous = state.inflight.get(decl.id) || Promise.resolve();
  const run = previous.then(async () => {
    if (!state.decls.includes(decl) || !state.dirty.has(decl.id) || decl.status === "sent") return;
    const seq = state.saveSeq.get(decl.id);
    state.saving++;
    renderSaveState();
    try {
      await api("decl.save", {item: serialize(decl)});
      if (state.saveSeq.get(decl.id) === seq) state.dirty.delete(decl.id);
      state.saveError = "";
      state.savedAt = new Date();
    } catch (error) {
      state.saveError = error.message;
      state.saveTimers.set(decl.id, setTimeout(() => saveDecl(decl), 8000));
    } finally {
      state.saving--;
      renderSaveState();
    }
  });
  state.inflight.set(decl.id, run.catch(() => {}));
  return run;
}

async function flushSaves(decls) {
  await Promise.all(decls.filter((decl) => state.dirty.has(decl.id)).map(saveDecl));
  const left = decls.filter((decl) => state.dirty.has(decl.id));
  if (left.length) throw new Error(`Не удалось сохранить черновик ДТ ${left[0].dt}${state.saveError ? `: ${state.saveError}` : ""}`);
}

function renderSaveState() {
  const node = $("save-status");
  if (!node) return;
  let text = "Черновики сохраняются автоматически.";
  if (state.saving) text = "Сохраняю черновики…";
  else if (state.saveError) text = `Черновик не сохранён: ${state.saveError}. Повторю сам.`;
  else if (state.dirty.size) text = "Есть несохранённые изменения…";
  else if (state.savedAt) text = `Черновики сохранены в ${pad(state.savedAt.getHours())}:${pad(state.savedAt.getMinutes())}.`;
  node.textContent = text;
  node.classList.toggle("err", Boolean(state.saveError) && !state.saving);
}

async function loadDecls() {
  state.loadError = "";
  state.loaded = false;
  renderDecls();
  try {
    const data = await api("decl.list");
    state.decls = (data.items || []).map(hydrate).filter((decl) => decl.status !== "sent");
    state.loaded = true;
    const known = new Set(state.decls.map((decl) => decl.id));
    const saved = store.get(EXPANDED_KEY, null);
    state.expanded = new Set(Array.isArray(saved) ? saved.filter((id) => known.has(id)) : state.decls.slice(0, 1).map((decl) => decl.id));
    persistExpanded();
  } catch (error) {
    state.loadError = error.message;
  }
  renderDecls();
  renderSaveState();
  if (!state.loadError) refreshProducts();
}

/**
 * «Марка модель» черновиков — свежая из каталога: «Модификацию» могли заполнить или
 * поправить в карточке товара уже после выбора VIN.
 */
async function refreshProducts() {
  const drafts = state.decls.filter((decl) => decl.status === "draft");
  const ids = [...new Set(drafts.flatMap((decl) => decl.rows.map((row) => row.product?.id).filter(Boolean)))].slice(0, 500);
  if (!ids.length) return;
  let items;
  try { items = (await api("product.info", {ids})).items || []; } catch (_) { return; }
  const fresh = new Map(items.map((item) => [Number(item.id), item]));
  for (const decl of drafts) {
    if (locked(decl)) continue;
    let changed = false;
    for (const row of decl.rows) {
      const item = row.product && fresh.get(Number(row.product.id));
      if (!item) continue;
      // «Декларация» товара могла заполниться уже после выбора VIN (БП по другой ДТ).
      const declaration = String(item.declaration || "");
      if (declaration !== String(row.product.declaration || "")) {
        row.product = {...row.product, declaration};
        trackDeclared(decl, row);
        changed = true;
      }
      if (String(item.modification || "") === String(row.product.modification || "")) continue;
      const model = modelOf(row);
      row.product = {...row.product, modification: String(item.modification || "")};
      trackModel(decl, row, model, "Марка модель обновлена из каталога");
      changed = true;
    }
    if (changed) scheduleSave(decl);
  }
  refresh();
}


// ---------- отправка в бизнес-процесс ----------

/*
 * «Отправить» — каждая строка декларации уходит в бизнес-процесс отдельным запуском шаблона
 * с её значениями (параметры — в lib.php, Bp::PARAMS). Карточки программа не создаёт — только
 * «толкает» БП, как «Перегон». Сервер проверяет сохранённую декларацию сам и запускает строки
 * порциями; страница повторяет запрос, пока не уйдут все.
 */
function renderQueueStatus(checks) {
  const drafts = state.decls.filter((decl) => decl.status !== "sent");
  const ready = drafts.filter((decl) => checks.get(decl.id)?.ok).length;
  const notReady = drafts.length - ready;
  const sent = state.decls.length - drafts.length;
  const rows = state.decls.reduce((n, decl) => n + decl.rows.length, 0);
  $("decl-count").textContent = state.decls.length;
  $("decl-desc").textContent = state.decls.length
    ? `${plural(rows, "строка", "строки", "строк")} в ${plural(state.decls.length, "декларации", "декларациях", "декларациях")}. `
      + "Нажмите на декларацию, чтобы свернуть или развернуть её. Строки заполняются прямо в таблице."
    : "Здесь появятся декларации. Создайте декларацию выше — в ней будет строка для заполнения.";
  const button = $("send-btn");
  button.textContent = state.sending ? "Отправляю…" : ready && !notReady ? `📤 Отправить (${ready})` : "📤 Отправить";
  button.disabled = state.sending || !drafts.length;
  // Есть ошибки — кнопка не отправляет, а показывает, что исправить.
  button.classList.toggle("blocked", !state.sending && notReady > 0);
  button.title = !state.sending && notReady ? "В декларациях есть ошибки — нажмите, чтобы увидеть, что исправить" : "";
  if (state.sending && state.progress) { $("send-status").textContent = state.progress; return; }
  const parts = [];
  if (!state.decls.length) parts.push("Пока нечего отправлять");
  else {
    parts.push(`Готовы к отправке: ${ready}`);
    if (notReady) parts.push(`с ошибками: ${notReady}`);
    if (sent) parts.push(`отправлено: ${sent}`);
  }
  $("send-status").textContent = `${parts.join(" · ")}.${notReady ? " Пока ошибки не исправлены, отправка не идёт." : ""}`;
}

function openSend() {
  if (state.sending) return;
  const checks = refresh();
  const drafts = state.decls.filter((decl) => decl.status !== "sent");
  const ready = drafts.filter((decl) => checks.get(decl.id).ok);
  const bad = drafts.filter((decl) => !checks.get(decl.id).ok);
  Audit.track("send.open", `Нажал «Отправить»: готовы ${ready.length}, с ошибками ${bad.length}`);
  // Хоть одна ошибка — не отправляется ничего: показываем, что не так, и подсвечиваем ячейки.
  if (bad.length) {
    bad.forEach((decl) => { state.tried.add(decl.id); state.expanded.add(decl.id); });
    persistExpanded();
    renderDecls();
    showSendProblems(bad, checks);
    return;
  }
  if (!ready.length) {
    toast("Нет черновиков для отправки.", "err");
    return;
  }
  const item = (decl) => {
    const check = checks.get(decl.id);
    const more = decl.status === "sending" ? ` · уже отправлено ${decl.launched} из ${decl.launchTotal}, отправятся остальные` : "";
    return `<label class="send-item"><input type="checkbox" value="${decl.id}" checked>
      <span><b>ДТ ${escapeHtml(decl.dt)}</b><small>${escapeHtml(vinsTitle(decl))}<br>${plural(decl.rows.length, "строка", "строки", "строк")}`
      + ` · итого ${money(check.totals.total)} ₽${more}</small></span></label>`;
  };
  const noProduct = ready.filter((decl) => decl.status === "draft").reduce((n, decl) => n + decl.rows.filter((row) => !row.product).length, 0);
  const warn = noProduct
    ? `<div class="notice send-warn">В ${plural(noProduct, "строке", "строках", "строках")} VIN не найден в каталоге товаров —`
      + " проверьте VIN.</div>"
    : "";
  openDialog({
    title: "Отправить декларации",
    body: `<p class="dialog-lead">Проверьте декларации и отметьте, что отправить.
        После отправки декларацию изменить нельзя.</p>
      <div class="send-list">${ready.map(item).join("")}</div>${warn}`,
    ok: `Отправить (${ready.length})`,
    onOpen: (root, okButton) => {
      root.addEventListener("change", () => {
        const n = root.querySelectorAll(".send-item input:checked").length;
        okButton.textContent = `Отправить (${n})`;
        okButton.disabled = !n;
      });
    },
    onOk: async (root) => {
      const ids = [...root.querySelectorAll(".send-item input:checked")].map((input) => input.value);
      const chosen = ids.map(findDecl).filter((decl) => decl && decl.status !== "sent");
      if (!chosen.length) return "Отметьте хотя бы одну декларацию";
      const skipped = ready.filter((decl) => !ids.includes(decl.id));
      if (skipped.length) Audit.track("send.skip", `Не стал отправлять: ${skipped.map((decl) => `ДТ ${decl.dt}`).join(", ")}`);
      await sendDecls(chosen);
      return "";
    },
    onCancel: () => Audit.track("send.cancel", "Закрыл окно отправки, ничего не отправив"),
  });
}

/** «Отправить» при ошибках: что не так в каждой декларации. «Показать» — к первой ошибке. */
function showSendProblems(bad, checks) {
  const LIMIT = 12;
  const total = bad.reduce((n, decl) => n + checks.get(decl.id).problems.length, 0);
  const blocks = bad.map((decl) => {
    const problems = checks.get(decl.id).problems;
    const items = problems.slice(0, LIMIT).map((problem) => `<li>${escapeHtml(problem.text)}</li>`).join("")
      + (problems.length > LIMIT ? `<li class="muted">и ещё ${problems.length - LIMIT}</li>` : "");
    return `<div class="send-problem"><b>ДТ ${escapeHtml(decl.dt || "без номера")}</b>`
      + ` <span class="muted">· ${plural(problems.length, "ошибка", "ошибки", "ошибок")}</span><ul>${items}</ul></div>`;
  }).join("");
  Audit.track("send.blocked", `Отправка не пошла — ошибки в ${plural(bad.length, "декларации", "декларациях", "декларациях")}: `
    + bad.map((decl) => `ДТ ${decl.dt || "без номера"} — ${checks.get(decl.id).firstProblem}`).join("; "));
  openDialog({
    title: "Отправить нельзя — есть ошибки",
    desc: `Ничего не отправлено. Исправьте ${plural(total, "ошибку", "ошибки", "ошибок")} — ячейки подсвечены красным — и нажмите «Отправить» снова.`,
    body: `<div class="notice err send-bad">${blocks}</div>`,
    ok: "Показать ошибку",
    onOk: () => {
      const decl = bad[0];
      const first = checks.get(decl.id).problems[0];
      const node = $(`decl-${decl.id}`);
      const cell = first?.rowId ? node?.querySelector(`[data-row="${first.rowId}"] [data-cell="${first.key}"]`)
        : first?.key === "rate" ? node?.querySelector('[data-param="rate"]') : null;
      setTimeout(() => {
        (cell || node)?.scrollIntoView({block: "center", inline: "center", behavior: "smooth"});
        if (cell && !cell.disabled) cell.focus({preventScroll: true});
      }, 0);
      return "";
    },
  });
}

/** Статус и сколько строк ушло — из ответа сервера. */
function applyServer(decl, item) {
  if (!item) return;
  if (STATUSES.includes(item.status)) decl.status = item.status;
  decl.sentAt = item.sentAt || decl.sentAt;
  decl.sentBy = item.sentBy || decl.sentBy;
  applyProgress(decl, item);
}

/** Одна декларация: запросы, пока все строки не уйдут в БП. Сервер не запускает строку повторно. */
async function sendOne(decl, warnings) {
  const total = declCheck(decl, duplicateIndex()).totals.total;
  for (;;) {
    const before = decl.launched;
    const data = await api("decl.send", {id: decl.id});
    applyServer(decl, data.item);
    (data.warnings || []).forEach((text) => warnings.push(`ДТ ${decl.dt}, ${text}`));
    state.progress = `Отправляю ДТ ${decl.dt}: отправлено ${decl.launched} из ${decl.launchTotal || decl.rows.length} строк…`;
    renderQueueStatus(refresh(decl));
    if (data.error) throw new Error(data.error);
    if (decl.status === "sent") break;
    if (decl.launched <= before) throw new Error("отправка не продвигается — попробуйте ещё раз");
  }
  state.dirty.delete(decl.id);
  state.tried.delete(decl.id);
  Audit.track("send.done", `Отправил декларацию в бизнес-процесс: ${plural(decl.launchTotal, "запуск", "запуска", "запусков")} — по одному на строку, итого ${money(total)} ₽`,
    {dt: decl.dt, vin: decl.rows.map((row) => vinKey(row.vin)).join(", ")});
}

async function sendDecls(decls) {
  state.sending = true;
  state.progress = "Сохраняю черновики…";
  activeComboClose?.();
  const list = $("decl-list");
  list.classList.add("busy");
  list.querySelectorAll("input").forEach((input) => { input.readOnly = true; });
  list.querySelectorAll("select").forEach((select) => { select.disabled = true; });
  renderQueueStatus(refresh());
  let done = 0;
  const failed = [];
  const warnings = [];
  try {
    await flushSaves(decls);
    for (const decl of decls) {
      try {
        await sendOne(decl, warnings);
        done++;
      } catch (error) {
        failed.push(`ДТ ${decl.dt}: ${error.message}`);
        Audit.track("send.fail", `Декларация не отправилась: ${error.message}`, {dt: decl.dt});
        if (error.transport) break;
      }
    }
  } catch (error) {
    Audit.track("send.fail", `Ошибка отправки: ${error.message}`);
    throw error;
  } finally {
    state.sending = false;
    state.progress = "";
    list.classList.remove("busy");
    // Отправленные в приложении больше не показываются. Найти их можно, набрав номер в поле «ДТ» новой декларации.
    const gone = state.decls.filter((decl) => decl.status === "sent");
    state.decls = state.decls.filter((decl) => decl.status !== "sent");
    gone.forEach((decl) => { state.expanded.delete(decl.id); state.dirty.delete(decl.id); });
    persistExpanded();
    renderDecls();
    renderSaveState();
  }
  const where = "Из списка она убрана — найти её можно, набрав номер ДТ в «Новой декларации».";
  if (failed.length) toast(`Отправлено: ${done}. Не отправились — ${failed.join("; ")}`, "err");
  else if (warnings.length) {
    // Подробности — для владельца, в журнал действий; сотруднику — коротко.
    Audit.track("send.warn", `Отправлено с замечаниями: ${[...new Set(warnings)].join("; ")}`);
    toast(`Отправлено: ${plural(done, "декларация", "декларации", "деклараций")}. Есть замечания — подробности у владельца в журнале действий.`, "err");
  }
  else toast(`Отправлено: ${plural(done, "декларация", "декларации", "деклараций")}. ${done > 1 ? where.replace("она убрана — найти её", "они убраны — найти их") : where}`, "ok");
}


// ---------- доступ ----------

let accessUsers = [];
let foundUsers = [];
let ownerUser = null;
const hasAccess = (id) => accessUsers.some((user) => user.id === id);

function userChip(user) {
  const classes = ["chip", hasAccess(user.id) ? "on" : "", user.active === false ? "gone" : ""].filter(Boolean).join(" ");
  const title = hasAccess(user.id) ? "Снять доступ" : "Выдать доступ";
  return `<div class="${classes}" data-user="${user.id}" title="${title}" role="button" tabindex="0">${escapeHtml(user.name)}`
    + `${user.position ? `<span class="chip-sub">${escapeHtml(user.position)}</span>` : ""}</div>`;
}

function renderAccess() {
  $("access-count").textContent = accessUsers.length;
  const owner = ownerUser
    ? `<div class="chip owner" title="Владелец — установил программу, доступ есть всегда">${escapeHtml(ownerUser.name)}<span class="chip-sub">владелец</span></div>`
    : "";
  $("access-chips").innerHTML = owner + (accessUsers.map(userChip).join("")
    || '<div class="combo-empty">Пока доступ только у владельца. Выдайте его сотрудникам ниже.</div>');
  $("user-chips").innerHTML = foundUsers.map(userChip).join("") || '<div class="combo-empty">Никого не найдено.</div>';
  document.querySelectorAll("[data-user]").forEach((node) => {
    node.onclick = () => toggleAccess(Number(node.dataset.user), node);
    node.onkeydown = (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); node.click(); } };
  });
}

async function loadAccess() {
  try {
    const [access, users] = await Promise.all([api("access.list"), api("access.users", {q: ""})]);
    ownerUser = access.owner || null;
    accessUsers = access.items || [];
    foundUsers = users.items || [];
    renderAccess();
  } catch (error) {
    $("access-chips").textContent = error.message;
    $("user-chips").textContent = "";
    tabsLoaded.delete("access");
    toast(error.message, "err");
  }
}

async function toggleAccess(id, node) {
  const had = hasAccess(id);
  const user = [...accessUsers, ...foundUsers].find((item) => item.id === id);
  node.classList.add("busy");
  try {
    accessUsers = (await api(had ? "access.remove" : "access.add", {id})).items || [];
    renderAccess();
    toast(had ? "Доступ снят." : "Доступ выдан.", "ok");
    Audit.track(had ? "access.remove" : "access.add", had ? `Снял доступ: ${user?.name || id}` : `Выдал доступ: ${user?.name || id}`,
      {field: "Доступ", from: had ? "есть" : "нет", to: had ? "нет" : "есть"});
  } catch (error) {
    node.classList.remove("busy");
    toast(error.message, "err");
  }
}

function setupAccess() {
  let seq = 0;
  let searchTimer = null;
  const logQuery = (query) => {
    if (!query) return;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => Audit.track("access.search", `Искал сотрудника: «${query}»`), 700);
  };
  $("user-search").addEventListener("input", debounce(async () => {
    const mine = ++seq;
    const query = $("user-search").value.trim();
    logQuery(query);
    try {
      const data = await api("access.users", {q: query});
      if (mine !== seq) return;
      foundUsers = data.items || [];
      renderAccess();
    } catch (error) {
      toast(error.message, "err");
    }
  }, 300));
}


// ---------- журнал действий ----------

const LOG_CATEGORIES = [
  ["nav", "Вход и вкладки", ["app", "tab"]],
  ["check", "Проверка и настройки", ["check"]],
  ["form", "Новая декларация", ["form"]],
  ["decl", "Декларации", ["decl"]],
  ["row", "Строки и ячейки", ["row"]],
  ["send", "Отправка", ["send"]],
  ["access", "Доступ", ["access"]],
  ["search", "Поиск", ["search"]],
  ["log", "Журнал", ["log"]],
];
const categoryOf = (action) => {
  const prefix = String(action || "").split(".")[0];
  return LOG_CATEGORIES.find((category) => category[2].includes(prefix)) || null;
};
const logView = {items: [], limit: 200};

function filteredLog() {
  const query = $("log-search").value.trim().toLowerCase();
  const user = $("log-user").value;
  const category = $("log-cat").value;
  return logView.items.filter((entry) => {
    if (user && String(entry.user?.id) !== user) return false;
    if (category && categoryOf(entry.action)?.[0] !== category) return false;
    if (query) {
      const haystack = [entry.text, entry.dt, entry.vin, entry.field, entry.from, entry.to, entry.user?.name].join(" ").toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    return true;
  });
}

function logRow(entry) {
  const where = [entry.dt ? `ДТ ${escapeHtml(entry.dt)}` : "", entry.vin ? `<small>VIN ${escapeHtml(entry.vin)}</small>` : ""].join("");
  const change = entry.change
    ? `${entry.field ? `<small>${escapeHtml(entry.field)}</small>` : ""}<span class="change"><del>${escapeHtml(entry.from || "пусто")}</del> → <ins>${escapeHtml(entry.to || "пусто")}</ins></span>`
    : "";
  const category = categoryOf(entry.action);
  return `<tr><td>${escapeHtml(fmtTime(entry.ts))}</td><td>${escapeHtml(entry.user?.name || "")}</td>`
    + `<td>${escapeHtml(entry.text)}${category ? `<small>${escapeHtml(category[1])}</small>` : ""}</td><td>${where}</td><td>${change}</td></tr>`;
}

function renderLog() {
  const items = filteredLog();
  $("log-count").textContent = items.length;
  $("log-rows").innerHTML = items.length
    ? items.slice(0, logView.limit).map(logRow).join("")
    : '<tr class="queue-empty"><td colspan="5">Записей нет.</td></tr>';
  $("log-more").hidden = items.length <= logView.limit;
}

function renderLogUsers() {
  const select = $("log-user");
  const current = select.value;
  const users = new Map();
  logView.items.forEach((entry) => { if (entry.user) users.set(String(entry.user.id), entry.user.name); });
  select.innerHTML = '<option value="">Все сотрудники</option>'
    + [...users].sort((a, b) => a[1].localeCompare(b[1], "ru")).map(([id, name]) => `<option value="${escapeHtml(id)}">${escapeHtml(name)}</option>`).join("");
  select.value = users.has(current) ? current : "";
}

async function fetchLog() {
  try {
    const data = await api("log.list");
    logView.items = data.items || [];
    renderLogUsers();
    renderLog();
  } catch (error) {
    $("log-rows").innerHTML = `<tr class="queue-empty"><td colspan="5">${escapeHtml(error.message)}</td></tr>`;
  }
}

async function loadLog() {
  await Audit.flush();
  return fetchLog();
}

function exportLog() {
  const items = filteredLog();
  // Значение, начинающееся с = + - @, Excel принял бы за формулу.
  const cell = (value) => {
    const text = String(value ?? "");
    return `"${(/^[=+\-@\t\r]/.test(text) ? `'${text}` : text).replace(/"/g, '""')}"`;
  };
  const head = ["Время", "Сотрудник", "Действие", "ДТ", "VIN", "Поле", "Было", "Стало"];
  const lines = items.map((entry) => [fmtTime(entry.ts), entry.user?.name, entry.text, entry.dt, entry.vin, entry.field,
    entry.change ? entry.from : "", entry.change ? entry.to : ""]);
  const csv = "﻿" + [head, ...lines].map((line) => line.map(cell).join(";")).join("\r\n");
  const url = URL.createObjectURL(new Blob([csv], {type: "text/csv;charset=utf-8"}));
  const now = new Date();
  saveFile(url, `Журнал действий ${pad(now.getDate())}.${pad(now.getMonth() + 1)}.${now.getFullYear()}.csv`);
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  Audit.track("log.export", `Скачал журнал (${plural(items.length, "запись", "записи", "записей")})`);
}

function setupLog() {
  $("log-cat").innerHTML = '<option value="">Все действия</option>'
    + LOG_CATEGORIES.map(([id, label]) => `<option value="${id}">${escapeHtml(label)}</option>`).join("");
  $("log-refresh").addEventListener("click", () => { Audit.track("log.refresh", "Обновил журнал"); loadLog(); });
  $("log-export").addEventListener("click", exportLog);
  $("log-more").addEventListener("click", () => { logView.limit += 200; renderLog(); });
  ["log-search", "log-user", "log-cat"].forEach((id) => $(id).addEventListener("input", debounce(() => { logView.limit = 200; renderLog(); }, 150)));
  Audit.onFlushed = debounce(() => { if (currentTab === "log") fetchLog(); }, 400);
}


// ---------- проверка и настройки поиска (только владелец) ----------

const MARKS = {ok: ["ok-mark", "✓"], info: ["info-mark", "·"], warn: ["warn-mark", "!"], error: ["err-mark", "✗"]};

async function runCheck() {
  $("check-result").innerHTML = '<div class="card">Проверяю…</div>';
  try {
    const data = await api("check.run");
    $("check-result").innerHTML = data.sections.map((section) => `<div class="card check-card"><h3>${escapeHtml(section.title)}</h3><ul class="probe">`
      + section.items.map((item) => {
        const [cls, mark] = MARKS[item.status] || MARKS.info;
        return `<li><span class="${cls}">${mark}</span><span>${escapeHtml(item.text)}</span></li>`;
      }).join("") + "</ul></div>").join("");
  } catch (error) {
    $("check-result").innerHTML = `<div class="notice err">${escapeHtml(error.message)}</div>`;
  }
}

async function runProbe() {
  const query = $("probe-query").value.trim();
  if (!query) return;
  Audit.track("check.probe", `Пробный поиск: «${query}»`);
  $("probe-result").innerHTML = '<p class="desc">Ищу…</p>';
  try {
    const data = await api("vin.search", {q: query});
    $("probe-result").innerHTML = data.items.length
      ? data.items.map((item) => `<div class="found"><b>${highlight(productLabel(item), query)}</b>`
        + `<small>${escapeHtml([item.vin ? item.name : "", item.modification ? `модификация ${item.modification}` : "модификации нет",
          item.declaration ? `уже был в декларации ${item.declaration}` : "в декларациях не был",
          item.model, item.section, `ID товара ${item.id}`].filter(Boolean).join(" · "))}</small></div>`).join("")
        + (data.more ? '<p class="desc">Показаны первые совпадения — уточните запрос.</p>' : "")
      : `<div class="notice">Ничего не найдено${query.replace(/\s+/g, "").length < MIN_QUERY ? ` — нужно хотя бы ${MIN_QUERY} знака` : ""}.</div>`;
  } catch (error) {
    $("probe-result").innerHTML = `<div class="notice err">${escapeHtml(error.message)}</div>`;
  }
}

let checkSettings = null;

function renderSettings(data) {
  checkSettings = data.settings;
  $("set-iblocks").value = data.settings.catalog_iblock_ids.join(", ");
  $("set-vin").value = data.settings.vin_fields.join(", ");
  $("set-model").value = data.settings.model_fields.join(", ");
  $("set-mod").value = data.settings.modification_code;
  $("set-decl").value = data.settings.declaration_code || "";
  $("set-template").value = data.settings.bp_template_id || "";
  $("set-reserve").value = data.settings.reserve_field;
  $("set-organ").value = data.settings.organ_field || "";
  $("set-iblocks-auto").textContent = data.auto.error
    ? `Сами не нашлись: ${data.auto.error}`
    : `Сами подбираются: ${data.auto.iblocks.map((iblock) => `${iblock.id} — «${iblock.name}»`).join(", ") || "нет"}.`;
  // Справочник для того, кто создаёт шаблон БП: какие параметры программа передаёт.
  $("bp-params").innerHTML = (data.bp?.params || []).map((param) => `<tr><td><code>${escapeHtml(param.code)}</code></td>`
    + `<td>${escapeHtml(param.name)}</td><td>${escapeHtml(param.type)}</td><td>${escapeHtml(param.value)}`
    + `${(param.checks || []).map((check) => `<div class="bp-check ${escapeHtml(check.status)}">${check.status === "ok" ? "✓" : check.status === "error" ? "✕" : "!"} ${escapeHtml(check.text)}</div>`).join("")}`
    + `</td></tr>`).join("");
}

async function loadSettings() {
  try { renderSettings(await api("settings.get")); } catch (error) { toast(error.message, "err"); }
}

/** what: search — «Настройки поиска», bp — «Отправка в бизнес-процесс». Сохраняются вместе. */
async function saveSettings(reset, what = "search") {
  const before = checkSettings ? JSON.stringify(checkSettings) : "";
  try {
    const data = reset ? await api("settings.reset")
      : await api("settings.save", {settings: {
        catalog_iblock_ids: $("set-iblocks").value, vin_fields: $("set-vin").value, model_fields: $("set-model").value,
        modification_code: $("set-mod").value, declaration_code: $("set-decl").value, bp_template_id: $("set-template").value, reserve_field: $("set-reserve").value,
        organ_field: $("set-organ").value,
      }});
    const listsChanged = checkSettings && (checkSettings.reserve_field !== data.settings.reserve_field
      || (checkSettings.organ_field || "") !== (data.settings.organ_field || ""));
    renderSettings(data);
    const title = reset ? "Вернул автоподбор каталогов и полей" : what === "bp" ? "Изменил настройки отправки в бизнес-процесс" : "Изменил настройки поиска";
    Audit.track(reset ? "check.settings.reset" : "check.settings", title,
      {field: what === "bp" ? "Настройки отправки" : "Настройки поиска", from: before, to: JSON.stringify(data.settings)});
    toast(reset ? "Вернул автоподбор." : listsChanged ? "Сохранено. Обновите страницу — списки в колонках возьмутся из новых полей." : "Настройки сохранены.", "ok");
    runCheck();
  } catch (error) {
    toast(error.message, "err");
  }
}

function setupCheck() {
  $("check-run").addEventListener("click", () => { Audit.track("check.run", "Запустил проверку"); runCheck(); });
  $("probe-run").addEventListener("click", runProbe);
  $("probe-query").addEventListener("keydown", (event) => { if (event.key === "Enter") runProbe(); });
  $("settings-save").addEventListener("click", () => saveSettings(false));
  $("settings-reset").addEventListener("click", () => saveSettings(true));
  $("bp-save").addEventListener("click", () => saveSettings(false, "bp"));
}


// ---------- демо-режим ----------

function renderDemo() {
  if (!DEMO) return;
  const options = DEMO.personas.map((persona) =>
    `<option value="${persona.id}"${persona.id === USER.id ? " selected" : ""}>${escapeHtml(persona.label)}</option>`).join("");
  document.querySelectorAll(".demo-slot").forEach((slot) => {
    slot.innerHTML = `<div class="demo-box"><b>Демо-режим</b><span>Без портала: данные хранятся в этом браузере.</span>
      <label>Войти как<select class="demo-as">${options}</select></label>
      <button class="link-btn demo-reset" type="button">Сбросить демо-данные</button></div>`;
    slot.querySelector(".demo-as").addEventListener("change", (event) => { Audit.beacon(); DEMO.switchTo(Number(event.target.value)); });
    slot.querySelector(".demo-reset").addEventListener("click", () => {
      if (confirm("Удалить все демо-декларации, выданные доступы и журнал?")) DEMO.reset();
    });
  });
}


// ---------- запуск ----------

function boot() {
  renderDemo();
  if (!USER.canUse) {
    $("no-access")?.classList.remove("hidden");
    return;
  }
  $("app").classList.remove("hidden");
  if (!IS_OWNER) document.querySelectorAll(".owner-only").forEach((node) => node.remove());
  $("user-name").textContent = USER.name;
  $("user-role").textContent = IS_OWNER ? "Владелец программы" : "Сотрудник";

  setupTabs();
  setupTyping();
  setupForm();
  setupDecls();
  if (IS_OWNER) { setupAccess(); setupLog(); setupCheck(); }

  window.addEventListener("beforeunload", (event) => {
    if (state.dirty.size || state.saving || state.sending) { event.preventDefault(); event.returnValue = ""; }
  });
  window.addEventListener("pagehide", () => {
    Audit.track("app.close", "Закрыл программу");
    Audit.beacon();
  });
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") Audit.flush(); });

  Audit.track("app.open", "Открыл программу");
  loadDecls();
}

boot();
