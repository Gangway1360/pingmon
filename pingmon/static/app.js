'use strict';
/* PingMon - interface. JS vanilla, aucune dépendance. */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const h = (tag, props = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v === true) e.setAttribute(k, '');
    else if (v !== false && v != null) e.setAttribute(k, v);
  }
  for (const k of kids.flat()) if (k != null) e.append(k.nodeType ? k : document.createTextNode(String(k)));
  return e;
};
const ls = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } },
  json(k, d) { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch (e) { return d; } },
};
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

const PRESETS = [['5 min', 300e3], ['15 min', 900e3], ['1 h', 3600e3], ['6 h', 21600e3], ['24 h', 86400e3], ['7 j', 604800e3]];
const MIN_SPAN = 10e3, MAX_SPAN = 30 * 86400e3, MAX_CMP = 8;
const COLOR_NAMES = ['Bleu', 'Orange', 'Turquoise', 'Jaune', 'Rose', 'Vert', 'Violet', 'Rouge'];
const M_FULL = { l: 52, r: 14, t: 8, b: 26, lane: 20 };
const M_CMP = { l: 52, r: 14, t: 4, b: 8, lane: 16 };
const M_CMP_LAST = { l: 52, r: 14, t: 4, b: 26, lane: 16 };

/* Types d'échec : couleur + forme (la forme évite de dépendre de la couleur seule) */
const ERR = {
  1: { key: 'timeout', label: 'Timeout', short: 'timeout', shape: 'square' },
  2: { key: 'unreach', label: 'Hôte injoignable', short: 'injoignable', shape: 'triangle' },
  3: { key: 'ttl', label: 'TTL expiré', short: 'TTL expiré', shape: 'diamond' },
  4: { key: 'dns', label: 'DNS introuvable', short: 'DNS', shape: 'circle' },
  5: { key: 'other', label: 'Défaillance', short: 'défaillance', shape: 'cross' },
};
const ERR_CODES = [1, 2, 3, 4, 5];
const errCode = e => (e && ERR[e]) ? e : 1;
/* Périodes non surveillées */
const GAP_LABEL = { pause: 'En pause', stop: 'Arrêtée', server: 'PingMon arrêté', sleep: 'Poste en veille' };

const S = {
  targets: [], sel: null, view: ls.get('pm.view') === 'compare' ? 'compare' : 'single',
  cmp: ls.json('pm.cmp', []), cmpColors: ls.json('pm.cmpcolors', {}), live: true, span: 900e3, from: 0, to: 0,
  mode: 'pan', clip: false, table: false, hoverTs: null, hoverCh: null, drag: null,
  editTag: null, editTarget: null, version: null, info: null,
  showStopped: ls.get('pm.stopped') === '1', closedSites: new Set(ls.json('pm.closed', [])),
  q: '', filt: ls.get('pm.filt') === 'fail' ? 'fail' : 'all', failTop: ls.get('pm.failtop') === '1',
  density: ls.get('pm.density') === 'comfort' ? 'comfort' : 'compact', reorderable: true,
};
let CHARTS = [], chartsKey = '';
let T = {};

/* ------------------------------------------------------------- utils */
const fmtTime = new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const fmtHM = new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit' });
const fmtDM = new Intl.DateTimeFormat('fr-FR', { day: '2-digit', month: '2-digit' });
const fmtFull = new Intl.DateTimeFormat('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
const fmtDMHM = new Intl.DateTimeFormat('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const fmtMs = v => v == null ? '—' : (v < 100 ? v.toFixed(1) : String(Math.round(v))).replace('.', ',');
const fmtPct = v => v == null ? '—' : String(v).replace('.', ',') + ' %';
function fmtDur(ms) {
  if (ms < 1000) return Math.round(ms) + ' ms';
  const s = ms / 1000;
  if (s < 60) return s.toFixed(s < 10 ? 1 : 0).replace('.', ',') + ' s';
  const m = Math.floor(s / 60), r = Math.round(s % 60);
  if (m < 60) return m + ' min' + (r ? ' ' + r + ' s' : '');
  const hh = Math.floor(m / 60);
  if (hh < 48) return hh + ' h' + (m % 60 ? ' ' + (m % 60) + ' min' : '');
  return Math.floor(hh / 24) + ' j';
}
const fmtSize = b => b < 1048576 ? Math.round(b / 1024) + ' Ko' : (b / 1048576).toFixed(1).replace('.', ',') + ' Mo';
const ago = ts => fmtDur(Math.max(0, Date.now() - ts));
const tname = t => t.label || t.host;
const byId = id => S.targets.find(t => t.id === id);
const selTarget = () => byId(S.sel);
function alpha(hex, a) {
  let c = (hex || '#888').replace('#', '');
  if (c.length === 3) c = c.split('').map(x => x + x).join('');
  const n = parseInt(c, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
function toast(msg, kind) {
  const t = $('#toast'); t.textContent = msg; t.className = 'toast' + (kind ? ' ' + kind : ''); t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, 4500);
}
async function api(path, o = {}) {
  const r = await fetch(path, {
    method: o.method || 'GET', signal: o.signal,
    headers: o.body ? { 'Content-Type': 'application/json' } : undefined,
    body: o.body ? JSON.stringify(o.body) : undefined,
  });
  let data = null;
  try { data = await r.json(); } catch (e) { /* corps vide */ }
  if (!r.ok) {
    const err = new Error((data && data.error) || r.statusText);
    err.data = data; err.status = r.status;
    throw err;
  }
  return data;
}
const toLocalInput = ts => new Date(ts - new Date(ts).getTimezoneOffset() * 60000).toISOString().slice(0, 19);

function readTheme() {
  const cs = getComputedStyle(document.documentElement);
  const g = n => cs.getPropertyValue(n).trim();
  T = {
    surface: g('--surface-1'), text: g('--text-primary'), text2: g('--text-secondary'), muted: g('--text-muted'),
    grid: g('--grid'), axis: g('--axis'), crit: g('--critical'),
    series: [1, 2, 3, 4, 5, 6, 7, 8].map(i => g('--s' + i)),
    err: { 1: g('--e-timeout'), 2: g('--e-unreach'), 3: g('--e-ttl'), 4: g('--e-dns'), 5: g('--e-other') },
  };
  T.hatch = null;
}
const N_COLORS = 7;   // la 8e couleur (rouge) reste réservée aux échecs
const baseColor = t => T.series[(t.color || 0) % N_COLORS];
/* Couleur affichée : celle de la cible, sauf dans « Comparer » où chaque cible comparée a sa propre
   case, attribuée à l'ajout et gardée tant qu'elle reste comparée (retirer une cible ne repeint pas les autres) */
function cmpSlot(t) { return S.view === 'compare' && S.cmpColors[t.id] != null ? S.cmpColors[t.id] : null; }
const tcolor = t => { const s = cmpSlot(t); return s == null ? baseColor(t) : T.series[s % N_COLORS]; };
const tdash = t => { const s = cmpSlot(t); return s != null && s >= N_COLORS ? [7, 4] : []; };   // 8e comparée : pointillés
function syncCmpColors() {
  const keep = {};
  S.cmp.forEach(id => { if (S.cmpColors[id] != null) keep[id] = S.cmpColors[id]; });
  S.cmp.forEach(id => {
    if (keep[id] != null) return;
    const used = new Set(Object.values(keep)), t = byId(id), own = t ? (t.color || 0) % N_COLORS : 0;
    let slot = !used.has(own) ? own : [...Array(N_COLORS).keys()].find(k => !used.has(k));
    if (slot == null) slot = [...Array(MAX_CMP).keys()].find(k => !used.has(k + N_COLORS)) + N_COLORS;
    keep[id] = slot;
  });
  S.cmpColors = keep; ls.set('pm.cmpcolors', JSON.stringify(keep));
}
function hatch(ctx) {
  if (T.hatch) return T.hatch;
  const c = document.createElement('canvas'); c.width = c.height = 8;
  const x = c.getContext('2d');
  x.fillStyle = alpha(T.muted, 0.08); x.fillRect(0, 0, 8, 8);
  x.strokeStyle = alpha(T.muted, 0.35); x.lineWidth = 1;
  x.beginPath(); x.moveTo(-2, 10); x.lineTo(10, -2); x.moveTo(-2, 2); x.lineTo(2, -2); x.moveTo(6, 10); x.lineTo(10, 6); x.stroke();
  T.hatch = ctx.createPattern(c, 'repeat');
  return T.hatch;
}

/* Formes des échecs : canvas et SVG */
function shapePath(ctx, shape, x, y, s) {
  const r = s / 2;
  ctx.beginPath();
  if (shape === 'square') ctx.rect(x - r, y - r, s, s);
  else if (shape === 'triangle') { ctx.moveTo(x, y - r); ctx.lineTo(x + r, y + r); ctx.lineTo(x - r, y + r); ctx.closePath(); }
  else if (shape === 'diamond') { ctx.moveTo(x, y - r - 1); ctx.lineTo(x + r + 1, y); ctx.lineTo(x, y + r + 1); ctx.lineTo(x - r - 1, y); ctx.closePath(); }
  else if (shape === 'circle') ctx.arc(x, y, r, 0, 7);
}
function drawShape(ctx, code, x, y, s, color) {
  if (ERR[code].shape === 'cross') {
    const r = s / 2; ctx.strokeStyle = color; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(x - r, y - r); ctx.lineTo(x + r, y + r); ctx.moveTo(x + r, y - r); ctx.lineTo(x - r, y + r); ctx.stroke();
    return;
  }
  ctx.fillStyle = color; shapePath(ctx, ERR[code].shape, x, y, s); ctx.fill();
}
function errIcon(code) {
  const NS = 'http://www.w3.org/2000/svg', svg = document.createElementNS(NS, 'svg'), c = T.err[code];
  svg.setAttribute('width', '11'); svg.setAttribute('height', '11'); svg.setAttribute('viewBox', '0 0 12 12');
  svg.setAttribute('aria-hidden', 'true'); svg.style.flex = 'none'; svg.style.verticalAlign = '-1px';
  const el = (n, a) => { const e = document.createElementNS(NS, n); for (const k in a) e.setAttribute(k, a[k]); svg.append(e); };
  const shape = ERR[code].shape;
  if (shape === 'square') el('rect', { x: 1, y: 1, width: 10, height: 10, fill: c });
  else if (shape === 'triangle') el('path', { d: 'M6 0.5 L11.5 11 L0.5 11 Z', fill: c });
  else if (shape === 'diamond') el('path', { d: 'M6 0 L12 6 L6 12 L0 6 Z', fill: c });
  else if (shape === 'circle') el('circle', { cx: 6, cy: 6, r: 5.2, fill: c });
  else el('path', { d: 'M1.5 1.5 L10.5 10.5 M10.5 1.5 L1.5 10.5', stroke: c, 'stroke-width': 2.2 });
  return svg;
}

/* --------------------------------------------------- timeline commune */
const viewTargets = () => (S.view === 'compare' ? S.cmp.map(byId) : [selTarget()]).filter(Boolean);
function tEnd(t) {
  if (!t || t.state !== 'stopped') return Date.now();
  const last = t.recent.length ? t.recent[t.recent.length - 1][0] : null;
  return t.stopped_at || last || Date.now();
}
/* Fin de la timeline : maintenant, ou l'instant de l'arrêt si toutes les cibles affichées sont arrêtées */
function endTs() {
  const vt = viewTargets();
  if (!vt.length || vt.some(t => t.state !== 'stopped')) return Date.now();
  return Math.max(...vt.map(tEnd));
}
const allStopped = () => { const vt = viewTargets(); return vt.length > 0 && vt.every(t => t.state === 'stopped'); };
function updateView() { if (S.live) { S.to = endTs(); S.from = S.to - S.span; } }

/* ----------------------------------------------------------- targets */
async function loadTargets() {
  const list = await api('/api/targets');
  const before = new Map(viewTargets().map(t => [t.id, t.state]));
  for (const t of list) {
    const old = byId(t.id), last = t.recent[t.recent.length - 1];
    t.last = (old && old.last) || (last ? { ts: last[0], rtt: last[1], err: last[2] } : null);
    if (t.fail) { t.slowed = !!t.fail.slowed; t.fail.counts = Object.fromEntries(Object.entries(t.fail.counts).map(([k, v]) => [+k, v])); }
    else t.slowed = false;
    if (old && old.last && old.last.ts > (last ? last[0] : 0)) { t.fail = old.fail; t.slowed = old.slowed; }   // échantillons SSE plus récents
  }
  S.targets = list;
  S.cmp = S.cmp.filter(id => byId(id));
  syncCmpColors();
  if (!byId(S.sel)) {
    const saved = parseInt(ls.get('pm.sel'), 10);
    const first = list.find(t => t.state !== 'stopped') || list[0];
    S.sel = byId(saved) ? saved : (first ? first.id : null);
  }
  // passage en arrêt / relance d'une cible affichée : la fenêtre se recale sur sa nouvelle fin
  if (viewTargets().some(t => before.has(t.id) && before.get(t.id) !== t.state && (before.get(t.id) === 'stopped' || t.state === 'stopped'))) {
    S.live = true; updateView();
  }
  renderSiteList(); renderCards(); renderPanel(); scheduleLoad(0); updateBadge(); renderFoot();
}

/* État d'une cible : [classe, icône, libellé court, code d'échec, détail].
   Le libellé court va sur la carte et le badge ; le détail (types, ralentissement, routeur) au survol. */
function statusOf(t) {
  if (t.state === 'stopped') return ['pz', '■', 'Arrêtée', null, t.stopped_at ? 'depuis le ' + fmtFull.format(t.stopped_at) : ''];
  if (t.state === 'paused') return ['pz', '❚❚', 'En pause', null, 'reprendre pour relancer le ping'];
  if (!t.last) return ['pz', '…', 'En attente', null, 'premier ping en cours'];
  if (t.last.rtt != null) return ['ok', '●', 'En ligne', null, 'dernière latence ' + fmtMs(t.last.rtt) + ' ms'];
  /* Statut stable : tous les types vus depuis la dernière réponse, dans leur ordre d'apparition
     (sous Windows, un hôte éteint alterne souvent « timeout » et « injoignable ») */
  const f = t.fail, codes = f && f.order.length ? f.order : [errCode(t.last.err)];
  const short = (codes.every(c => c === 4) ? 'Nom introuvable' : 'Hors ligne') + (f ? ' · ' + fmtSince(Date.now() - f.since) : '');
  // le serveur dit si les pings sont réellement ralentis (jamais sur un échec DNS : aucun ping n'est envoyé)
  const i = S.info, detail = [codes.map(c => ERR[c].label).join(' / '),
    t.slowed && i && t.interval_ms < i.backoff_s * 1000 ? 'ping ralenti à ' + i.backoff_s + ' s' : null,
    t.last.src ? 'réponse de ' + t.last.src : null].filter(Boolean).join(' · ');
  return ['ko', null, short, codes[0], detail];
}
function fmtSince(ms) { return ms < 60e3 ? Math.max(1, Math.round(ms / 1000)) + ' s' : fmtDur(Math.floor(ms / 60e3) * 60e3); }
function trackFail(t, d) {
  t.slowed = !!d.slow;
  if (d.rtt != null) { t.fail = null; return; }
  const c = errCode(d.err), since = d.fs || d.ts;
  // nouvelle série côté serveur (après une veille, un redémarrage…) : on repart de zéro
  if (!t.fail || t.fail.since !== since) t.fail = { since, order: [], counts: {} };
  if (!t.fail.counts[c]) { t.fail.counts[c] = 0; t.fail.order.push(c); }
  t.fail.counts[c]++;
}
function statusNodes(t) {
  const [cls, ico, txt, code] = statusOf(t);
  return [code ? errIcon(code) : h('span', { class: cls, text: ico }), ' ' + txt];
}
function statusBadge(t, small) {
  const [cls, ico, txt, code, detail] = statusOf(t);
  return h('span', { class: 'badge-st ' + cls + (small ? ' sm' : ''), title: detail || null },
    code ? errIcon(code) : h('span', { class: 'ico', text: ico, 'aria-hidden': 'true' }), txt);
}
const failing = t => t.state === 'active' && t.last && t.last.rtt == null;
function hostLine(t, withHost) {
  const p = [];
  if (withHost) p.push(t.host);
  if (!t.is_ip) p.push(t.ip ? '→ ' + t.ip : '→ non résolu');
  return p.join(' ');
}

const btn = (text, fn, cls = 'ghost', title) => h('button', { class: cls, type: 'button', text, title,
  onclick: e => { e.preventDefault(); e.stopPropagation(); fn(); } });

/* ---------------------------------------------------- liste des cibles */
const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const matches = (t, q) => !q || norm([t.label, t.host, t.ip, t.site].join(' ')).includes(q);
let failSig = '';

function cardActions(t) {
  const acts = [];
  if (S.view === 'compare') {
    acts.push(S.cmp.includes(t.id) ? { label: 'Retirer de la comparaison', fn: () => cardClick(t.id) } : { label: 'Ajouter à la comparaison', fn: () => cardClick(t.id) });
    acts.push({ label: 'Ouvrir seule', fn: () => selectTarget(t.id) });
  } else acts.push({ label: 'Comparer…', fn: () => compareList([t.id]) });
  acts.push('-');
  if (t.state === 'stopped') {
    acts.push({ label: '▶ Relancer', fn: () => setState(t, 'active') });
  } else {
    acts.push(t.state === 'active' ? { label: '❚❚ Pause', fn: () => setState(t, 'paused') } : { label: '▶ Reprendre', fn: () => setState(t, 'active') });
    acts.push({ label: '■ Arrêter', fn: () => setState(t, 'stopped'), hint: 'historique conservé' });
  }
  acts.push({ label: 'Modifier…', fn: () => openEdit(t) });
  acts.push({ label: 'Copier l\'adresse', fn: () => copyText(t.host) });
  if (t.state === 'stopped') acts.push('-', { label: 'Supprimer…', fn: () => deleteTarget(t), danger: true });
  return acts;
}

function cardShell(t, cls, kids) {
  const cmp = S.view === 'compare', on = cmp ? S.cmp.includes(t.id) : t.id === S.sel;
  const el = h('div', { class: 'card ' + cls + (on ? (cmp ? ' cmp-on' : ' sel') : '') + (t.state !== 'active' ? ' off' : ''),
    'data-id': t.id, tabindex: 0, role: 'button', 'aria-pressed': cmp ? String(on) : null,
    'aria-label': (cmp ? 'Comparer ' : 'Afficher ') + tname(t) }, kids);
  el.style.setProperty('--c', tcolor(t));
  el.addEventListener('click', () => cardClick(t.id));
  el.addEventListener('contextmenu', e => { e.preventDefault(); openCardMenu(t, $('.more', el) || el, e); });
  el.addEventListener('keydown', e => {
    if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      if (S.reorderable) moveCard(t.id, e.key === 'ArrowUp' ? -1 : 1); else toast('Efface la recherche et les filtres pour réorganiser', 'info');
    } else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); cardClick(t.id); }
    else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) { e.preventDefault(); openCardMenu(t, $('.more', el) || el); }
  });
  if (S.reorderable) {
    el.draggable = true;
    el.addEventListener('dragstart', e => {
      closePops();
      DND = { kind: 'card', id: t.id, stopped: t.state === 'stopped' };
      e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(t.id));
      requestAnimationFrame(() => el.classList.add('dragging'));
    });
    el.addEventListener('dragend', endDrag);
  }
  return el;
}
const moreBtn = t => h('button', { class: 'more', type: 'button', text: '⋯', 'aria-label': 'Actions pour ' + tname(t), 'aria-haspopup': 'menu',
  onclick: e => { e.stopPropagation(); openCardMenu(t, e.currentTarget); } });

/* Ligne compacte (~44 px) : état, nom, mini-courbe, latence ; actions au survol (⋯) ou clic droit */
function cardCompact(t) {
  const sub = [t.label ? t.host : null, t.is_ip ? null : (t.ip || 'non résolu'), t.state === 'stopped' && t.site ? t.site : null].filter(Boolean).join(' · ');
  return cardShell(t, 'c', [
    h('span', { class: 'chk', 'aria-hidden': 'true' }),
    h('span', { class: 'dot', 'aria-hidden': 'true' }),
    h('div', { class: 'names' }, h('b', { text: tname(t) }), sub ? h('small', { text: sub }) : null),
    h('canvas', { class: 'spark', 'aria-hidden': 'true' }),
    h('div', { class: 'val' }),
    moreBtn(t)]);
}
/* Carte confortable (affichage d'avant) */
function cardFull(t) {
  const acts = t.state === 'stopped'
    ? [btn('Relancer', () => setState(t, 'active')), btn('Supprimer', () => deleteTarget(t), 'ghost danger')]
    : [btn(t.state === 'active' ? 'Pause' : 'Reprendre', () => setState(t, t.state === 'active' ? 'paused' : 'active')),
       btn('Arrêter', () => setState(t, 'stopped'), 'ghost', 'Arrêter le ping (historique conservé)')];
  return cardShell(t, 'full', [
    h('div', { class: 'row' },
      h('span', { class: 'chk', 'aria-hidden': 'true' }),
      h('div', { class: 'names' }, h('b', { text: tname(t) }),
        h('small', { text: hostLine(t, !!t.label) + (t.state === 'stopped' && t.site ? ' · ' + t.site : '') })),
      h('div', { class: 'val' })),
    h('canvas', { class: 'spark' }),
    h('div', { class: 'row foot' }, h('span', { class: 'status' }), h('span', { class: 'acts' }, acts, moreBtn(t)))]);
}
const card = t => S.density === 'comfort' ? cardFull(t) : cardCompact(t);

function siteGroup(site, list, opts = {}) {
  const key = opts.key || site;
  const nfail = list.filter(failing).length, active = list.filter(t => t.state === 'active'), paused = list.filter(t => t.state === 'paused');
  const gacts = [];
  if (!opts.fail) {
    gacts.push(btn('⇄', () => compareList(list.map(t => t.id)), 'ghost', 'Comparer ces cibles sur la même timeline'));
    if (active.length) gacts.push(btn('❚❚', () => groupState(active, 'paused'), 'ghost', 'Mettre en pause ces cibles'));
    if (paused.length) gacts.push(btn('▶', () => groupState(paused, 'active'), 'ghost', 'Reprendre ces cibles'));
    gacts.push(btn('■', () => {
      if (confirm('Arrêter les ' + list.length + ' cibles de « ' + (site || 'Sans site') + ' » ?')) groupState(list, 'stopped');
    }, 'ghost', 'Arrêter ces cibles'));
  } else gacts.push(btn('⇄', () => compareList(list.map(t => t.id)), 'ghost', 'Comparer les cibles en échec'));
  const det = h('details', { class: 'site' + (opts.fail ? ' failgrp' : ''), open: !S.closedSites.has(key), 'data-site': opts.fail ? null : site },
    h('summary', { draggable: S.reorderable && !opts.fail ? 'true' : null, title: S.reorderable && !opts.fail ? 'Glisser pour déplacer le site' : null },
      h('b', { text: opts.title || site || 'Sans site' }), h('span', { class: 'n', text: String(list.length) }),
      nfail && !opts.fail ? h('span', { class: 'bad', text: '✕ ' + nfail }) : null, h('span', { class: 'gacts' }, gacts)),
    list.map(card));
  det.addEventListener('toggle', () => {
    if (det.open) S.closedSites.delete(key); else S.closedSites.add(key);
    ls.set('pm.closed', JSON.stringify([...S.closedSites]));
  });
  if (S.reorderable && !opts.fail) {
    const sum = det.firstElementChild;
    sum.addEventListener('dragstart', e => {
      closePops();
      DND = { kind: 'site', site };
      e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', 'site:' + site);
      requestAnimationFrame(() => det.classList.add('dragging'));
    });
    sum.addEventListener('dragend', endDrag);
  }
  return det;
}

function groupBySite(list, out) {
  if (S.targets.some(t => t.site && t.state !== 'stopped')) {
    const groups = new Map();
    list.forEach(t => { if (!groups.has(t.site)) groups.set(t.site, []); groups.get(t.site).push(t); });
    [...groups.keys()].forEach(s => out.push(siteGroup(s, groups.get(s))));   // ordre choisi par l'utilisateur
  } else out.push(...list.map(card));
}

function renderCards() {
  document.body.classList.toggle('cmpmode', S.view === 'compare');
  document.body.classList.toggle('dense', S.density !== 'comfort');
  const q = norm(S.q.trim());
  const live = S.targets.filter(t => t.state !== 'stopped'), stopped = S.targets.filter(t => t.state === 'stopped');
  const nfail = live.filter(failing).length;
  $('#filt [data-f="all"] .cnt').textContent = S.targets.length ? String(S.targets.length) : '';
  $('#filt [data-f="fail"] .cnt').textContent = String(nfail);
  $('#filt [data-f="fail"]').classList.toggle('alert', nfail > 0);
  $$('#filt button').forEach(b => b.classList.toggle('on', b.dataset.f === S.filt));
  $('#failtop').setAttribute('aria-pressed', String(S.failTop)); $('#failtop').classList.toggle('on', S.failTop);
  // réorganiser n'a de sens que sur la liste complète, dans son ordre
  S.reorderable = !q && S.filt === 'all' && !S.failTop;
  let shown = live.filter(t => matches(t, q)), shownStopped = stopped.filter(t => matches(t, q));
  if (S.filt === 'fail') { shown = shown.filter(failing); shownStopped = []; }
  const kids = [];
  if (S.failTop && S.filt === 'all') {
    const f = shown.filter(failing);
    if (f.length) kids.push(siteGroup('', f, { fail: true, key: '__fail', title: 'En échec' }));
    shown = shown.filter(t => !failing(t));
  }
  groupBySite(shown, kids);
  if (shownStopped.length) {
    const det = h('details', { class: 'stopped', open: S.showStopped || !!q || shownStopped.some(t => t.id === S.sel && S.view === 'single') },
      h('summary', { text: 'Arrêtées (' + shownStopped.length + ')' }), shownStopped.map(card));
    det.addEventListener('toggle', () => { if (!q) { S.showStopped = det.open; ls.set('pm.stopped', det.open ? '1' : '0'); } });
    kids.push(det);
  }
  if (!kids.length && S.targets.length) {
    kids.push(h('div', { class: 'noresult' },
      h('p', { text: S.filt === 'fail' && !q ? 'Aucune cible en échec. 👍' : 'Aucune cible ne correspond' + (q ? ' à « ' + S.q.trim() + ' »' : '') + '.' }),
      (q || S.filt !== 'all') ? h('button', { class: 'ghost small', type: 'button', text: 'Effacer la recherche et les filtres', onclick: clearFilters }) : null));
  } else if (!live.length && stopped.length && !q && S.filt === 'all') kids.unshift(h('div', { class: 'muted small-empty', text: 'Aucune cible en cours.' }));
  $('#targets').replaceChildren(...kids);
  $('#targets').classList.toggle('noreorder', !S.reorderable);
  S.targets.forEach(updateCard);
  failSig = live.filter(failing).map(t => t.id).join(',');
}
function clearFilters() {
  S.q = ''; $('#q').value = ''; S.filt = 'all'; ls.set('pm.filt', 'all'); renderCards();
}
/* appelé à chaque série de mesures : la liste n'est reconstruite que si l'ensemble des cibles en échec change */
function refreshFailing() {
  const sig = S.targets.filter(failing).map(t => t.id).join(',');
  if (sig === failSig) return;
  if (S.filt === 'fail' || S.failTop) renderCards();
  else {
    failSig = sig;
    const n = sig ? sig.split(',').length : 0;
    $('#filt [data-f="fail"] .cnt').textContent = String(n);
    $('#filt [data-f="fail"]').classList.toggle('alert', n > 0);
    $$('#targets details.site').forEach(d => {
      const ids = $$('.card', d).map(c => +c.dataset.id), k = ids.filter(id => failing(byId(id) || {})).length;
      const sum = d.firstElementChild, old = $('.bad', sum);
      if (old) old.remove();
      if (k) sum.insertBefore(h('span', { class: 'bad', text: '✕ ' + k }), $('.gacts', sum));
    });
  }
}

/* ------------------------------------------------------------- menus */
let OPEN_POP = null;
function closePops() {
  if (!OPEN_POP) return;
  OPEN_POP.pop.hidden = true;
  if (OPEN_POP.anchor) OPEN_POP.anchor.setAttribute('aria-expanded', 'false');
  OPEN_POP = null;
}
function openPop(pop, anchor, at) {
  const same = OPEN_POP && OPEN_POP.pop === pop && OPEN_POP.anchor === anchor;
  closePops();
  if (same) return;
  pop.hidden = false;
  if (anchor) anchor.setAttribute('aria-expanded', 'true');
  const r = anchor.getBoundingClientRect(), pw = pop.offsetWidth, ph = pop.offsetHeight;
  let left = at ? at.clientX : r.right - pw, top = at ? at.clientY : r.bottom + 4;
  if (left + pw > innerWidth - 6) left = innerWidth - pw - 6;
  if (top + ph > innerHeight - 6) top = Math.max(6, (at ? at.clientY : r.top) - ph - 4);
  pop.style.left = Math.max(6, left) + 'px'; pop.style.top = top + 'px';
  OPEN_POP = { pop, anchor };
  const first = pop.querySelector('button:not([disabled]), input');
  if (first) first.focus({ preventScroll: true });
}
function openCardMenu(t, anchor, at) {
  const pop = $('#cardmenu');
  pop.replaceChildren(h('div', { class: 'mhead', text: tname(t) }), ...cardActions(t).map(a => a === '-' ? h('div', { class: 'msep' })
    : h('button', { role: 'menuitem', type: 'button', class: a.danger ? 'danger' : null, onclick: e => { e.stopPropagation(); closePops(); a.fn(); } },
      a.label, a.hint ? h('small', { text: a.hint }) : null)));
  openPop(pop, anchor, at);
}
function menuKeys(e) {
  if (!OPEN_POP) return;
  if (e.key === 'Escape') { const a = OPEN_POP.anchor; closePops(); if (a) a.focus(); e.stopPropagation(); return; }
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  const items = $$('button, input', OPEN_POP.pop), i = items.indexOf(document.activeElement);
  if (!items.length) return;
  e.preventDefault();
  items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus();
}
async function copyText(s) {
  try { await navigator.clipboard.writeText(s); toast('Copié : ' + s, 'info'); }
  catch (e) { toast('Copie impossible : ' + s); }
}

/* ------------------------------------------------------ réorganisation */
let DND = null;
function endDrag() {
  DND = null;
  $$('.dragging, .drop-before, .drop-after, .drop-into').forEach(x => x.classList.remove('dragging', 'drop-before', 'drop-after', 'drop-into'));
}
function clearMarks() { $$('.drop-before, .drop-after, .drop-into').forEach(x => x.classList.remove('drop-before', 'drop-after', 'drop-into')); }
/* Où lâcher ? Renvoie {el, where: 'before'|'after'|'into'} ou null */
function dropSpot(e) {
  const box = $('#targets');
  if (DND.kind === 'card') {
    const c = e.target.closest('.card');
    if (c && +c.dataset.id !== DND.id) {
      if (!!c.closest('details.stopped') !== DND.stopped) return null;
      const r = c.getBoundingClientRect();
      return { el: c, where: e.clientY < r.top + r.height / 2 ? 'before' : 'after' };
    }
    const g = e.target.closest('details.site');
    if (g && !DND.stopped) return { el: g, where: 'into' };
    return null;
  }
  const g = e.target.closest('details.site');
  if (!g || g.dataset.site === DND.site || !box.contains(g)) return null;
  const r = g.getBoundingClientRect();
  return { el: g, where: e.clientY < r.top + Math.min(r.height, 40) / 2 ? 'before' : 'after' };
}
function setupReorder() {
  const box = $('#targets');
  box.addEventListener('dragover', e => {
    if (!DND) return;
    const spot = dropSpot(e);
    clearMarks();
    if (!spot) return;
    e.preventDefault(); e.dataTransfer.dropEffect = 'move';
    spot.el.classList.add('drop-' + spot.where);
  });
  box.addEventListener('dragleave', e => { if (!box.contains(e.relatedTarget)) clearMarks(); });
  box.addEventListener('drop', e => {
    if (!DND) return;
    e.preventDefault();
    const spot = dropSpot(e), d = DND;
    endDrag();
    if (spot) applyDrop(d, spot);
  });
}
const domOrder = () => $$('#targets .card').map(c => +c.dataset.id);
function applyDrop(d, spot) {
  let ids = domOrder(), sites = {};
  if (d.kind === 'card') {
    ids = ids.filter(i => i !== d.id);
    let idx;
    if (spot.where === 'into') {
      const inGroup = $$('.card', spot.el).map(c => +c.dataset.id).filter(i => i !== d.id);
      idx = inGroup.length ? ids.indexOf(inGroup[inGroup.length - 1]) + 1 : ids.length;
    } else idx = ids.indexOf(+spot.el.dataset.id) + (spot.where === 'after' ? 1 : 0);
    ids.splice(idx, 0, d.id);
    const g = (spot.where === 'into' ? spot.el : spot.el.closest('details.site'));
    const t = byId(d.id);
    if (g && t && g.dataset.site !== t.site) sites[d.id] = g.dataset.site;
  } else {
    const groups = $$('#targets > details.site').map(g => ({ site: g.dataset.site, ids: $$('.card', g).map(c => +c.dataset.id) }));
    const moving = groups.find(g => g.site === d.site), rest = groups.filter(g => g.site !== d.site);
    const at = rest.findIndex(g => g.site === spot.el.dataset.site) + (spot.where === 'after' ? 1 : 0);
    rest.splice(at, 0, moving);
    const stopped = $$('#targets details.stopped .card').map(c => +c.dataset.id);
    ids = rest.flatMap(g => g.ids).concat(stopped);
  }
  saveOrder(ids, sites);
}
function moveCard(id, dir) {
  const el = $(`.card[data-id="${id}"]`); if (!el) return;
  const peers = $$('.card', el.parentElement).filter(c => c.parentElement === el.parentElement).map(c => +c.dataset.id);
  const i = peers.indexOf(id), j = i + dir;
  if (j < 0 || j >= peers.length) return;
  const ids = domOrder(), a = ids.indexOf(id), b = ids.indexOf(peers[j]);
  [ids[a], ids[b]] = [ids[b], ids[a]];
  saveOrder(ids, {}).then(() => { const n = $(`.card[data-id="${id}"]`); if (n) n.focus(); });
}
async function saveOrder(ids, sites) {
  // affichage immédiat, le serveur confirme ensuite
  const pos = new Map(ids.map((id, i) => [id, i]));
  S.targets.forEach(t => { if (pos.has(t.id)) t.position = pos.get(t.id); if (sites[t.id] != null) t.site = sites[t.id]; });
  S.targets.sort((a, b) => a.position - b.position);
  renderCards(); renderSiteList();
  try { await api('/api/targets/order', { method: 'POST', body: { ids, sites } }); }
  catch (e) { toast(e.message); loadTargets(); }
}

function renderSiteList() {
  const sites = [...new Set(S.targets.map(t => t.site).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'fr'));
  $('#sites').replaceChildren(...sites.map(s => h('option', { value: s })));
}

function updateCard(t) {
  const el = $(`.card[data-id="${t.id}"]`); if (!el) return;
  const ok = t.last && t.last.rtt != null, [cls, , txt, code] = statusOf(t);
  const chk = $('.chk', el); if (chk) chk.textContent = el.classList.contains('cmp-on') ? '✓' : '';
  el.title = tname(t) + ' — ' + txt + (statusOf(t)[4] ? ' (' + statusOf(t)[4] + ')' : '') + '\nping toutes les ' + fmtDur(t.interval_ms)
    + (S.reorderable ? '\nGlisser pour réorganiser · clic droit : actions' : '\nClic droit : actions');
  if (el.classList.contains('c')) {
    const dot = $('.dot', el);
    dot.className = 'dot ' + cls; dot.replaceChildren(...(code ? [errIcon(code)] : []));
    const v = $('.val', el);
    if (ok) v.replaceChildren(fmtMs(t.last.rtt), h('small', { text: ' ms' }));
    else if (t.state === 'active' && t.fail) v.replaceChildren(h('span', { class: 'bad', text: fmtSince(Date.now() - t.fail.since) }));
    else v.replaceChildren(h('span', { class: 'muted', text: t.state === 'paused' ? '❚❚' : t.state === 'stopped' ? '■' : '—' }));
  } else {
    $('.val', el).replaceChildren(ok ? fmtMs(t.last.rtt) : '—', h('small', { text: ok ? ' ms' : '' }));
    $('.status', el).replaceChildren(statusBadge(t, true));
  }
  drawSpark($('canvas', el), t);
}

function drawSpark(cv, t) {
  const W = cv.clientWidth, H = cv.clientHeight, dpr = devicePixelRatio || 1;
  if (!W) return;
  if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
  const ctx = cv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H);
  const pts = t.recent; if (!pts.length) return;
  const vals = pts.map(p => p[1]).filter(v => v != null);
  const max = Math.max(1, ...vals) * 1.1, n = 60;
  const X = i => 2 + (W - 4) * (i + (n - pts.length)) / (n - 1), Y = v => H - 3 - (H - 8) * (v / max);
  ctx.strokeStyle = tcolor(t); ctx.lineWidth = 1.5; ctx.lineJoin = 'round'; ctx.beginPath();
  let pen = false;
  pts.forEach((p, i) => { if (p[1] == null) { pen = false; return; } pen ? ctx.lineTo(X(i), Y(p[1])) : ctx.moveTo(X(i), Y(p[1])); pen = true; });
  ctx.stroke();
  pts.forEach((p, i) => { if (p[1] == null) { ctx.fillStyle = T.err[errCode(p[2])]; ctx.fillRect(X(i) - 1, H - 6, 2, 6); } });
}

async function setState(t, state) {
  try { await api('/api/targets/' + t.id, { method: 'PATCH', body: { state } }); } catch (e) { toast(e.message); }
}
async function groupState(list, state) {
  const res = await Promise.allSettled(list.map(t => api('/api/targets/' + t.id, { method: 'PATCH', body: { state } })));
  const bad = res.filter(r => r.status === 'rejected');
  if (bad.length) toast(bad.length + ' cible(s) non modifiée(s) : ' + bad[0].reason.message);
}
async function deleteTarget(t) {
  if (!confirm('Supprimer « ' + tname(t) + ' » avec tout son historique et ses tags ?\nCette action est définitive.')) return;
  try { await api('/api/targets/' + t.id, { method: 'DELETE' }); $('#tgtdlg').close(); } catch (e) { toast(e.message); }
}

function cardClick(id) {
  if (S.view === 'compare') {
    const i = S.cmp.indexOf(id);
    if (i >= 0) S.cmp.splice(i, 1);
    else if (S.cmp.length >= MAX_CMP) { toast(MAX_CMP + ' cibles au maximum dans la comparaison'); return; }
    else S.cmp.push(id);
    ls.set('pm.cmp', JSON.stringify(S.cmp)); syncCmpColors();
    updateView();
    renderCards(); renderPanel(); scheduleLoad(0);
  } else selectTarget(id);
}
function selectTarget(id) {
  if (id === S.sel && S.view === 'single') return;
  S.sel = id; ls.set('pm.sel', id);
  if (S.view !== 'single') setView('single', false);
  renderCards(); renderPanel(); scheduleLoad(0);
}
function compareList(ids) {
  S.cmp = ids.slice(0, MAX_CMP); ls.set('pm.cmp', JSON.stringify(S.cmp)); syncCmpColors();
  if (ids.length > MAX_CMP) toast('Comparaison limitée aux ' + MAX_CMP + ' premières cibles', 'info');
  setView('compare');
}
function setView(v, render = true) {
  S.view = v; ls.set('pm.view', v);
  if (v === 'compare' && !S.cmp.length && S.sel) { S.cmp = [S.sel]; ls.set('pm.cmp', JSON.stringify(S.cmp)); }
  syncCmpColors();
  $$('#views button').forEach(b => b.classList.toggle('on', b.dataset.view === v));
  S.live = true; updateView();
  if (render) { renderCards(); renderPanel(); scheduleLoad(0); }
}

/* ------------------------------------------------------------ charts */
function makeChart(tid, cv, margins) {
  return { tid, cv, M: margins, data: { bucket: 0, rows: [] }, loaded: false, tags: [], gaps: [], stats: null,
    geo: null, hits: [], ctl: null, lastLoad: 0, lastStats: 0, lastTags: 0 };
}
function syncCharts() {
  const ids = S.view === 'compare' ? S.cmp.filter(byId) : (S.sel ? [S.sel] : []);
  const key = S.view + ':' + ids.join(',');
  if (key === chartsKey) return false;
  chartsKey = key;
  CHARTS.forEach(ch => ch.ctl && ch.ctl.abort());
  if (S.view === 'single') {
    CHARTS = ids.map(id => makeChart(id, $('#chart'), M_FULL));
  } else {
    CHARTS = ids.map((id, i) => {
      const last = i === ids.length - 1;
      return makeChart(id, h('canvas', { class: 'cchart' + (last ? ' last' : ''), role: 'img', 'aria-label': 'Latence' }), last ? M_CMP_LAST : M_CMP);
    });
    $('#cmplist').replaceChildren(...CHARTS.map(ch => h('div', { class: 'cblock', 'data-id': ch.tid }, h('div', { class: 'chead' }), ch.cv)));
  }
  CHARTS.forEach(ch => { ch.cv._ch = ch; wireCanvas(ch.cv); });
  return true;
}
const mainChart = () => CHARTS[0];

/* -------------------------------------------------------- main panel */
function renderPanel() {
  const any = S.targets.length > 0;
  $('#empty').hidden = any; $('#panel').hidden = !any;
  if (!any) { CHARTS = []; chartsKey = ''; return; }
  $('#single').hidden = S.view !== 'single'; $('#compare').hidden = S.view !== 'compare';
  $('#tblchk').hidden = S.view !== 'single';
  $$('#views button').forEach(b => b.classList.toggle('on', b.dataset.view === S.view));
  syncCharts();
  renderPresets();
  if (S.view === 'single') renderSingle(); else renderCompare();
  scheduleDraw();
}

function renderSingle() {
  const t = selTarget(); if (!t) return;
  const title = $('#ctitle');
  if (title) { title.textContent = tname(t); title.style.borderBottom = '3px solid ' + tcolor(t); }
  renderStatus();
  const meta = [];
  if (t.label) meta.push(t.host);
  if (!t.is_ip) meta.push(t.ip ? '→ ' + t.ip + (t.ip_checked ? ' (vérifiée il y a ' + ago(t.ip_checked) + ')' : '') : '→ nom non résolu');
  if (t.site) meta.push('site ' + t.site);
  if (t.state === 'stopped') meta.push('arrêtée le ' + fmtFull.format(tEnd(t)));
  meta.push('ping toutes les ' + fmtDur(t.interval_ms), 'timeout ' + t.timeout_ms + ' ms',
    t.outage_n ? 'coupure après ' + t.outage_n + ' pertes' : 'détection de coupure désactivée');
  $('#cmeta').textContent = meta.join(' · ');
  $('#pp').hidden = t.state === 'stopped';
  $('#pp').textContent = t.state === 'active' ? 'Pause' : 'Reprendre';
  $('#stop').textContent = t.state === 'stopped' ? 'Relancer' : 'Arrêter';
  const ch = mainChart();
  renderLegend(ch, $('#legend')); renderStats(ch); renderTagList(ch ? ch.tags : [], $('#taglist'), $('#tagcount')); renderTable(ch);
}
function renderStatus() {
  const t = selTarget(); if (!t || S.view !== 'single') return;
  const [cls, ico, txt, code, detail] = statusOf(t), b = $('#cstatus');
  b.className = 'badge-st ' + cls;
  b.replaceChildren(code ? errIcon(code) : h('span', { class: 'ico', text: ico, 'aria-hidden': 'true' }), txt);
  $('#cdetail').textContent = cls === 'ko' ? detail : '';
}

function legendItems(charts, withLine) {
  const items = [];
  if (withLine) {
    const ch = charts[0], t = ch && byId(ch.tid);
    if (t) items.push(h('span', {}, h('i', { class: 'ln', style: 'border-color:' + tcolor(t) }), 'Latence ' + (ch.data.bucket ? '(moyenne)' : '(ms)')));
    if (ch && ch.data.bucket) items.push(h('span', {}, h('i', { class: 'bd', style: 'background:' + tcolor(t) }), 'Min – max (résolution ' + fmtDur(ch.data.bucket) + ')'));
  }
  ERR_CODES.forEach(c => { if (charts.some(ch => ch.stats && ch.stats.errors[ERR[c].key])) items.push(h('span', {}, errIcon(c), ' ' + ERR[c].label)); });
  if (charts.some(ch => ch.gaps.length)) items.push(h('span', {}, h('i', { class: 'gp' }), 'Non surveillé'));
  return items;
}
function renderLegend(ch, box) { box.replaceChildren(...(ch ? legendItems([ch], true) : [])); }

function renderPresets() {
  const box = $('#presets');
  if (!box.children.length) {
    PRESETS.forEach(([label, v]) => box.append(h('button', { text: label, 'data-v': v, onclick: () => { S.span = v; S.live = true; updateView(); renderPresets(); scheduleLoad(0); scheduleDraw(); } })));
  }
  const span = S.to - S.from, near = v => Math.abs(v - span) <= v * 0.02;
  [...box.children].forEach(b => b.classList.toggle('on', near(+b.dataset.v)));
  // durée toujours visible ; plage horaire exacte quand on n'est plus en direct
  const sel = $('#presets-sel');
  if (!sel.options.length) sel.append(h('option', { value: '', text: 'Personnalisée' }), ...PRESETS.map(([l, v]) => h('option', { value: v, text: l })));
  const m = PRESETS.find(p => near(p[1]));
  sel.value = m ? String(m[1]) : '';
  const lbl = $('#span'), custom = !m;
  lbl.textContent = S.live ? (custom ? 'Fenêtre : ' + fmtDur(span) : '')
    : fmtDMHM.format(S.from) + ' → ' + (new Date(S.from).toDateString() === new Date(S.to).toDateString() ? fmtHM.format(S.to) : fmtDMHM.format(S.to)) + ' (' + fmtDur(span) + ')';
  lbl.hidden = !lbl.textContent;
  const stopped = allStopped();
  $('#live').classList.toggle('on', S.live);
  $('#live').textContent = stopped ? (S.live ? '■ Fin' : '▶ Fin') : (S.live ? '● Direct' : '▶ Direct');
  $('#live').title = stopped ? 'Revenir au moment de l\'arrêt (L)' : 'Revenir au direct (L)';
}

/* ------------------------------------------------------- vue Comparer */
function renderCompare() {
  const none = !CHARTS.length;
  $('#cmpempty').hidden = !none;
  $$('#compare .sect, #cmptable, #cmptags, #cmplegend').forEach(e => { e.hidden = none; });
  CHARTS.forEach(ch => renderCmpHead(ch));
  $('#cmplegend').replaceChildren(...legendItems(CHARTS, false));
  renderCmpTable();
  const tags = [], seen = new Set();
  CHARTS.forEach(ch => ch.tags.forEach(g => { if (!seen.has(g.id)) { seen.add(g.id); tags.push(g); } }));
  tags.sort((a, b) => a.ts - b.ts);
  renderTagList(tags, $('#cmptags'), $('#cmptagcount'));
}
function renderCmpHead(ch) {
  const t = byId(ch.tid), box = $(`.cblock[data-id="${ch.tid}"]`); if (!t || !box) return;
  box.style.setProperty('--c', tcolor(t));
  const s = ch.stats, sub = [t.label ? t.host : null, t.site || null].filter(Boolean).join(' · ');
  const st = s && s.n ? [h('span', { text: (s.availability != null ? 'dispo ' + fmtAvail(s.availability) + ' · ' : '') + 'p95 ' + fmtMs(s.p95) + ' ms · perte ' }),
    h('span', { class: s.lost ? 'bad' : '', text: fmtPct(s.loss_pct) }), s.outages ? h('span', { class: 'bad', text: ' · ' + s.outages + ' coupure' + (s.outages > 1 ? 's' : '') }) : null] : [];
  $('.chead', box).replaceChildren(
    h('b', { text: tname(t), title: 'Ouvrir cette cible', onclick: () => selectTarget(t.id) }),
    sub ? h('small', { text: sub }) : null,
    statusBadge(t, true),
    h('span', { class: 'cstats' }, st),
    btn('✕', () => cardClick(t.id), 'ghost small', 'Retirer de la comparaison'));
}
function renderCmpTable() {
  const cols = ['Cible', 'Site', 'Dispo', 'Moy', 'Médiane', 'p95', 'Max', 'Gigue', 'Perte', 'Coupures', 'Plus longue', 'Non surveillé'];
  $('#cmptable').replaceChildren(h('table', {},
    h('thead', {}, h('tr', {}, cols.map((c, i) => h('th', { class: i < 2 ? 'l' : null, text: c })))),
    h('tbody', {}, CHARTS.map(ch => {
      const t = byId(ch.tid), s = ch.stats || {};
      if (!t) return null;
      const td = (v, cls) => h('td', { class: cls, text: v });
      return h('tr', { class: 'clk', title: 'Ouvrir cette cible', onclick: () => selectTarget(t.id) },
        h('td', { class: 'l' }, h('span', { class: 'key', style: 'border-color:' + tcolor(t) + (tdash(t).length ? ';border-top-style:dashed' : '') }), tname(t)),
        td(t.site || '—', 'l'), td(s.availability != null ? fmtAvail(s.availability) : '—', s.downtime_ms ? 'err' : null), td(fmtMs(s.avg)), td((s.approx ? '≈ ' : '') + fmtMs(s.median)), td((s.approx ? '≈ ' : '') + fmtMs(s.p95)), td(fmtMs(s.max)), td(fmtMs(s.jitter)),
        td(s.n ? fmtPct(s.loss_pct) : '—', s.lost ? 'err' : null), td(s.n ? String(s.outages) : '—'),
        td(s.outages ? fmtDur(s.longest_outage_ms) : '—'), td(s.unmonitored_ms ? fmtDur(s.unmonitored_ms) : '—'));
    }))));
}

/* ------------------------------------------------------- data loading */
let loadTimer = null;
function scheduleLoad(delay = 120) { clearTimeout(loadTimer); loadTimer = setTimeout(loadAll, delay); }
function loadAll() { CHARTS.forEach(ch => { loadData(ch); loadStats(ch); loadTags(ch); }); renderPresets(); }
const isCurrent = ch => CHARTS.includes(ch);

async function loadData(ch) {
  if (ch.ctl) ch.ctl.abort();
  ch.ctl = new AbortController();
  const maxpts = Math.max(200, Math.floor((ch.cv.clientWidth - ch.M.l - ch.M.r) / 2));
  const span = S.to - S.from, pad = span * 0.02;
  const q = new URLSearchParams({ target: ch.tid, from: Math.floor(S.from - pad), to: Math.ceil(S.to + pad + 1000), max: maxpts });
  ch.maxpts = maxpts; ch.lastLoad = Date.now();
  if (S.view === 'single') $('#chartwrap').classList.add('loading');
  try {
    const d = await api('/api/samples?' + q, { signal: ch.ctl.signal });
    if (!isCurrent(ch)) return;
    ch.data = d; ch.loaded = true;
  } catch (e) { if (e.name !== 'AbortError') toast(e.message); return; }
  finally { if (S.view === 'single') $('#chartwrap').classList.remove('loading'); }
  if (S.view === 'single') { renderLegend(ch, $('#legend')); renderTable(ch); }
  drawChart(ch);
}

async function loadStats(ch) {
  ch.lastStats = Date.now();
  try {
    const s = await api('/api/stats?' + new URLSearchParams({ target: ch.tid, from: Math.floor(S.from), to: Math.ceil(S.to) }));
    if (!isCurrent(ch)) return;
    ch.stats = s;
    if (S.view === 'single') { renderStats(ch); renderLegend(ch, $('#legend')); }
    else { renderCmpHead(ch); renderCmpTable(); $('#cmplegend').replaceChildren(...legendItems(CHARTS, false)); }
  } catch (e) { /* se rafraîchit au tour suivant */ }
}

async function loadTags(ch) {
  ch.lastTags = Date.now();
  const q = new URLSearchParams({ target: ch.tid, from: Math.floor(S.from), to: Math.ceil(S.to) });
  try {
    const [tags, gaps] = await Promise.all([api('/api/tags?' + q), api('/api/gaps?' + q)]);
    if (!isCurrent(ch)) return;
    ch.tags = tags; ch.gaps = gaps;
    if (S.view === 'single') { renderTagList(tags, $('#taglist'), $('#tagcount')); renderLegend(ch, $('#legend')); }
    else renderCompare();
    drawChart(ch);
  } catch (e) { /* ignore */ }
}
const reloadTags = () => CHARTS.forEach(loadTags);

async function loadInfo() {
  try { S.info = await api('/api/info'); renderFoot(); } catch (e) { /* ignore */ }
}

/* ------------------------------------------------------------- stats */
/* rafraîchissement des stats : 3 s sur 15 min, jusqu'à 60 s sur 7 jours (inutile de recalculer plus souvent) */
const statsEvery = () => clamp((S.to - S.from) / 100, 3000, 60000);
const fmtAvail = v => v == null ? '—' : (v >= 100 ? '100' : v >= 99 ? v.toFixed(2) : v.toFixed(1)).replace('.', ',') + ' %';
function renderStats(ch) {
  const s = ch && ch.stats, box = $('#stats'), kp = $('#kpis');
  if (!s || !s.n) {
    kp.replaceChildren(h('div', { class: 'muted nodata', text: s ? 'Aucune mesure dans cette fenêtre.' : '' }));
    box.replaceChildren(); $('#morestats').hidden = true; return;
  }
  $('#morestats').hidden = false;
  const ax = s.approx ? '≈ ' : '';
  const kpi = (l, v, unit, sub, bad, title) => h('div', { class: 'kpi' + (bad ? ' bad' : ''), title },
    h('div', { class: 'l', text: l }), h('div', { class: 'v' }, v, unit && !/—/.test(v) ? h('small', { text: ' ' + unit }) : null), h('div', { class: 's', text: sub || '' }));
  const t = byId(ch.tid), rule = t && t.outage_n > 0 ? t.outage_n : 3;
  kp.replaceChildren(
    kpi('Disponibilité', s.availability != null ? fmtAvail(s.availability).replace(' %', '') : '—', s.availability != null ? '%' : '',
      s.monitored_ms ? (s.downtime_ms ? 'indisponible ' + fmtDur(s.downtime_ms) + ' sur ' : 'sur ') + fmtDur(s.monitored_ms) + ' surveillées' : '',
      s.downtime_ms > 0, 'Temps sans coupure (≥ ' + rule + ' pertes consécutives) rapporté au temps réellement surveillé, hors pauses, arrêts et veille'),
    kpi('Perte', fmtPct(s.loss_pct).replace(' %', ''), '%', s.lost + ' sur ' + s.n.toLocaleString('fr-FR') + ' pings', s.lost > 0),
    kpi('Latence p95', s.p95 == null ? '—' : ax + fmtMs(s.p95), 'ms', s.avg == null ? 'aucune réponse' : 'moyenne ' + fmtMs(s.avg) + ' ms' + (s.approx ? ' · p95 approché à ±10 %' : ''), false,
      '95 % des pings ont répondu en moins de ce temps'),
    kpi('Coupures', String(s.outages), '', s.outages ? 'plus longue ' + fmtDur(s.longest_outage_ms) : 'aucune coupure de ' + rule + ' pertes ou plus',
      s.outages > 0, 'Au moins ' + rule + ' pertes consécutives (réglable par cible dans « Modifier »)'));
  const tile = (l, v, unit, sub, bad) => h('div', { class: 'tile' + (bad ? ' bad' : '') },
    h('div', { class: 'l', text: l }), h('div', { class: 'v' }, v, unit && !/—/.test(v) ? h('small', { text: ' ' + unit }) : null), sub ? h('div', { class: 's', text: sub }) : null);
  const isolated = Math.max(0, (s.loss_runs || 0) - s.outages);
  const tiles = [
    tile('Moyenne', fmtMs(s.avg), 'ms'), tile('Médiane', ax + fmtMs(s.median), 'ms', s.approx ? 'approchée à ±10 %' : null),
    tile('Min', fmtMs(s.min), 'ms'), tile('Max', fmtMs(s.max), 'ms'),
    tile('p99', ax + fmtMs(s.p99), 'ms', s.approx ? 'approché à ±10 %' : null),
    tile('Gigue', fmtMs(s.jitter), 'ms', 'écart moyen entre 2 pings'), tile('Écart-type', fmtMs(s.stddev), 'ms'),
    tile('Pertes isolées', String(isolated), '', 'séries de moins de ' + rule + ' pertes'),
    tile('Non surveillé', s.unmonitored_ms ? fmtDur(s.unmonitored_ms) : '—', '', 'pause, arrêt, veille… (hors stats)'),
  ];
  if (s.lost) {
    tiles.push(h('div', { class: 'tile wide' }, h('div', { class: 'l', text: 'Détail des échecs' }),
      h('div', { class: 'errs' }, ERR_CODES.filter(c => s.errors[ERR[c].key]).map(c =>
        h('span', {}, errIcon(c), h('b', { text: String(s.errors[ERR[c].key]) }), ERR[c].label)))));
  }
  box.replaceChildren(...tiles);
}

/* -------------------------------------------------------------- tags */
const tagEnd = g => g.ts_end != null ? g.ts_end : (g.kind === 'outage' ? Date.now() : null);
const whenText = g => {
  const e = tagEnd(g);
  return e != null ? fmtFull.format(g.ts) + ' → ' + (g.ts_end == null ? 'en cours' : fmtFull.format(e)) : fmtFull.format(g.ts);
};
function renderTagList(tags, ul, count) {
  count.textContent = tags.length ? '(' + tags.length + ')' : '';
  if (!tags.length) { ul.replaceChildren(h('li', { class: 'muted', style: 'cursor:default;border-style:dashed' }, 'Aucun tag ici. Passe en mode « Tagger » (T) ou double-clique sur le graph.')); return; }
  ul.replaceChildren(...tags.map(g => {
    const t = g.target_id != null ? byId(g.target_id) : null;
    return h('li', { tabindex: 0, onclick: () => openTag(g), onkeydown: e => { if (e.key === 'Enter') openTag(g); } },
      h('span', { class: 'chip', style: 'background:' + T.series[g.color % 8] }),
      h('b', { text: g.label }),
      h('span', { class: 'when', text: whenText(g) }),
      g.note ? h('span', { class: 'note', text: g.note }) : null,
      h('span', { class: 'spacer' }),
      S.view === 'compare' && t ? h('span', { class: 'badge', text: tname(t) }) : null,
      g.auto ? h('span', { class: 'badge auto', text: g.kind === 'outage' ? 'coupure auto' : 'auto' }) : null,
      g.target_id == null ? h('span', { class: 'badge', text: 'Toutes les cibles' }) : null);
  }));
}

function buildTagDialog() {
  const box = $('#t-colors');
  COLOR_NAMES.forEach((n, i) => box.append(h('label', { title: n },
    h('input', { type: 'radio', name: 'tc', value: i, 'aria-label': n }), h('span', { style: '--c:var(--s' + (i + 1) + ')' }))));
  $('#t-range').addEventListener('change', syncRange);
  $('#t-cancel').addEventListener('click', () => $('#tagdlg').close());
  $('#t-del').addEventListener('click', async () => {
    if (!S.editTag || !confirm('Supprimer ce tag ?')) return;
    try { await api('/api/tags/' + S.editTag.id, { method: 'DELETE' }); $('#tagdlg').close(); reloadTags(); } catch (e) { toast(e.message); }
  });
  $('#tagform').addEventListener('submit', async e => {
    e.preventDefault();
    const start = new Date($('#t-start').value).getTime();
    const end = $('#t-range').checked && $('#t-end').value ? new Date($('#t-end').value).getTime() : null;
    if (isNaN(start)) { toast('Date de début invalide'); return; }
    const scope = $('#t-scope').value;
    const body = {
      label: $('#t-label').value, note: $('#t-note').value,
      color: +(document.querySelector('input[name=tc]:checked') || { value: 1 }).value,
      ts: start, ts_end: end, target_id: scope === 'all' ? null : +scope,
    };
    try {
      if (S.editTag) await api('/api/tags/' + S.editTag.id, { method: 'PATCH', body });
      else await api('/api/tags', { method: 'POST', body });
      $('#tagdlg').close(); reloadTags();
    } catch (err) { toast(err.message); }
  });
}
function syncRange() { $('#t-endrow').hidden = !$('#t-range').checked; }

function openTag(tag, preset) {
  S.editTag = tag || null;
  const p = tag || preset || { ts: Date.now() };
  $('#tagtitle').textContent = tag ? (tag.auto ? 'Tag automatique' : 'Modifier le tag') : 'Nouveau tag';
  $('#t-label').value = tag ? tag.label : '';
  $('#t-note').value = tag ? tag.note : '';
  const col = tag ? tag.color : 1;
  $$('input[name=tc]').forEach(r => { r.checked = +r.value === col; });
  const sc = $('#t-scope');
  sc.replaceChildren(...S.targets.map(t => h('option', { value: t.id, text: 'Cible : ' + tname(t) + (t.site ? ' (' + t.site + ')' : '') + (t.state === 'stopped' ? ' · arrêtée' : '') })),
    h('option', { value: 'all', text: 'Toutes les cibles' }));
  sc.value = tag ? (tag.target_id == null ? 'all' : String(tag.target_id)) : String((preset && preset.target) || S.sel);
  const end = tag ? tag.ts_end : p.ts_end;
  $('#t-range').checked = end != null || (tag && tag.kind === 'outage');
  $('#t-start').value = toLocalInput(p.ts);
  $('#t-end').value = end != null ? toLocalInput(end) : '';
  syncRange();
  $('#t-del').hidden = !tag;
  $('#tagdlg').showModal();
  $('#t-label').focus();
}

/* ------------------------------------------------------ target dialog */
function buildTargetDialog() {
  const sw = $('#g-colors');
  COLOR_NAMES.slice(0, N_COLORS).forEach((n, i) => sw.append(h('label', { title: n },
    h('input', { type: 'radio', name: 'gc', value: i, 'aria-label': n }), h('span', { style: '--c:var(--s' + (i + 1) + ')' }))));
  $('#g-cancel').addEventListener('click', () => $('#tgtdlg').close());
  $('#g-del').addEventListener('click', () => { if (S.editTarget) deleteTarget(S.editTarget); });
  $('#tgtform').addEventListener('submit', async e => {
    e.preventDefault();
    try {
      await api('/api/targets/' + S.editTarget.id, { method: 'PATCH', body: {
        label: $('#g-label').value, site: $('#g-site').value, outage_n: +$('#g-out').value,
        color: +(document.querySelector('input[name=gc]:checked') || { value: S.editTarget.color }).value,
        interval_ms: Math.round(parseFloat($('#g-int').value) * 1000), timeout_ms: +$('#g-to').value } });
      $('#tgtdlg').close();
    } catch (err) { toast(err.message); }
  });
  $('#edit').addEventListener('click', () => { const t = selTarget(); if (t) openEdit(t); });
  $('#ctitle').addEventListener('click', startRename);
  $('#pp').addEventListener('click', () => { const t = selTarget(); if (t) setState(t, t.state === 'active' ? 'paused' : 'active'); });
  $('#stop').addEventListener('click', () => { const t = selTarget(); if (t) setState(t, t.state === 'stopped' ? 'active' : 'stopped'); });
}
function openEdit(t) {
    S.editTarget = t;
    $('#g-title').textContent = t.host;
    $('#g-ip').textContent = t.is_ip ? '' : (t.ip ? 'IP résolue : ' + t.ip : 'Nom non résolu pour l\'instant');
    $('#g-label').value = t.label; $('#g-site').value = t.site || '';
    $('#g-int').value = t.interval_ms / 1000; $('#g-to').value = t.timeout_ms; $('#g-out').value = t.outage_n;
    $$('input[name=gc]').forEach(r => { r.checked = +r.value === (t.color || 0) % N_COLORS; });
    $('#tgtdlg').showModal();
}

function startRename() {
  const t = selTarget(), h1 = $('#ctitle'); if (!t || !h1) return;
  const inp = h('input', { class: 'rename', value: t.label, placeholder: 'Nom : switch… (vide = ' + t.host + ')', maxlength: 60, 'aria-label': 'Nom de la cible' });
  h1.replaceWith(inp); inp.focus(); inp.select();
  let done = false;
  const finish = async save => {
    if (done) return; done = true;
    inp.replaceWith(h1);
    const v = inp.value.trim();
    if (save && v !== t.label) {
      try { await api('/api/targets/' + t.id, { method: 'PATCH', body: { label: v } }); } catch (e) { toast(e.message); }
    }
  };
  inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); finish(true); } else if (e.key === 'Escape') finish(false); });
  inp.addEventListener('blur', () => finish(true));
}

/* ---------------------------------------------------- fenêtre Ajouter */
let BULK_PREVIEW = () => {};
function addTab(which) {
  const one = which === 'one';
  $('#tab-one').setAttribute('aria-selected', String(one)); $('#tab-list').setAttribute('aria-selected', String(!one));
  $('#addform').hidden = !one; $('#bulkform').hidden = one;
  ls.set('pm.addtab', which);
  if (one) $('#a-host').focus(); else { $('#b-result').hidden = true; $('#b-ok').disabled = false; BULK_PREVIEW(); $('#b-text').focus(); }
}
function openAdd(which) {
  closePops();
  const dlg = $('#adddlg');
  const v = S.settings && S.settings.values;
  if (v && !dlg.open) {
    if (!$('#a-host').value) { $('#a-int').value = v.def_interval_ms / 1000; $('#a-to').value = v.def_timeout_ms; }
    if (!$('#b-text').value) { $('#b-int').value = v.def_interval_ms / 1000; $('#b-to').value = v.def_timeout_ms; }
  }
  if (!dlg.open) dlg.showModal();
  addTab(which || ls.get('pm.addtab') || 'one');
}
function buildAddDialog() {
  const dlg = $('#adddlg');
  $('#tab-one').addEventListener('click', () => addTab('one'));
  $('#tab-list').addEventListener('click', () => addTab('list'));
  $('.tabs', dlg).addEventListener('keydown', e => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); const next = $('#addform').hidden ? 'one' : 'list'; addTab(next); $(next === 'one' ? '#tab-one' : '#tab-list').focus(); }
  });
  $$('[data-close]', dlg).forEach(b => b.addEventListener('click', () => dlg.close()));
  $('#add').addEventListener('click', () => openAdd());
  $('#addform').addEventListener('submit', async e => {
    e.preventDefault();
    try {
      const t = await api('/api/targets', { method: 'POST', body: {
        host: $('#a-host').value.trim(), label: $('#a-label').value.trim(), site: $('#a-site').value.trim(),
        interval_ms: Math.round(parseFloat($('#a-int').value || '1') * 1000), timeout_ms: +$('#a-to').value || 2000 } });
      $('#a-host').value = ''; $('#a-label').value = '';
      if (t.reactivated) toast('Cible déjà connue : relancée avec son historique', 'info');
      else if (t.updated) toast(t.host + ' déjà surveillée : ' + t.updated.map(k => k === 'label' ? 'nom' : 'site').join(' et ') + ' mis à jour', 'info');
      else toast(tname(t) + ' ajoutée', 'info');
      if (S.view === 'compare') { if (!S.cmp.includes(t.id) && S.cmp.length < MAX_CMP) S.cmp.push(t.id); ls.set('pm.cmp', JSON.stringify(S.cmp)); }
      else { ls.set('pm.sel', t.id); S.sel = t.id; }
      if ($('#a-keep').checked) $('#a-host').focus(); else dlg.close();
      await loadTargets();
    } catch (err) {
      toast(err.message);
      if (err.data && err.data.id) { dlg.close(); selectTarget(err.data.id); }
    }
  });
}

/* -------------------------------------------------------- ajout en lot */
function parseLines(txt) {
  return txt.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#')).map(l => {
    let p;
    if (/[;\t,]/.test(l)) p = l.split(/\s*[;\t,]\s*/);
    else { const m = l.match(/^(\S+)\s*(.*)$/); p = [m[1], m[2]]; }
    return { host: (p[0] || '').trim(), label: (p[1] || '').trim(), site: (p[2] || '').trim() };
  }).filter(it => it.host);
}
function buildBulkDialog() {
  const dlg = $('#adddlg');
  const preview = () => {
    const items = parseLines($('#b-text').value), sites = new Set(items.map(i => i.site || $('#b-site').value.trim()).filter(Boolean));
    $('#b-preview').textContent = items.length ? items.length + ' cible(s)' + (sites.size ? ' · site(s) : ' + [...sites].join(', ') : ' · sans site') : '';
  };
  BULK_PREVIEW = preview;
  $('#b-text').addEventListener('input', preview); $('#b-site').addEventListener('input', preview);
  $('#bulkform').addEventListener('submit', async e => {
    e.preventDefault();
    const items = parseLines($('#b-text').value);
    if (!items.length) { toast('Aucune ligne exploitable'); return; }
    $('#b-ok').disabled = true;
    try {
      const r = await api('/api/targets/bulk', { method: 'POST', body: { items, site: $('#b-site').value.trim(),
        interval_ms: Math.round(parseFloat($('#b-int').value || '1') * 1000), timeout_ms: +$('#b-to').value || 2000 } });
      const box = $('#b-result');
      box.replaceChildren(h('div', { text: r.created.length + ' ajoutée(s), ' + r.reactivated.length + ' relancée(s), ' + r.errors.length + ' en erreur' }),
        ...r.errors.map(x => h('div', { class: 'bad', text: x.host + ' : ' + x.error })));
      box.hidden = false;
      if (!r.errors.length) $('#b-text').value = '';
      else $('#b-text').value = r.errors.map(x => items.find(i => i.host === x.host)).filter(Boolean).map(i => [i.host, i.label, i.site].join(';').replace(/;+$/, '')).join('\n');
      preview();
    } catch (err) { toast(err.message); }
    $('#b-ok').disabled = false;
  });
}

/* ------------------------------------------------------------- chart */
const STEPS = [1e3, 2e3, 5e3, 10e3, 15e3, 30e3, 60e3, 120e3, 300e3, 600e3, 900e3, 1800e3, 3600e3, 7200e3, 10800e3, 21600e3, 43200e3, 86400e3, 172800e3, 604800e3];
function xTicks(from, to, pxW) {
  const want = Math.max(2, Math.floor(pxW / 110));
  const step = STEPS.find(s => (to - from) / s <= want) || STEPS[STEPS.length - 1];
  const off = new Date(from).getTimezoneOffset() * 60000;
  const out = [];
  for (let t = Math.ceil((from - off) / step) * step + off; t <= to; t += step) out.push(t);
  return { step, ticks: out };
}
function niceStep(raw) {
  const e = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / e;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * e;
}
function computeYMax(rows, bucket) {
  const vals = [];
  for (const r of rows) {
    if (r[0] < S.from - bucket || r[0] > S.to) continue;
    const v = bucket ? r[3] : r[1];
    if (v != null) vals.push(v);
  }
  if (!vals.length) return 10;
  let max = 0; for (const v of vals) if (v > max) max = v;
  if (S.clip && vals.length > 20) { vals.sort((a, b) => a - b); max = vals[Math.floor(vals.length * 0.99)] * 1.05; }
  return Math.max(max, 1);
}

let drawQueued = false;
function scheduleDraw() { if (drawQueued) return; drawQueued = true; requestAnimationFrame(() => { drawQueued = false; drawAll(); }); }
function drawAll() { if ($('#panel').hidden || !T.surface) return; updateView(); CHARTS.forEach(drawChart); if (S.drag || !S.live) renderPresets(); }

function drawChart(ch) {
  const cv = ch.cv, t = byId(ch.tid);
  if (!t || !T.surface || !cv.isConnected) return;
  const dpr = devicePixelRatio || 1, W = cv.clientWidth, H = cv.clientHeight, M = ch.M;
  if (!W) return;
  if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H);
  const from = S.from, to = S.to, span = to - from, compact = M !== M_FULL;
  const x0 = M.l, x1 = W - M.r, y0 = M.t + M.lane + (compact ? 6 : 8), y1 = H - M.b;
  const X = ts => x0 + (ts - from) / span * (x1 - x0);
  const col = tcolor(t), rows = ch.data.rows, bucket = ch.data.bucket;
  const yMax0 = computeYMax(rows, bucket), step = niceStep(yMax0 * 1.08 / (compact ? 2 : 4)), yMax = step * Math.ceil(yMax0 * 1.08 / step);
  const Y = v => y1 - (y1 - y0) * Math.min(v, yMax) / yMax;
  ch.geo = { x0, x1, y0, y1, W, H, laneY: M.t, laneH: M.lane };

  ctx.font = '11.5px system-ui, "Segoe UI", sans-serif';
  ctx.lineWidth = 1; ctx.textBaseline = 'middle'; ctx.textAlign = 'right';
  for (let v = 0; v <= yMax + 1e-9; v += step) {
    const y = Math.round(Y(v)) + .5;
    ctx.strokeStyle = v === 0 ? T.axis : T.grid; ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();
    ctx.fillStyle = T.muted; ctx.fillText(String(+v.toFixed(2)).replace('.', ','), x0 - 7, y);
  }
  if (!compact) { ctx.textAlign = 'left'; ctx.fillText('ms' + (S.clip ? ' · écrêté' : ''), 4, y0 - 8); }
  const xt = xTicks(from, to, x1 - x0);
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  let prevDay = null;
  xt.ticks.forEach((tk, i) => {
    const x = Math.round(X(tk)) + .5;
    ctx.strokeStyle = T.grid; ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x, y1); ctx.stroke();
    if (M.b < 20) return;   // graphs empilés : étiquettes de temps sur le dernier seulement
    const d = new Date(tk), day = d.toDateString();
    let label = xt.step < 60e3 ? fmtTime.format(d) : xt.step < 86400e3 ? fmtHM.format(d) : fmtDM.format(d);
    if (xt.step < 86400e3 && (i === 0 || day !== prevDay)) label = fmtDM.format(d) + ' ' + label;
    prevDay = day;
    const w = ctx.measureText(label).width;
    ctx.fillStyle = T.muted; ctx.fillText(label, clamp(x, x0 + w / 2, x1 - w / 2 + 6), y1 + 6);
  });

  // périodes non surveillées (hachures)
  ctx.save(); ctx.beginPath(); ctx.rect(x0, y0, x1 - x0, y1 - y0); ctx.clip();
  ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.font = '11px system-ui, "Segoe UI", sans-serif';
  ch.gaps.forEach(g => {
    const xa = X(g.start), xb = X(g.end != null ? g.end : Date.now()), w = Math.max(xb - xa, 2);
    if (xb < x0 || xa > x1) return;
    ctx.fillStyle = hatch(ctx); ctx.fillRect(xa, y0, w, y1 - y0);
    const lab = GAP_LABEL[g.reason] || g.reason, room = Math.min(xb, x1) - Math.max(xa, x0) - 8;
    if (room > 40) { ctx.fillStyle = T.muted; ctx.fillText(fit(ctx, lab, room), Math.max(xa, x0) + 4, y0 + 4); }
  });
  ctx.restore();

  // tags
  ch.hits = [];
  const laneY = M.t, laneH = M.lane;
  ctx.fillStyle = alpha(T.text, 0.045); ctx.fillRect(x0, laneY, x1 - x0, laneH);
  const tags = ch.tags.slice().sort((a, b) => a.ts - b.ts);
  ctx.save(); ctx.beginPath(); ctx.rect(x0, laneY, x1 - x0, y1 - laneY); ctx.clip();
  tags.forEach(g => {
    const c = T.series[g.color % 8], e = tagEnd(g);
    if (e != null) {
      const xa = X(g.ts), xb = X(e);
      ctx.fillStyle = alpha(c, 0.08); ctx.fillRect(xa, y0, Math.max(xb - xa, 2), y1 - y0);
    } else {
      const x = Math.round(X(g.ts)) + .5;
      ctx.strokeStyle = alpha(c, 0.85); ctx.lineWidth = 1.5; ctx.setLineDash(g.auto ? [2, 3] : [4, 3]);
      ctx.beginPath(); ctx.moveTo(x, laneY + laneH); ctx.lineTo(x, y1); ctx.stroke(); ctx.setLineDash([]);
    }
  });
  ctx.textBaseline = 'middle'; ctx.textAlign = 'left'; ctx.font = '11.5px system-ui, "Segoe UI", sans-serif';
  tags.forEach((g, i) => {
    const c = T.series[g.color % 8], e = tagEnd(g);
    const nextX = tags[i + 1] ? X(tags[i + 1].ts) : x1;
    if (e != null) {
      const xa = X(g.ts), xb = X(e), w = Math.max(xb - xa, 3);
      ctx.fillStyle = alpha(c, 0.28); ctx.fillRect(xa, laneY + 2, w, laneH - 4);
      ctx.fillStyle = c; ctx.fillRect(xa, laneY + 2, w, 2);
      ch.hits.push({ tag: g, xa, xb: xa + w });
      const room = Math.min(xb, x1) - Math.max(xa, x0) - 8;
      if (room > 26) { ctx.fillStyle = T.text; ctx.fillText(fit(ctx, g.label, room), Math.max(xa, x0) + 4, laneY + laneH / 2 + 1); }
    } else {
      const x = X(g.ts), r = laneH / 2 - 4;
      ctx.fillStyle = c; ctx.beginPath();
      ctx.moveTo(x, laneY + 4); ctx.lineTo(x + r + 1, laneY + laneH / 2); ctx.lineTo(x, laneY + laneH - 4); ctx.lineTo(x - r - 1, laneY + laneH / 2); ctx.closePath(); ctx.fill();
      ch.hits.push({ tag: g, xa: x - 6, xb: x + 6 });
      const room = nextX - x - 14;
      if (room > 26) { ctx.fillStyle = T.text2; ctx.fillText(fit(ctx, g.label, Math.min(room, 220)), x + 9, laneY + laneH / 2 + 1); }
    }
  });
  ctx.restore();

  ctx.save(); ctx.beginPath(); ctx.rect(x0, y0 - 2, x1 - x0, y1 - y0 + 4); ctx.clip();
  if (bucket) drawBuckets(ctx, rows, bucket, X, Y, col, y0, y1, span, x1 - x0, tdash(t));
  else drawRaw(ctx, rows, X, Y, col, y0, y1, span, x1 - x0, t);

  if (S.hoverTs != null && S.hoverTs >= from && S.hoverTs <= to) {
    const r = rows.length ? nearestRow(ch, S.hoverTs) : null;
    const tsx = r && rowNear(ch, r, S.hoverTs) ? r[0] + bucket / 2 : S.hoverTs;
    const hx = Math.round(X(tsx)) + .5;
    ctx.strokeStyle = alpha(T.text, ch === S.hoverCh ? 0.4 : 0.25); ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(hx, y0); ctx.lineTo(hx, y1); ctx.stroke();
    if (r && rowNear(ch, r, S.hoverTs) && r[1] != null) {
      ctx.fillStyle = col; ctx.strokeStyle = T.surface; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(hx, Y(r[1]), 4.5, 0, 7); ctx.fill(); ctx.stroke();
    }
  }
  if (S.drag && S.drag.ch === ch && S.drag.kind === 'tag' && S.drag.moved) {
    const a = clamp(Math.min(S.drag.x, S.drag.cur), x0, x1), b = clamp(Math.max(S.drag.x, S.drag.cur), x0, x1);
    ctx.fillStyle = alpha(col, 0.18); ctx.fillRect(a, y0, b - a, y1 - y0);
    ctx.strokeStyle = col; ctx.lineWidth = 1; ctx.strokeRect(a + .5, y0 + .5, b - a, y1 - y0);
  }
  ctx.restore();

  if (ch.loaded && !rows.length && !ch.gaps.length) {
    const msg = t.state === 'active' ? 'Aucune mesure dans cette fenêtre (en attente…)'
      : (t.state === 'stopped' ? 'Cible arrêtée' : 'Cible en pause') + ' · aucune mesure dans cette fenêtre';
    ctx.fillStyle = T.muted; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.font = '13px system-ui, sans-serif';
    ctx.fillText(msg, (x0 + x1) / 2, (y0 + y1) / 2);
  }
}

function fit(ctx, text, max) {
  if (ctx.measureText(text).width <= max) return text;
  let s = text;
  while (s.length > 1 && ctx.measureText(s + '…').width > max) s = s.slice(0, -1);
  return s + '…';
}

function drawRaw(ctx, rows, X, Y, col, y0, y1, span, plotW, t) {
  const pxPer = plotW / (span / t.interval_ms), w = Math.max(3, Math.min(pxPer, 8));
  rows.forEach(r => {
    if (r[1] != null) return;
    ctx.fillStyle = alpha(T.err[errCode(r[2])], 0.2); ctx.fillRect(X(r[0]) - w / 2, y0, w, y1 - y0);
  });
  rows.forEach(r => {
    if (r[1] != null) return;
    const code = errCode(r[2]), c = T.err[code], x = X(r[0]);
    if (pxPer >= 7) drawShape(ctx, code, x, y1 - 6, 7, c);
    else { ctx.fillStyle = c; ctx.fillRect(x - 1.5, y1 - 6, 3, 6); }
  });
  const gap = Math.max(t.interval_ms * 3.5, 2500);
  ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.setLineDash(tdash(t)); ctx.beginPath();
  let pen = false, prev = null;
  rows.forEach(r => {
    if (r[1] == null) { pen = false; prev = r[0]; return; }
    const x = X(r[0]), y = Y(r[1]);
    if (!pen || (prev != null && r[0] - prev > gap)) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    pen = true; prev = r[0];
  });
  ctx.stroke(); ctx.setLineDash([]);
  ctx.fillStyle = col;
  rows.forEach((r, i) => {
    if (r[1] == null) return;
    const iso = (i === 0 || rows[i - 1][1] == null || r[0] - rows[i - 1][0] > gap) && (i === rows.length - 1 || rows[i + 1][1] == null || rows[i + 1][0] - r[0] > gap);
    if (pxPer >= 8 || iso) { ctx.beginPath(); ctx.arc(X(r[0]), Y(r[1]), pxPer >= 8 ? 3 : 2.5, 0, 7); ctx.fill(); }
  });
}

function drawBuckets(ctx, rows, bucket, X, Y, col, y0, y1, span, plotW, dash) {
  const bw = Math.max(2, bucket / span * plotW), SH = 8;
  rows.forEach(r => {
    if (!r[4]) return;
    const x = X(r[0]), errs = r[6] || [r[4], 0, 0, 0, 0];
    let dom = 0; errs.forEach((v, i) => { if (v > errs[dom]) dom = i; });
    ctx.fillStyle = alpha(T.err[dom + 1], Math.min(0.55, 0.15 + 0.5 * r[4] / r[5]));
    ctx.fillRect(x, y0, bw, y1 - y0);
    let y = y1;
    errs.forEach((v, i) => { if (!v) return; const hh = Math.max(1, SH * v / r[4]); ctx.fillStyle = T.err[i + 1]; ctx.fillRect(x, y - hh, bw, hh); y -= hh; });
  });
  const gap = bucket * 2.5, segs = [];
  let cur = [];
  rows.forEach(r => {
    if (r[1] == null || (cur.length && r[0] - cur[cur.length - 1][0] > gap)) { if (cur.length) segs.push(cur); cur = []; }
    if (r[1] != null) cur.push(r);
  });
  if (cur.length) segs.push(cur);
  segs.forEach(sg => {
    ctx.fillStyle = alpha(col, 0.2); ctx.beginPath();
    sg.forEach((r, i) => { const x = X(r[0] + bucket / 2); i ? ctx.lineTo(x, Y(r[3])) : ctx.moveTo(x, Y(r[3])); });
    for (let i = sg.length - 1; i >= 0; i--) ctx.lineTo(X(sg[i][0] + bucket / 2), Y(sg[i][2]));
    ctx.closePath(); ctx.fill();
    ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.setLineDash(dash || []); ctx.beginPath();
    sg.forEach((r, i) => { const x = X(r[0] + bucket / 2); i ? ctx.lineTo(x, Y(r[1])) : ctx.moveTo(x, Y(r[1])); });
    ctx.stroke(); ctx.setLineDash([]);
  });
}

/* ------------------------------------------------------ interactions */
function pos(ch, e) { const r = ch.cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
function xToT(ch, x) { const g = ch.geo; return S.from + (clamp(x, g.x0, g.x1) - g.x0) / (g.x1 - g.x0) * (S.to - S.from); }
function laneHit(ch, p) {
  const g = ch.geo;
  if (p.y < g.laneY || p.y > g.laneY + g.laneH) return null;
  let best = null;
  for (const hh of ch.hits) if (p.x >= hh.xa - 2 && p.x <= hh.xb + 2) { if (!best || (hh.xb - hh.xa) < (best.xb - best.xa)) best = hh; }
  return best ? best.tag : null;
}
function nearestRow(ch, ts) {
  const rows = ch.data.rows, b = ch.data.bucket / 2; if (!rows.length) return null;
  let lo = 0, hi = rows.length - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (rows[mid][0] + b < ts) lo = mid + 1; else hi = mid; }
  if (lo > 0 && Math.abs(rows[lo - 1][0] + b - ts) < Math.abs(rows[lo][0] + b - ts)) lo--;
  return rows[lo];
}
/* la mesure la plus proche est-elle vraiment "à cet instant" ? (sinon : trou) */
function rowNear(ch, r, ts) {
  const t = byId(ch.tid), tol = Math.max(ch.data.bucket || 0, (t ? t.interval_ms : 1000) * 1.5, (S.to - S.from) / 400);
  return Math.abs(r[0] + ch.data.bucket / 2 - ts) <= tol;
}
const gapAt = (ch, ts) => ch.gaps.find(g => ts >= g.start && ts <= (g.end != null ? g.end : Date.now()));

function errLine(code, text) {
  return h('div', { class: 'r' }, errIcon(code), h('span', { class: 'bad', style: 'color:' + T.err[code], text }));
}
function rowLines(ch, ts, withName) {
  const t = byId(ch.tid), b = ch.data.bucket, out = [];
  const key = h('span', { class: 'k', style: 'border-color:' + tcolor(t) });
  const name = withName ? h('span', { class: 'l', text: tname(t) }) : null;
  const r = nearestRow(ch, ts);
  if (!r || !rowNear(ch, r, ts)) {
    const g = gapAt(ch, ts);
    out.push(h('div', { class: 'r' }, key, h('span', { class: 'l', text: g ? (GAP_LABEL[g.reason] || g.reason) : 'pas de mesure' }), name));
    return out;
  }
  if (!b) {
    if (r[1] == null) {
      const c = errCode(r[2]);
      out.push(h('div', { class: 'r' }, key, errIcon(c), h('span', { class: 'bad', style: 'color:' + T.err[c], text: ERR[c].label }), name));
      if (r[3] && !withName) out.push(h('div', { class: 'r' }, h('span', { class: 'l', text: 'réponse de ' + r[3] })));
    } else out.push(h('div', { class: 'r' }, key, h('span', { class: 'v', text: fmtMs(r[1]) + ' ms' }), name || h('span', { class: 'l', text: tname(t) })));
    return out;
  }
  if (r[1] != null) out.push(h('div', { class: 'r' }, key, h('span', { class: 'v', text: fmtMs(r[1]) + ' ms' }), name || h('span', { class: 'l', text: 'moyenne' })));
  else out.push(h('div', { class: 'r' }, key, h('span', { class: 'l', text: 'aucune réponse' }), name));
  if (!withName) {
    if (r[1] != null) out.push(h('div', { class: 'r' }, h('span', { class: 'l', text: 'min ' + fmtMs(r[2]) + ' · max ' + fmtMs(r[3]) + ' ms' })));
    (r[6] || [r[4], 0, 0, 0, 0]).forEach((v, i) => { if (v) out.push(errLine(i + 1, v + ' × ' + ERR[i + 1].label)); });
    out.push(h('div', { class: 'r' }, h('span', { class: 'l', text: r[5] + ' mesures' + (r[4] ? ' · ' + r[4] + ' en échec' : '') })));
  } else if (r[4]) out.push(h('div', { class: 'r' }, h('span', { class: 'bad', text: '   ✕ ' + r[4] + ' / ' + r[5] + ' en échec' })));
  return out;
}

function showTip(e, ch, tagHit) {
  const tip = $('#tip'), kids = [];
  if (tagHit) {
    kids.push(h('div', { class: 't', text: whenText(tagHit) }),
      h('div', { class: 'r' }, h('span', { class: 'v', text: tagHit.label })),
      tagHit.note ? h('div', { class: 'n', text: tagHit.note }) : null,
      h('div', { class: 'l', text: (tagHit.auto ? 'Tag automatique · ' : '') + (tagHit.target_id == null ? 'Toutes les cibles' : tname(byId(tagHit.target_id) || { host: '?' })) }));
  } else if (S.hoverTs != null) {
    const b = Math.max(...CHARTS.map(c => c.data.bucket));
    kids.push(h('div', { class: 't', text: b ? fmtTime.format(S.hoverTs - b / 2) + ' → ' + fmtTime.format(S.hoverTs + b / 2) : fmtTime.format(S.hoverTs) + ' · ' + fmtDM.format(S.hoverTs) }));
    if (S.view === 'compare') CHARTS.forEach(c => kids.push(...rowLines(c, S.hoverTs, true)));
    else kids.push(...rowLines(ch, S.hoverTs, false));
  } else { tip.hidden = true; return; }
  tip.replaceChildren(...kids); tip.hidden = false;
  const tw = tip.offsetWidth, th = tip.offsetHeight, vw = innerWidth, vh = innerHeight;
  let left = e.clientX + 18, top = e.clientY + 18;
  if (left + tw > vw - 6) left = e.clientX - tw - 12;
  if (top + th > vh - 6) top = e.clientY - th - 12;
  tip.style.left = Math.max(4, left) + 'px'; tip.style.top = Math.max(4, top) + 'px';
}
function clearHover() { S.hoverTs = null; S.hoverCh = null; $('#tip').hidden = true; scheduleDraw(); }

function wireCanvas(cv) {
  if (cv._wired) return; cv._wired = true;
  new ResizeObserver(() => scheduleDraw()).observe(cv);
  cv.addEventListener('pointerdown', e => {
    const ch = cv._ch; if (e.button !== 0 || !ch || !ch.geo) return;
    const p = pos(ch, e), g = ch.geo;
    if (p.x < g.x0 || p.x > g.x1) return;
    const hit = laneHit(ch, p);
    S.drag = { ch, x: p.x, y: p.y, cur: p.x, t: xToT(ch, p.x), from: S.from, to: S.to, moved: false, hit,
      kind: ((S.mode === 'tag' || e.shiftKey) && !hit) ? 'tag' : 'pan' };
    cv.setPointerCapture(e.pointerId);
  });
  cv.addEventListener('pointermove', e => {
    const ch = cv._ch; if (!ch || !ch.geo) return;
    const p = pos(ch, e), g = ch.geo, d = S.drag;
    if (d) {
      if (Math.abs(p.x - d.x) > 4 || Math.abs(p.y - d.y) > 4) d.moved = true;
      if (d.kind === 'pan' && d.moved && !d.hit) {
        cv.classList.add('dragging');
        const msPx = (d.to - d.from) / (g.x1 - g.x0), dt = -(p.x - d.x) * msPx;
        let f = d.from + dt, t = d.to + dt; const end = endTs(), lim = end + (d.to - d.from) * 0.03;
        if (t > lim) { f -= t - lim; t = lim; }
        S.from = f; S.to = t; S.span = t - f; S.live = t >= end - msPx * 2;
        S.hoverTs = null; $('#tip').hidden = true;
        scheduleLoad();
      } else if (d.kind === 'tag') d.cur = p.x;
      scheduleDraw(); return;
    }
    const inPlot = p.x >= g.x0 && p.x <= g.x1 && p.y >= g.laneY && p.y <= g.y1;
    if (!inPlot) { clearHover(); return; }
    const hit = laneHit(ch, p);
    cv.style.cursor = hit ? 'pointer' : '';
    if (hit) { S.hoverTs = null; S.hoverCh = ch; showTip(e, ch, hit); scheduleDraw(); return; }
    S.hoverTs = xToT(ch, p.x); S.hoverCh = ch;
    showTip(e, ch, null); scheduleDraw();
  });
  const end = e => {
    const d = S.drag; if (!d) return;
    S.drag = null; cv.classList.remove('dragging');
    try { cv.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    if (e.type === 'pointercancel') { scheduleDraw(); return; }
    const ch = d.ch, p = pos(ch, e);
    if (d.kind === 'tag') {
      if (d.moved) { const a = xToT(ch, d.x), b = xToT(ch, p.x); openTag(null, { ts: Math.round(Math.min(a, b)), ts_end: Math.round(Math.max(a, b)), target: ch.tid }); }
      else openTag(null, { ts: Math.round(d.t), target: ch.tid });
    } else if (!d.moved && d.hit) openTag(d.hit);
    scheduleDraw();
  };
  cv.addEventListener('pointerup', end);
  cv.addEventListener('pointercancel', end);
  cv.addEventListener('pointerleave', () => { if (!S.drag) clearHover(); });
  cv.addEventListener('dblclick', e => {
    const ch = cv._ch; if (!ch || !ch.geo) return;
    const p = pos(ch, e), g = ch.geo; if (p.x < g.x0 || p.x > g.x1 || laneHit(ch, p)) return;
    openTag(null, { ts: Math.round(xToT(ch, p.x)), target: ch.tid });
  });
  cv.addEventListener('wheel', e => {
    const ch = cv._ch; if (!ch || !ch.geo) return;
    e.preventDefault();
    const g = ch.geo, p = pos(ch, e), span = S.to - S.from, k = Math.exp(e.deltaY * 0.0015);
    const ns = clamp(span * k, MIN_SPAN, MAX_SPAN), anchor = xToT(ch, p.x);
    if (S.live) { S.span = ns; updateView(); }
    else {
      const r = (anchor - S.from) / span;
      let f = anchor - r * ns, t = f + ns; const end = endTs(), lim = end + ns * 0.03;
      if (t > lim) { f -= t - lim; t = lim; }
      S.from = f; S.to = t; S.span = ns;
      S.live = t >= end - ns / (g.x1 - g.x0) * 2;
    }
    S.hoverTs = null; $('#tip').hidden = true;
    renderPresets(); scheduleLoad(); scheduleDraw();
  }, { passive: false });
}

function setMode(m) {
  S.mode = m;
  $$('#modes button').forEach(b => b.classList.toggle('on', b.dataset.mode === m));
  document.body.classList.toggle('tagging', m === 'tag');
}

/* ------------------------------------------------------------- table */
function renderTable(ch) {
  const box = $('#tablewrap'); box.hidden = !S.table || S.view !== 'single';
  if (box.hidden || !ch) return;
  const b = ch.data.bucket, rows = ch.data.rows.slice(-300).reverse();
  const td = (v, cls, style) => h('td', { text: v, class: cls, style });
  const head = b ? ['Heure', 'Moy (ms)', 'Min', 'Max', 'Mesures', 'Échecs'] : ['Heure', 'Latence (ms)', 'Résultat', 'Réponse de'];
  box.replaceChildren(h('table', {},
    h('thead', {}, h('tr', {}, head.map(c => h('th', { text: c })))),
    h('tbody', {}, rows.map(r => {
      if (b) {
        const errs = r[6] || [r[4], 0, 0, 0, 0];
        const txt = errs.map((v, i) => v ? v + ' ' + ERR[i + 1].label.toLowerCase() : null).filter(Boolean).join(', ') || '—';
        return h('tr', {}, td(fmtFull.format(r[0])), td(fmtMs(r[1])), td(fmtMs(r[2])), td(fmtMs(r[3])), td(r[5]), td(txt));
      }
      if (r[1] == null) {
        const c = errCode(r[2]);
        return h('tr', {}, td(fmtFull.format(r[0])), td('—'), td(ERR[c].label, 'err', 'color:' + T.err[c]), td(r[3] || ''));
      }
      return h('tr', {}, td(fmtFull.format(r[0])), td(fmtMs(r[1])), td('OK'), td(''));
    }))));
}

/* ------------------------------------------- favicon et titre de l'onglet */
const FAV = bad => '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#2a78d6"/>'
  + '<path d="M8 36h12l5-14 8 26 6-18 4 6h13" fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>'
  + (bad ? '<circle cx="50" cy="14" r="12" fill="#d03b3b" stroke="#fff" stroke-width="3"/>' : '') + '</svg>';
let badgeN = -1;
function updateBadge(force) {
  const n = S.targets.filter(failing).length;
  if (n === badgeN && !force) return;
  badgeN = n;
  $('#favicon').href = 'data:image/svg+xml,' + encodeURIComponent(FAV(n > 0));
  document.title = (n ? '✕ ' + n + ' · ' : '') + 'PingMon' + (S.version ? ' ' + S.version : '');
}

/* ------------------------------------------------------------ footer */
function renderFoot() {
  const i = S.info; if (!i) return;
  const items = i.demo ? [h('span', { class: 'demo', text: 'MODE DÉMO : latences simulées, aucun ping réel' })] : [];
  const act = S.targets.filter(t => t.state === 'active');
  if (act.length) {
    // cadence réelle : ralentie après échecs répétés, nulle tant qu'un nom ne se résout pas
    const dns = t => t.last && t.last.rtt == null && errCode(t.last.err) === 4;
    const rate = t => dns(t) ? 0 : 1000 / Math.max(t.interval_ms, t.slowed ? i.backoff_s * 1000 : 0);
    const pps = act.reduce((a, t) => a + rate(t), 0), nslow = act.filter(t => t.slowed && !dns(t)).length, ndns = act.filter(dns).length;
    const extra = [nslow ? nslow + ' ralentie' + (nslow > 1 ? 's' : '') : null, ndns ? ndns + ' sans ping (DNS)' : null].filter(Boolean).join(', ');
    items.push(h('span', { text: 'charge : ' + act.length + ' cible(s)' + (extra ? ' dont ' + extra : '') + ', ' + (pps < 10 ? pps.toFixed(1) : String(Math.round(pps))).replace('.', ',') + ' ping/s au total, ' + i.ping_size + ' octets',
      title: 'Au plus 1 ping/s par cible et par IP, un seul ping en vol par cible' + (i.backoff ? ', ralenti à ' + i.backoff_s + ' s après ' + i.backoff_after + ' échecs consécutifs' : '') }));
  }
  if (i.dropped) items.push(h('span', { class: 'warn', text: i.dropped + ' mesures perdues (voir le journal dans Paramètres)' }));
  if (i.backups_keep && (!i.last_backup || Date.now() - i.last_backup > 2 * 86400e3)) items.push(h('span', { class: 'warn', text: 'aucune sauvegarde récente' }));
  $('#foot').replaceChildren(...items);
  LOAD_TXT = items.find(x => x.textContent.startsWith('charge')) ? items.find(x => x.textContent.startsWith('charge')).textContent : '';
}
/* ------------------------------------------------- panneau Paramètres */
let LOAD_TXT = '';
const SETTING_FIELDS = { def_interval_ms: ['s-int', 1000], def_timeout_ms: ['s-to', 1], def_outage_n: ['s-out', 1], raw_days: ['s-raw', 1],
  retention_days: ['s-ret', 1], backoff: ['s-bo', 0], backoff_after: ['s-boa', 1], backoff_s: ['s-bos', 1], backups_keep: ['s-bk', 1] };
const CLI_OPT = { raw_days: '--raw-days', retention_days: '--retention-days', backups_keep: '--backups', backoff: '--no-backoff' };
async function loadSettings() { try { S.settings = await api('/api/settings'); } catch (e) { /* ignore */ } }
function sizeEstimate() {
  // ~26 o par ping brut, ~1 Mo par cible et par semaine de résumés (mesuré)
  const raw = +$('#s-raw').value || 0, ret = +$('#s-ret').value || 0;
  const act = S.targets.filter(t => t.state !== 'stopped');
  if (!act.length) { $('#s-est').textContent = ''; return; }
  const mb = act.reduce((a, t) => a + raw * 2.25 * (1000 / Math.max(1000, t.interval_ms)) + ret * 0.15, 0);
  $('#s-est').textContent = 'Taille maximale estimée de la base pour tes ' + act.length + ' cibles : ≈ ' + (mb < 1024 ? Math.round(mb) + ' Mo' : (mb / 1024).toFixed(1).replace('.', ',') + ' Go')
    + ' (actuellement ' + (S.info ? fmtSize(S.info.db_size) : '?') + ').';
}
async function openSettings() {
  closePops();
  await Promise.all([loadSettings(), loadInfo()]);
  const st = S.settings, i = S.info; if (!st || !i) { toast('Paramètres indisponibles'); return; }
  for (const [k, [id, div]] of Object.entries(SETTING_FIELDS)) {
    const el = $('#' + id), locked = st.locked.includes(k);
    if (div === 0) el.checked = !!st.values[k]; else el.value = st.values[k] / div;
    el.disabled = locked;
    const note = $(`.lock[data-for="${k}"]`); if (note) note.textContent = locked ? 'imposé au lancement (' + CLI_OPT[k] + ')' : '';
  }
  const syncBo = () => { $('#s-boa').disabled = !$('#s-bo').checked; $('#s-bos').disabled = !$('#s-bo').checked; };
  $('#s-bo').onchange = syncBo; syncBo();
  sizeEstimate();
  $('#s-bkinfo').textContent = 'Dernière sauvegarde : ' + (i.last_backup ? fmtFull.format(i.last_backup) : 'aucune') + ' · dossier ' + i.backup_dir;
  const row = (k, v) => [h('dt', { text: k }), h('dd', { text: v })];
  $('#s-about').replaceChildren(
    ...row('Version', 'PingMon ' + i.version + (i.demo ? ' (mode démo)' : '') + ' · base de données v' + i.schema),
    ...row('Démarré', fmtFull.format(i.started) + ' (il y a ' + ago(i.started) + ')'),
    ...row('Base', i.db + ' · ' + fmtSize(i.db_size)),
    ...row('Journal', i.log_file),
    ...row('Charge', LOAD_TXT.replace(/^charge : /, '') || 'aucune cible active'),
    ...row('Mesures perdues', i.dropped ? String(i.dropped) + ' (voir le journal)' : 'aucune'));
  $('#setdlg').showModal();
}
function buildSettingsDialog() {
  const dlg = $('#setdlg');
  $$('[data-close]', dlg).forEach(b => b.addEventListener('click', () => dlg.close()));
  ['s-raw', 's-ret'].forEach(id => $('#' + id).addEventListener('input', sizeEstimate));
  $('#s-backup').addEventListener('click', async () => { await doBackup(); await loadInfo();
    $('#s-bkinfo').textContent = 'Dernière sauvegarde : ' + (S.info.last_backup ? fmtFull.format(S.info.last_backup) : 'aucune') + ' · dossier ' + S.info.backup_dir; });
  $('#setform').addEventListener('submit', async e => {
    e.preventDefault();
    const body = {};
    for (const [k, [id, div]] of Object.entries(SETTING_FIELDS)) {
      const el = $('#' + id); if (el.disabled && k !== 'backoff_after' && k !== 'backoff_s') continue;
      if (S.settings.locked.includes(k)) continue;
      body[k] = div === 0 ? el.checked : Math.round(parseFloat(el.value) * div);
    }
    try { S.settings = await api('/api/settings', { method: 'PATCH', body }); dlg.close(); toast('Paramètres enregistrés', 'info'); loadInfo(); }
    catch (err) { toast(err.message); }
  });
  $('#m-settings').addEventListener('click', openSettings);
}

async function doBackup() {
  try { const r = await api('/api/backup', { method: 'POST' }); toast('Sauvegarde créée : ' + r.path, 'info'); loadInfo(); }
  catch (e) { toast(e.message); }
}

/* ------------------------------------------------------- menus fixes */
function buildMenus() {
  $('#menubtn').addEventListener('click', e => { e.stopPropagation(); openPop($('#mainmenu'), e.currentTarget); });
  $$('#mainmenu [data-theme]').forEach(b => b.addEventListener('click', () => { theme = b.dataset.theme; ls.set('pm.theme', theme); applyTheme(); closePops(); }));
  const syncDensity = () => $$('#mainmenu [data-density]').forEach(b => b.setAttribute('aria-checked', String(b.dataset.density === S.density)));
  $$('#mainmenu [data-density]').forEach(b => b.addEventListener('click', () => {
    S.density = b.dataset.density; ls.set('pm.density', S.density); syncDensity(); closePops(); renderCards();
  }));
  syncDensity();
  $('#m-help').addEventListener('click', () => { closePops(); $('#helpdlg').showModal(); });
  $('#helpbtn').addEventListener('click', () => $('#helpdlg').showModal());
  $$('#helpdlg [data-close]').forEach(b => b.addEventListener('click', () => $('#helpdlg').close()));
  $('#viewbtn').addEventListener('click', e => { e.stopPropagation(); openPop($('#viewmenu'), e.currentTarget); });
  $$('.popover').forEach(p => p.addEventListener('click', e => e.stopPropagation()));
  document.addEventListener('click', closePops);
  addEventListener('resize', closePops);
  $('#targets').addEventListener('scroll', closePops, { passive: true });
  // recherche et filtres
  let qt = null;
  $('#q').addEventListener('input', e => { clearTimeout(qt); qt = setTimeout(() => { S.q = e.target.value; renderCards(); }, 80); });
  $('#q').addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.preventDefault(); if (e.target.value) { e.target.value = ''; S.q = ''; renderCards(); } else e.target.blur(); }
    else if (e.key === 'Enter') { const c = $('#targets .card'); if (c) { c.click(); c.focus(); } }   // ouvre le premier résultat
  });
  $$('#filt button').forEach(b => b.addEventListener('click', () => { S.filt = b.dataset.f; ls.set('pm.filt', S.filt); renderCards(); }));
  $('#failtop').addEventListener('click', () => { S.failTop = !S.failTop; ls.set('pm.failtop', S.failTop ? '1' : '0'); renderCards(); });
  // durées : boutons, ou liste déroulante quand la place manque
  $('#presets-sel').addEventListener('change', e => { if (!e.target.value) return; S.span = +e.target.value; S.live = true; updateView(); renderPresets(); scheduleLoad(0); scheduleDraw(); });
}

/* ------------------------------------------------------------- theme */
const THEMES = ['auto', 'light', 'dark'], THEME_LABEL = { auto: 'Thème : auto', light: 'Thème : clair', dark: 'Thème : sombre' };
let theme = THEMES.includes(ls.get('pm.theme')) ? ls.get('pm.theme') : 'auto';
function applyTheme() {
  if (theme === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', theme);
  $$('#mainmenu [data-theme]').forEach(b => b.setAttribute('aria-checked', String(b.dataset.theme === theme)));
  readTheme();
  if (S.targets.length) { renderCards(); renderPanel(); }
  scheduleDraw();
}

/* Le serveur a été mis à jour : on recharge seulement si rien n'est en cours de saisie */
const busy = () => !!document.querySelector('dialog[open]') || !!$('input.rename') || !!S.drag || !!DND;
function offerReload(v) {
  if (!busy()) { location.reload(); return; }
  $('#update-txt').textContent = 'PingMon est passé en version ' + v + '. Termine ta saisie, puis recharge la page.';
  $('#update').hidden = false;
  clearInterval(offerReload.t);
  offerReload.t = setInterval(() => { if (!busy()) location.reload(); }, 2000);   // rechargement dès que tout est fermé
}

/* --------------------------------------------------------------- SSE */
let flushQueued = false, tgtTimer = null;
function connectSSE() {
  const es = new EventSource('/api/stream');
  const conn = $('#conn');
  es.onopen = () => {
    document.body.classList.remove('offline');
    conn.replaceChildren(h('span', { class: 'g', text: '●' }), ' Connecté');
    loadTargets().catch(e => toast(e.message));
  };
  es.onerror = () => {
    document.body.classList.add('offline');
    conn.replaceChildren(h('span', { class: 'r', text: '✕' }), ' Déconnecté');
  };
  es.addEventListener('hello', ev => {
    const d = JSON.parse(ev.data);
    if (S.version && S.version !== d.version) { offerReload(d.version); return; }  // serveur mis à jour
    S.version = d.version; loadInfo(); loadSettings();
    $('#ver').textContent = 'v' + d.version; updateBadge(true);
  });
  es.addEventListener('sample', ev => {
    const d = JSON.parse(ev.data), t = byId(d.t); if (!t) return;
    t.last = { ts: d.ts, rtt: d.rtt, err: d.err, src: d.src };
    trackFail(t, d);
    t.recent.push([d.ts, d.rtt, d.err]); if (t.recent.length > 60) t.recent.shift();
    t._dirty = true;
    CHARTS.forEach(ch => {
      if (ch.tid !== d.t || !ch.loaded || ch.data.bucket !== 0) return;
      const rows = ch.data.rows;
      if (!rows.length || rows[rows.length - 1][0] < d.ts) rows.push([d.ts, d.rtt, d.err, d.src]);
      if (rows.length > ch.maxpts * 1.3) loadData(ch);
    });
    if (!flushQueued) {
      flushQueued = true;
      requestAnimationFrame(() => {
        flushQueued = false;
        S.targets.forEach(x => { if (x._dirty) { x._dirty = false; updateCard(x); } });
        refreshFailing(); updateBadge();
        if (S.view === 'single') renderStatus(); else CHARTS.forEach(renderCmpHead);
      });
    }
  });
  es.addEventListener('targets', () => { clearTimeout(tgtTimer); tgtTimer = setTimeout(() => loadTargets().catch(e => toast(e.message)), 150); });
  es.addEventListener('tags', reloadTags);
  es.addEventListener('settings', () => { loadSettings(); loadInfo(); });
  es.addEventListener('gaps', reloadTags);
}

/* -------------------------------------------------------------- init */
function init() {
  buildTagDialog(); buildTargetDialog(); buildAddDialog(); buildBulkDialog(); setupReorder(); buildMenus(); buildSettingsDialog();
  const ms = $('#morestats'); ms.open = ls.get('pm.morestats') === '1'; ms.addEventListener('toggle', () => ls.set('pm.morestats', ms.open ? '1' : '0'));
  $('#update-btn').addEventListener('click', () => location.reload());
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (theme === 'auto') applyTheme(); });
  $('#live').addEventListener('click', () => { if (!S.live) { S.span = S.to - S.from; S.live = true; updateView(); renderPresets(); scheduleLoad(0); scheduleDraw(); } });
  $$('#modes button').forEach(b => b.addEventListener('click', () => setMode(b.dataset.mode)));
  $$('#views button').forEach(b => b.addEventListener('click', () => { if (b.dataset.view !== S.view) setView(b.dataset.view); }));
  $('#clip').addEventListener('change', e => { S.clip = e.target.checked; scheduleDraw(); });
  $('#tbl').addEventListener('change', e => { S.table = e.target.checked; renderTable(mainChart()); });

  document.addEventListener('keydown', menuKeys, true);
  document.addEventListener('keydown', e => {
    if (e.ctrlKey || e.metaKey || e.altKey || document.querySelector('dialog[open]')) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    if (e.key === 't' || e.key === 'T') setMode(S.mode === 'tag' ? 'pan' : 'tag');
    else if (e.key === 'l' || e.key === 'L') $('#live').click();
    else if (e.key === 'n' || e.key === 'N') { e.preventDefault(); openAdd(); }
    else if (e.key === '/') { e.preventDefault(); $('#q').focus(); $('#q').select(); }
    else if (e.key === '?') { e.preventDefault(); $('#helpdlg').showModal(); }
  });

  applyTheme();
  S.to = Date.now(); S.from = S.to - S.span;
  connectSSE();

  setInterval(() => {
    if (document.hidden || $('#panel').hidden || !S.live || allStopped()) return;
    updateView();
    const now = Date.now(), cut = S.from - S.span * 0.05;
    CHARTS.forEach(ch => {
      const rows = ch.data.rows;
      if (ch.data.bucket === 0) { let n = 0; while (n < rows.length && rows[n][0] < cut) n++; if (n > 0) rows.splice(0, n); }
      if (ch.data.bucket > 0 && now - ch.lastLoad > Math.max(2000, ch.data.bucket)) loadData(ch);
      if (now - ch.lastStats > statsEvery()) loadStats(ch);
      if (now - ch.lastTags > 10000) loadTags(ch);
    });
    scheduleDraw();
  }, 250);
  setInterval(() => { if (!document.hidden) loadInfo(); }, 60000);
  setInterval(() => { if (!document.hidden) renderFoot(); }, 5000);   // la charge suit les ralentissements
}
init();
