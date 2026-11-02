// Rendu des onglets (groupes) et de la grille / liste d'éléments.
import { iconUrl } from "./api.js";
import { search } from "./fuzzy.js";
import { t, formatHotkey } from "./i18n.js";
import { state, settings, findGroup } from "./store.js";
import { h, icon } from "./ui.js";

/** Actions branchées par main.js (évite les imports circulaires). */
export const handlers = {
  importStartMenu: () => {},
  addFiles: () => {},
  addFromQuery: () => {},
};

const GRID_ICON = { s: 32, m: 44, l: 60 };
const LIST_ICON = { s: 22, m: 28, l: 36 };
const MAX_RECENTS = 8;

export const looksLikeUrl = (q) =>
  /^[a-z][a-z0-9+.-]*:\/\/\S+$/i.test(q) || /^(www\.)?[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}(\/\S*)?$/i.test(q);
export const looksLikePath = (q) => /^([a-z]:\\|\\\\[^\\]+\\)/i.test(q);

// ---------------------------------------------------------------------------
// Onglets
export function renderTabs() {
  const nav = document.getElementById("tabs");
  const counts = new Map();
  for (const it of state.config.items) counts.set(it.groupId, (counts.get(it.groupId) || 0) + 1);
  const tab = (id, label, n) =>
    h(
      "button",
      { class: `tab ${state.tab === id ? "active" : ""}`, type: "button", role: "tab", "aria-selected": String(state.tab === id), dataset: { group: id } },
      h("span", { text: label }),
      n ? h("span", { class: "tab-count", text: n }) : null
    );
  const indicator = h("span", { class: "tab-indicator", "aria-hidden": "true" });
  nav.replaceChildren(
    tab("all", t("tabs.all"), 0),
    ...state.config.groups.map((g) => tab(g.id, g.name, counts.get(g.id) || 0)),
    h("button", { class: "tab tab-add", type: "button", title: t("tabs.newGroup"), "aria-label": t("tabs.newGroup"), dataset: { action: "new-group" } }, icon("plus")),
    indicator
  );
  requestAnimationFrame(moveIndicator);
}

export function moveIndicator() {
  const nav = document.getElementById("tabs");
  const active = nav.querySelector(".tab.active");
  const ind = nav.querySelector(".tab-indicator");
  if (!active || !ind) return;
  const pad = 14;
  const w = Math.max(active.offsetWidth - pad * 2, 12);
  ind.style.transform = `translateX(${active.offsetLeft + pad}px) scaleX(${w / 100})`;
  // Garde l'onglet actif visible si les onglets débordent.
  active.scrollIntoView({ block: "nearest", inline: "nearest" });
}

// ---------------------------------------------------------------------------
// Contenu
function fallbackGlyph(item) {
  if (item.kind === "url") {
    let host = item.target;
    try {
      host = new URL(item.target).hostname.replace(/^www\./, "") || item.name;
    } catch {}
    const letter = (item.name || host || "?").trim().charAt(0).toUpperCase();
    let hash = 0;
    for (const c of host) hash = (hash * 31 + c.charCodeAt(0)) | 0;
    return h("span", { class: "glyph letter", style: { "--hue": String(Math.abs(hash) % 360) }, text: letter });
  }
  const name = { folder: "folder", file: "file", app: "app" }[item.kind] || "app";
  return h("span", { class: "glyph" }, icon(name));
}

function iconEl(item, px) {
  const wrap = h("div", { class: "tile-icon" });
  const url = iconUrl(item, px);
  if (!url) {
    wrap.append(fallbackGlyph(item));
    return wrap;
  }
  const img = h("img", { src: url, alt: "", loading: "lazy", decoding: "async", draggable: "false", width: px, height: px });
  img.addEventListener("error", () => img.replaceWith(fallbackGlyph(item)), { once: true });
  img.addEventListener("load", () => img.classList.add("loaded"), { once: true });
  wrap.append(img);
  return wrap;
}

/** Sous-titre en vue liste : le chemin, ou seulement le type si les chemins sont masqués. */
function subtitle(item) {
  if (item.kind === "app" || settings().hidePaths) return t(`edit.kind.${item.kind}`);
  return item.target + (item.args ? `  ${item.args}` : "");
}

function tileEl(item, list) {
  const size = settings().iconSize;
  const px = list ? LIST_ICON[size] : GRID_ICON[size];
  const broken = state.broken.has(item.id);
  const idx = state.visible.length;
  const el = h(
    "div",
    {
      class: `tile ${broken ? "broken" : ""}`,
      role: "option",
      id: `opt-${idx}`,
      "aria-selected": "false",
      dataset: { id: item.id, idx: String(idx) },
      title: list ? null : item.name,
    },
    iconEl(item, px),
    h(
      "div",
      { class: "tile-text" },
      h("span", { class: "tile-name", text: item.name }),
      list ? h("span", { class: "tile-sub", text: subtitle(item) }) : null
    ),
    h(
      "div",
      { class: "tile-badges" },
      broken ? h("span", { class: "badge warn", title: t("broken.title") }, icon("warning")) : null,
      item.admin ? h("span", { class: "badge", title: t("edit.admin") }, icon("shield")) : null,
      list && item.pinned ? h("span", { class: "badge star" }, icon("star")) : null
    )
  );
  state.visible.push({ item, el });
  return el;
}

function section(key, title, items, { list, reorder, iconName, empty } = {}) {
  const tiles = h("div", { class: "tiles", role: "group", "aria-label": title, dataset: { section: key, reorder: reorder ? "1" : "0" } });
  for (const it of items) tiles.append(tileEl(it, list));
  if (!items.length && empty) tiles.append(h("p", { class: "section-empty muted", text: empty }));
  return h(
    "section",
    { class: "section" },
    title
      ? h("h3", { class: "section-title" }, iconName ? icon(iconName) : null, h("span", { text: title }), items.length ? h("span", { class: "count", text: items.length }) : null)
      : null,
    tiles
  );
}

function emptyState() {
  const hk = formatHotkey(settings().hotkey);
  return h(
    "div",
    { class: "empty" },
    h("div", { class: "empty-logo", "aria-hidden": "true" }, logoSvg()),
    h("h1", { text: t("empty.title") }),
    h("p", { class: "muted", text: t("empty.subtitle") }),
    h(
      "div",
      { class: "empty-actions" },
      h("button", { class: "card primary", type: "button", onclick: () => handlers.importStartMenu() }, icon("import"), h("span", { class: "card-title", text: t("empty.import") }), h("small", { text: t("empty.importSub") })),
      h("button", { class: "card", type: "button", onclick: () => handlers.addFiles() }, icon("plus"), h("span", { class: "card-title", text: t("empty.add") }), h("small", { text: t("empty.addSub") }))
    ),
    h("p", { class: "empty-drop muted" }, icon("download"), h("span", { text: t("empty.drop") })),
    h("p", { class: "empty-tip muted", text: t("empty.hotkey", { hotkey: hk }) })
  );
}

export function logoSvg() {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 64 64");
  svg.innerHTML = `<defs><linearGradient id="lg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#4cc2ff"/><stop offset="1" stop-color="#7a5cff"/></linearGradient></defs>
  <rect x="4" y="4" width="56" height="56" rx="14" fill="url(#lg)"/>
  <rect x="15" y="15" width="11" height="11" rx="3" fill="#fff" opacity=".92"/>
  <rect x="15" y="29" width="11" height="11" rx="3" fill="#fff" opacity=".92"/>
  <rect x="29" y="29" width="11" height="11" rx="3" fill="#fff" opacity=".92"/>
  <path d="M30 26 L40 16 M33 15.5 H40.5 V23" stroke="#fff" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`;
  return svg;
}

export function renderContent() {
  const content = document.getElementById("content");
  const s = settings();
  const items = state.config.items;
  const q = state.query.trim();
  state.visible = [];
  const list = q ? true : s.view === "list";
  content.dataset.view = list ? "list" : "grid";
  content.dataset.size = s.iconSize;

  const frag = document.createDocumentFragment();
  if (!items.length && !q) {
    frag.append(emptyState());
  } else if (q) {
    const results = search(items, q);
    const sec = section("results", t("sections.results"), results, { list: true });
    if (looksLikeUrl(q) || looksLikePath(q)) {
      const label = looksLikeUrl(q) ? t("search.addUrl", { q }) : t("search.addPath", { q });
      const idx = state.visible.length;
      const row = h(
        "div",
        { class: "tile special", role: "option", id: `opt-${idx}`, dataset: { idx: String(idx), special: "add" } },
        h("div", { class: "tile-icon" }, h("span", { class: "glyph accent" }, icon(looksLikeUrl(q) ? "link" : "plus"))),
        h("div", { class: "tile-text" }, h("span", { class: "tile-name", text: label }))
      );
      state.visible.push({ special: "add", el: row });
      sec.querySelector(".tiles").append(row);
    }
    if (!state.visible.length) sec.querySelector(".tiles").append(h("p", { class: "section-empty muted", text: t("search.none", { q }) }));
    frag.append(sec);
  } else if (state.tab === "all") {
    const pinned = items.filter((i) => i.pinned);
    if (pinned.length) frag.append(section("pinned", t("sections.favorites"), pinned, { list, reorder: true, iconName: "star" }));
    if (s.showRecents) {
      const recents = items.filter((i) => i.lastLaunched).sort((a, b) => b.lastLaunched - a.lastLaunched).slice(0, MAX_RECENTS);
      if (recents.length) frag.append(section("recents", t("sections.recents"), recents, { list }));
    }
    for (const g of state.config.groups) {
      const gi = items.filter((i) => i.groupId === g.id && !i.pinned);
      if (gi.length) frag.append(section(`g:${g.id}`, g.name, gi, { list, reorder: true }));
    }
    const loose = items.filter((i) => !i.groupId && !i.pinned);
    if (loose.length) frag.append(section("loose", t("sections.ungrouped"), loose, { list, reorder: true }));
  } else {
    const g = findGroup(state.tab);
    const gi = items.filter((i) => i.groupId === state.tab);
    // Favoris du groupe en tête, puis le reste (ordre manuel conservé).
    const ordered = [...gi.filter((i) => i.pinned), ...gi.filter((i) => !i.pinned)];
    frag.append(section(`g:${state.tab}`, null, ordered, { list, reorder: true, empty: t("sections.emptyGroup") }));
    if (!g) state.tab = "all";
  }
  content.replaceChildren(frag);
  state.selected = Math.min(state.selected, Math.max(state.visible.length - 1, 0));
  updateSelection(false);
}

export function render() {
  renderTabs();
  renderContent();
}

// ---------------------------------------------------------------------------
// Sélection (le focus reste dans la barre de recherche)
export function updateSelection(scroll = true) {
  const search = document.getElementById("search");
  document.querySelectorAll("#content .tile.selected").forEach((e) => {
    e.classList.remove("selected");
    e.setAttribute("aria-selected", "false");
  });
  const cur = state.visible[state.selected];
  if (!cur) {
    search.removeAttribute("aria-activedescendant");
    return;
  }
  cur.el.classList.add("selected");
  cur.el.setAttribute("aria-selected", "true");
  search.setAttribute("aria-activedescendant", cur.el.id);
  if (scroll) cur.el.scrollIntoView({ block: "nearest" });
}

export function select(i, scroll = true) {
  if (!state.visible.length) return;
  state.selected = Math.max(0, Math.min(i, state.visible.length - 1));
  updateSelection(scroll);
}

/** Navigation géométrique haut/bas : fonctionne en grille, en liste et entre sections. */
export function moveVertical(dir) {
  const cur = state.visible[state.selected];
  if (!cur) return select(0);
  const r0 = cur.el.getBoundingClientRect();
  const cx = r0.left + r0.width / 2;
  let best = -1, bestRow = Infinity, bestDx = Infinity;
  state.visible.forEach((v, i) => {
    if (i === state.selected) return;
    const r = v.el.getBoundingClientRect();
    const dy = dir > 0 ? r.top - r0.bottom + 1 : r0.top - r.bottom + 1;
    if (dy < 0) return;
    const row = Math.round(dy / 4); // tolérance de quelques pixels
    const dx = Math.abs(r.left + r.width / 2 - cx);
    if (row < bestRow || (row === bestRow && dx < bestDx)) {
      best = i;
      bestRow = row;
      bestDx = dx;
    }
  });
  if (best >= 0) select(best);
}

export const selectedEntry = () => state.visible[state.selected] || null;
