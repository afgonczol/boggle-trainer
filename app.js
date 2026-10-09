(() => {
'use strict';
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------- storage ----------
// Shared across profiles: dictionary exceptions (about Netflix, not the player), cached definitions, the profile list itself.
// The 'default' profile keeps the original unprefixed keys so data saved before profiles existed is still there.
const SHARED = new Set(['dict', 'defs', 'profiles', 'profile']);
const rawGet = (k, d) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } };
const profiles = rawGet('bt.profiles', [{ id: 'default', name: 'Player 1' }]);
let pid = rawGet('bt.profile', 'default');
if (!profiles.some(p => p.id === pid)) pid = profiles[0].id;
const keyFor = (k, id) => SHARED.has(k) || id === 'default' ? 'bt.' + k : `bt.p.${id}.${k}`;
const store = {
  get(k, d) { return rawGet(keyFor(k, pid), d); },
  set(k, v) { try { localStorage.setItem(keyFor(k, pid), JSON.stringify(v)); } catch (e) { console.warn('storage failed', e); } }
};
let practice = false;
try { practice = sessionStorage.getItem('bt.practice') === '1'; } catch (e) { /* ignore */ }
let stats = store.get('stats', {});          // word -> [seen, found, missed, streak]
let games = store.get('games', []);
let rejects = store.get('rejects', {});       // word -> [times swiped, last time]
let dictEx = store.get('dict', { ban: [], add: [] });
let settings = Object.assign({ size: 4, time: 120, min: 3, smart: false, sound: true, quality: 'good' }, store.get('settings', {}));
const saveStats = () => store.set('stats', stats);

// ---------- dictionary / trie ----------
let dict, trie;
function buildDict() {
  dict = new Set(window.WORDS.split(' '));
  dictEx.ban.forEach(w => dict.delete(w));
  dictEx.add.forEach(w => dict.add(w));
  trie = {};
  for (const w of dict) {
    let n = trie;
    for (let i = 0; i < w.length; i++) n = n[w[i]] || (n[w[i]] = {});
    n.$ = 1;
  }
  buildFamilies();
}

// ---------- sound ----------
let actx = null;
function tone(freq, t0, dur, type, vol) {
  const o = actx.createOscillator(), g = actx.createGain(), t = actx.currentTime + t0;
  o.type = type; o.frequency.setValueAtTime(freq, t);
  g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g); g.connect(actx.destination); o.start(t); o.stop(t + dur + 0.05);
}
function sfx(kind, len) {
  if (!settings.sound) return;
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    if (actx.state === 'suspended') actx.resume();
    if (kind === 'init') return;
    if (kind === 'ok') { const f = 520 * Math.pow(1.06, Math.min(len, 10) - 3); tone(f, 0, 0.12, 'sine', 0.25); tone(f * 1.5, 0.08, 0.2, 'sine', 0.25); }
    else if (kind === 'dup') { tone(330, 0, 0.07, 'triangle', 0.2); tone(330, 0.1, 0.07, 'triangle', 0.2); }
    else { tone(160, 0, 0.18, 'sawtooth', 0.15); tone(110, 0.1, 0.22, 'sawtooth', 0.15); }
  } catch (e) { /* audio unavailable */ }
}

// ---------- definitions ----------
const defCache = store.get('defs', {});
async function fetchDef(w) {
  if (defCache[w] !== undefined) return defCache[w];
  const strip = h => { const d = document.createElement('div'); d.innerHTML = h; return d.textContent.trim(); };
  const get = async x => {
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 7000);
    try {
      const r = await fetch('https://en.wiktionary.org/api/rest_v1/page/definition/' + encodeURIComponent(x), { signal: ctl.signal });
      if (r.status === 404) return null;
      if (!r.ok) throw new Error('http ' + r.status);
      const j = await r.json();
      return (j.en || []).map(m => ({ pos: m.partOfSpeech, def: strip((m.definitions[0] || {}).definition || '') })).filter(m => m.def).slice(0, 3);
    } finally { clearTimeout(timer); }
  };
  let out = await get(w), via = null;
  if (!out || !out.length) { const root = family(w).root; if (root !== w) { out = await get(root); via = root; } }
  const res = out && out.length ? { via, meanings: out } : null;
  defCache[w] = res; store.set('defs', defCache);
  return res;
}
async function showDef(w) {
  let box = $('#defBox');
  if (!box) { box = document.createElement('div'); box.id = 'defBox'; document.body.appendChild(box); }
  const links = `<a href="https://www.merriam-webster.com/dictionary/${w}" target="_blank" rel="noopener">Merriam-Webster</a> · <a href="https://en.wiktionary.org/wiki/${w}" target="_blank" rel="noopener">Wiktionary</a> · <a href="https://www.collinsdictionary.com/dictionary/english/${w}" target="_blank" rel="noopener">Collins</a>`;
  const head = `<button class="ghost" id="defClose">✕</button><b>${esc(w)}</b> `;
  box.hidden = false; box.dataset.w = w;
  box.innerHTML = head + '<span class="muted">looking up…</span>';
  $('#defClose').onclick = () => box.hidden = true;
  let d = null, failed = false;
  try { d = await fetchDef(w); } catch (e) { failed = true; }
  if (box.dataset.w !== w) return;
  const body = d ? (d.via ? `<div class="muted">form of “${esc(d.via)}”</div>` : '') + d.meanings.map(m => `<div><i>${esc(m.pos)}</i> ${esc(m.def)}</div>`).join('')
    : `<div class="muted">${failed ? 'Offline — can’t reach the dictionary service.' : 'No definition found (common for Scrabble-only words).'}</div>`;
  box.innerHTML = head + body + `<div class="links">${links}</div>`;
  $('#defClose').onclick = () => box.hidden = true;
}

// ---------- boards ----------
const DICE = {
  4: 'AAEEGN ABBJOO ACHOPS AFFKPS AOOTTW CIMOTU DEILRX DELRVY DISTTY EEGHNW EEINSU EHRTVW EIOSST ELRTTY HIMNUQ HLNNRZ',
  5: 'AAAFRS AAEEEE AAFIRS ADENNN AEEEEM AEEGMU AEGMNN AFIRSY BJKQXZ CCNSTW CEIILT CEILPT CEIPST DDLNOR DHHLOR DHHNOT DHLNOR EIIITT EMOTTT ENSSSU FIPRSY GORRVW HIPRRY NOOTUW OOOTTU'
};
// 6x6 has no standard dice we can rely on: weighted letter draw instead.
const WEIGHTED = 'eeeeeeeeeeeeaaaaaaaaaiiiiiiiiioooooooonnnnnnrrrrrrttttttllllssssssuuuuddddgggbbccmmppffhhvvwwyykjxqz';
const rnd = n => Math.floor(Math.random() * n);
function newBoard(n) {
  let letters;
  if (DICE[n]) {
    const dice = DICE[n].split(' ').map(d => d[rnd(d.length)]);
    for (let i = dice.length - 1; i > 0; i--) { const j = rnd(i + 1); [dice[i], dice[j]] = [dice[j], dice[i]]; }
    letters = dice.map(c => c.toLowerCase());
  } else {
    letters = Array.from({ length: n * n }, () => WEIGHTED[rnd(WEIGHTED.length)]);
  }
  return letters.map(c => c === 'q' ? 'qu' : c);
}
const nbrCache = {};
function neighbors(n) {
  if (nbrCache[n]) return nbrCache[n];
  const out = [];
  for (let i = 0; i < n * n; i++) {
    const r = Math.floor(i / n), c = i % n, a = [];
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      if (!dr && !dc) continue;
      const rr = r + dr, cc = c + dc;
      if (rr >= 0 && rr < n && cc >= 0 && cc < n) a.push(rr * n + cc);
    }
    out.push(a);
  }
  return nbrCache[n] = out;
}
function solve(tiles, n, minLen, paths, used) {
  const res = new Set(), nb = neighbors(n), seen = new Array(tiles.length).fill(false), cur = [];
  function dfs(i, node, word) {
    let nd = node;
    for (const ch of tiles[i]) { nd = nd[ch]; if (!nd) return; }
    word += tiles[i];
    cur.push(i);
    if (nd.$ && word.length >= minLen) { res.add(word); if (used) for (const k of cur) used[k] = true; if (paths && !paths.has(word)) paths.set(word, cur.slice()); }
    seen[i] = true;
    for (const j of nb[i]) if (!seen[j]) dfs(j, nd, word);
    seen[i] = false;
    cur.pop();
  }
  for (let i = 0; i < tiles.length; i++) dfs(i, trie, '');
  return res;
}
// Non-'any' boards must use every tile in some word, plus a floor on total 3+ letter words (from simulation).
const FLOOR = { any: {}, good: { 4: 60, 5: 185, 6: 245 }, rich: { 4: 90, 5: 240, 6: 335 } };
function richBoard(n) {
  const floor = (FLOOR[settings.quality] || {})[n] || 0;
  let tiles = newBoard(n);
  const ok = t => {                                  // every tile is part of at least one 3+ letter word, and enough words overall
    const used = new Array(n * n).fill(false), cnt = solve(t, n, 3, null, used).size;
    return used.every(Boolean) && cnt >= floor;
  };
  for (let i = 0; i < 300 && settings.quality !== 'any' && !ok(tiles); i++) tiles = newBoard(n);
  return tiles;
}
const PTS = len => len <= 4 ? 1 : len === 5 ? 2 : len === 6 ? 3 : len === 7 ? 5 : 11;

// ---------- morphological families ----------
// roots.js (built by build-words.js from a real lemma list + strict derivational rules) maps word -> [root, form code].
let ROOT = null, members = null;
const FORM = { s: '-s', d: '-ed', i: '-ing', r: 'er/est', o: 'irregular', l: '-ly', n: '-ness', m: '-ment', a: '-able', f: '-ful', x: '-less', g: '-er (agent)' };
function buildFamilies() {
  if (!ROOT) { ROOT = new Map(); for (const e of window.ROOTS.split(' ')) { const [w, r, c] = e.split('>'); ROOT.set(w, [r, c]); } }
  members = new Map();                                    // root -> dictionary words in that family
  for (const w of dict) { const r = (ROOT.get(w) || [w])[0]; if (!members.has(r)) members.set(r, []); members.get(r).push(w); }
}
function family(w) { const e = ROOT.get(w); return e ? { root: e[0], label: FORM[e[1]] || 'other' } : { root: w, label: null }; }
function relatives(w) { const g = members.get(family(w).root); return g ? g.length - (g.includes(w) ? 1 : 0) : 0; }

// ---------- priority model ----------
function famMissRate(root, fams) {
  const g = fams && fams.get(root);
  if (!g) return 0;
  let s = 0, m = 0;
  for (const w of g) { const e = stats[w]; if (e) { s += e[0]; m += e[2]; } }
  return s ? m / s : 0;
}
function groupFamilies() {
  const fams = new Map();
  for (const w in stats) { const r = family(w).root; if (!fams.has(r)) fams.set(r, []); fams.get(r).push(w); }
  return fams;
}
// Learning a word also unlocks its relatives (bake -> bakes, baked, baking, baker), so bigger families rank higher.
const REL_BONUS = 15, REL_CAP = 10;
function priority(w) {
  const e = stats[w];
  if (!e || !e[2]) return 0;
  const [seen, , missed, streak] = e;
  if (streak >= 3) return 0;                               // learned: found 3 times in a row since last miss
  return missed * 100 + seen * 10 + w.length + REL_BONUS * Math.min(relatives(w), REL_CAP);
}

// ---------- rejected swipes ----------
function addReject(w) {
  if (G.practice) return;
  const r = rejects[w] || (rejects[w] = [0, 0]);
  r[0]++; r[1] = Date.now();
  G.rej.set(w, (G.rej.get(w) || 0) + 1);
  store.set('rejects', rejects);
}
function removeReject(w, n) {                             // n = how many swipes to undo; omit to forget the word entirely
  const r = rejects[w];
  if (r) { r[0] -= n === undefined ? r[0] : n; if (r[0] <= 0) delete rejects[w]; }
  if (G && G.rej.has(w)) { const left = G.rej.get(w) - (n === undefined ? G.rej.get(w) : n); left > 0 ? G.rej.set(w, left) : G.rej.delete(w); }
  store.set('rejects', rejects);
}
function nearWord(w) {                                    // a real word the swipe probably meant (extra suffix on a real word)
  for (let k = 1; k <= 3; k++) { const p = w.slice(0, -k); if (p.length >= 3 && dict.has(p)) return p; }
  return null;
}

// ---------- recording ----------
function record(size, solutions, foundSet, meta) {
  let totalPts = 0, gotPts = 0;
  for (const w of solutions) {
    const e = stats[w] || (stats[w] = [0, 0, 0, 0]);
    e[0]++;
    totalPts += PTS(w.length);
    if (foundSet.has(w)) { e[1]++; e[3]++; gotPts += PTS(w.length); } else { e[2]++; e[3] = 0; }
  }
  games.push(Object.assign({ t: Date.now(), size, found: foundSet.size, total: solutions.size, pts: gotPts, totalPts }, meta));
  if (games.length > 2000) games = games.slice(-2000);
  saveStats(); store.set('games', games);
}

// ---------- game ----------
let G = null;
const sizeFont = n => ({ 4: '2.4rem', 5: '2rem', 6: '1.6rem' }[n]);

function pickSmartBoard(n, minLen) {
  const fams = groupFamilies();
  let best = null, bestScore = -1;
  const tries = n === 6 ? 10 : n === 5 ? 20 : 40;
  for (let i = 0; i < tries; i++) {
    const tiles = richBoard(n), sol = solve(tiles, n, minLen);
    let sc = 0; for (const w of sol) sc += priority(w, fams);
    if (sc > bestScore) { bestScore = sc; best = tiles; }
  }
  return best;
}

function renderBoard(tiles, n) {
  const b = $('#board');
  b.style.gridTemplateColumns = `repeat(${n},1fr)`;
  b.style.fontSize = sizeFont(n);
  b.innerHTML = tiles.map(t => `<div class="cell">${t === 'qu' ? 'Qu' : t}</div>`).join('');
}

function startGame(tiles) {
  const n = settings.size;
  tiles = tiles || (settings.smart ? pickSmartBoard(n, settings.min) : richBoard(n));
  const paths = new Map();
  G = { n, tiles, paths, practice, rej: new Map(), solutions: solve(tiles, n, settings.min, paths), found: new Set(), score: 0, path: [], dur: settings.time, end: Date.now() + settings.time * 1000, over: false };
  $('#setup').hidden = true; $('#results').hidden = true; $('#game').hidden = false;
  renderBoard(tiles, n);
  $('#foundList').innerHTML = '';
  updateHud();
  clearInterval(G.timer);
  G.timer = setInterval(tick, 200);
  tick();
  requestAnimationFrame(clearTrail);
}
function tick() {
  if (!G || G.over) return;
  const left = Math.max(0, G.end - Date.now());
  $('#hudTime').textContent = Math.floor(left / 60000) + ':' + String(Math.ceil(left / 1000) % 60).padStart(2, '0');
  $('#timebar div').style.width = (left / (G.dur * 1000) * 100) + '%';
  if (left <= 0) endGame();
}
function updateHud() {
  $('#hudScore').textContent = G.score + ' pts';
  $('#hudCount').textContent = G.found.size + ' words';
}
function endGame() {
  if (!G || G.over) return;
  G.over = true; clearInterval(G.timer); G.path = []; clearTrail();
  if (!G.practice) record(G.n, G.solutions, G.found, { src: 'trainer', time: G.dur });
  showResults();
}
function showResults() {
  const fams = groupFamilies();
  const missed = [...G.solutions].filter(w => !G.found.has(w));
  missed.sort((a, b) => (priority(b, fams) - priority(a, fams)) || (b.length - a.length));
  const totalPts = [...G.solutions].reduce((s, w) => s + PTS(w.length), 0);
  const chip = w => { const f = family(w); return `<span class="chip bad" data-w="${w}" title="${f.root !== w ? 'family: ' + f.root : ''}">${w}${f.root !== w ? ` <span class="fam">← ${f.root}</span>` : ''}</span> `; };
  $('#game').hidden = true;
  const r = $('#results'); r.hidden = false;
  r.innerHTML = `<div id="rSticky"><div id="rBoardWrap" class="boardWrap"><div id="rBoard" class="board"></div><svg id="rTrail" class="trail"></svg></div><div id="rCur">&nbsp;</div></div>
    <div class="card"><h2>Results</h2>
    ${G.practice ? '<p class="chip">🕶 Practice game — nothing was saved to your stats.</p>' : ''}
    <p><b>${G.found.size}</b> of ${G.solutions.size} words · <b>${G.score}</b> of ${totalPts} pts (${Math.round(100 * G.score / (totalPts || 1))}%)</p>
    <div class="row"><button id="rAgain">Play again</button><button id="rSame" class="ghost">Replay this board</button></div></div>
    <div class="card"><h2>Missed words (${missed.length}) — most important first</h2>
      ${missed.slice(0, 60).map(chip).join('')}
      ${missed.length > 60 ? `<details><summary>${missed.length - 60} more</summary>${missed.slice(60).map(chip).join('')}</details>` : ''}</div>
    ${G.rej.size ? `<div class="card" id="rejCard"><h2>Rejected swipes (${G.rej.size})</h2><p class="muted">Words you tried that aren't valid. Tap ✕ if it was just a misswipe.</p>
      ${[...G.rej].map(([w, c]) => { const nw = nearWord(w); return `<span class="chip rej" data-w="${w}">${w}${c > 1 ? ' ×' + c : ''}${nw ? ` <span class="fam">≈ ${nw}</span>` : ''} <button class="x" data-rm="${w}" title="misswipe">✕</button></span> `; }).join('')}</div>` : ''}
    <div class="card"><h2>Found (${G.found.size})</h2>${[...G.found].sort((a, b) => b.length - a.length).map(w => `<span class="chip good" data-w="${w}">${w}</span> `).join('')}</div>`;
  const rb = $('#rBoard');
  rb.style.gridTemplateColumns = `repeat(${G.n},1fr)`; rb.style.fontSize = sizeFont(G.n);
  rb.innerHTML = G.tiles.map(t => `<div class="cell">${t === 'qu' ? 'Qu' : t}</div>`).join('');
  let pinned = null;
  const show = w => {
    const path = w && G.paths.get(w), wr = $('#rBoardWrap').getBoundingClientRect();
    const cs = [...rb.children].map(c => { const q = c.getBoundingClientRect(); return { x: q.left - wr.left + q.width / 2, y: q.top - wr.top + q.height / 2, r: q.width }; });
    $('#rTrail').setAttribute('viewBox', `0 0 ${wr.width} ${wr.height}`);
    $('#rTrail').innerHTML = path && path.length > 1 ? arrowTrail(path, cs) : '';
    [...rb.children].forEach((c, i) => { c.classList.toggle('sel', !!path && path.includes(i)); c.classList.toggle('last', !!path && path[path.length - 1] === i); c.classList.toggle('first', !!path && path[0] === i); });
    $('#rCur').textContent = w || ' ';
  };
  r.querySelectorAll('[data-w]').forEach(c => {
    c.onmouseenter = () => show(c.dataset.w);
    c.onmouseleave = () => show(pinned);
    c.onclick = () => { pinned = pinned === c.dataset.w ? null : c.dataset.w; show(pinned); if (pinned) showDef(pinned); };
  });
  r.querySelectorAll('[data-rm]').forEach(b => b.onclick = e => {
    e.stopPropagation(); removeReject(b.dataset.rm); b.closest('.chip').remove();
    if (!G.rej.size) { const c = $('#rejCard'); if (c) c.remove(); }
  });
  $('#rAgain').onclick = () => { $('#results').hidden = true; $('#setup').hidden = false; };
  $('#rSame').onclick = () => startGame(G.tiles);
}

// Path line with a direction arrowhead on every step.
function arrowTrail(path, cs) {
  const r = cs[0].r, w = r * 0.12, h = r * 0.32;
  let out = `<polyline stroke-width="${w}" points="${path.map(i => cs[i].x + ',' + cs[i].y).join(' ')}"/>`;
  for (let k = 1; k < path.length; k++) {
    const a = cs[path[k - 1]], b = cs[path[k]], d = Math.hypot(b.x - a.x, b.y - a.y), ux = (b.x - a.x) / d, uy = (b.y - a.y) / d;
    const tx = b.x - ux * r * 0.3, ty = b.y - uy * r * 0.3;          // tip sits just before the next tile centre
    const bx = tx - ux * h, by = ty - uy * h, px = -uy * h * 0.65, py = ux * h * 0.65;
    out += `<polygon class="head" points="${tx},${ty} ${bx + px},${by + py} ${bx - px},${by - py}"/>`;
  }
  return out;
}

// ---------- swiping ----------
const cells = () => $$('#board .cell');
function cellCenters() {
  const wr = $('#boardWrap').getBoundingClientRect();
  return cells().map(c => { const r = c.getBoundingClientRect(); return { x: r.left - wr.left + r.width / 2, y: r.top - wr.top + r.height / 2, r: r.width }; });
}
function hit(e) {
  const wr = $('#boardWrap').getBoundingClientRect(), px = e.clientX - wr.left, py = e.clientY - wr.top;
  const cs = cellCenters();
  for (let i = 0; i < cs.length; i++) if (Math.hypot(px - cs[i].x, py - cs[i].y) < cs[i].r * 0.42) return i;
  return -1;
}
function clearTrail() {
  const wr = $('#boardWrap').getBoundingClientRect();
  $('#trail').setAttribute('viewBox', `0 0 ${wr.width} ${wr.height}`);
  $('#trail').innerHTML = '';
  cells().forEach(c => c.classList.remove('sel', 'last'));
}
function drawPath() {
  const cs = cellCenters(), wr = $('#boardWrap').getBoundingClientRect();
  $('#trail').setAttribute('viewBox', `0 0 ${wr.width} ${wr.height}`);
  $('#trail').innerHTML = G.path.length > 1 ? `<polyline stroke-width="${cs[0].r * 0.18}" points="${G.path.map(i => cs[i].x + ',' + cs[i].y).join(' ')}"/>` : '';
  cells().forEach((c, i) => { c.classList.toggle('sel', G.path.includes(i)); c.classList.toggle('last', G.path[G.path.length - 1] === i); });
  const cur = $('#current'); cur.className = ''; cur.textContent = G.path.map(i => G.tiles[i]).join('') || ' ';
}
function pathWord() { return G.path.map(i => G.tiles[i]).join(''); }
function feedback(cls, text) {
  const cur = $('#current'); cur.className = cls; cur.textContent = text;
  if (cls === 'no') { cur.classList.add('shake'); }
  setTimeout(() => { if (!G.path.length) { cur.className = ''; cur.innerHTML = '&nbsp;'; } }, 700);
}
let undoTimer = null;
function offerUndo(w) {
  if (G.practice) return;
  const b = $('#undoRej');
  b.textContent = '✕ misswipe — forget “' + w + '”'; b.hidden = false;
  b.onclick = () => { removeReject(w, 1); b.hidden = true; };
  clearTimeout(undoTimer); undoTimer = setTimeout(() => b.hidden = true, 3500);
}
function submit() {
  const w = pathWord();
  if (!w) return;
  if (w.length < settings.min) { /* ignore accidental taps */ }
  else if (G.found.has(w)) { sfx('dup'); feedback('no', w + ' (already)'); }
  else if (dict.has(w)) {
    G.found.add(w); G.score += PTS(w.length); updateHud();
    const s = document.createElement('span'); s.textContent = w; $('#foundList').prepend(s);
    sfx('ok', w.length); feedback('ok', w + ' +' + PTS(w.length));
    if (navigator.vibrate) navigator.vibrate(15);
  } else {
    sfx('no'); feedback('no', w);
    if (w.length >= settings.min) { addReject(w); offerUndo(w); }
  }
  G.path = []; clearTrail();
}
function initSwipe() {
  const wrap = $('#boardWrap');
  let down = false;
  wrap.addEventListener('pointerdown', e => {
    if (!G || G.over) return;
    down = true; wrap.setPointerCapture(e.pointerId);
    G.path = []; move(e); e.preventDefault();
  });
  function move(e) {
    if (!down || !G || G.over) return;
    const i = hit(e);
    if (i < 0) return;
    const p = G.path, last = p[p.length - 1];
    if (i === last) return;
    if (p.length > 1 && i === p[p.length - 2]) p.pop();                         // backtrack
    else if (!p.includes(i) && (last === undefined || neighbors(G.n)[last].includes(i))) p.push(i);
    drawPath();
  }
  wrap.addEventListener('pointermove', move);
  const up = () => { if (!down) return; down = false; if (G && !G.over) submit(); };
  wrap.addEventListener('pointerup', up);
  wrap.addEventListener('pointercancel', up);
  wrap.addEventListener('contextmenu', e => e.preventDefault());
}

// ---------- Learn tab ----------
let comboKind = 'tri';
const COMBO_KINDS = [['bi', '2-letter'], ['tri', '3-letter'], ['pre', 'Starts with'], ['suf', 'Ends with']];
function comboStats(kind) {
  const m = new Map(); let S = 0, F = 0;
  for (const w in stats) {
    const e = stats[w], L = w.length; S += e[0]; F += e[1];
    const gs = new Set();
    if (kind === 'bi') for (let i = 0; i < L - 1; i++) gs.add(w.substr(i, 2));
    else if (kind === 'tri') for (let i = 0; i < L - 2; i++) gs.add(w.substr(i, 3));
    else if (kind === 'pre') gs.add(w.slice(0, 3));
    else gs.add(w.slice(-3));
    for (const g of gs) {
      let r = m.get(g); if (!r) { r = { g, seen: 0, found: 0, missed: 0, words: [] }; m.set(g, r); }
      r.seen += e[0]; r.found += e[1]; r.missed += e[2]; if (e[2]) r.words.push(w);
    }
  }
  const base = S ? F / S : 0;
  // excess misses = misses beyond what the overall find rate predicts for this many appearances
  return [...m.values()].map(r => Object.assign(r, { excess: r.missed - r.seen * (1 - base) })).filter(r => r.seen >= 15 && r.excess > 0).sort((a, b) => b.excess - a.excess).slice(0, 40);
}
function combosView() {
  const rows = comboStats(comboKind);
  const sub = `<div class="tabs2">${COMBO_KINDS.map(([k, l]) => `<button data-ck="${k}" class="${comboKind === k ? 'on' : ''}">${l}</button>`).join('')}</div>`;
  return `<div class="card">${sub}<p class="muted">Letter patterns you miss more often than your overall find rate predicts (at least 15 appearances). Open one to see the missed words that contain it.</p>
    ${rows.map(r => `<details><summary><b class="gram">${r.g}</b> <span class="fam">found ${r.found}/${r.seen} (${Math.round(100 * r.found / r.seen)}%) · ${r.missed} missed</span></summary>${r.words.sort((a, b) => stats[b][2] - stats[a][2]).slice(0, 14).map(w => `<span class="chip bad" data-w="${w}">${w.split(r.g).join('<u>' + r.g + '</u>')}</span> `).join('')}</details>`).join('') || '<p class="muted">Not enough data yet.</p>'}</div>`;
}
function rejectsView() {
  const rows = Object.entries(rejects).sort((a, b) => b[1][0] - a[1][0] || b[1][1] - a[1][1]);
  return `<div class="card"><p class="muted">Words you swiped that the dictionary rejected. Repeats are words you believe are valid. Remove anything that was just a misswipe. Click a word to look it up.</p>
    ${rows.length ? `<table><tr><th>Word</th><th class="n">Times</th><th>Looks like</th><th>Last</th><th></th></tr>${rows.map(([w, [c, t]]) => { const nw = nearWord(w); return `<tr class="lw" data-w="${w}"><td><b>${w}</b></td><td class="n">${c}</td><td class="fam">${nw ? nw + ' + ' + w.slice(nw.length) : '—'}</td><td class="fam">${new Date(t).toLocaleDateString()}</td><td><button class="ghost x" data-rm="${w}">✕ misswipe</button></td></tr>`; }).join('')}</table>
    <div class="row" style="margin-top:10px"><button class="ghost danger" id="rejClear">Clear all</button></div>` : '<p class="muted">Nothing rejected yet.</p>'}</div>`;
}
let learnView = 'words';
function renderLearn() {
  const el = $('#tab-learn');
  const fams = groupFamilies();
  const tabs = `<div class="tabs2">${[['words', 'Words to learn'], ['families', 'Families'], ['patterns', 'Patterns'], ['combos', 'Letter combos'], ['rejects', 'Rejected']].map(([k, l]) => `<button data-v="${k}" class="${learnView === k ? 'on' : ''}">${l}</button>`).join('')}</div>`;
  let body = '';
  if (learnView === 'rejects') body = rejectsView();
  else if (learnView === 'combos' && Object.keys(stats).length) body = combosView();
  else if (!Object.keys(stats).length) body = '<div class="card muted">Play a game first. Every word on every board counts as an appearance; each one you miss is added here.</div>';
  else if (learnView === 'words') {
    const rows = Object.keys(stats).map(w => [w, priority(w, fams)]).filter(x => x[1] > 0).sort((a, b) => b[1] - a[1]).slice(0, 150);
    const max = rows.length ? rows[0][1] : 1;
    body = `<div class="card"><p class="muted">Priority = Missed × 100 + Seen × 10 + Length + 15 × related forms (max 10). Three finds in a row marks a word learned and removes it from the list.</p><table>
      <tr><th>Word</th><th>Family</th><th class="n">Len</th><th class="n">Seen</th><th class="n">Missed</th><th class="n">Rel</th><th>Priority</th></tr>
      ${rows.map(([w, p]) => { const e = stats[w], f = family(w); return `<tr class="lw" data-w="${w}"><td><b>${w}</b></td><td class="fam">${f.root !== w ? f.root + ' ' + (f.label || '') : '—'}</td><td class="n">${w.length}</td><td class="n">${e[0]}</td><td class="n">${e[2]}</td><td class="n">${relatives(w)}</td><td><span class="bar" style="width:${Math.max(4, 90 * p / max)}px"></span> ${p}</td></tr>`; }).join('')}</table></div>`;
  } else if (learnView === 'families') {
    const rows = [...fams.entries()].map(([root, ws]) => {
      let tot = 0; const m = ws.filter(w => stats[w][2] > 0 && stats[w][3] < 3);
      m.forEach(w => tot += priority(w, fams));
      return { root, ws, tot, nm: m.length };
    }).filter(x => x.ws.length > 1 && x.tot > 0).sort((a, b) => b.tot - a.tot).slice(0, 80);
    body = `<div class="card"><p class="muted">Word families where you keep missing members. Green = you usually find it, red = you usually miss it.</p>
      ${rows.map(r => `<details><summary><b>${r.root}</b> <span class="fam">— ${r.nm} of ${r.ws.length} weak</span></summary>${r.ws.sort().map(w => { const e = stats[w], rate = e[1] / e[0]; return `<span class="chip ${rate >= .6 ? 'good' : 'bad'}" data-w="${w}">${w} ${e[1]}/${e[0]}</span> `; }).join('')}</details>`).join('') || '<p class="muted">Not enough data yet.</p>'}</div>`;
  } else {
    const byLabel = {}, byLen = {};
    for (const w in stats) {
      const e = stats[w], l = family(w).label || 'base word';
      (byLabel[l] = byLabel[l] || [0, 0])[0] += e[0]; byLabel[l][1] += e[1];
      const L = Math.min(w.length, 9);
      (byLen[L] = byLen[L] || [0, 0])[0] += e[0]; byLen[L][1] += e[1];
    }
    const tbl = (obj, name, keyFmt) => `<table><tr><th>${name}</th><th class="n">Seen</th><th class="n">Found</th><th>Find rate</th></tr>${Object.entries(obj).sort((a, b) => a[1][1] / a[1][0] - b[1][1] / b[1][0]).map(([k, [s, f]]) => `<tr><td>${keyFmt(k)}</td><td class="n">${s}</td><td class="n">${f}</td><td><span class="bar" style="width:${90 * f / s}px"></span> ${Math.round(100 * f / s)}%</td></tr>`).join('')}</table>`;
    body = `<div class="card"><h2>By word form</h2><p class="muted">Weakest first. A low rate on -ing / -ed / -s means you're missing inflections of words you already see.</p>${tbl(byLabel, 'Form', k => k)}</div>
      <div class="card"><h2>By length</h2>${tbl(byLen, 'Length', k => k >= 9 ? '9+' : k)}</div>`;
  }
  el.innerHTML = tabs + body;
  $$('#tab-learn [data-w]').forEach(c => c.onclick = e => { if (e.target.closest('[data-rm]')) return; e.preventDefault(); showDef(c.dataset.w); });
  $$('#tab-learn [data-ck]').forEach(b => b.onclick = () => { comboKind = b.dataset.ck; renderLearn(); });
  $$('#tab-learn [data-rm]').forEach(b => b.onclick = e => { e.stopPropagation(); removeReject(b.dataset.rm); renderLearn(); });
  const rc = $('#rejClear'); if (rc) rc.onclick = () => { if (confirm('Clear the whole rejected list?')) { rejects = {}; store.set('rejects', rejects); renderLearn(); } };
  $$('#tab-learn .tabs2 button[data-v]').forEach(b => b.onclick = () => { learnView = b.dataset.v; renderLearn(); });
}

// ---------- Stats tab ----------
function renderStats() {
  const el = $('#tab-stats');
  if (!games.length) { el.innerHTML = '<div class="card muted">No games yet.</div>'; return; }
  const bySize = {};
  games.forEach(g => { const b = bySize[g.size] || (bySize[g.size] = { n: 0, found: 0, total: 0, pts: 0, tp: 0 }); b.n++; b.found += g.found; b.total += g.total; b.pts += g.pts; b.tp += g.totalPts; });
  const recent = games.slice(-15).reverse();
  el.innerHTML = `<div class="card"><h2>By board size</h2><table><tr><th>Size</th><th class="n">Games</th><th class="n">Words</th><th class="n">Points captured</th></tr>
    ${Object.entries(bySize).map(([s, b]) => `<tr><td>${s}×${s}</td><td class="n">${b.n}</td><td class="n">${Math.round(100 * b.found / b.total)}%</td><td class="n">${Math.round(100 * b.pts / b.tp)}%</td></tr>`).join('')}</table></div>
    <div class="card"><h2>Recent games</h2><table><tr><th>When</th><th>Size</th><th>Source</th><th class="n">Found</th><th class="n">Pts</th></tr>
    ${recent.map(g => `<tr><td>${new Date(g.t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</td><td>${g.size}×${g.size}</td><td>${g.src}</td><td class="n">${g.found}/${g.total}</td><td class="n">${g.pts}/${g.totalPts}</td></tr>`).join('')}</table></div>
    <div class="card muted">${Object.keys(stats).length} distinct words tracked.</div>`;
}

// ---------- Tools tab ----------
function parseBoard(text, n) {
  const s = text.toLowerCase().replace(/[^a-z]/g, '');
  const tiles = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === 'q') { tiles.push('qu'); if (s[i + 1] === 'u') i++; } else tiles.push(s[i]);
  }
  return tiles.length === n * n ? tiles : null;
}
function nfBoard() {
  const n = +$('#nfSize').value, tiles = parseBoard($('#nfLetters').value, n);
  if (!tiles) { $('#nfMsg').textContent = `Need exactly ${n * n} tiles (Q counts as one Qu tile).`; return null; }
  $('#nfMsg').textContent = ''; return { n, tiles };
}
function renderDictLists() {
  $('#dictLists').innerHTML = `Rejected: ${dictEx.ban.map(w => `<span class="chip" data-un="ban:${w}">${w} ✕</span>`).join(' ') || 'none'}<br>Added: ${dictEx.add.map(w => `<span class="chip" data-un="add:${w}">${w} ✕</span>`).join(' ') || 'none'}`;
  $$('#dictLists [data-un]').forEach(c => c.onclick = () => { const [k, w] = c.dataset.un.split(':'); dictEx[k] = dictEx[k].filter(x => x !== w); store.set('dict', dictEx); buildDict(); renderDictLists(); });
}
function initTools() {
  $('#nfPlay').onclick = () => {
    const b = nfBoard(); if (!b) return;
    settings.size = b.n; $('#optSize').value = b.n;
    switchTab('play'); startGame(b.tiles);
  };
  $('#nfLog').onclick = () => {
    const b = nfBoard(); if (!b) return;
    if (practice) { $('#nfMsg').textContent = 'Practice mode is on, so results would not be saved. Turn it off in the header to log this board.'; return; }
    const sol = [...solve(b.tiles, b.n, settings.min)].sort((a, c) => c.length - a.length || a.localeCompare(c));
    $('#nfOut').innerHTML = `<p><b>${sol.length}</b> words on this board. Tick the ones you found on Netflix:</p>
      ${sol.map(w => `<label class="wordcheck"><input type="checkbox" value="${w}">${w}</label>`).join('')}
      <div class="row"><button id="nfSave">Save result</button></div>`;
    $('#nfSave').onclick = () => {
      const found = new Set($$('#nfOut input:checked').map(i => i.value));
      record(b.n, new Set(sol), found, { src: 'netflix' });
      $('#nfOut').innerHTML = `<p class="chip good">Saved: ${found.size} of ${sol.length} words logged.</p>`;
    };
  };
  const exc = kind => () => {
    const w = $('#dictWord').value.trim().toLowerCase();
    if (!/^[a-z]{3,}$/.test(w)) return;
    const other = kind === 'ban' ? 'add' : 'ban';
    dictEx[other] = dictEx[other].filter(x => x !== w);
    if (!dictEx[kind].includes(w)) dictEx[kind].push(w);
    store.set('dict', dictEx); buildDict(); renderDictLists(); $('#dictWord').value = '';
  };
  $('#dictBan').onclick = exc('ban'); $('#dictAdd').onclick = exc('add');
  renderDictLists();
  $('#btnExport').onclick = () => {
    const blob = new Blob([JSON.stringify({ stats, games, dictEx, settings, rejects })], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'boggle-trainer-data.json'; a.click();
  };
  $('#fileImport').onchange = async e => {
    try {
      const d = JSON.parse(await e.target.files[0].text());
      stats = d.stats || {}; games = d.games || []; dictEx = d.dictEx || { ban: [], add: [] }; rejects = d.rejects || {}; store.set('rejects', rejects);
      saveStats(); store.set('games', games); store.set('dict', dictEx); buildDict(); renderDictLists(); alert('Imported.');
    } catch (err) { alert('Import failed: ' + err.message); }
  };
  $('#btnReset').onclick = () => { if (confirm('Delete all stats and game history?')) { stats = {}; games = []; rejects = {}; store.set('rejects', rejects); saveStats(); store.set('games', games); } };
}

// ---------- simulator ----------
// Generates boards exactly like the game does and counts how many boards each word (and word family) appears on.
let sim = null, simView = 'words';
function simRows() {
  const src = simView === 'words' ? sim.words : sim.fams;
  return [...src.entries()].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length).slice(0, 150);
}
function renderSimResults() {
  const el = $('#simOut');
  if (!sim) { el.innerHTML = ''; return; }
  const n = sim.done, pct = c => (100 * c / n).toFixed(1) + '%';
  const rows = simRows();
  const lens = Object.entries(sim.byLen).sort((a, b) => a[0] - b[0]).map(([l, c]) => `<tr><td>${l >= 8 ? '8+' : l}</td><td class="n">${(c / n).toFixed(1)}</td></tr>`).join('');
  const body = simView === 'words'
    ? `<tr><th>Word</th><th class="n">Len</th><th class="n">Boards</th><th class="n">Chance</th><th class="n">Your find rate</th></tr>` + rows.map(([w, c]) => {
        const e = stats[w];
        return `<tr class="lw" data-w="${w}"><td><b>${w}</b></td><td class="n">${w.length}</td><td class="n">${c}</td><td class="n">${pct(c)}</td><td class="n fam">${e ? Math.round(100 * e[1] / e[0]) + '% of ' + e[0] : '—'}</td></tr>`;
      }).join('')
    : `<tr><th>Family root</th><th>Family forms</th><th class="n">Boards</th><th class="n">Chance</th></tr>` + rows.map(([r, c]) => {
        const g = (members.get(r) || []).slice(0, 6).join(', ');
        return `<tr class="lw" data-w="${r}"><td><b>${r}</b></td><td class="fam">${g}${(members.get(r) || []).length > 6 ? ', …' : ''}</td><td class="n">${c}</td><td class="n">${pct(c)}</td></tr>`;
      }).join('');
  el.innerHTML = `<div class="card"><h2>${n.toLocaleString()} ${sim.size}×${sim.size} boards${sim.done < sim.total ? ' (stopped early)' : ''}</h2>
    <p class="muted">Average ${(sim.totalWords / n).toFixed(0)} words per board (min length ${sim.min}), ${sim.words.size.toLocaleString()} distinct words seen. “Chance” is the share of boards the word appears on at least once.</p>
    <details><summary>Average words per board by length</summary><table style="max-width:260px"><tr><th>Length</th><th class="n">Words</th></tr>${lens}</table></details></div>
    <div class="card"><div class="tabs2"><button data-sv="words" class="${simView === 'words' ? 'on' : ''}">Words</button><button data-sv="fams" class="${simView === 'fams' ? 'on' : ''}">Families</button></div>
    <table>${body}</table></div>`;
  $$('#simOut [data-sv]').forEach(b => b.onclick = () => { simView = b.dataset.sv; renderSimResults(); });
  $$('#simOut [data-w]').forEach(r => r.onclick = () => showDef(r.dataset.w));
}
let simStop = false;
function runSim() {
  const size = +$('#simSize').value, total = Math.max(1, Math.min(20000, +$('#simRuns').value || 1000)), min = +$('#simMin').value;
  sim = { size, total, min, done: 0, words: new Map(), fams: new Map(), byLen: {}, totalWords: 0 };
  simStop = false;
  $('#simGo').hidden = true; $('#simStop').hidden = false;
  const step = () => {
    const t0 = performance.now();
    while (sim.done < total && !simStop && performance.now() - t0 < 40) {
      const sol = solve(richBoard(size), size, min), roots = new Set();
      for (const w of sol) {
        sim.words.set(w, (sim.words.get(w) || 0) + 1);
        roots.add(family(w).root);
        const L = Math.min(w.length, 8); sim.byLen[L] = (sim.byLen[L] || 0) + 1;
      }
      for (const r of roots) sim.fams.set(r, (sim.fams.get(r) || 0) + 1);
      sim.totalWords += sol.size; sim.done++;
    }
    $('#simProg').textContent = `${sim.done} / ${total}`;
    if (sim.done < total && !simStop) { setTimeout(step, 0); if (sim.done % 100 < 5) renderSimResults(); }
    else { $('#simGo').hidden = false; $('#simStop').hidden = true; $('#simProg').textContent = ''; renderSimResults(); }
  };
  step();
}
function initSim() {
  $('#simGo').onclick = runSim;
  $('#simStop').onclick = () => { simStop = true; };
}

// ---------- tabs / setup ----------
function switchTab(t) {
  $$('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === t));
  $$('main > section').forEach(s => s.hidden = s.id !== 'tab-' + t);
  if (t === 'learn') renderLearn();
  if (t === 'stats') renderStats();
}
function initProfiles() {
  const sel = $('#profileSel');
  sel.innerHTML = profiles.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
  sel.value = pid;
  const switchTo = id => { try { localStorage.setItem('bt.profile', JSON.stringify(id)); } catch (e) { /* ignore */ } location.reload(); };
  const saveList = () => localStorage.setItem('bt.profiles', JSON.stringify(profiles));
  sel.onchange = () => switchTo(sel.value);
  $('#profNew').onclick = () => {
    const name = (prompt('Name for the new profile:') || '').trim();
    if (!name) return;
    const id = 'p' + Date.now().toString(36);
    profiles.push({ id, name }); saveList(); switchTo(id);
  };
  $('#profRename').onclick = () => {
    const p = profiles.find(x => x.id === pid), name = (prompt('Rename profile:', p.name) || '').trim();
    if (!name) return;
    p.name = name; saveList(); location.reload();
  };
  $('#profDelete').onclick = () => {
    if (profiles.length < 2) { alert('You need at least one profile.'); return; }
    const p = profiles.find(x => x.id === pid);
    if (!confirm(`Delete profile "${p.name}" and all of its stats? This cannot be undone.`)) return;
    ['stats', 'games', 'rejects', 'settings'].forEach(k => localStorage.removeItem(keyFor(k, pid)));
    profiles.splice(profiles.indexOf(p), 1); saveList(); switchTo(profiles[0].id);
  };
  const pt = $('#practiceToggle');
  const apply = () => { document.body.classList.toggle('practice', practice); pt.checked = practice; };
  pt.onchange = () => { practice = pt.checked; try { sessionStorage.setItem('bt.practice', practice ? '1' : '0'); } catch (e) { /* ignore */ } apply(); };
  apply();
}
function init() {
  buildDict();
  initProfiles();
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
  $$('#tabs button[data-tab]').forEach(b => b.onclick = () => switchTab(b.dataset.tab));
  const howto = $('#howto');
  let seen = false; try { seen = !!localStorage.getItem('bt.seenHowto'); } catch (e) { /* ignore */ }
  howto.hidden = seen;
  $('#howtoClose').onclick = () => { howto.hidden = true; try { localStorage.setItem('bt.seenHowto', '1'); } catch (e) { /* ignore */ } };
  $('#helpBtn').onclick = () => { switchTab('play'); howto.hidden = !howto.hidden; if (!howto.hidden) howto.scrollIntoView(); };
  $('#optSize').value = settings.size; $('#optTime').value = settings.time; $('#optMin').value = settings.min; $('#optSmart').checked = settings.smart; $('#optSound').checked = settings.sound; $('#optQuality').value = settings.quality;
  document.addEventListener('pointerdown', () => { if (settings.sound && !actx) sfx('init'); }, { once: true });
  $('#btnStart').onclick = () => {
    settings = { size: +$('#optSize').value, time: +$('#optTime').value, min: +$('#optMin').value, smart: $('#optSmart').checked, sound: $('#optSound').checked, quality: $('#optQuality').value };
    store.set('settings', settings);
    startGame();
  };
  $('#btnEnd').onclick = () => { if (confirm('End this game now?')) endGame(); };
  initSwipe(); initTools(); initSim();
  window.addEventListener('resize', () => { if (G && !G.over) drawPath(); });
  window.__bt = { solve: (t, n, m) => solve(t, n, m || 3), family, dict: () => dict, stats: () => stats };
}
init();
})();
