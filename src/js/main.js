// Point d'entrée : démarrage, événements, clavier, lancement, menus.
import { invoke, listen, appWindow, webview } from "./api.js";
import { t, setLanguage, applyStatic, formatHotkey } from "./i18n.js";
import { state, settings, save, flushSave, findItem, findGroup, addItems, applySectionOrder, moveToGroup, addGroup, deleteGroup, moveGroup, checkBroken } from "./store.js";
import { render, renderContent, renderTabs, moveIndicator, handlers, select, moveVertical, selectedEntry, looksLikeUrl, looksLikePath, logoSvg } from "./render.js";
import { hooks, openAddDialog, openImportDialog, openEditDialog, openBrokenDialog, openSettings, deleteWithUndo, addUrl, pickAndAdd, promptUrl, syncAutostart, openUpdateDialog } from "./dialogs.js";
import { enableReorder } from "./dnd.js";
import { h, icon, openMenu, toast, prompt, confirmBox, closeTop, closeMenus, hasLayer, topLayer, segmented } from "./ui.js";

const $ = (id) => document.getElementById(id);
const searchEl = $("search");
const content = $("content");
const tabsEl = $("tabs");
const systemDark = matchMedia("(prefers-color-scheme: dark)");

// ---------------------------------------------------------------------------
// Apparence
function applyAppearance() {
  const s = settings();
  setLanguage(s.language);
  applyStatic();
  const dark = s.theme === "dark" || (s.theme === "system" && systemDark.matches);
  const root = document.documentElement;
  root.dataset.theme = dark ? "dark" : "light";
  root.classList.toggle("mica", !!state.env.mica);
  root.style.setProperty("--accent", s.accent);
  // Texte lisible sur la couleur d'accent (contraste WCAG).
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(s.accent.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  root.style.setProperty("--on-accent", lum > 0.36 ? "#0b0b0b" : "#ffffff");
  invoke("set_window_theme", { theme: s.theme }).catch(() => {});
  document.querySelectorAll("[data-hotkey]").forEach((el) => (el.textContent = formatHotkey(s.hotkey)));
  $("btn-paths").setAttribute("aria-pressed", String(!!s.hidePaths));
  renderToolbarToggles();
}
systemDark.addEventListener("change", () => settings().theme === "system" && applyAppearance());

function renderToolbarToggles() {
  const s = settings();
  $("view-toggle").replaceChildren(
    segmented([
      { value: "grid", icon: "grid", title: t("toolbar.grid") },
      { value: "list", icon: "list", title: t("toolbar.list") },
    ], s.view, (v) => {
      s.view = v;
      save();
      renderContent();
    })
  );
  $("size-toggle").replaceChildren(
    segmented([
      { value: "s", label: "S", title: t("toolbar.sizeS") },
      { value: "m", label: "M", title: t("toolbar.sizeM") },
      { value: "l", label: "L", title: t("toolbar.sizeL") },
    ], s.iconSize, (v) => {
      s.iconSize = v;
      save();
      renderContent();
    })
  );
}

// ---------------------------------------------------------------------------
// Lancement
async function launch(item, { admin } = {}) {
  if (state.broken.has(item.id)) return openBrokenDialog(item);
  const el = content.querySelector(`.tile[data-id="${CSS.escape(item.id)}"]`);
  el?.classList.add("launching");
  setTimeout(() => el?.classList.remove("launching"), 400);
  try {
    await invoke("launch_item", {
      req: { kind: item.kind, target: item.target, args: item.args || "", workdir: item.workdir || "", admin: admin ?? !!item.admin },
    });
    item.lastLaunched = Date.now();
    item.launchCount = (item.launchCount || 0) + 1;
    save();
    if (settings().hideAfterLaunch) {
      await invoke("hide_window");
    } else if (settings().showRecents && !state.query) renderContent();
  } catch (e) {
    const code = e?.code || "other";
    if (code === "not_found") {
      state.broken.add(item.id);
      renderContent();
      openBrokenDialog(item);
    } else if (code === "access_denied" && !admin) {
      toast(t("errors.access_denied"), { kind: "error", action: t("menu.launchAdmin"), onAction: () => launch(item, { admin: true }) });
    } else {
      toast(t(`errors.${code}`, { message: e?.message || String(e) }), { kind: "error" });
    }
  }
}

async function activate(entry, opts = {}) {
  if (!entry) return;
  if (entry.special === "add") return addFromQuery();
  if (opts.location) return invoke("open_location", { kind: entry.item.kind, target: entry.item.target }).catch((e) => toast(String(e), { kind: "error" }));
  return launch(entry.item, opts);
}

async function addFromQuery() {
  const q = state.query.trim();
  let added = [];
  if (looksLikePath(q)) {
    const items = await invoke("inspect_paths", { paths: [q] });
    added = addItems(items, state.tab !== "all" ? state.tab : null);
    afterAdd(added);
  } else added = addUrl(q);
  if (added.length) clearSearch();
}

function afterAdd(added) {
  render();
  if (added?.length) {
    const i = state.visible.findIndex((v) => v.item?.id === added[added.length - 1].id);
    if (i >= 0) select(i);
  }
  checkBroken(true).then((changed) => changed && renderContent());
}

// ---------------------------------------------------------------------------
// Menu contextuel d'un élément
function itemMenu(item, x, y) {
  const groups = state.config.groups;
  const broken = state.broken.has(item.id);
  const canAdmin = ["exe", "lnk"].includes(item.kind);
  openMenu(x, y, [
    broken ? { label: t("menu.fix"), icon: "warning", onClick: () => openBrokenDialog(item) } : { label: t("menu.launch"), icon: "play", onClick: () => launch(item) },
    canAdmin && !broken ? { label: t("menu.launchAdmin"), icon: "shield", onClick: () => launch(item, { admin: true }) } : null,
    !["url", "app"].includes(item.kind) ? { label: t("menu.openLocation"), icon: "location", onClick: () => invoke("open_location", { kind: item.kind, target: item.target }).catch((e) => toast(String(e), { kind: "error" })) } : null,
    { sep: true },
    { label: item.pinned ? t("menu.unpin") : t("menu.pin"), icon: "star", onClick: () => togglePin(item) },
    {
      label: t("menu.moveTo"),
      icon: "move",
      sub: () => [
        { label: t("menu.noGroup"), checked: !item.groupId, onClick: () => doMove(item, null) },
        ...groups.map((g) => ({ label: g.name, checked: item.groupId === g.id, onClick: () => doMove(item, g.id) })),
      ],
    },
    { label: t("menu.rename"), icon: "rename", onClick: () => renameItem(item) },
    { label: t("menu.edit"), icon: "edit", onClick: () => openEditDialog(item) },
    { sep: true },
    { label: t("menu.remove"), icon: "trash", danger: true, onClick: () => deleteWithUndo(item) },
  ].filter(Boolean));
}

function doMove(item, groupId) {
  if (item.groupId === groupId) return;
  moveToGroup(item.id, groupId);
  render();
  toast(t("toast.moved", { group: groupId ? findGroup(groupId)?.name : t("menu.noGroup") }));
}

function togglePin(item) {
  item.pinned = !item.pinned;
  save();
  const id = item.id;
  renderContent();
  const i = state.visible.findIndex((v) => v.item?.id === id);
  if (i >= 0) select(i);
  toast(item.pinned ? t("toast.pinned") : t("toast.unpinned"));
}

async function renameItem(item) {
  const name = await prompt({ title: t("prompt.renameItem"), value: item.name });
  if (!name) return;
  item.name = name;
  save();
  renderContent();
}

// ---------------------------------------------------------------------------
// Groupes (onglets)
async function newGroup() {
  const name = await prompt({ title: t("prompt.newGroup"), placeholder: t("prompt.groupPlaceholder") });
  if (!name) return;
  const g = addGroup(name);
  switchTab(g.id);
}

function switchTab(id) {
  state.tab = id;
  state.selected = 0;
  if (state.query) clearSearch(false);
  render();
  content.scrollTop = 0;
}

function cycleTab(dir) {
  const ids = ["all", ...state.config.groups.map((g) => g.id)];
  const i = ids.indexOf(state.tab);
  switchTab(ids[(i + dir + ids.length) % ids.length]);
}

/** Entrées « ajouter » d'un menu contextuel, pour un groupe donné (null = sans groupe). */
function addEntries(groupId) {
  const g = groupId ? findGroup(groupId) : null;
  return [
    g ? { header: t("menu.addHere", { group: g.name }) } : null,
    { label: t("menu.addFiles"), icon: "file", onClick: () => pickAndAdd("files", groupId) },
    { label: t("menu.addFolder"), icon: "folder", onClick: () => pickAndAdd("folder", groupId) },
    { label: t("menu.addUrl"), icon: "globe", onClick: () => promptUrl(groupId) },
    { label: t("menu.addStartMenu"), icon: "import", onClick: () => openImportDialog(groupId) },
  ].filter(Boolean);
}

/** Clic droit sur l'onglet « Tout » ou dans le vide de la liste. */
function addMenu(groupId, x, y) {
  openMenu(x, y, [...addEntries(groupId), { sep: true }, { label: t("menu.newGroup"), icon: "plus", onClick: () => newGroup() }]);
}

function groupMenu(id, x, y) {
  const g = findGroup(id);
  if (!g) return;
  const idx = state.config.groups.indexOf(g);
  openMenu(x, y, [
    ...addEntries(id),
    { sep: true },
    { label: t("tabs.rename"), icon: "rename", onClick: async () => {
      const name = await prompt({ title: t("prompt.renameGroup"), value: g.name });
      if (name) {
        g.name = name;
        save();
        render();
      }
    } },
    { label: t("tabs.moveLeft"), disabled: idx === 0, onClick: () => (moveGroup(id, -1), renderTabs()) },
    { label: t("tabs.moveRight"), disabled: idx === state.config.groups.length - 1, onClick: () => (moveGroup(id, 1), renderTabs()) },
    { sep: true },
    { label: t("tabs.delete"), icon: "trash", danger: true, onClick: async () => {
      const n = state.config.items.filter((i) => i.groupId === id).length;
      const ok = await confirmBox({ title: t("prompt.deleteGroup", { name: g.name }), text: t("prompt.deleteGroupText", { n }), okLabel: t("common.delete") });
      if (ok) {
        deleteGroup(id);
        render();
      }
    } },
  ]);
}

tabsEl.addEventListener("click", (e) => {
  const b = e.target.closest(".tab");
  if (!b) return;
  if (b.dataset.action === "new-group") return newGroup();
  switchTab(b.dataset.group);
  searchEl.focus();
});
tabsEl.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  const b = e.target.closest(".tab[data-group]");
  if (!b || b.dataset.group === "all") addMenu(null, e.clientX, e.clientY);
  else groupMenu(b.dataset.group, e.clientX, e.clientY);
});
tabsEl.addEventListener("wheel", (e) => {
  if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
    tabsEl.scrollLeft += e.deltaY;
    e.preventDefault();
  }
}, { passive: false });

// ---------------------------------------------------------------------------
// Souris sur les éléments
const dnd = enableReorder(content, {
  tabsEl,
  onReorder: (ids) => applySectionOrder(ids),
  onDropOnTab: (id, groupId) => {
    const it = findItem(id);
    if (it) doMove(it, groupId);
  },
});

// Un clic sélectionne, un double-clic lance (comme dans l'Explorateur).
content.addEventListener("click", (e) => {
  if (dnd.consumeClick()) return;
  const tile = e.target.closest(".tile");
  if (!tile) return;
  select(Number(tile.dataset.idx), false);
});
content.addEventListener("dblclick", (e) => {
  const tile = e.target.closest(".tile");
  if (!tile) return;
  const i = Number(tile.dataset.idx);
  select(i, false);
  activate(state.visible[i], { admin: e.ctrlKey ? true : undefined, location: e.shiftKey && !e.ctrlKey });
});
content.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  const tile = e.target.closest(".tile[data-id]");
  if (!tile) {
    // Clic droit dans le vide : ajouter dans le groupe affiché.
    if (!e.target.closest(".tile, .empty")) addMenu(state.tab !== "all" ? state.tab : null, e.clientX, e.clientY);
    return;
  }
  select(Number(tile.dataset.idx), false);
  const it = findItem(tile.dataset.id);
  if (it) itemMenu(it, e.clientX, e.clientY);
});
document.addEventListener("contextmenu", (e) => {
  // Pas de menu « Inspecter / Recharger » du navigateur, sauf dans les champs.
  if (!e.target.closest("input, textarea")) e.preventDefault();
});

// ---------------------------------------------------------------------------
// Recherche
function clearSearch(rerender = true) {
  searchEl.value = "";
  state.query = "";
  state.selected = 0;
  if (rerender) renderContent();
}

let searchRaf = 0;
searchEl.addEventListener("input", () => {
  cancelAnimationFrame(searchRaf);
  searchRaf = requestAnimationFrame(() => {
    state.query = searchEl.value;
    state.selected = 0;
    renderContent();
    content.scrollTop = 0;
  });
});

// ---------------------------------------------------------------------------
// Clavier
document.addEventListener("keydown", (e) => {
  if (hasLayer()) {
    topLayer().onKey(e);
    return;
  }
  const inSearch = document.activeElement === searchEl;
  const ctrl = e.ctrlKey || e.metaKey;
  const entry = selectedEntry();
  const item = entry?.item;
  const caretAtEnd = !inSearch || searchEl.selectionStart === searchEl.value.length;

  switch (true) {
    case e.key === "Escape":
      e.preventDefault();
      if (state.query) clearSearch();
      else invoke("hide_window");
      return;
    case e.key === "ArrowDown":
    case e.key === "ArrowUp":
      e.preventDefault();
      moveVertical(e.key === "ArrowDown" ? 1 : -1);
      return;
    case (e.key === "ArrowRight" || e.key === "ArrowLeft") && !e.altKey && (!state.query || !inSearch):
      e.preventDefault();
      select(state.selected + (e.key === "ArrowRight" ? 1 : -1));
      return;
    case (e.key === "Home" || e.key === "End") && !state.query:
      e.preventDefault();
      select(e.key === "Home" ? 0 : state.visible.length - 1);
      return;
    case e.key === "PageDown" || e.key === "PageUp": {
      e.preventDefault();
      for (let k = 0; k < 4; k++) moveVertical(e.key === "PageDown" ? 1 : -1);
      return;
    }
    case e.key === "Enter":
      e.preventDefault();
      if (!entry) return;
      if (ctrl) activate(entry, { admin: true });
      else if (e.shiftKey) activate(entry, { location: true });
      else activate(entry);
      return;
    case ctrl && e.key.toLowerCase() === "n":
      e.preventDefault();
      openAddDialog();
      return;
    case ctrl && (e.key === "," || e.code === "Comma"):
      e.preventDefault();
      openSettings();
      return;
    case ctrl && e.key.toLowerCase() === "f":
      e.preventDefault();
      searchEl.focus();
      searchEl.select();
      return;
    case ctrl && e.key === "Tab":
      e.preventDefault();
      cycleTab(e.shiftKey ? -1 : 1);
      return;
    case ctrl && /^[1-9]$/.test(e.key): {
      e.preventDefault();
      const ids = ["all", ...state.config.groups.map((g) => g.id)];
      const id = ids[Number(e.key) - 1];
      if (id) switchTab(id);
      return;
    }
    case ctrl && e.key.toLowerCase() === "d" && !!item:
      e.preventDefault();
      togglePin(item);
      return;
    case e.key === "Delete" && !!item && caretAtEnd:
      e.preventDefault();
      deleteWithUndo(item);
      return;
    case e.key === "F2" && !!item:
      e.preventDefault();
      renameItem(item);
      return;
    case (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) && !!item: {
      e.preventDefault();
      const r = entry.el.getBoundingClientRect();
      itemMenu(item, r.left + r.width / 2, r.top + r.height / 2);
      return;
    }
    case e.key === "F5":
    case ctrl && e.key.toLowerCase() === "r":
    case ctrl && e.key.toLowerCase() === "p":
    case ctrl && e.key.toLowerCase() === "s":
      e.preventDefault(); // pas de rechargement / impression du navigateur
      return;
  }
  // Une frappe ailleurs que dans la recherche y est redirigée.
  if (!inSearch && e.key.length === 1 && !ctrl && !e.altKey && !e.target.closest("input, select, textarea")) {
    searchEl.focus();
  }
});

// Collage d'un lien ou d'un chemin dans une recherche vide : proposé à l'ajout.
searchEl.addEventListener("paste", () => requestAnimationFrame(() => {
  const q = searchEl.value.trim();
  if (q && (looksLikeUrl(q) || looksLikePath(q))) {
    state.query = searchEl.value;
    renderContent();
    const i = state.visible.findIndex((v) => v.special === "add");
    if (i >= 0) select(i);
  }
}));

// ---------------------------------------------------------------------------
// Barre de titre et barre d'outils
$("btn-close").addEventListener("click", () => invoke("hide_window"));
$("btn-min").addEventListener("click", () => appWindow().minimize());
$("btn-settings").addEventListener("click", () => openSettings());
$("btn-add").addEventListener("click", () => openAddDialog());
$("btn-paths").addEventListener("click", () => {
  settings().hidePaths = !settings().hidePaths;
  save();
  applyAppearance();
  renderContent();
});
$("brand-logo").append(logoSvg());

// ---------------------------------------------------------------------------
// Dépôt de fichiers depuis l'Explorateur (API native Tauri)
const overlay = $("drop-overlay");
function dropGroupAt(pos) {
  if (!pos) return state.tab !== "all" ? state.tab : null;
  const dpr = devicePixelRatio || 1;
  const el = document.elementFromPoint(pos.x / dpr, pos.y / dpr);
  const tab = el?.closest?.(".tab[data-group]");
  if (tab) return tab.dataset.group === "all" ? null : tab.dataset.group;
  return state.tab !== "all" ? state.tab : null;
}
webview().onDragDropEvent(async (ev) => {
  const p = ev.payload;
  if (p.type === "enter" || p.type === "over") {
    const g = dropGroupAt(p.position);
    overlay.querySelector(".drop-sub").textContent = g ? t("drop.into", { group: findGroup(g)?.name || "" }) : "";
    overlay.classList.add("open");
  } else if (p.type === "leave") {
    overlay.classList.remove("open");
  } else if (p.type === "drop") {
    overlay.classList.remove("open");
    if (!p.paths?.length) return;
    const items = await invoke("inspect_paths", { paths: p.paths });
    afterAdd(addItems(items, dropGroupAt(p.position)));
  }
});

// ---------------------------------------------------------------------------
// Affichage / masquage de la fenêtre
function onShown() {
  closeMenus();
  document.getElementById("app").classList.remove("appear");
  void document.getElementById("app").offsetWidth;
  document.getElementById("app").classList.add("appear");
  if (!hasLayer()) {
    if (state.query) clearSearch();
    else select(0, false);
    content.scrollTop = 0;
    searchEl.focus();
    searchEl.select();
  }
  // Vérification des chemins en tâche de fond (limitée à une fois / 20 s).
  setTimeout(() => checkBroken().then((changed) => changed && renderContent()), 120);
}

// Changement d'écran avec une autre densité de pixels : icônes à la bonne taille.
function watchDpr() {
  matchMedia(`(resolution: ${devicePixelRatio}dppx)`).addEventListener("change", () => {
    renderContent();
    moveIndicator();
    watchDpr();
  }, { once: true });
}

let resizeRaf = 0;
addEventListener("resize", () => {
  cancelAnimationFrame(resizeRaf);
  resizeRaf = requestAnimationFrame(moveIndicator);
});

// ---------------------------------------------------------------------------
// Démarrage
async function boot() {
  const [config, env] = await Promise.all([invoke("load_config"), invoke("get_env")]);
  state.config = config;
  state.env = env;

  hooks.render = render;
  hooks.applyAppearance = applyAppearance;
  hooks.afterAdd = afterAdd;
  handlers.importStartMenu = () => openImportDialog();
  handlers.addFiles = () => openAddDialog();

  applyAppearance();
  render();
  searchEl.focus();
  watchDpr();

  await listen("lanette://shown", onShown);
  await listen("lanette://hidden", () => {
    closeMenus();
    flushSave();
  });
  await listen("lanette://open-settings", () => {
    while (topLayer() && !document.querySelector(".modal.settings")) closeTop();
    openSettings();
  });
  await listen("lanette://autostart-changed", (e) => syncAutostart(!!e.payload));
  await listen("lanette://check-update", () => {
    while (topLayer()) closeTop();
    openUpdateDialog();
  });

  // La fenêtre n'est affichée qu'une fois l'interface prête (pas d'écran blanc).
  requestAnimationFrame(() => invoke("app_ready"));
  if (env.hotkeyError) toast(t("toast.hotkeyError", { error: env.hotkeyError }), { kind: "error", duration: 8000 });
  setTimeout(() => checkBroken(true).then((changed) => changed && renderContent()), 400);
}

boot().catch((e) => {
  console.error(e);
  document.body.append(h("pre", { class: "fatal", text: String(e?.stack || e) }));
  invoke("app_ready").catch(() => {});
});
