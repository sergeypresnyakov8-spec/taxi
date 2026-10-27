(() => {
'use strict';
const C = window.CONFIG;
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ───────── Состояние ───────── */
const S = { session: null, me: null, config: { trialDays: 7, subPrice: 0, defaultCity: 'Москва' }, orders: [], snap: null,
            pendingRole: null, tab: 'active', filter: null, sheet: null, reasons: [] };
const LS = {
  get(k) { try { return JSON.parse(localStorage.getItem('taxi.' + k)); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem('taxi.' + k, JSON.stringify(v)); } catch (e) { /* приватный режим */ } },
  del(k) { try { localStorage.removeItem('taxi.' + k); } catch (e) { /* ничего */ } }
};
const role = () => (S.me ? S.me.user.role : 'passenger');
const phone = () => S.session.phone;

/* ───────── API ───────── */
class ApiError extends Error { constructor(code, msg) { super(msg || code); this.code = code; } }
async function api(action, data = {}) {
  let r;
  try {
    r = await fetch(C.API_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ action, ...data }) });
  } catch (e) { throw new ApiError('network'); }
  let j;
  try { j = await r.json(); } catch (e) { throw new ApiError('bad_response'); }
  if (!j.ok) throw new ApiError(j.error || 'server_error', j.message);
  return j.data;
}
const ERRORS = {
  network: 'Нет связи с сервером. Проверьте интернет и повторите',
  bad_response: 'Сервер ответил не так, как ожидалось. Проверьте развёртывание Apps Script (доступ «Все», новая версия)',
  busy: 'Сервер занят, повторите через пару секунд',
  bad_request: 'Некорректный запрос', unknown_action: 'Сервер не знает это действие: обновите код Apps Script и разверните новую версию',
  bad_phone: 'Введите номер телефона полностью', name_required: 'Укажите имя',
  driver_fields: 'Заполните все данные водителя', address_required: 'Укажите адреса «Откуда» и «Куда»',
  bad_time: 'Укажите время подачи', time_in_past: 'Это время уже прошло', bad_price: 'Укажите цену числом',
  not_editable: 'Заказ уже нельзя изменить', not_cancellable: 'Заказ уже нельзя отменить',
  taken: 'Этот заказ уже взял другой водитель', not_found: 'Заказ не найден', own_order: 'Это ваш собственный заказ',
  state_changed: 'Статус заказа изменился, данные обновлены', subscription: 'Нужна активная подписка',
  already_rated: 'Вы уже оценили эту поездку', bad_stars: 'Поставьте оценку от 1 до 5', no_user: 'Пользователь не найден', no_driver: 'Сначала заполните данные водителя',
  schema_mismatch: 'Заголовки листа в таблице не совпадают со схемой. Удалите лист, он создастся заново'
};
const errText = e => ERRORS[e && e.code] || 'Что-то пошло не так. Повторите';

/* ───────── Форматирование ───────── */
const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const pad = n => String(n).padStart(2, '0');
const money = n => (n == null ? '' : Number(n).toLocaleString('ru-RU').replace(/\s/g, ' ') + ' ₽');
const timeOf = iso => { const d = new Date(iso); return pad(d.getHours()) + ':' + pad(d.getMinutes()); };
const dayKey = d => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
function fmtWhen(iso) {
  const d = new Date(iso), diff = Math.round((dayKey(d) - dayKey(new Date())) / 864e5), t = timeOf(iso);
  if (diff === 0) return 'Сегодня, ' + t;
  if (diff === 1) return 'Завтра, ' + t;
  return d.getDate() + ' ' + MONTHS[d.getMonth()] + ', ' + t;
}
function until(iso) {
  const m = Math.round((new Date(iso) - Date.now()) / 60000);
  if (m <= 0 || m >= 1440) return '';
  return 'через ' + (m >= 60 ? Math.floor(m / 60) + ' ч ' + (m % 60 ? (m % 60) + ' мин' : '') : m + ' мин');
}
const inputDT = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
function defaultWhen() { const d = new Date(Date.now() + 2 * 3600e3); d.setMinutes(Math.ceil(d.getMinutes() / 15) * 15, 0, 0); return d; }
const days = n => n + ' ' + (n % 10 === 1 && n % 100 !== 11 ? 'день' : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? 'дня' : 'дней');
function fmtPhone(v) {
  let d = String(v).replace(/\D/g, '');
  if (!d) return '';
  if (d[0] === '8') d = '7' + d.slice(1);
  if (d[0] !== '7') d = '7' + d;
  d = d.slice(0, 11);
  let s = '+7';
  if (d.length > 1) s += ' ' + d.slice(1, 4);
  if (d.length > 4) s += ' ' + d.slice(4, 7);
  if (d.length > 7) s += '-' + d.slice(7, 9);
  if (d.length > 9) s += '-' + d.slice(9, 11);
  return s;
}
const phoneOk = v => String(v).replace(/\D/g, '').length === 11;
const tel = p => 'tel:+' + String(p).replace(/\D/g, '');
const initial = n => (String(n || '?').trim()[0] || '?').toUpperCase();
const num = v => Number(String(v).replace(/\D/g, '')) || 0;
const val = id => { const el = document.getElementById(id); return el ? el.value.trim() : ''; };

/* ───────── Иконки и общие блоки ───────── */
const P = {
  car: '<path d="M5 16l1.6-5.2A2 2 0 018.5 9.4h7a2 2 0 011.9 1.4L19 16"/><rect x="3.5" y="16" width="17" height="3.5" rx="1"/><path d="M7 19.5V21M17 19.5V21"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4.5 20a7.5 7.5 0 0115 0"/>',
  pin: '<path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0113 0c0 5.4-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.3"/>',
  list: '<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r=".6"/><circle cx="4.5" cy="12" r=".6"/><circle cx="4.5" cy="18" r=".6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  phone: '<path d="M5 4h4l2 5-2.5 1.5a11 11 0 005 5L15 13l5 2v4a2 2 0 01-2 2A15 15 0 013 6a2 2 0 012-2z"/>',
  back: '<path d="M15 5l-7 7 7 7"/>', check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  down: '<path d="M6 9l6 6 6-6"/>', right: '<path d="M9 5l7 7-7 7"/>',
  star: '<path d="M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.9L12 17l-5.2 2.7 1-5.9-4.3-4.1 5.9-.8z" stroke-width="1.6"/>'
};
const ico = (n, s = 22, w = 2) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[n]}</svg>`;
const screen = (inner, nav = '') => `<div class="screen">${inner}${nav}</div>`;
const route = (a, b, sm) => `<div class="route${sm ? ' sm' : ''}"><div class="dots"><span class="ring"></span><span class="vline"></span><span class="sq"></span></div><div class="pts"><span>${esc(a)}</span><span>${esc(b)}</span></div></div>`;
const backLink = href => `<a class="back" href="${href}" aria-label="Назад">${ico('back', 24)}</a>`;
const field = (id, label, value, o = {}) => `<div class="field"><label class="label" for="${id}">${label}</label><input class="input${o.lg ? ' lg' : ''}" id="${id}" value="${esc(value)}" ${o.type ? `type="${o.type}"` : ''} ${o.attrs || ''}></div>`;
const driverCard = d => `<span class="avatar">${esc(initial(d.name))}</span><div style="min-width:0"><div style="font-size:17px;font-weight:800">${esc(d.name)}</div><div class="lead">${esc(d.model)}, ${esc(String(d.color).toLowerCase())}</div></div>`;
const go = h => { if (location.hash === h) render(); else location.hash = h; };

function navPass(a) {
  const it = (h, k, i, t) => `<a href="${h}" ${a === k ? 'aria-current="page"' : ''}><span class="pill">${ico(i)}</span>${t}</a>`;
  return `<nav class="nav" aria-label="Основное меню">${it('#/new', 'new', 'pin', 'Заказ')}${it('#/history', 'history', 'list', 'Поездки')}${it('#/profile', 'profile', 'user', 'Профиль')}</nav>`;
}
function navDrv(a) {
  const it = (h, k, i, t) => `<a href="${h}" ${a === k ? 'aria-current="page"' : ''}><span class="pill">${ico(i)}</span>${t}</a>`;
  return `<nav class="nav" aria-label="Основное меню">${it('#/feed', 'feed', 'list', 'Заказы')}${it('#/mine', 'mine', 'car', 'Мои')}${it('#/dprofile', 'dprofile', 'user', 'Профиль')}</nav>`;
}
const statusChip = s => ({ searching: ['yel', 'Ищем водителя'], offered: ['warn', 'Нужно ваше решение'], confirmed: ['yel', 'Машина назначена'], done: ['ok', 'Завершена'], cancelled: ['', 'Отменена'] }[s]);

/* ───────── Уведомления ───────── */
function notify(title, body) {
  if (!S.me || !S.me.user.push || !('Notification' in window) || Notification.permission !== 'granted' || !document.hidden) return;
  const reg = navigator.serviceWorker && navigator.serviceWorker.getRegistration();
  Promise.resolve(reg).then(r => (r ? r.showNotification(title, { body, icon: 'icon-192.png', tag: 'taxi' }) : new Notification(title, { body }))).catch(() => {});
}
function detect(list) {
  const next = {};
  list.forEach(o => { next[o.id] = o.status; });
  if (S.snap) {
    list.forEach(o => {
      const p = S.snap[o.id];
      if (!p || p === o.status) return;
      if (role() === 'passenger') {
        if (o.status === 'offered') notify('Водитель предлагает другую цену', 'Откройте заказ, чтобы согласиться или отказаться');
        else if (o.status === 'confirmed') notify('Машина назначена', 'Водитель подтвердил заказ');
        else if (o.status === 'searching') notify('Водитель отказался от заказа', 'Заказ снова ищет водителя');
      } else if (p === 'offered' && o.status === 'confirmed') notify('Пассажир согласился', 'Заказ подтверждён по новой цене');
    });
    if (role() === 'driver') Object.keys(S.snap).forEach(id => { if (!(id in next)) notify('Заказ снят', 'Пассажир отказался или отменил заказ'); });
  }
  S.snap = next;
}
async function loadOrders() {
  const list = await api(role() === 'driver' ? 'driverOrders' : 'myOrders', { phone: phone() });
  detect(list);
  S.orders = list;
  return list;
}
async function askPush() {
  if ('Notification' in window && Notification.permission === 'default') { try { await Notification.requestPermission(); } catch (e) { /* ничего */ } }
}

/* ───────── Сессия ───────── */
async function refreshMe() { S.me = await api('me', { phone: phone() }); S.session.role = S.me.user.role; LS.set('session', S.session); return S.me; }
function homeFor() {
  if (!S.session) return '#/';
  if (role() === 'passenger') return '#/new';
  if (!S.me.driver) return '#/driver-signup';
  return S.me.sub.state === 'none' ? '#/subscription' : '#/feed';
}
function logout() { S.session = null; S.me = null; S.snap = null; S.filter = null; LS.del('session'); location.hash = '#/'; }

/* ───────── Экраны: вход ───────── */
function vMain() {
  const r = S.pendingRole || (S.me ? S.me.user.role : 'passenger');
  S.pendingRole = r;
  const card = (k, icon, t, s) => `<button type="button" class="role" data-act="pick" data-role="${k}" aria-pressed="${r === k}">
    <span class="avatar">${ico(icon, 24)}</span><span class="grow"><div class="t">${t}</div><div class="s">${s}</div></span>
    <span class="radio">${r === k ? ico('check', 16, 3) : ''}</span></button>`;
  return screen(`<div class="body" style="padding-top:32px;padding-bottom:28px">
    <div class="brand"><span class="logo">${ico('car', 24)}</span>${esc(C.APP_NAME)}</div>
    <div class="stack" style="margin-top:36px;gap:14px"><h1 class="h1 xl">Такси к нужному времени</h1>
      <p class="lead big">Укажите, куда и когда ехать. Свободный водитель возьмёт заказ и подтвердит время подачи.</p></div>
    <div class="stack" style="margin-top:12px"><span class="label">Кто вы?</span>
      ${card('passenger', 'user', 'Я пассажир', 'Закажу поездку к нужному времени')}
      ${card('driver', 'car', 'Я водитель', 'Буду брать свободные заказы')}</div>
    <div class="stack mt-auto" style="align-items:center;gap:14px"><button class="btn" data-act="roleNext">Продолжить</button>
      <span class="note">Водителям: ${days(S.config.trialDays)} бесплатно, затем подписка</span></div></div>`);
}

function vLogin() {
  const r = S.pendingRole || 'passenger';
  return screen(`<div class="body" style="padding:16px 24px 28px;gap:0">
    ${backLink('#/role')}
    <div class="stack" style="margin-top:16px"><span class="who">Вход как ${r === 'driver' ? 'водитель' : 'пассажир'} <a href="#/role">Сменить</a></span>
      <h1 class="h1 lg">Вход по номеру телефона</h1>
      <p class="lead big">Номер нужен, чтобы водитель мог с вами связаться. Он виден только после подтверждения заказа.</p></div>
    <form class="stack" style="margin-top:28px;gap:20px" data-form="login">
      <div class="field"><label class="label" for="l-phone">Номер телефона</label>
        <input class="input lg" id="l-phone" type="tel" inputmode="tel" autocomplete="tel" placeholder="+7 900 000-00-00" data-phone value="${esc(LS.get('lastPhone') || '')}"></div>
      <div class="field"><label class="label" for="l-name">Как вас зовут</label>
        <input class="input lg" id="l-name" autocomplete="given-name" placeholder="Имя" maxlength="60" value="${esc(LS.get('lastName') || '')}"></div>
      <button class="btn" type="submit" style="margin-top:12px">Войти</button></form>
    <span class="note mt-auto" style="padding-top:24px">${r === 'driver' ? 'После входа заполните данные об автомобиле' : 'Подтверждение по коду пока не требуется'}</span></div>`);
}

function vSignup() {
  const d = S.me.driver, edit = !!d;
  return screen(`<div class="body" style="padding:16px 24px 28px;gap:0">
    ${backLink(edit ? '#/dprofile' : '#/role')}
    <div class="stack" style="margin-top:8px">
      ${edit ? '' : '<div class="steps"><div><i class="on"></i><i></i></div>Шаг 1 из 2</div>'}
      <h1 class="h1 lg">Данные водителя</h1>
      <p class="lead">Мы подставим их в каждый заказ, который вы возьмёте. Перед отправкой пассажиру их можно изменить.</p></div>
    <form class="stack" style="margin-top:24px;gap:16px" data-form="signup">
      ${field('s-name', 'Имя', d ? d.name : S.me.user.name, { attrs: 'maxlength="60" autocomplete="given-name"' })}
      ${field('s-phone', 'Телефон', d ? d.contact_phone : S.me.user.phone, { type: 'tel', attrs: 'inputmode="tel" data-phone' })}
      ${field('s-model', 'Марка и модель', d ? d.model : '', { attrs: 'maxlength="60" placeholder="Например, Skoda Octavia"' })}
      <div class="grid2">${field('s-color', 'Цвет', d ? d.color : '', { attrs: 'maxlength="30"' })}
        ${field('s-plate', 'Госномер', d ? d.plate : '', { attrs: 'maxlength="20" autocapitalize="characters"' })}</div>
      <button class="btn" type="submit" style="margin-top:20px">${edit ? 'Сохранить' : 'Далее'}</button></form></div>`);
}

function vSub() {
  const st = S.me.sub, first = st.state === 'none', n = S.config.trialDays;
  return screen(`<div class="body" style="padding:16px 24px 28px;gap:0">
    ${backLink(first ? '#/driver-signup' : '#/dprofile')}
    <div class="stack" style="margin-top:8px">
      ${first ? '<div class="steps"><div><i class="on"></i><i class="on"></i></div>Шаг 2 из 2</div>' : ''}
      <h1 class="h1 lg">Подписка водителя</h1>
      <p class="lead">Лента свободных заказов доступна по подписке.</p></div>
    <div class="plan" style="margin-top:28px">
      <div class="stack" style="gap:6px"><span style="font-size:14px;font-weight:700;color:var(--line2)">Пробный период</span>
        <span class="big">${days(n)} бесплатно</span>
        <span style="font-size:17px;font-weight:600">Затем ${money(S.config.subPrice)} в месяц</span></div>
      <div class="sep"></div>
      <ul><li>${ico('check', 22, 2.5)}Лента свободных заказов с адресами и временем подачи</li>
        <li>${ico('check', 22, 2.5)}Можно скорректировать цену и время подачи при взятии заказа</li></ul></div>
    <div class="stack mt-auto" style="align-items:center;gap:14px;padding-top:24px">
      <button class="btn" data-act="${first ? 'startTrial' : 'pay'}">${first ? 'Начать пробный период' : 'Оформить подписку'}</button>
      <span class="note">${first ? 'Подписку можно продлить в профиле' : 'Оплата подписки подключается, пока доступ выдаётся вручную'}</span></div></div>`);
}

/* ───────── Экраны: пассажир ───────── */
async function vNew([id]) {
  let o = null;
  if (id) { o = (await loadOrders()).find(x => x.id === id); if (!o || o.status !== 'searching') return { redirect: id ? '#/order/' + id : '#/new' }; }
  const when = o ? new Date(o.when) : defaultWhen();
  return screen(`<div class="body" style="gap:20px">
    ${o ? `<div class="topbar">${backLink('#/order/' + id)}<h1 class="h2">Изменить заказ</h1></div>`
        : `<div class="stack" style="gap:8px"><h1 class="h1">Куда поедем?</h1><p class="lead">Укажите адрес подачи и время. Свободный водитель возьмёт заказ.</p></div>`}
    <form class="stack" style="gap:20px;flex:1" data-form="order" data-id="${id || ''}">
      <div class="card" style="flex-direction:row;gap:14px"><div class="route edit" style="flex:1"><div class="dots"><span class="ring"></span><span class="vline"></span><span class="sq"></span></div>
        <div class="stack grow" style="gap:12px">
          <div class="field" style="gap:2px"><label class="label" for="o-from" style="font-size:12px">Откуда</label>
            <input id="o-from" class="input" style="border:0;border-bottom:1px solid var(--line);border-radius:0;padding:0;height:44px;background:transparent" value="${esc(o ? o.from : '')}" placeholder="Адрес подачи" maxlength="200" autocomplete="street-address"></div>
          <div class="field" style="gap:2px"><label class="label" for="o-to" style="font-size:12px">Куда</label>
            <input id="o-to" class="input" style="border:0;padding:0;height:44px;background:transparent" value="${esc(o ? o.to : '')}" placeholder="Адрес назначения" maxlength="200"></div></div></div></div>
      <div class="stack" style="gap:12px">
        <div class="card" style="padding:14px 16px;gap:2px"><label class="label" for="o-when" style="font-size:12px">Подать к</label>
          <input id="o-when" type="datetime-local" class="input" style="border:0;padding:0;height:44px;background:transparent" value="${inputDT(when)}" min="${inputDT(new Date())}"></div>
        <div class="card" style="padding:14px 16px;gap:2px"><label class="label" for="o-price" style="font-size:12px">Ваша цена, ₽</label>
          <input id="o-price" class="input" style="border:0;padding:0;height:44px;background:transparent" inputmode="numeric" data-money placeholder="1 800" value="${o ? Number(o.price).toLocaleString('ru-RU') : ''}"></div></div>
      <p class="lead" style="font-size:14px">Водитель может согласиться или предложить свою цену. Новую цену вы подтвердите отдельно.</p>
      <button class="btn mt-auto" type="submit">${o ? 'Сохранить' : 'Заказать'}</button></form></div>`, navPass('new'));
}

const cancelSheet = o => `<div class="overlay" data-act="closeSheet"><div class="sheet" role="dialog" aria-modal="true" aria-labelledby="sh-t">
  <span class="grab"></span><div class="stack" style="gap:6px"><h2 class="h2" id="sh-t">Отменить ${o.status === 'confirmed' ? 'поездку' : 'заказ'}?</h2>
  <p class="lead">${o.status === 'confirmed' ? 'Водитель получит уведомление.' : 'Заказ пропадёт из списка водителей.'} Причина поможет нам улучшить сервис.</p></div>
  <fieldset class="radios"><legend class="sr">Причина отмены</legend>
    ${['Передумал(а) ехать', 'Нашёл(ла) другую машину', 'Изменились планы по времени', 'Другое'].map((t, i) => `<label><input type="radio" name="reason" value="${t}" ${i === 0 ? 'checked' : ''}>${t}</label>`).join('')}</fieldset>
  <div class="actions"><button class="btn danger" data-act="cancelOrder" data-id="${o.id}">Отменить ${o.status === 'confirmed' ? 'поездку' : 'заказ'}</button>
    <button class="btn sec" data-act="closeSheet">Оставить ${o.status === 'confirmed' ? 'поездку' : 'заказ'}</button></div></div></div>`;

const summary = o => `<div class="card">${route(o.from, o.to)}<div class="sep"></div>
  <div class="row between"><span class="row" style="gap:8px;font-size:15px;font-weight:700">${ico('clock', 20)}${fmtWhen(o.when)}</span><span class="price">${money(o.final_price || o.price)}</span></div></div>`;

async function vOrder([id]) {
  const o = (await loadOrders()).find(x => x.id === id);
  if (!o || o.status === 'cancelled') return { redirect: '#/history' };
  if (o.status === 'done') return { redirect: o.rated ? '#/history' : '#/rate/' + id };
  const sheet = S.sheet === id ? cancelSheet(o) : '';
  const nav = navPass('new');
  if (o.status === 'searching') {
    return screen(`<div class="body"><div class="stack" style="align-items:center;gap:20px;padding-top:12px">
      <span class="pulse"><i><b>${ico('car', 30)}</b></i></span>
      <div class="stack" style="align-items:center;gap:8px;text-align:center"><h1 class="h1 md">Ищем водителя</h1>
        <p class="lead" style="max-width:290px">Заказ уже в общем списке. Как только водитель его возьмёт, мы пришлём уведомление.</p></div></div>
      ${summary(o)}
      <div class="actions mt-auto"><a class="btn sec" href="#/edit/${id}">Изменить заказ</a>
        <button class="btn link red" data-act="openSheet" data-id="${id}">Отменить заказ</button></div></div>`, nav) + sheet;
  }
  const d = o.driver, t = timeOf(o.driver_time || o.when);
  if (o.status === 'offered') {
    return screen(`<div class="body" style="gap:18px"><div class="stack" style="gap:10px"><span class="pill-note">Нужно ваше решение</span>
      <h1 class="h1 md">Водитель предлагает другую цену</h1></div>
      <div class="card" style="padding:20px"><div class="compare">
        <div class="stack" style="gap:6px"><span class="label">Вы предложили</span><span class="old strike">${money(o.price)}</span></div>
        <div class="stack" style="gap:6px"><span class="label">Предлагает водитель</span><span class="new">${money(o.offer_price)}</span></div></div></div>
      <div class="card"><div class="row">${driverCard(d)}<span class="plate" style="margin-left:auto">${esc(d.plate)}</span></div>
        <div class="sep"></div><div class="row" style="gap:8px;font-size:15px;font-weight:700">${ico('clock', 20)}Подача к ${t}${new Date(o.driver_time) - new Date(o.when) ? ' <span class="chip warn">время изменено</span>' : ''}</div>
        ${o.driver_comment ? `<p class="quote">Комментарий водителя: ${esc(o.driver_comment)}</p>` : ''}</div>
      <div class="actions mt-auto"><button class="btn" data-act="answer" data-id="${id}" data-accept="1">Согласиться за ${money(o.offer_price)}</button>
        <button class="btn sec" data-act="answer" data-id="${id}" data-accept="0">Отказаться</button>
        <p class="note">После отказа заказ вернётся в общий список, и его сможет взять другой водитель</p></div></div>`, nav);
  }
  return screen(`<div class="body" style="gap:18px"><div class="row" style="gap:14px"><span class="okmark">${ico('check', 28, 3)}</span>
    <div><div style="font-size:14px;font-weight:700;color:var(--ok)">Заказ подтверждён</div><h1 class="h1 md" style="line-height:1.1">Машина будет к ${t}</h1></div></div>
    <div class="card"><div class="row">${driverCard(d)}
      <a class="round" style="margin-left:auto" href="${tel(d.phone)}" aria-label="Позвонить водителю">${ico('phone')}</a></div>
      <div class="plate-box"><span class="plate big">${esc(d.plate)}</span></div>
      ${o.driver_comment ? `<p class="quote">Комментарий водителя: ${esc(o.driver_comment)}</p>` : ''}</div>
    <div class="card">${route(o.from, o.to)}<div class="sep"></div><div class="row between"><span class="label">Цена согласована</span><span class="price" style="font-size:22px">${money(o.final_price)}</span></div></div>
    <div class="actions tight mt-auto"><button class="btn sec" data-act="finish" data-id="${id}" data-next="rate">Поездка завершена: оценить</button>
      <button class="btn link red" data-act="openSheet" data-id="${id}">Отменить поездку</button></div></div>`, nav) + sheet;
}

async function vHistory() {
  const list = await loadOrders();
  const card = o => {
    const active = ['searching', 'offered', 'confirmed'].includes(o.status), c = statusChip(o.status);
    const link = active ? '#/order/' + o.id : (o.status === 'done' && !o.rated ? '#/rate/' + o.id : '');
    const inner = `<div class="row between"><span class="label">${fmtWhen(o.when)}</span><span class="chip ${c[0]}">${c[1]}</span></div>
      <span class="rt">${esc(o.from)} → ${esc(o.to)}</span>
      <div class="row between"><span class="price ${o.status === 'cancelled' ? 'strike' : ''}" style="font-size:18px">${money(o.final_price || o.price)}</span>${link && o.status === 'done' ? '<span class="label" style="color:var(--ink)">Оценить →</span>' : ''}</div>`;
    return link ? `<a class="card${active ? ' sel' : ''}" style="gap:10px" href="${link}">${inner}</a>` : `<div class="card" style="gap:10px">${inner}</div>`;
  };
  return screen(`<div class="body tight"><h1 class="h1">Поездки</h1>
    ${list.length ? list.map(card).join('') : `<div class="empty"><h2 class="h2">Поездок пока нет</h2><p class="lead">Закажите первую поездку к нужному времени.</p><a class="btn mini" href="#/new" style="margin-top:8px">Заказать</a></div>`}</div>`, navPass('history'));
}

const citySelect = cur => { const list = [...new Set([...C.CITIES, cur])]; return `<select data-change="city" aria-label="Город">${list.map(c => `<option ${c === cur ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>`; };
const pushRow = on => `<div class="listrow"><b id="push-l">Push-уведомления</b><button type="button" class="switch" role="switch" aria-checked="${on}" aria-labelledby="push-l" data-act="togglePush"><i></i></button></div>`;

function vProfile() {
  const u = S.me.user;
  return screen(`<div class="body"><h1 class="h1">Профиль</h1>
    <div class="row" style="gap:14px"><span class="avatar xl yel">${esc(initial(u.name))}</span><div><div style="font-size:20px;font-weight:800">${esc(u.name)}</div><div class="lead big">${esc(u.phone)}</div></div></div>
    <div class="card flat"><div class="listrow"><b>Имя</b><span>${esc(u.name)}</span></div><div class="listrow"><b>Телефон</b><span>${esc(u.phone)}</span></div>
      <div class="listrow"><b>Город</b>${citySelect(u.city)}</div>${pushRow(u.push)}
      <div class="listrow"><b>Роль</b><a class="row" style="gap:6px;min-height:44px;color:var(--mute)" href="#/role">Пассажир, сменить ${ico('right', 18)}</a></div></div>
    <button class="btn sec red mt-auto" data-act="logout">Выйти</button></div>`, navPass('profile'));
}

const starsHtml = n => `<div class="stars" role="group" aria-label="Оценка от 1 до 5" id="stars" data-v="${n}">${[1, 2, 3, 4, 5].map(i => `<button type="button" class="${i <= n ? 'on' : ''}" aria-label="Оценка ${i}" aria-pressed="${i <= n}" data-act="star" data-n="${i}">${ico('star', 44)}</button>`).join('')}</div>`;

async function vRate([id], asDriver) {
  const o = (await loadOrders()).find(x => x.id === id);
  const back = asDriver ? '#/mine' : '#/history';
  if (!o || o.status !== 'done' || o.rated) return { redirect: back };
  const tags = asDriver ? ['Вышел вовремя', 'Вежливый', 'Не дозвониться', 'Менял маршрут', 'Не вышел к подаче'] : [];
  const who = asDriver ? o.passenger : o.driver;
  return screen(`<div class="body" style="gap:${asDriver ? 20 : 24}px;padding-bottom:28px">
    <div class="stack" style="gap:8px"><h1 class="h1 lg">${asDriver ? 'Как прошла поездка с пассажиром?' : 'Как прошла поездка?'}</h1>
      <p class="lead">${asDriver ? 'Оцените пассажира после завершения заказа.' : 'Ваша оценка поможет другим пассажирам и водителю.'}</p></div>
    <div class="card" style="gap:12px"><div class="row"><span class="avatar">${esc(initial(who.name))}</span><div style="min-width:0"><div style="font-size:17px;font-weight:800">${esc(who.name)}</div>
      <div class="lead">${asDriver ? `${fmtWhen(o.when)} · ${money(o.final_price)}` : `${esc(o.driver.model)}, ${esc(String(o.driver.color).toLowerCase())} · ${fmtWhen(o.when)}`}</div></div></div>
      ${asDriver ? `<span class="label">${esc(o.from)} → ${esc(o.to)}</span>` : ''}</div>
    ${starsHtml(5)}
    ${tags.length ? `<div class="stack" style="gap:10px"><span class="label">Что отметить (необязательно)</span><div class="tags">${tags.map(t => `<button type="button" class="tag" aria-pressed="false" data-act="tag">${t}</button>`).join('')}</div></div>` : ''}
    <div class="field"><label class="label" for="r-comment">Комментарий (необязательно)</label>
      <textarea class="input" id="r-comment" maxlength="500" style="height:${asDriver ? 96 : 120}px" placeholder="${asDriver ? 'Что стоит знать о поездке' : 'Что понравилось или что можно улучшить'}"></textarea></div>
    <div class="actions tight mt-auto"><button class="btn" data-act="sendRate" data-id="${id}" data-back="${back}">Отправить</button>
      <a class="btn link" style="color:var(--mute)" href="${back}">Пропустить</a></div></div>`);
}

/* ───────── Экраны: водитель ───────── */
const lockedFeed = () => screen(`<div class="body tight"><h1 class="h1 md">Заказы</h1>
  <div class="card"><span class="chip warn" style="align-self:flex-start">${S.me.sub.state === 'expired' ? 'Пробный период закончился' : 'Нет подписки'}</span>
  <h2 class="h2">Лента заказов закрыта</h2><p class="lead">Оформите подписку, чтобы снова видеть свободные заказы и брать их.</p>
  <a class="btn" href="#/subscription">Оформить подписку</a></div></div>`, navDrv('feed'));

async function vFeed() {
  if (!S.filter) S.filter = LS.get('filter') || { city: S.me.user.city, min: 0 };
  const f = S.filter;
  if (S.me.sub.state === 'expired' || S.me.sub.state === 'none') return lockedFeed();
  let data;
  try { data = await api('feed', { phone: phone(), city: f.city, min: f.min }); }
  catch (e) { if (e.code === 'subscription') return lockedFeed(); throw e; }
  const cities = [...new Set([...C.CITIES, ...data.cities, f.city].filter(Boolean))];
  const mins = [0, 1000, 2000, 3000, 5000];
  const st = S.me.sub;
  const card = o => `<div class="card fc"><div class="row between" style="align-items:baseline"><span style="font-size:16px;font-weight:800">${fmtWhen(o.when)} ${until(o.when) ? `<span class="label" style="font-size:12px">· ${until(o.when)}</span>` : ''}</span><span class="price" style="font-size:18px">${money(o.price)}</span></div>
    <div class="row" style="gap:10px">${route(o.from, o.to, true).replace('class="route sm"', 'class="route sm grow"')}<a class="btn mini" href="#/take/${o.id}">Взять</a></div></div>`;
  return screen(`<div class="body" style="padding:24px 16px 20px;gap:10px">
    <div class="row between" style="gap:8px"><h1 class="h1 md" style="line-height:1.1">Заказы</h1>${st.state === 'trial' ? `<span class="chip warn" style="font-size:12px;padding:5px 10px">Пробный период: ещё ${st.daysLeft} дн.</span>` : ''}</div>
    <div class="filters">
      <label class="filter"><span class="t"><small>Город</small>${esc(f.city || 'Все города')}</span>${ico('down', 18, 2.2)}
        <select data-change="fcity" aria-label="Город"><option value="" ${f.city ? '' : 'selected'}>Все города</option>${cities.map(c => `<option ${c === f.city ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></label>
      <label class="filter"><span class="t"><small>Цена</small>${f.min ? 'от ' + money(f.min) : 'любая'}</span>${ico('down', 18, 2.2)}
        <select data-change="fmin" aria-label="Минимальная цена">${mins.map(m => `<option value="${m}" ${m === f.min ? 'selected' : ''}>${m ? 'от ' + money(m) : 'Любая цена'}</option>`).join('')}</select></label></div>
    <div class="meta"><span>Найдено ${data.orders.length} · сначала ближайшие</span><button type="button" data-act="resetFilter">Сбросить</button></div>
    <div class="stack" style="gap:8px">${data.orders.length ? data.orders.map(card).join('') : '<div class="empty"><h2 class="h2">Свободных заказов нет</h2><p class="lead">Новые появятся здесь сами. Можно сменить город или цену.</p></div>'}</div></div>`, navDrv('feed'));
}

async function vTake([id]) {
  const data = await api('feed', { phone: phone(), city: '', min: 0 }).catch(e => { if (e.code === 'subscription') return null; throw e; });
  const o = data && data.orders.find(x => x.id === id);
  if (!o) { toast('Этот заказ уже недоступен'); return { redirect: '#/feed' }; }
  const d = S.me.driver;
  return screen(`<div class="body" style="padding:16px 20px 28px;gap:16px">
    <div class="topbar">${backLink('#/feed')}<h1 class="h2">Взять заказ</h1></div>
    <div class="card" style="gap:12px">${route(o.from, o.to)}<div class="sep"></div>
      <div class="row between"><span style="font-size:15px;font-weight:700">Подать к ${timeOf(o.when)}</span><span class="label" style="font-size:15px">Цена пассажира: ${money(o.price)}</span></div></div>
    <form class="stack" style="gap:16px;flex:1" data-form="take" data-id="${id}" data-when="${o.when}" data-price="${o.price}">
      <div class="grid2">${field('t-price', 'Цена, ₽', Number(o.price).toLocaleString('ru-RU'), { attrs: 'inputmode="numeric" data-money' })}
        ${field('t-time', 'Время подачи', timeOf(o.when), { type: 'time' })}</div>
      <p class="note" style="text-align:left;margin-top:-4px">Если измените цену или время, пассажир должен это подтвердить. Время по заказу: ${timeOf(o.when)}.</p>
      <div class="sep"></div>
      ${field('t-name', 'Имя', d.name, { attrs: 'maxlength="60"' })}
      ${field('t-phone', 'Телефон', d.contact_phone, { type: 'tel', attrs: 'inputmode="tel" data-phone' })}
      ${field('t-model', 'Марка и модель', d.model, { attrs: 'maxlength="60"' })}
      <div class="grid2">${field('t-color', 'Цвет', d.color, { attrs: 'maxlength="30"' })}${field('t-plate', 'Госномер', d.plate, { attrs: 'maxlength="20"' })}</div>
      <div class="field"><label class="label" for="t-comment">Комментарий пассажиру</label><textarea class="input" id="t-comment" maxlength="300" placeholder="Например, где вас встретить"></textarea></div>
      <p class="note mt-auto" style="padding-top:8px">После подтверждения заказ пропадёт из общего списка, а пассажир получит уведомление</p>
      <button class="btn" type="submit">Подтвердить заказ</button></form></div>`);
}

async function vMine() {
  const list = await loadOrders();
  const act = list.filter(o => o.status !== 'done'), done = list.filter(o => o.status === 'done');
  const routeBlock = o => route(o.from, o.to);
  const card = o => {
    if (o.status === 'offered') return `<div class="card" style="gap:12px"><div class="row between wrap" style="gap:8px"><span style="font-size:20px;font-weight:800;white-space:nowrap">${fmtWhen(o.when)}</span><span class="chip warn">Ждём ответа пассажира</span></div>
      ${routeBlock(o)}<div class="row between"><div class="row" style="align-items:baseline;gap:8px"><span class="strike" style="font-size:16px;font-weight:700">${money(o.price)}</span><span class="price" style="font-size:22px">${money(o.offer_price)}</span></div><span class="lead" style="font-size:14px">Новая цена</span></div>
      <button class="btn sec red" style="height:48px;border-radius:14px;font-size:15px" data-act="release" data-id="${o.id}">Отказаться от заказа</button></div>`;
    if (o.status === 'confirmed') return `<div class="card" style="gap:12px"><div class="row between wrap" style="gap:8px"><span style="font-size:20px;font-weight:800;white-space:nowrap">${fmtWhen(o.when)}</span><span class="chip ok">Цена подтверждена</span></div>
      ${routeBlock(o)}<div class="row between"><div class="stack" style="gap:2px"><span class="price" style="font-size:22px">${money(o.final_price)}</span><span class="lead" style="font-size:14px">${esc(o.passenger.name)}</span></div>
      <a class="btn call" href="${tel(o.passenger.phone)}">${ico('phone', 20)}Позвонить</a></div>
      <button class="btn sec" style="height:48px;border-radius:14px;font-size:15px" data-act="finish" data-id="${o.id}" data-next="rate-p">Поездка завершена: оценить пассажира</button></div>`;
    return `<div class="card" style="gap:12px"><div class="row between wrap" style="gap:8px"><span style="font-size:20px;font-weight:800;white-space:nowrap">${fmtWhen(o.when)}</span><span class="chip ok">Завершена</span></div>
      ${routeBlock(o)}<div class="row between"><div class="stack" style="gap:2px"><span class="price" style="font-size:22px">${money(o.final_price)}</span><span class="lead" style="font-size:14px">${esc(o.passenger.name)}</span></div>
      ${o.rated ? '<span class="label">Оценено</span>' : `<a class="btn mini sec" style="width:auto;height:44px" href="#/rate-p/${o.id}">Оценить</a>`}</div></div>`;
  };
  const shown = S.tab === 'done' ? done : act;
  return screen(`<div class="body" style="padding:28px 20px 20px;gap:14px"><h1 class="h1 lg" style="font-size:30px">Мои заказы</h1>
    <div class="tabs" role="tablist" aria-label="Фильтр заказов"><button role="tab" type="button" data-act="tab" data-tab="active" aria-selected="${S.tab !== 'done'}">Активные${act.length ? ' · ' + act.length : ''}</button>
      <button role="tab" type="button" data-act="tab" data-tab="done" aria-selected="${S.tab === 'done'}">Выполненные</button></div>
    ${shown.length ? shown.map(card).join('') : `<div class="empty"><h2 class="h2">${S.tab === 'done' ? 'Выполненных пока нет' : 'Активных заказов нет'}</h2><p class="lead">${S.tab === 'done' ? 'Завершённые поездки появятся здесь.' : 'Возьмите заказ в ленте.'}</p>${S.tab === 'done' ? '' : '<a class="btn mini" href="#/feed" style="margin-top:8px">К заказам</a>'}</div>`}</div>`, navDrv('mine'));
}

function vDProfile() {
  const u = S.me.user, d = S.me.driver, st = S.me.sub;
  const subCard = (() => {
    const chip = { trial: ['warn', 'Пробный период'], paid: ['ok', 'Активна'], expired: ['', 'Закончилась'], none: ['', 'Не начата'] }[st.state];
    const title = { trial: `Осталось ${st.daysLeft} из ${st.total} дней`, paid: `Оплачено ещё ${days(st.daysLeft)}`, expired: 'Пробный период закончился', none: 'Пробный период не начат' }[st.state];
    return `<div class="card" style="gap:12px"><div class="row between"><span class="label">Подписка</span><span class="chip ${chip[0]}">${chip[1]}</span></div>
      <span style="font-size:18px;font-weight:800">${title}</span>
      ${st.state === 'trial' ? `<div class="bar" role="progressbar" aria-label="Пробный период" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(st.daysLeft / st.total * 100)}"><i style="width:${Math.round(st.daysLeft / st.total * 100)}%"></i></div>` : ''}
      <span class="lead" style="font-size:14px">Затем ${money(S.config.subPrice)} в месяц</span>
      <a class="btn sec" style="height:52px;border:0;background:var(--yel);border-radius:14px" href="#/subscription">Оформить подписку</a></div>`;
  })();
  return screen(`<div class="body" style="padding:28px 20px 20px;gap:16px"><h1 class="h1 lg" style="font-size:30px">Профиль</h1>
    <div class="row" style="gap:14px"><span class="avatar xl yel" style="width:60px;height:60px;font-size:24px">${esc(initial(u.name))}</span><div><div style="font-size:20px;font-weight:800">${esc(u.name)}</div><div class="lead big">${esc(u.phone)}</div></div></div>
    <div class="card" style="gap:12px"><div class="row between"><span class="label">Автомобиль</span><a class="row" style="min-height:44px;font-size:15px;font-weight:800" href="#/driver-signup">Изменить</a></div>
      <span style="font-size:18px;font-weight:800">${esc(d.model)}, ${esc(String(d.color).toLowerCase())}</span><span class="plate" style="align-self:flex-start;font-size:18px;padding:6px 14px">${esc(d.plate)}</span></div>
    ${subCard}
    <div class="card flat"><div class="listrow"><b>Город</b>${citySelect(u.city)}</div>${pushRow(u.push)}
      <div class="listrow"><b>Роль</b><a class="row" style="gap:6px;min-height:44px;color:var(--mute)" href="#/role">Водитель, сменить ${ico('right', 18)}</a></div></div>
    <button class="btn sec red mt-auto" data-act="logout">Выйти</button></div>`, navDrv('dprofile'));
}

/* ───────── Маршрутизация ───────── */
const R = {
  '': { view: () => (S.session ? { redirect: homeFor() } : vMain()) },
  role: { view: vMain }, login: { view: vLogin },
  'driver-signup': { view: vSignup, auth: 1, role: 'driver' }, subscription: { view: vSub, auth: 1, role: 'driver', needDriver: 1 },
  new: { view: vNew, auth: 1, role: 'passenger' }, edit: { view: vNew, auth: 1, role: 'passenger' },
  order: { view: vOrder, auth: 1, role: 'passenger', live: 1 }, history: { view: vHistory, auth: 1, role: 'passenger', live: 1 },
  profile: { view: vProfile, auth: 1, role: 'passenger' }, rate: { view: a => vRate(a, false), auth: 1, role: 'passenger' },
  feed: { view: vFeed, auth: 1, role: 'driver', needDriver: 1, live: 1 }, take: { view: vTake, auth: 1, role: 'driver', needDriver: 1 },
  mine: { view: vMine, auth: 1, role: 'driver', needDriver: 1, live: 1 }, dprofile: { view: vDProfile, auth: 1, role: 'driver', needDriver: 1 },
  'rate-p': { view: a => vRate(a, true), auth: 1, role: 'driver', needDriver: 1 }
};
const cur = () => { const [n, ...a] = location.hash.replace(/^#\/?/, '').split('/'); return { name: n || '', args: a.map(decodeURIComponent) }; };

let token = 0, lastHtml = '';
const formFocused = () => /^(INPUT|TEXTAREA|SELECT)$/.test((document.activeElement || {}).tagName || '');
function setHtml(html, keepScroll) {
  const y = window.scrollY;
  $('#app').innerHTML = html;
  lastHtml = html;
  if (keepScroll) window.scrollTo(0, y); else window.scrollTo(0, 0);
}

async function render(opts = {}) {
  const t = ++token, { name, args } = cur(), def = R[name] || R[''];
  if (def.auth && !S.session) { location.hash = '#/'; return; }
  if (def.role && role() !== def.role) { location.hash = homeFor(); return; }
  if (def.needDriver && !S.me.driver) { location.hash = '#/driver-signup'; return; }
  if (!opts.silent) S.sheet = name === 'order' && S.sheet === args[0] ? S.sheet : null;
  const quiet = opts.silent || opts.keep;
  const slow = quiet ? 0 : setTimeout(() => { if (t === token) setHtml('<div class="screen"><div class="body center"><div class="spinner" role="status" aria-label="Загрузка"></div></div></div>'); }, 200);
  try {
    const out = await def.view(args);
    clearTimeout(slow);
    if (t !== token) return;
    if (out && out.redirect) { if (location.hash === out.redirect) return; location.hash = out.redirect; return; }
    if (opts.silent && (formFocused() || S.sheet || out === lastHtml)) return;
    setHtml(out, quiet);
  } catch (e) {
    clearTimeout(slow);
    if (t !== token) return;
    if (opts.silent) return;
    if (opts.keep) { toast(errText(e)); return; }
    setHtml(`<div class="screen"><div class="body center" style="text-align:center"><h2 class="h2">Не удалось загрузить</h2><p class="lead">${esc(errText(e))}</p><button class="btn mini" data-act="retry">Повторить</button></div></div>`);
  }
}

let polling = false;
async function poll() {
  if (!S.session || polling || !S.me) return;
  polling = true;
  try {
    const def = R[cur().name];
    if (def && def.live && !document.hidden) await render({ silent: true }); else await loadOrders();
  } catch (e) { /* следующий опрос повторит */ } finally { polling = false; }
}

/* ───────── Действия ───────── */
let toastT;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg; el.hidden = false;
  clearTimeout(toastT); toastT = setTimeout(() => { el.hidden = true; }, 3800);
}
async function run(btn, fn) {
  if (btn && btn.disabled) return;
  if (btn) btn.disabled = true;
  try { await fn(); } catch (e) { toast(errText(e)); if (e.code === 'state_changed') render(); } finally { if (btn && btn.isConnected) btn.disabled = false; }
}

const ACT = {
  pick(el) { S.pendingRole = el.dataset.role; render(); },
  async roleNext(el) {
    if (!S.session) { location.hash = '#/login'; return; }
    await run(el, async () => {
      if (S.me.user.role !== S.pendingRole) { S.snap = null; S.me = await api('setRole', { phone: phone(), role: S.pendingRole }); S.session.role = S.pendingRole; LS.set('session', S.session); }
      go(homeFor());
    });
  },
  retry() { render(); },
  logout() { logout(); },
  async startTrial(el) { await run(el, async () => { S.me = await api('startTrial', { phone: phone() }); toast('Пробный период начался'); location.hash = '#/feed'; }); },
  pay() { toast('Оплата подписки подключается позже. Пока доступ выдаёт администратор'); },
  openSheet(el) { S.sheet = el.dataset.id; render({ keep: true }); },
  closeSheet() { S.sheet = null; render({ keep: true }); },
  async cancelOrder(el) {
    const r = $('input[name=reason]:checked');
    await run(el, async () => { await api('cancelOrder', { phone: phone(), id: el.dataset.id, reason: r ? r.value : '' }); S.sheet = null; toast('Заказ отменён'); location.hash = '#/history'; });
  },
  async answer(el) {
    await run(el, async () => {
      const acc = el.dataset.accept === '1';
      await api('answerOffer', { phone: phone(), id: el.dataset.id, accept: acc });
      toast(acc ? 'Цена согласована' : 'Заказ вернулся в общий список');
      render();
    });
  },
  async finish(el) {
    await run(el, async () => { await api('finishOrder', { phone: phone(), id: el.dataset.id }); location.hash = '#/' + el.dataset.next + '/' + el.dataset.id; });
  },
  async release(el) {
    await run(el, async () => { await api('releaseOrder', { phone: phone(), id: el.dataset.id }); toast('Вы отказались от заказа'); render(); });
  },
  tab(el) { S.tab = el.dataset.tab; render(); },
  resetFilter() { S.filter = { city: S.me.user.city, min: 0 }; LS.set('filter', S.filter); render(); },
  star(el) {
    const g = $('#stars'), n = Number(el.dataset.n);
    g.dataset.v = n;
    $$('button', g).forEach((b, i) => { b.classList.toggle('on', i < n); b.setAttribute('aria-pressed', i < n); });
  },
  tag(el) { el.setAttribute('aria-pressed', el.getAttribute('aria-pressed') !== 'true'); },
  async sendRate(el) {
    await run(el, async () => {
      await api('rate', { phone: phone(), order_id: el.dataset.id, stars: Number($('#stars').dataset.v), comment: val('r-comment'),
        tags: $$('.tag[aria-pressed=true]').map(b => b.textContent) });
      toast('Спасибо за оценку');
      location.hash = el.dataset.back;
    });
  },
  async togglePush(el) {
    const on = el.getAttribute('aria-checked') !== 'true';
    el.setAttribute('aria-checked', on);
    await run(el, async () => { if (on) await askPush(); S.me = await api('saveUser', { phone: phone(), push: on }); });
  }
};

const FORMS = {
  async login(form) {
    const p = val('l-phone'), name = val('l-name');
    if (!phoneOk(p)) return toast(ERRORS.bad_phone);
    if (!name) return toast(ERRORS.name_required);
    await run($('button[type=submit]', form), async () => {
      const me = await api('login', { phone: p, name, role: S.pendingRole || 'passenger' });
      S.me = me; S.snap = null; S.session = { phone: me.user.phone, role: me.user.role };
      LS.set('session', S.session); LS.set('lastPhone', p); LS.set('lastName', name);
      askPush();
      go(homeFor());
    });
  },
  async signup(form) {
    const body = { phone: phone(), name: val('s-name'), contact_phone: val('s-phone'), model: val('s-model'), color: val('s-color'), plate: val('s-plate').toUpperCase() };
    if (!body.name || !body.model || !body.color || !body.plate) return toast(ERRORS.driver_fields);
    if (!phoneOk(body.contact_phone)) return toast(ERRORS.bad_phone);
    const first = !S.me.driver;
    await run($('button[type=submit]', form), async () => {
      S.me = await api('saveDriver', body);
      if (!first) toast('Сохранено');
      go(first ? '#/subscription' : '#/dprofile');
    });
  },
  async order(form) {
    const id = form.dataset.id, from = val('o-from'), to = val('o-to'), w = val('o-when'), price = num(val('o-price'));
    if (!from || !to) return toast(ERRORS.address_required);
    if (!w || isNaN(new Date(w))) return toast(ERRORS.bad_time);
    if (new Date(w) < new Date(Date.now() - 5 * 60000)) return toast(ERRORS.time_in_past);
    if (!price) return toast(ERRORS.bad_price);
    await run($('button[type=submit]', form), async () => {
      const body = { phone: phone(), from, to, when: new Date(w).toISOString(), price };
      const r = await api(id ? 'updateOrder' : 'createOrder', id ? { ...body, id } : body);
      location.hash = '#/order/' + r.id;
    });
  },
  async take(form) {
    const price = num(val('t-price')), t = val('t-time'), orig = new Date(form.dataset.when);
    if (!price) return toast(ERRORS.bad_price);
    if (!t) return toast(ERRORS.bad_time);
    const when = new Date(orig); const [h, m] = t.split(':').map(Number); when.setHours(h, m, 0, 0);
    const body = { phone: phone(), id: form.dataset.id, price, time: when.toISOString(), name: val('t-name'), contact_phone: val('t-phone'),
      model: val('t-model'), color: val('t-color'), plate: val('t-plate').toUpperCase(), comment: val('t-comment') };
    if (!body.name || !body.model || !body.color || !body.plate) return toast(ERRORS.driver_fields);
    if (!phoneOk(body.contact_phone)) return toast(ERRORS.bad_phone);
    await run($('button[type=submit]', form), async () => {
      try {
        const r = await api('takeOrder', body);
        toast(r.status === 'offered' ? 'Отправили пассажиру новую цену. Ждём ответа' : 'Заказ ваш, пассажир уведомлён');
        location.hash = '#/mine';
      } catch (e) { if (e.code === 'taken' || e.code === 'not_found') { toast(errText(e)); location.hash = '#/feed'; } else throw e; }
    });
  }
};

document.addEventListener('click', e => {
  const el = e.target.closest('[data-act]');
  if (!el || !ACT[el.dataset.act]) return;
  if (el.dataset.act === 'closeSheet' && e.target !== el) return;
  e.preventDefault();
  ACT[el.dataset.act](el, e);
});
document.addEventListener('submit', e => {
  const f = e.target.closest('[data-form]');
  if (!f || !FORMS[f.dataset.form]) return;
  e.preventDefault();
  FORMS[f.dataset.form](f).catch(err => toast(errText(err)));
});
document.addEventListener('input', e => {
  const t = e.target;
  if (t.matches('[data-phone]')) t.value = fmtPhone(t.value);
  else if (t.matches('[data-money]')) { const n = num(t.value); t.value = n ? n.toLocaleString('ru-RU') : ''; }
});
document.addEventListener('change', e => {
  const t = e.target, k = t.dataset.change;
  if (!k) return;
  if (k === 'fcity') { S.filter = { ...S.filter, city: t.value }; LS.set('filter', S.filter); render(); }
  else if (k === 'fmin') { S.filter = { ...S.filter, min: Number(t.value) }; LS.set('filter', S.filter); render(); }
  else if (k === 'city') run(null, async () => { S.me = await api('saveUser', { phone: phone(), city: t.value }); S.filter = null; toast('Город сохранён'); });
});
document.addEventListener('keydown', e => { if (e.key === 'Escape' && S.sheet) { S.sheet = null; render({ keep: true }); } });
document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
window.addEventListener('hashchange', () => render());

/* ───────── Запуск ───────── */
function fatal(e) {
  setHtml(`<div class="screen"><div class="body center" style="text-align:center"><h2 class="h2">Нет связи</h2><p class="lead">${esc(errText(e))}</p><button class="btn mini" data-act="reboot">Повторить</button></div></div>`);
}
ACT.reboot = () => boot();

async function boot() {
  try {
    S.config = await api('config');
    const saved = LS.get('session');
    if (saved && saved.phone) {
      S.session = saved;
      try { await refreshMe(); }
      catch (e) { if (e.code === 'no_user' || e.code === 'bad_phone') { S.session = null; S.me = null; LS.del('session'); } else throw e; }
    }
  } catch (e) { fatal(e); return; }
  render();
  if (!boot.timer) boot.timer = setInterval(poll, C.POLL_MS);
}

if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
boot();
})();
