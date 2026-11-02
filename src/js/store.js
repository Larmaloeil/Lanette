// État de l'application et opérations sur la configuration.
// Le frontend est la seule source de vérité de la configuration ; chaque
// modification est enregistrée (avec un court délai) par le backend Rust.
import { invoke } from "./api.js";
import { t } from "./i18n.js";
import { toast } from "./ui.js";

export const state = {
  config: null,
  env: {},
  broken: new Set(), // id des éléments dont le chemin n'existe plus
  query: "",
  tab: "all", // "all" ou id de groupe
  selected: 0, // index dans la liste visible
  visible: [], // éléments affichés, dans l'ordre (navigation clavier)
};

export const settings = () => state.config.settings;

let saveTimer = null;
export function save(immediate = false) {
  clearTimeout(saveTimer);
  const run = () =>
    invoke("save_config", { config: state.config }).catch((e) => toast(t("toast.saveError", { error: String(e) }), { kind: "error" }));
  if (immediate) return run();
  saveTimer = setTimeout(run, 250);
}

export function flushSave() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
    return invoke("save_config", { config: state.config }).catch(() => {});
  }
}

export const uid = (p = "i") => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export const findItem = (id) => state.config.items.find((i) => i.id === id);
export const findGroup = (id) => state.config.groups.find((g) => g.id === id);
const normTarget = (s) => (s || "").trim().toLowerCase().replace(/[\\/]+$/, "");

/** Ajoute des éléments en ignorant les doublons (même cible). */
export function addItems(newItems, groupId = null) {
  const existing = new Set(state.config.items.map((i) => normTarget(i.target)));
  const added = [];
  let dupes = 0;
  for (const n of newItems) {
    const key = normTarget(n.target);
    if (!key) continue;
    if (existing.has(key)) {
      dupes++;
      continue;
    }
    existing.add(key);
    const item = {
      id: uid(),
      name: n.name || n.target,
      kind: n.kind || "file",
      target: n.target,
      args: "",
      workdir: "",
      admin: false,
      launchOnStart: false,
      groupId: groupId && findGroup(groupId) ? groupId : null,
      pinned: false,
      icon: null,
      lastLaunched: null,
      launchCount: 0,
      addedAt: Date.now(),
    };
    state.config.items.push(item);
    added.push(item);
  }
  if (added.length) {
    state.config.settings.onboarded = true;
    save();
  }
  if (added.length && dupes) toast(`${t("toast.added", { n: added.length })} · ${t("toast.duplicates", { n: dupes })}`);
  else if (added.length) toast(t("toast.added", { n: added.length }));
  else if (dupes) toast(dupes === 1 ? t("toast.duplicate") : t("toast.duplicates", { n: dupes }));
  return added;
}

/** Retire un élément ; renvoie une fonction d'annulation. */
export function removeItem(id) {
  const items = state.config.items;
  const idx = items.findIndex((i) => i.id === id);
  if (idx < 0) return () => {};
  const [item] = items.splice(idx, 1);
  state.broken.delete(id);
  save();
  return () => {
    if (findItem(item.id)) return;
    items.splice(Math.min(idx, items.length), 0, item);
    save();
  };
}

/**
 * Réordonne un sous-ensemble d'éléments (une section) sans toucher aux
 * autres : les positions occupées par la section dans la liste globale sont
 * remplies dans le nouvel ordre.
 */
export function applySectionOrder(ids) {
  const items = state.config.items;
  const set = new Set(ids);
  const slots = [];
  items.forEach((it, i) => set.has(it.id) && slots.push(i));
  const byId = new Map(items.map((i) => [i.id, i]));
  ids.forEach((id, k) => {
    if (slots[k] != null && byId.has(id)) items[slots[k]] = byId.get(id);
  });
  save();
}

export function moveToGroup(id, groupId) {
  const it = findItem(id);
  if (!it) return;
  it.groupId = groupId;
  // L'élément passe en fin de son nouveau groupe.
  const items = state.config.items;
  items.splice(items.indexOf(it), 1);
  items.push(it);
  save();
}

export function addGroup(name) {
  const g = { id: uid("g"), name };
  state.config.groups.push(g);
  save();
  return g;
}

export function deleteGroup(id) {
  state.config.groups = state.config.groups.filter((g) => g.id !== id);
  state.config.items.forEach((i) => i.groupId === id && (i.groupId = null));
  if (state.tab === id) state.tab = "all";
  save();
}

export function moveGroup(id, delta) {
  const gs = state.config.groups;
  const i = gs.findIndex((g) => g.id === id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= gs.length) return;
  [gs[i], gs[j]] = [gs[j], gs[i]];
  save();
}

/** Vérifie en arrière-plan quels chemins n'existent plus. */
let lastCheck = 0;
export async function checkBroken(force = false) {
  if (!force && Date.now() - lastCheck < 20000) return false;
  lastCheck = Date.now();
  const items = state.config.items;
  if (!items.length) return false;
  const ids = items.map((i) => i.id); // instantané : la liste peut changer pendant l'attente
  try {
    const res = await invoke("check_paths", { items: items.map((i) => ({ kind: i.kind, target: i.target })) });
    const next = new Set();
    res.forEach((ok, k) => !ok && findItem(ids[k]) && next.add(ids[k]));
    const changed = next.size !== state.broken.size || [...next].some((id) => !state.broken.has(id));
    state.broken = next;
    return changed;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Liste « Pour plus tard » : applications détectées, mises de côté.
const laterList = () => (state.config.later ||= []);
export const freshLater = () => laterList().filter((l) => l.fresh);

/**
 * Applications que le backend vient de détecter. Celles déjà présentes dans
 * Lanette (même cible ou même nom) ou déjà en attente sont ignorées ; les
 * autres sont gardées tout de suite dans la liste, marquées « nouvelles ».
 */
export function receiveDetected(cands) {
  const items = state.config.items;
  const targets = new Set([...items, ...laterList()].map((i) => normTarget(i.target)));
  const names = new Set(items.map((i) => (i.name || "").trim().toLowerCase()));
  const fresh = [];
  for (const c of cands || []) {
    const key = normTarget(c.target);
    if (!key || targets.has(key) || names.has((c.name || "").trim().toLowerCase())) continue;
    targets.add(key);
    fresh.push({ name: c.name, kind: c.kind || "lnk", target: c.target, source: c.source || "", addedAt: Date.now(), fresh: true });
  }
  if (fresh.length) {
    state.config.later = [...fresh, ...laterList()];
    save();
  }
  return fresh;
}

export function laterRemove(entries) {
  const drop = new Set(entries.map((e) => normTarget(e.target)));
  state.config.later = laterList().filter((l) => !drop.has(normTarget(l.target)));
  save();
}

/** Ajoute des éléments de la liste dans Lanette et les en retire. */
export function laterAdd(entries, groupId = null) {
  const added = addItems(entries.map((e) => ({ name: e.name, kind: e.kind, target: e.target })), groupId);
  laterRemove(entries);
  return added;
}

export function laterMarkSeen() {
  let changed = false;
  for (const l of laterList()) if (l.fresh) (l.fresh = false), (changed = true);
  if (changed) save();
}
