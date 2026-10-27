/**
 * Такси с предзаказом: бэкенд на Google Apps Script.
 * База: Google Таблица (листы users, drivers, orders, ratings создаются сами).
 * Версия 1: вход по номеру телефона без кода. Позже заменяется на нормальную БД.
 */

// ===== Настройки =====
const TRIAL_DAYS = 7;      // дней бесплатного периода для водителя
const SUB_PRICE = 500;     // цена подписки, ₽ в месяц (только для показа)
const DEFAULT_CITY = 'Москва';

// ===== Схема таблиц =====
const SCHEMA = {
  users:   ['phone', 'name', 'role', 'city', 'push', 'created_at'],
  drivers: ['phone', 'name', 'contact_phone', 'model', 'color', 'plate', 'trial_start', 'paid_until'],
  orders:  ['id', 'created_at', 'updated_at', 'status', 'passenger_phone', 'passenger_name', 'city',
            'from', 'to', 'when', 'price', 'offer_price', 'final_price',
            'driver_user', 'driver_name', 'driver_phone', 'driver_model', 'driver_color', 'driver_plate',
            'driver_time', 'driver_comment', 'cancel_reason'],
  ratings: ['order_id', 'from_role', 'from_phone', 'to_phone', 'stars', 'tags', 'comment', 'created_at']
};
// Статусы заказа: searching → offered → confirmed → done | cancelled
const DAY = 86400000;
const cache_ = {};

// ===== Вход в веб-приложение =====
function doGet() {
  return json_({ ok: true, data: { service: 'taxi-api' } });
}

function doPost(e) {
  let body;
  try { body = JSON.parse(e.postData.contents); }
  catch (err) { return json_({ ok: false, error: 'bad_request' }); }

  const def = ACTIONS[body.action];
  if (!def) return json_({ ok: false, error: 'unknown_action' });

  const lock = LockService.getScriptLock();
  const write = def.write;
  if (write) {
    try { lock.waitLock(20000); }
    catch (err) { return json_({ ok: false, error: 'busy' }); }
  }
  try {
    return json_({ ok: true, data: def.fn(body) });
  } catch (err) {
    return json_({ ok: false, error: err.code || 'server_error', message: String(err.message || err) });
  } finally {
    if (write) lock.releaseLock();
  }
}

/** Запустите один раз вручную: создаст листы и запросит доступ к таблице. */
function setup() {
  Object.keys(SCHEMA).forEach(sheet_);
}

// ===== Действия API =====
const ACTIONS = {
  config:       { fn: () => cfg_() },
  me:           { fn: b => me_(phone_(b.phone)) },
  login:        { fn: login_, write: true },
  setRole:      { fn: setRole_, write: true },
  saveUser:     { fn: saveUser_, write: true },
  saveDriver:   { fn: saveDriver_, write: true },
  startTrial:   { fn: startTrial_, write: true },
  createOrder:  { fn: createOrder_, write: true },
  updateOrder:  { fn: updateOrder_, write: true },
  cancelOrder:  { fn: cancelOrder_, write: true },
  myOrders:     { fn: myOrders_ },
  feed:         { fn: feed_ },
  takeOrder:    { fn: takeOrder_, write: true },
  answerOffer:  { fn: answerOffer_, write: true },
  releaseOrder: { fn: releaseOrder_, write: true },
  finishOrder:  { fn: finishOrder_, write: true },
  driverOrders: { fn: driverOrders_ },
  rate:         { fn: rate_, write: true }
};

function cfg_() {
  return { trialDays: TRIAL_DAYS, subPrice: SUB_PRICE, defaultCity: DEFAULT_CITY };
}

// ----- Пользователи -----
function login_(b) {
  const phone = phone_(b.phone);
  const role = b.role === 'driver' ? 'driver' : 'passenger';
  const name = clean_(b.name, 60);
  let u = find_('users', r => r.phone === phone);
  if (!u) {
    if (!name) fail_('name_required');
    u = save_('users', { phone: phone, name: name, role: role, city: DEFAULT_CITY, push: 'true', created_at: iso_() });
  } else {
    u.role = role;
    if (name) u.name = name;
    save_('users', u);
  }
  return me_(phone);
}

function setRole_(b) {
  const u = user_(b.phone);
  u.role = b.role === 'driver' ? 'driver' : 'passenger';
  save_('users', u);
  return me_(u.phone);
}

function saveUser_(b) {
  const u = user_(b.phone);
  if (b.name !== undefined && clean_(b.name, 60)) u.name = clean_(b.name, 60);
  if (b.city !== undefined && clean_(b.city, 60)) u.city = clean_(b.city, 60);
  if (b.push !== undefined) u.push = b.push ? 'true' : 'false';
  save_('users', u);
  return me_(u.phone);
}

function saveDriver_(b) {
  const u = user_(b.phone);
  const name = clean_(b.name, 60), model = clean_(b.model, 60), color = clean_(b.color, 30), plate = clean_(b.plate, 20);
  if (!name || !model || !color || !plate) fail_('driver_fields');
  let d = find_('drivers', r => r.phone === u.phone) || { phone: u.phone, trial_start: '', paid_until: '' };
  d.name = name;
  d.contact_phone = phone_(b.contact_phone || u.phone);
  d.model = model; d.color = color; d.plate = plate;
  save_('drivers', d);
  return me_(u.phone);
}

function startTrial_(b) {
  const u = user_(b.phone);
  const d = find_('drivers', r => r.phone === u.phone);
  if (!d) fail_('no_driver');
  if (!d.trial_start) { d.trial_start = iso_(); save_('drivers', d); }
  return me_(u.phone);
}

function me_(phone) {
  const u = find_('users', r => r.phone === phone);
  if (!u) fail_('no_user');
  const d = find_('drivers', r => r.phone === phone);
  return { user: userView_(u), driver: d ? driverView_(d) : null, sub: d ? sub_(d) : null };
}

function userView_(u) {
  return { phone: u.phone, name: u.name, role: u.role, city: u.city || DEFAULT_CITY, push: u.push !== 'false' };
}
function driverView_(d) {
  return { name: d.name, contact_phone: d.contact_phone, model: d.model, color: d.color, plate: d.plate };
}

function sub_(d) {
  const now = Date.now();
  const paid = ms_(d.paid_until);
  if (paid > now) return { state: 'paid', until: d.paid_until, daysLeft: Math.ceil((paid - now) / DAY) };
  if (!d.trial_start) return { state: 'none', total: TRIAL_DAYS, daysLeft: TRIAL_DAYS };
  const end = ms_(d.trial_start) + TRIAL_DAYS * DAY;
  if (end > now) return { state: 'trial', total: TRIAL_DAYS, daysLeft: Math.ceil((end - now) / DAY) };
  return { state: 'expired', total: TRIAL_DAYS, daysLeft: 0 };
}

function needSub_(phone) {
  const d = find_('drivers', r => r.phone === phone);
  if (!d) fail_('no_driver');
  const s = sub_(d);
  if (s.state !== 'trial' && s.state !== 'paid') fail_('subscription');
  return d;
}

// ----- Заказы пассажира -----
function createOrder_(b) {
  const u = user_(b.phone);
  const o = {
    id: Utilities.getUuid(), created_at: iso_(), updated_at: iso_(), status: 'searching',
    passenger_phone: u.phone, passenger_name: u.name, city: u.city || DEFAULT_CITY
  };
  fillOrder_(o, b);
  save_('orders', o);
  return { id: o.id };
}

function updateOrder_(b) {
  const o = ownOrder_(b);
  if (o.status !== 'searching') fail_('not_editable');
  fillOrder_(o, b);
  o.updated_at = iso_();
  save_('orders', o);
  return { id: o.id };
}

function fillOrder_(o, b) {
  const from = clean_(b.from, 200), to = clean_(b.to, 200);
  const when = ms_(b.when);
  const price = Math.round(Number(b.price));
  if (!from || !to) fail_('address_required');
  if (!when) fail_('bad_time');
  if (when < Date.now() - 5 * 60000) fail_('time_in_past');
  if (!(price >= 1 && price <= 1000000)) fail_('bad_price');
  o.from = from; o.to = to; o.when = new Date(when).toISOString(); o.price = price;
}

function cancelOrder_(b) {
  const o = ownOrder_(b);
  if (['searching', 'offered', 'confirmed'].indexOf(o.status) < 0) fail_('not_cancellable');
  o.status = 'cancelled';
  o.cancel_reason = clean_(b.reason, 100);
  o.updated_at = iso_();
  save_('orders', o);
  return { id: o.id };
}

function answerOffer_(b) {
  const o = ownOrder_(b);
  if (o.status !== 'offered') fail_('state_changed');
  if (b.accept) {
    o.status = 'confirmed';
    o.final_price = o.offer_price;
  } else {
    clearDriver_(o);
    o.status = 'searching';
  }
  o.updated_at = iso_();
  save_('orders', o);
  return { id: o.id, status: o.status };
}

function myOrders_(b) {
  const phone = phone_(b.phone);
  const rated = rated_();
  return rows_('orders')
    .filter(o => o.passenger_phone === phone)
    .sort((a, c) => ms_(c.when) - ms_(a.when))
    .map(o => orderView_(o, 'passenger', rated));
}

// ----- Заказы водителя -----
function feed_(b) {
  const phone = phone_(b.phone);
  needSub_(phone);
  const all = rows_('orders').filter(o => o.status === 'searching' && ms_(o.when) > Date.now() && o.passenger_phone !== phone);
  const cities = [];
  all.forEach(o => { if (o.city && cities.indexOf(o.city) < 0) cities.push(o.city); });
  const city = clean_(b.city, 60), min = Number(b.min) || 0;
  const list = all
    .filter(o => (!city || o.city === city) && Number(o.price) >= min)
    .sort((a, c) => ms_(a.when) - ms_(c.when))
    .slice(0, 100)
    .map(o => ({ id: o.id, city: o.city, from: o.from, to: o.to, when: o.when, price: Number(o.price) }));
  return { orders: list, cities: cities };
}

function takeOrder_(b) {
  const phone = phone_(b.phone);
  needSub_(phone);
  const o = find_('orders', r => r.id === b.id);
  if (!o) fail_('not_found');
  if (o.status !== 'searching') fail_('taken');
  if (o.passenger_phone === phone) fail_('own_order');
  if (ms_(o.when) < Date.now() - 5 * 60000) fail_('time_in_past');
  const price = Math.round(Number(b.price));
  const time = ms_(b.time) || ms_(o.when);
  const name = clean_(b.name, 60), model = clean_(b.model, 60), color = clean_(b.color, 30), plate = clean_(b.plate, 20);
  if (!(price >= 1 && price <= 1000000)) fail_('bad_price');
  if (!name || !model || !color || !plate) fail_('driver_fields');
  o.driver_user = phone;
  o.driver_name = name;
  o.driver_phone = phone_(b.contact_phone || phone);
  o.driver_model = model; o.driver_color = color; o.driver_plate = plate;
  o.driver_time = new Date(time).toISOString();
  o.driver_comment = clean_(b.comment, 300);
  const changed = price !== Number(o.price) || time !== ms_(o.when);
  if (changed) { o.status = 'offered'; o.offer_price = price; o.final_price = ''; }
  else { o.status = 'confirmed'; o.offer_price = ''; o.final_price = o.price; }
  o.updated_at = iso_();
  save_('orders', o);
  return { id: o.id, status: o.status };
}

function releaseOrder_(b) {
  const phone = phone_(b.phone);
  const o = find_('orders', r => r.id === b.id);
  if (!o || o.driver_user !== phone) fail_('not_found');
  if (o.status !== 'offered' && o.status !== 'confirmed') fail_('state_changed');
  clearDriver_(o);
  o.status = 'searching';
  o.updated_at = iso_();
  save_('orders', o);
  return { id: o.id };
}

function driverOrders_(b) {
  const phone = phone_(b.phone);
  const rated = rated_();
  return rows_('orders')
    .filter(o => o.driver_user === phone && ['offered', 'confirmed', 'done'].indexOf(o.status) >= 0)
    .sort((a, c) => ms_(c.when) - ms_(a.when))
    .map(o => orderView_(o, 'driver', rated));
}

// ----- Завершение и оценки -----
function finishOrder_(b) {
  const phone = phone_(b.phone);
  const o = find_('orders', r => r.id === b.id);
  if (!o || (o.passenger_phone !== phone && o.driver_user !== phone)) fail_('not_found');
  if (o.status === 'done') return { id: o.id };
  if (o.status !== 'confirmed') fail_('state_changed');
  o.status = 'done';
  o.updated_at = iso_();
  save_('orders', o);
  return { id: o.id };
}

function rate_(b) {
  const phone = phone_(b.phone);
  const o = find_('orders', r => r.id === b.order_id);
  if (!o) fail_('not_found');
  let role, to;
  if (o.passenger_phone === phone) { role = 'passenger'; to = o.driver_user; }
  else if (o.driver_user === phone) { role = 'driver'; to = o.passenger_phone; }
  else fail_('not_found');
  if (o.status !== 'done') fail_('state_changed');
  if (rated_().has(o.id + '|' + role)) fail_('already_rated');
  const stars = Math.round(Number(b.stars));
  if (!(stars >= 1 && stars <= 5)) fail_('bad_stars');
  const tags = (Array.isArray(b.tags) ? b.tags : []).map(t => clean_(t, 40)).filter(Boolean).slice(0, 8).join(', ');
  save_('ratings', { order_id: o.id, from_role: role, from_phone: phone, to_phone: to, stars: stars, tags: tags,
                     comment: clean_(b.comment, 500), created_at: iso_() });
  return { ok: true };
}

// ===== Представления заказа (что видит каждая сторона) =====
function orderView_(o, role, rated) {
  const contacts = o.status === 'confirmed' || o.status === 'done';
  const v = {
    id: o.id, status: o.status, city: o.city, from: o.from, to: o.to, when: o.when,
    price: Number(o.price), offer_price: Number(o.offer_price) || null, final_price: Number(o.final_price) || null,
    driver_time: o.driver_time, driver_comment: o.driver_comment, cancel_reason: o.cancel_reason,
    updated_at: o.updated_at, rated: rated.has(o.id + '|' + role)
  };
  if (role === 'passenger') {
    if (o.driver_user) {
      v.driver = { name: o.driver_name, model: o.driver_model, color: o.driver_color, plate: o.driver_plate,
                   phone: contacts ? o.driver_phone : '' };
    }
  } else {
    v.passenger = { name: o.passenger_name, phone: contacts ? o.passenger_phone : '' };
  }
  return v;
}

function clearDriver_(o) {
  ['driver_user', 'driver_name', 'driver_phone', 'driver_model', 'driver_color', 'driver_plate',
   'driver_time', 'driver_comment', 'offer_price', 'final_price'].forEach(k => { o[k] = ''; });
}

function ownOrder_(b) {
  const phone = phone_(b.phone);
  const o = find_('orders', r => r.id === b.id);
  if (!o || o.passenger_phone !== phone) fail_('not_found');
  return o;
}

function user_(raw) {
  const u = find_('users', r => r.phone === phone_(raw));
  if (!u) fail_('no_user');
  return u;
}

function rated_() {
  const set = new Set();
  rows_('ratings').forEach(r => set.add(r.order_id + '|' + r.from_role));
  return set;
}

// ===== Работа с таблицей =====
function book_() {
  const id = PropertiesService.getScriptProperties().getProperty('SHEET_ID');
  return id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
}

function sheet_(name) {
  if (cache_[name]) return cache_[name];
  const cols = SCHEMA[name];
  const book = book_();
  let sh = book.getSheetByName(name) || book.insertSheet(name);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, sh.getMaxRows(), cols.length).setNumberFormat('@'); // всё как текст: телефоны и даты не портятся
    sh.getRange(1, 1, 1, cols.length).setValues([cols]);
    sh.setFrozenRows(1);
  } else {
    const head = sh.getRange(1, 1, 1, cols.length).getValues()[0].join('|');
    if (head !== cols.join('|')) fail_('schema_mismatch', 'Заголовки листа ' + name + ' не совпадают со схемой');
  }
  cache_[name] = sh;
  return sh;
}

function rows_(name) {
  const sh = sheet_(name), cols = SCHEMA[name], n = sh.getLastRow() - 1;
  if (n < 1) return [];
  return sh.getRange(2, 1, n, cols.length).getValues().map((r, i) => {
    const o = { _row: i + 2 };
    cols.forEach((c, j) => { o[c] = r[j] === '' || r[j] == null ? '' : String(r[j]); });
    return o;
  });
}

function find_(name, pred) {
  const list = rows_(name);
  for (let i = 0; i < list.length; i++) if (pred(list[i])) return list[i];
  return null;
}

function save_(name, o) {
  const sh = sheet_(name), cols = SCHEMA[name];
  const vals = cols.map(c => (o[c] == null ? '' : String(o[c])));
  if (!o._row) {
    o._row = sh.getLastRow() + 1;
    if (o._row > sh.getMaxRows()) {
      sh.insertRowsAfter(sh.getMaxRows(), 500);
      sh.getRange(o._row, 1, 500, cols.length).setNumberFormat('@');
    }
  }
  sh.getRange(o._row, 1, 1, cols.length).setValues([vals]);
  return o;
}

// ===== Утилиты =====
function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function fail_(code, msg) {
  const e = new Error(msg || code);
  e.code = code;
  throw e;
}

function phone_(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (d.length === 11 && d[0] === '8') d = '7' + d.slice(1);
  if (d.length === 10) d = '7' + d;
  if (d.length !== 11 || d[0] !== '7') fail_('bad_phone');
  return '+7 ' + d.slice(1, 4) + ' ' + d.slice(4, 7) + '-' + d.slice(7, 9) + '-' + d.slice(9, 11);
}

function clean_(s, max) {
  return String(s == null ? '' : s).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);
}

function ms_(s) {
  const t = Date.parse(s);
  return isNaN(t) ? 0 : t;
}

function iso_() {
  return new Date().toISOString();
}
