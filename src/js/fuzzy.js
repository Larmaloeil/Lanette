// Recherche floue : sous-séquence avec bonus (début de mot, lettres consécutives,
// préfixe), insensible à la casse et aux accents. ~0,1 ms pour 500 éléments.

const SEP = /[\s\-_.()\[\]\\/:]/;

export function normalize(s) {
  return (s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/** Score > 0 si `q` (déjà normalisée) correspond à `text` (normalisé), sinon -1. */
export function score(q, text) {
  if (!q) return 0;
  if (!text) return -1;
  const idx = text.indexOf(q);
  if (idx === 0) return 2000 - text.length;
  if (idx > 0) return (SEP.test(text[idx - 1]) ? 1500 : 1000) - idx - text.length * 0.1;

  let ti = 0, s = 0, streak = 0, first = -1;
  for (let qi = 0; qi < q.length; qi++) {
    const c = q[qi];
    if (c === " ") continue;
    let found = false;
    while (ti < text.length) {
      if (text[ti] === c) {
        const wordStart = ti === 0 || SEP.test(text[ti - 1]);
        s += 10 + streak * 6 + (wordStart ? 18 : 0);
        if (first < 0) first = ti;
        streak++;
        ti++;
        found = true;
        break;
      }
      streak = 0;
      ti++;
    }
    if (!found) return -1;
  }
  return s - first * 2 - text.length * 0.1;
}

const cache = new Map();

/** Filtre et trie les éléments. Utilise un cache de chaînes normalisées. */
export function search(items, query, limit = 60) {
  const q = normalize(query.trim());
  if (!q) return [];
  const out = [];
  for (const it of items) {
    let c = cache.get(it.id);
    if (!c || c.raw !== it.name + "|" + it.target) {
      const base = it.target.split(/[\\/]/).pop() || "";
      c = { raw: it.name + "|" + it.target, name: normalize(it.name), base: normalize(base) };
      cache.set(it.id, c);
    }
    const a = score(q, c.name);
    const b = score(q, c.base) * 0.6;
    const best = Math.max(a, b);
    if (best > 0) {
      // Léger bonus aux éléments souvent utilisés.
      out.push({ it, s: best + Math.min(it.launchCount || 0, 50) * 2 + (it.pinned ? 20 : 0) });
    }
  }
  out.sort((x, y) => y.s - x.s);
  return out.slice(0, limit).map((r) => r.it);
}
