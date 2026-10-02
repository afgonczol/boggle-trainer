// Builds words.js (ENABLE word list) and roots.js (word -> family root) so index.html works from file:// with no server.
//   data/enable1.txt          ENABLE word list
//   data/lemmatization-en.txt michmech/lemmatization-lists ("lemma<TAB>inflected" pairs: real inflections incl. irregulars)
const fs = require('fs');
const read = f => fs.readFileSync(__dirname + '/data/' + f, 'utf8').replace(/^﻿/, '').split(/\r?\n/);

const words = read('enable1.txt').map(w => w.trim().toLowerCase()).filter(w => /^[a-z]{3,}$/.test(w));
const dict = new Set(words);
const allWords = new Set(read('enable1.txt').map(w => w.trim().toLowerCase()).filter(w => /^[a-z]+$/.test(w)));   // roots may be 2 letters (go -> went/gone)
fs.writeFileSync(__dirname + '/words.js', 'window.WORDS="' + words.join(' ') + '";\n');

// inflected -> best lemma that is itself in the dictionary (longest shared prefix, then shortest)
const BLOCK = new Set(['number', 'liver']);   // known-bad pairs in the lemma list (number<-numb, liver<-live)
const lemmas = new Map(), forms = new Map();   // forms: lemma -> all inflected forms listed
const common = (a, b) => { let i = 0; while (i < a.length && a[i] === b[i]) i++; return i; };
for (const line of read('lemmatization-en.txt')) {
  const [lemma, infl] = line.split('\t').map(x => (x || '').trim().toLowerCase());
  if (BLOCK.has(infl) || !lemma || !infl || lemma === infl || !allWords.has(lemma) || !dict.has(infl)) continue;
  if (!forms.has(lemma)) forms.set(lemma, new Set());
  forms.get(lemma).add(infl);
  const cur = lemmas.get(infl);
  const better = !cur || common(lemma, infl) > common(cur, infl) || (common(lemma, infl) === common(cur, infl) && lemma.length < cur.length);
  if (better) lemmas.set(infl, lemma);
}

// A comparative/superlative claim is only believed if the lemma has both an -er and an -est form (big: bigger+biggest; numb: number only -> noise)
for (const [infl, lemma] of [...lemmas]) {
  if (/(ier|er)$/.test(infl) && labelFor(infl, lemma) === 'r') {
    const f = forms.get(lemma);
    if (![...f].some(x => /(iest|est)$/.test(x))) lemmas.delete(infl);
  }
}

// Derivational endings the lemma list does not cover. Deliberately strict: stem must be a dictionary word of >= minStem letters.
const DERIV = [
  ['ily', 'y', 'l', 3], ['ly', '', 'l', 4], ['ness', '', 'n', 4], ['ments', '', 'm', 4], ['ment', '', 'm', 4],
  ['able', '', 'a', 4], ['ably', '', 'a', 4], ['ful', '', 'f', 4], ['less', '', 'x', 4],
  ['er', '', 'g', 5], ['er', 'e', 'g', 5], ['ers', '', 'g', 5]
];
function step(w) {
  const l = lemmas.get(w);
  if (l) return { root: l, code: labelFor(w, l) };
  for (const [suf, rep, code, minStem] of DERIV) {
    if (!w.endsWith(suf)) continue;
    const base = w.slice(0, -suf.length);
    const cands = [base + rep];
    if (/([^aeiou])\1$/.test(base) && !rep) cands.push(base.slice(0, -1));
    for (const s of cands) if (s.length >= minStem && s !== w && allWords.has(s)) return { root: s, code };
  }
  return null;
}
// one-letter form code: s = plural/3rd person, d = -ed/past, i = -ing, r = comparative/superlative, o = irregular,
// l = -ly, n = -ness, m = -ment, a = -able, f = -ful, x = -less, g = agent -er
function labelFor(w, l) {
  if (/ing$/.test(w)) return 'i';
  if (/(ed|d)$/.test(w) && w.length > l.length) return 'd';
  if (/(ier|iest|er|est)$/.test(w) && !/s$/.test(l)) return 'r';
  if (/s$/.test(w) && w.length > l.length) return 's';
  return 'o';
}

const out = [];
let n = 0;
for (const w of words) {
  let root = w, code = null, seen = new Set([w]);
  for (let d = 0; d < 4; d++) {
    const s = step(root);
    if (!s || seen.has(s.root)) break;
    if (!code) code = s.code;
    seen.add(s.root); root = s.root;
  }
  if (root !== w) { out.push(w + '>' + root + '>' + code); n++; }
}
fs.writeFileSync(__dirname + '/roots.js', 'window.ROOTS="' + out.join(' ') + '";\n');
console.log(words.length + ' words, ' + n + ' with a root');
