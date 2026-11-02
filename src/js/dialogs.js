// Fenêtres : ajout, import du menu Démarrer, modification, élément introuvable, paramètres.
import { invoke, iconUrl, listen } from "./api.js";
import { t, formatHotkey, LOCALES } from "./i18n.js";
import { state, settings, save, addItems, findGroup, removeItem, freshLater, laterAdd, laterRemove, laterMarkSeen } from "./store.js";
import { h, icon, openModal, toast, toggle, segmented } from "./ui.js";

/** Branché par main.js : re-rendu, application du thème, etc. */
export const hooks = {
  render: () => {},
  applyAppearance: () => {},
  afterAdd: (_items) => {},
  launch: (_item, _opts) => {},
  refreshLater: () => {},
};

const currentGroup = () => (state.tab !== "all" && findGroup(state.tab) ? state.tab : null);

function groupSelect(value) {
  const sel = h("select", { class: "input" }, h("option", { value: "", text: t("menu.noGroup") }), ...state.config.groups.map((g) => h("option", { value: g.id, text: g.name, selected: g.id === value })));
  sel.value = value || "";
  return sel;
}

export function normalizeUrl(raw) {
  let v = (raw || "").trim();
  if (!v) return null;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(v)) v = "https://" + v;
  try {
    const u = new URL(v);
    if ((u.protocol === "http:" || u.protocol === "https:") && !u.hostname.includes(".") && u.hostname !== "localhost") return null;
    return u.href;
  } catch {
    return null;
  }
}

export function urlName(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "");
    if (!host) return url;
    const base = host.split(".").slice(-2, -1)[0] || host;
    return base.charAt(0).toUpperCase() + base.slice(1);
  } catch {
    return url;
  }
}

export function addUrl(raw, name, groupId = currentGroup()) {
  const url = normalizeUrl(raw);
  if (!url) {
    toast(t("errors.invalidUrl"), { kind: "error" });
    return [];
  }
  const added = addItems([{ name: (name || "").trim() || urlName(url), kind: "url", target: url }], groupId);
  hooks.afterAdd(added);
  return added;
}

export async function pickAndAdd(kind, groupId = currentGroup()) {
  const paths = await invoke("pick", { kind });
  if (!paths.length) return [];
  const items = await invoke("inspect_paths", { paths });
  const added = addItems(items, groupId);
  hooks.afterAdd(added);
  return added;
}

// ---------------------------------------------------------------------------
/** Petite fenêtre pour ajouter un lien web dans un groupe précis. */
export function promptUrl(groupId = currentGroup()) {
  const urlInput = h("input", { class: "input", type: "text", placeholder: t("add.urlPlaceholder"), spellcheck: "false", autofocus: true });
  const nameInput = h("input", { class: "input", type: "text", placeholder: t("add.urlName"), spellcheck: "false" });
  openModal({
    title: t("add.url"),
    body: h("div", { class: "url-prompt" }, urlInput, h("div", { style: { height: "8px" } }), nameInput),
    actions: [
      { label: t("common.cancel") },
      { label: t("add.urlAdd"), kind: "primary", onClick: () => (addUrl(urlInput.value, nameInput.value, groupId).length ? undefined : (urlInput.focus(), false)) },
    ],
  });
}

export function openAddDialog(groupId = currentGroup()) {
  const group = groupSelect(groupId);
  const urlInput = h("input", { class: "input", type: "text", placeholder: t("add.urlPlaceholder"), spellcheck: "false" });
  const nameInput = h("input", { class: "input", type: "text", placeholder: t("add.urlName"), spellcheck: "false" });
  const urlForm = h(
    "div",
    { class: "url-form hidden" },
    urlInput,
    nameInput,
    h("button", { class: "btn primary", type: "button", text: t("add.urlAdd"), onclick: () => {
      if (addUrl(urlInput.value, nameInput.value, group.value || null).length) modal.close();
      else urlInput.focus();
    } })
  );
  urlInput.addEventListener("keydown", (e) => e.key === "Enter" && (e.preventDefault(), urlForm.querySelector(".btn").click()));
  nameInput.addEventListener("keydown", (e) => e.key === "Enter" && (e.preventDefault(), urlForm.querySelector(".btn").click()));

  const choice = (ico, title, sub, onClick) =>
    h("button", { class: "choice", type: "button", onclick: onClick }, h("span", { class: "choice-ico" }, icon(ico)), h("span", { class: "choice-text" }, h("span", { class: "choice-title", text: title }), h("small", { class: "muted", text: sub })));

  const body = h(
    "div",
    { class: "add-dialog" },
    h("label", { class: "field inline" }, h("span", { text: t("add.group") }), group),
    h(
      "div",
      { class: "choices" },
      choice("file", t("add.files"), t("add.filesSub"), async () => {
        if ((await pickAndAdd("files", group.value || null)).length) modal.close();
      }),
      choice("folder", t("add.folder"), t("add.folderSub"), async () => {
        if ((await pickAndAdd("folder", group.value || null)).length) modal.close();
      }),
      choice("globe", t("add.url"), t("add.urlSub"), () => {
        urlForm.classList.remove("hidden");
        urlInput.focus();
      }),
      urlForm,
      choice("import", t("add.startMenu"), t("add.startMenuSub"), () => {
        modal.close();
        openImportDialog(group.value || null);
      })
    ),
    h("p", { class: "muted small", text: t("add.tip") })
  );
  const modal = openModal({ title: t("add.title"), body });
  body.querySelector(".choice")?.focus();
}

// ---------------------------------------------------------------------------
export function openImportDialog(groupId = currentGroup()) {
  const existing = new Set(state.config.items.map((i) => i.target.toLowerCase()));
  const filter = h("input", { class: "input", type: "search", placeholder: t("import.filter"), spellcheck: "false", autofocus: true });
  const list = h("div", { class: "import-list", role: "list" }, h("div", { class: "import-loading muted" }, h("span", { class: "spinner" }), t("import.loading")));
  const count = h("span", { class: "muted small" });
  const group = groupSelect(groupId);
  const checked = new Set();
  let candidates = [];

  const submitBtn = () => modal.dialog.querySelector(".modal-actions .btn.primary");
  const refreshCount = () => {
    count.textContent = t("import.count", { n: checked.size, total: candidates.filter((c) => !existing.has(c.target.toLowerCase())).length });
    const b = submitBtn();
    if (b) {
      b.textContent = t("import.submit", { n: checked.size });
      b.disabled = checked.size === 0;
    }
  };

  const renderList = () => {
    const q = filter.value.trim().toLowerCase();
    const frag = document.createDocumentFragment();
    let shown = 0;
    candidates.forEach((c, i) => {
      if (q && !c.name.toLowerCase().includes(q)) return;
      shown++;
      const already = existing.has(c.target.toLowerCase());
      const url = iconUrl(c, 24);
      const img = url ? h("img", { src: url, alt: "", loading: "lazy", decoding: "async", width: 24, height: 24 }) : null;
      img?.addEventListener("error", () => img.replaceWith(h("span", { class: "glyph" }, icon("app"))), { once: true });
      frag.append(
        h(
          "label",
          { class: `import-row ${already ? "disabled" : ""}`, role: "listitem" },
          h("input", { type: "checkbox", checked: already || checked.has(i), disabled: already, onchange: (e) => {
            e.target.checked ? checked.add(i) : checked.delete(i);
            refreshCount();
          } }),
          h("span", { class: "import-ico" }, img || h("span", { class: "glyph" }, icon("app"))),
          h("span", { class: "import-name", text: c.name }),
          already ? h("span", { class: "pill", text: t("import.already") }) : c.source === "store" ? h("span", { class: "pill", text: t("import.store") }) : null
        )
      );
    });
    if (!shown) frag.append(h("p", { class: "muted import-loading", text: t("import.none") }));
    list.replaceChildren(frag);
  };

  const setAll = (on) => {
    candidates.forEach((c, i) => {
      if (existing.has(c.target.toLowerCase())) return;
      on ? checked.add(i) : checked.delete(i);
    });
    renderList();
    refreshCount();
  };

  filter.addEventListener("input", renderList);
  const body = h(
    "div",
    { class: "import-dialog" },
    h("div", { class: "import-top" }, filter, h("button", { class: "btn subtle", type: "button", text: t("import.selectAll"), onclick: () => setAll(true) }), h("button", { class: "btn subtle", type: "button", text: t("import.selectNone"), onclick: () => setAll(false) })),
    list,
    h("div", { class: "import-bottom" }, count, h("label", { class: "field inline" }, h("span", { text: t("add.group") }), group))
  );

  const modal = openModal({
    title: t("import.title"),
    body,
    wide: true,
    actions: [
      { label: t("common.cancel") },
      {
        label: t("import.submit", { n: 0 }),
        kind: "primary",
        onClick: () => {
          if (!checked.size) return false;
          const chosen = [...checked].sort((a, b) => a - b).map((i) => candidates[i]);
          const added = addItems(chosen.map((c) => ({ name: c.name, kind: c.kind, target: c.target })), group.value || null);
          hooks.afterAdd(added);
        },
      },
    ],
  });
  refreshCount();

  invoke("scan_start_menu")
    .then((res) => {
      candidates = res;
      renderList();
      refreshCount();
    })
    .catch((e) => list.replaceChildren(h("p", { class: "muted import-loading", text: String(e) })));
}

// ---------------------------------------------------------------------------
export function openEditDialog(item) {
  const draft = { ...item };
  const preview = h("div", { class: "edit-icon" });
  const renderPreview = () => {
    const url = iconUrl(draft, 48);
    preview.replaceChildren();
    if (url) {
      const img = h("img", { src: url + "&v=" + encodeURIComponent(draft.icon || ""), alt: "", width: 48, height: 48 });
      img.addEventListener("error", () => img.replaceWith(h("span", { class: "glyph" }, icon(draft.kind === "url" ? "globe" : draft.kind === "folder" ? "folder" : "app"))), { once: true });
      preview.append(img);
    } else preview.append(h("span", { class: "glyph" }, icon("globe")));
  };
  renderPreview();

  const field = (label, input, extra) => h("label", { class: "field" }, h("span", { text: label }), extra ? h("div", { class: "field-row" }, input, extra) : input);
  const name = h("input", { class: "input", type: "text", value: draft.name, autofocus: true, maxlength: "200" });
  // Chemins masqués : les champs affichent des points (le bouton Parcourir reste utilisable).
  const masked = !!settings().hidePaths;
  const pathCls = masked ? "input masked" : "input";
  const target = h("input", { class: pathCls, type: "text", value: draft.target, spellcheck: "false", autocomplete: "off" });
  const args = h("input", { class: "input", type: "text", value: draft.args || "", placeholder: t("edit.argsPlaceholder"), spellcheck: "false" });
  const workdir = h("input", { class: pathCls, type: "text", value: draft.workdir || "", placeholder: t("edit.workdirPlaceholder"), spellcheck: "false", autocomplete: "off" });
  if (masked) for (const el of [target, workdir]) {
    // Empêche de copier un chemin masqué.
    el.addEventListener("copy", (e) => e.preventDefault());
    el.addEventListener("cut", (e) => e.preventDefault());
  }
  const group = groupSelect(draft.groupId);
  const isProgram = ["exe", "lnk"].includes(draft.kind);
  const browseBtn = (kind, input) =>
    h("button", { class: "btn", type: "button", text: t("edit.browse"), onclick: async () => {
      const [p] = await invoke("pick", { kind });
      if (p) input.value = p;
    } });

  const body = h(
    "div",
    { class: "edit-dialog" },
    h(
      "div",
      { class: "edit-head" },
      preview,
      h(
        "div",
        { class: "edit-head-actions" },
        h("span", { class: "pill", text: t(`edit.kind.${draft.kind}`) }),
        h("button", { class: "btn subtle", type: "button", text: t("edit.icon"), onclick: async () => {
          const [p] = await invoke("pick", { kind: "icon" });
          if (p) {
            draft.icon = p;
            renderPreview();
          }
        } }),
        h("button", { class: "btn subtle", type: "button", text: t("edit.iconReset"), onclick: () => {
          draft.icon = null;
          renderPreview();
        } })
      )
    ),
    field(t("edit.name"), name),
    draft.kind === "app" ? null : field(t("edit.target"), target, draft.kind === "url" ? null : browseBtn(draft.kind === "folder" ? "workdir" : "target", target)),
    isProgram ? field(t("edit.args"), args) : null,
    isProgram ? field(t("edit.workdir"), workdir, browseBtn("workdir", workdir)) : null,
    masked && draft.kind !== "app" ? h("p", { class: "masked-note", text: t("edit.masked") }) : null,
    field(t("edit.group"), group),
    h(
      "div",
      { class: "edit-toggles" },
      isProgram ? toggle(t("edit.admin"), !!draft.admin, (v) => (draft.admin = v)) : null,
      toggle(t("edit.startup"), !!draft.launchOnStart, (v) => (draft.launchOnStart = v)),
      toggle(t("edit.pinned"), !!draft.pinned, (v) => (draft.pinned = v))
    )
  );

  openModal({
    title: t("edit.title"),
    body,
    wide: true,
    actions: [
      { label: t("common.delete"), kind: "danger", left: true, onClick: () => deleteWithUndo(item) },
      { label: t("common.cancel") },
      {
        label: t("common.save"),
        kind: "primary",
        onClick: () => {
          const n = name.value.trim();
          if (!n) return name.focus(), false;
          let tgt = target.value.trim().replace(/^"(.*)"$/, "$1");
          if (draft.kind === "url") {
            tgt = normalizeUrl(tgt);
            if (!tgt) return toast(t("errors.invalidUrl"), { kind: "error" }), false;
          }
          if (draft.kind !== "app" && !tgt) return target.focus(), false;
          Object.assign(item, draft, {
            name: n,
            target: draft.kind === "app" ? item.target : tgt,
            args: args.value.trim(),
            workdir: workdir.value.trim().replace(/^"(.*)"$/, "$1"),
            groupId: group.value || null,
          });
          state.broken.delete(item.id);
          save();
          hooks.render();
          hooks.afterAdd([]); // relance la vérification des chemins
        },
      },
    ],
  });
}

export function deleteWithUndo(item) {
  const undo = removeItem(item.id);
  hooks.render();
  toast(t("toast.removed", { name: item.name }), { action: t("common.undo"), onAction: () => {
    undo();
    hooks.render();
  } });
}

// ---------------------------------------------------------------------------
export function openBrokenDialog(item) {
  openModal({
    title: t("broken.title"),
    body: h("div", { class: "broken-dialog" }, h("div", { class: "broken-ico" }, icon("warning")), h("p", { text: t("broken.text", { name: item.name }) }), settings().hidePaths ? null : h("code", { class: "path", text: item.target })),
    actions: [
      { label: t("broken.remove"), kind: "danger", left: true, onClick: () => deleteWithUndo(item) },
      { label: t("menu.edit"), onClick: () => setTimeout(() => openEditDialog(item), 160) },
      {
        label: t("broken.fix"),
        kind: "primary",
        onClick: async () => {
          const [p] = await invoke("pick", { kind: item.kind === "folder" ? "workdir" : "target" });
          if (!p) return false;
          const [info] = await invoke("inspect_paths", { paths: [p] });
          item.target = p;
          if (info) item.kind = info.kind;
          state.broken.delete(item.id);
          save();
          hooks.render();
        },
      },
    ],
  });
}

// ---------------------------------------------------------------------------
const ACCENTS = ["#4cc2ff", "#0078d4", "#8764b8", "#e3008c", "#e74856", "#ff8c00", "#ffb900", "#16c60c", "#00b7c3"];

/** Convertit un KeyboardEvent en accélérateur Tauri ("Ctrl+Alt+K"). */
function accelFromEvent(e) {
  const mods = [];
  if (e.ctrlKey) mods.push("Ctrl");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  if (e.metaKey) mods.push("Super");
  const c = e.code;
  let key = null;
  if (/^Key[A-Z]$/.test(c)) key = c.slice(3);
  else if (/^Digit\d$/.test(c)) key = c.slice(5);
  else if (/^F\d{1,2}$/.test(c)) key = c;
  else if (/^Numpad\d$/.test(c)) key = c;
  else key = { Space: "Space", Enter: "Enter", Tab: "Tab", Backquote: "Backquote", Minus: "Minus", Equal: "Equal", BracketLeft: "BracketLeft", BracketRight: "BracketRight", Backslash: "Backslash", Semicolon: "Semicolon", Quote: "Quote", Comma: "Comma", Period: "Period", Slash: "Slash", Insert: "Insert", Home: "Home", End: "End", PageUp: "PageUp", PageDown: "PageDown", ArrowUp: "ArrowUp", ArrowDown: "ArrowDown", ArrowLeft: "ArrowLeft", ArrowRight: "ArrowRight", Pause: "Pause" }[c] || null;
  if (!key) return null; // seulement des modificateurs pour l'instant
  if (!mods.length && !/^F\d/.test(key)) return null; // une touche seule gênerait la frappe
  return [...mods, key].join("+");
}

function hotkeyField() {
  const btn = h("button", { class: "hotkey-field", type: "button" }, h("kbd", { text: formatHotkey(settings().hotkey) }));
  const hint = h("small", { class: "muted", text: t("settings.hotkeyHint") });
  let capturing = false;
  const stop = () => {
    capturing = false;
    btn.classList.remove("capturing");
    btn.firstChild.textContent = formatHotkey(settings().hotkey);
  };
  btn.addEventListener("click", () => {
    capturing = true;
    btn.classList.add("capturing");
    btn.firstChild.textContent = t("settings.hotkeyWaiting");
  });
  btn.addEventListener("blur", stop);
  btn.addEventListener("keydown", async (e) => {
    if (!capturing) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "Escape") return stop();
    const accel = accelFromEvent(e);
    if (!accel) return;
    try {
      await invoke("set_hotkey", { accel });
      settings().hotkey = accel;
      save();
      toast(t("settings.hotkeySaved", { hotkey: formatHotkey(accel) }));
      document.querySelectorAll("[data-hotkey]").forEach((el) => (el.textContent = formatHotkey(accel)));
    } catch (err) {
      toast(String(err), { kind: "error" });
    }
    stop();
  });
  return h("div", { class: "setting" }, h("div", { class: "setting-label" }, h("span", { text: t("settings.hotkey") }), hint), btn);
}

export function openSettings() {
  if (document.querySelector(".modal.settings")) return;
  const s = settings();
  const env = state.env;
  const change = (fn) => (v) => {
    fn(v);
    save();
    hooks.applyAppearance();
    hooks.render();
  };
  const row = (label, control, sub) => h("div", { class: "setting" }, h("div", { class: "setting-label" }, h("span", { text: label }), sub ? h("small", { class: "muted", text: sub }) : null), control);

  const custom = h("input", { type: "color", class: "swatch-custom", value: s.accent, title: t("settings.accentCustom"), oninput: (e) => {
    s.accent = e.target.value;
    hooks.applyAppearance();
    markSwatch();
  }, onchange: () => save() });
  const swatches = h("div", { class: "swatches" }, ...ACCENTS.map((c) => h("button", { class: "swatch", type: "button", style: { "--c": c }, title: c, "aria-label": c, dataset: { c }, onclick: () => {
    s.accent = c;
    custom.value = c;
    save();
    hooks.applyAppearance();
    markSwatch();
  } })), custom);
  const markSwatch = () => swatches.querySelectorAll(".swatch").forEach((b) => b.classList.toggle("active", b.dataset.c.toLowerCase() === s.accent.toLowerCase()));
  markSwatch();

  const autostart = toggle(t("settings.autostart"), !!env.autostart, async (v) => {
    try {
      env.autostart = await invoke("set_autostart", { enabled: v });
    } catch (e) {
      toast(String(e), { kind: "error" });
    }
  }, t("settings.autostartSub"));
  autostart.classList.add("autostart-toggle");

  const lang = h("select", { class: "input small", onchange: (e) => {
    change((v) => (s.language = v))(e.target.value);
    invoke("set_language", { lang: s.language }).catch(() => {});
    hooks.refreshLater();
    // Rouvre les paramètres pour les afficher dans la nouvelle langue.
    const top = modal.dialog.querySelector(".modal-body")?.scrollTop || 0;
    modal.close();
    setTimeout(() => {
      openSettings();
      const b = document.querySelector(".modal.settings .modal-body");
      if (b) b.scrollTop = top;
    }, 150);
  } }, ...Object.entries(LOCALES).map(([code, d]) => h("option", { value: code, text: d._name, selected: code === s.language })));

  const k = (name) => t(`keyNames.${name}`);
  const shortcuts = [
    ["↑ ↓ ← →", "keys.nav"], [k("Enter"), "keys.launch"], [k("DoubleClick"), "keys.launch"], [`Ctrl+${k("Enter")}`, "keys.admin"], [`${k("Shift")}+${k("Enter")}`, "keys.location"],
    ["Ctrl+N", "keys.add"], [k("Delete"), "keys.remove"], ["F2", "keys.rename"], ["Ctrl+D", "keys.pin"], [`${k("Shift")}+F10`, "keys.menu"],
    ["Ctrl+Tab", "keys.tabs"], ["Ctrl+F", "keys.search"], ["Ctrl+,", "keys.settings"], [k("Escape"), "keys.hide"],
  ];

  const body = h(
    "div",
    { class: "settings-body" },
    h("h4", { text: t("settings.appearance") }),
    row(t("settings.theme"), segmented([
      { value: "system", label: t("settings.themeSystem"), icon: "monitor" },
      { value: "dark", label: t("settings.themeDark"), icon: "moon" },
      { value: "light", label: t("settings.themeLight"), icon: "sun" },
    ], s.theme, change((v) => (s.theme = v)))),
    row(t("settings.accent"), swatches),
    row(t("settings.iconSize"), segmented([
      { value: "s", label: t("settings.sizeS") }, { value: "m", label: t("settings.sizeM") }, { value: "l", label: t("settings.sizeL") },
    ], s.iconSize, change((v) => (s.iconSize = v)))),
    row(t("settings.view"), segmented([
      { value: "grid", label: t("toolbar.grid"), icon: "grid" }, { value: "list", label: t("toolbar.list"), icon: "list" },
    ], s.view, change((v) => (s.view = v)))),
    row(t("settings.language"), lang),

    h("h4", { text: t("settings.behavior") }),
    hotkeyField(),
    toggle(t("settings.hideAfterLaunch"), s.hideAfterLaunch, change((v) => (s.hideAfterLaunch = v))),
    toggle(t("settings.showRecents"), s.showRecents, change((v) => (s.showRecents = v))),
    toggle(t("settings.hidePaths"), !!s.hidePaths, change((v) => (s.hidePaths = v)), t("settings.hidePathsSub")),
    toggle(t("settings.detectNew"), s.detectNewApps !== false, change((v) => (s.detectNewApps = v)), t("settings.detectNewSub")),
    autostart,

    h("h4", { text: t("settings.data") }),
    h(
      "div",
      { class: "btn-row" },
      h("button", { class: "btn", type: "button", onclick: async () => {
        try {
          if (await invoke("export_config", { config: state.config })) toast(t("toast.exported"));
        } catch (e) {
          toast(String(e), { kind: "error" });
        }
      } }, icon("upload"), h("span", { text: t("settings.export") })),
      h("button", { class: "btn", type: "button", onclick: async () => {
        try {
          const cfg = await invoke("import_config");
          if (!cfg) return;
          state.config = cfg;
          state.broken.clear();
          state.tab = "all";
          await save(true);
          hooks.applyAppearance();
          hooks.render();
          hooks.afterAdd([]);
          toast(t("toast.imported", { n: cfg.items.length }));
          modal.close();
        } catch (e) {
          toast(String(e), { kind: "error" });
        }
      } }, icon("download"), h("span", { text: t("settings.import") })),
      h("button", { class: "btn", type: "button", onclick: () => invoke("open_data_dir").catch((e) => toast(String(e), { kind: "error" })) }, icon("folder"), h("span", { text: t("settings.openData") })),
      h("button", { class: "btn", type: "button", onclick: async () => {
        await invoke("clear_icon_cache").catch(() => {});
        toast(t("toast.cacheCleared"));
        hooks.render();
      } }, icon("trash"), h("span", { text: t("settings.clearCache") }))
    ),
    h("p", { class: "muted small", text: env.portable ? t("settings.portable") : t("settings.portableOff") }),
    s.hidePaths ? null : h("p", { class: "muted small path", text: t("settings.dataDir", { dir: env.dataDir || "" }) }),

    h("h4", { text: t("settings.shortcuts") }),
    h("div", { class: "shortcuts" }, ...shortcuts.map(([k, label]) => h("div", { class: "shortcut" }, h("kbd", { text: k }), h("span", { text: t(label) })))),

    h("h4", { text: t("settings.about") }),
    h("p", { class: "muted small", text: t("settings.version", { v: env.version || "" }) }),
    h(
      "div",
      { class: "btn-row about-actions" },
      h("button", { class: "btn", type: "button", onclick: () => {
        modal.close();
        setTimeout(openUpdateDialog, 150);
      } }, icon("download"), h("span", { text: t("settings.checkUpdate") })),
      h("button", { class: "btn danger-subtle", type: "button", onclick: async () => {
        await import("./store.js").then((m) => m.flushSave());
        invoke("quit_app");
      } }, icon("close"), h("span", { text: t("settings.quit") }))
    )
  );

  const modal = openModal({ title: t("settings.title"), body, wide: true, className: "settings" });
}

/** Le menu de la zone de notification a changé l'option « Lancer avec Windows ». */
export function syncAutostart(enabled) {
  state.env.autostart = enabled;
  const input = document.querySelector(".autostart-toggle input");
  if (input) input.checked = enabled;
}

// ---------------------------------------------------------------------------
// Mises à jour (GitHub Releases), uniquement à la demande de l'utilisateur.
export function openUpdateDialog() {
  if (document.querySelector(".modal.update")) return;
  const s = settings();
  const body = h("div", { class: "update-body" });
  const modal = openModal({ title: t("update.title"), body, className: "update" });
  const actions = h("footer", { class: "modal-actions" });
  modal.dialog.append(actions);
  let unlisten = null;
  const prevClose = modal.close;
  modal.close = () => {
    unlisten?.();
    prevClose();
  };

  const setActions = (list) =>
    actions.replaceChildren(...list.map((a) => h("button", { class: `btn ${a.kind || ""}`, type: "button", text: a.label, onclick: a.onClick })));
  const status = (ico, text, cls = "") =>
    h("div", { class: `update-status ${cls}` }, h("span", { class: "ico-badge" }, ico === "spinner" ? h("span", { class: "spinner" }) : icon(ico)), h("p", { text }));
  const openPage = (url) =>
    invoke("launch_item", { req: { kind: "url", target: url, args: "", workdir: "", admin: false } }).catch(() => {});
  const releasesPage = "https://github.com/Larmaloeil/Lanette/releases";

  function askConsent() {
    const remember = h("input", { type: "checkbox" });
    body.replaceChildren(status("globe", t("update.consent")), h("label", { class: "check-row" }, remember, h("span", { text: t("update.remember") })));
    setActions([
      { label: t("common.cancel"), onClick: () => modal.close() },
      { label: t("update.check"), kind: "primary", onClick: () => {
        if (remember.checked) {
          s.updateConsent = true;
          save();
        }
        check();
      } },
    ]);
    actions.querySelector(".btn.primary")?.focus();
  }

  async function check() {
    body.replaceChildren(status("spinner", t("update.checking")));
    setActions([]);
    try {
      const info = await invoke("check_update");
      if (!info.available) {
        body.replaceChildren(status("check", t("update.upToDate", { v: info.current })));
        setActions([{ label: t("common.close"), kind: "primary", onClick: () => modal.close() }]);
        return;
      }
      body.replaceChildren(
        status("download", t("update.available", { v: info.latest, current: info.current })),
        info.notes ? h("div", {}, h("small", { class: "muted", text: t("update.notes") }), h("div", { class: "update-notes", text: info.notes })) : null
      );
      setActions([
        { label: t("update.later"), onClick: () => modal.close() },
        { label: t("update.install"), kind: "primary", onClick: () => install(info) },
      ]);
      actions.querySelector(".btn.primary")?.focus();
    } catch (e) {
      showError(e);
    }
  }

  async function install(info) {
    const label = h("p", { text: t("update.downloading", { p: 0 }) });
    const bar = h("div", { class: "progress-bar" });
    body.replaceChildren(label, h("div", { class: "progress" }, bar));
    setActions([]);
    unlisten = await listen("lanette://update-progress", (ev) => {
      const { done, total } = ev.payload;
      const ratio = total ? Math.min(done / total, 1) : 0;
      bar.style.transform = `scaleX(${ratio})`;
      label.textContent = t("update.downloading", { p: Math.round(ratio * 100) });
    });
    try {
      await import("./store.js").then((m) => m.flushSave());
      await invoke("install_update", { url: info.url, size: info.size, version: info.latest });
      bar.style.transform = "scaleX(1)";
      body.replaceChildren(status("spinner", t("update.installing")));
    } catch (e) {
      showError(e);
    }
  }

  function showError(e) {
    const code = e?.code || "network";
    body.replaceChildren(status("warning", t(`update.errors.${code}`, { message: e?.message || String(e) }), "error"));
    setActions([
      { label: t("update.openPage"), onClick: () => openPage(releasesPage) },
      { label: t("update.retry"), kind: "primary", onClick: () => check() },
    ]);
  }

  if (s.updateConsent) check();
  else askConsent();
}

// ---------------------------------------------------------------------------
// Applications détectées et liste « Pour plus tard »
function appIcon(c, px = 24) {
  const url = iconUrl(c, px);
  const fallback = () => h("span", { class: "glyph" }, icon(c.kind === "url" ? "globe" : "app"));
  if (!url) return fallback();
  const img = h("img", { src: url, alt: "", loading: "lazy", decoding: "async", width: px, height: px });
  img.addEventListener("error", () => img.replaceWith(fallback()), { once: true });
  return img;
}

const sourcePill = (c) => (c.source ? h("span", { class: "pill", text: t(`detect.source.${c.source}`) }) : null);

/** Proposition d'ajout des applications installées depuis le dernier passage. */
export function openDetectedDialog() {
  if (document.querySelector(".modal.detected")) return;
  const fresh = freshLater();
  if (!fresh.length) return;
  const checked = new Set(fresh.map((_, i) => i));
  const group = groupSelect(currentGroup());
  const addLabel = () => t("detect.add", { n: checked.size });
  const rows = fresh.map((c, i) =>
    h(
      "label",
      { class: "import-row" },
      h("input", { type: "checkbox", checked: true, onchange: (e) => {
        e.target.checked ? checked.add(i) : checked.delete(i);
        const b = modal.dialog.querySelector(".modal-actions .btn.primary");
        b.textContent = addLabel();
        b.disabled = !checked.size;
      } }),
      h("span", { class: "import-ico" }, appIcon(c)),
      h("span", { class: "import-name", text: c.name }),
      sourcePill(c)
    )
  );
  const body = h(
    "div",
    { class: "detected-body" },
    h("div", { class: "update-status" }, h("span", { class: "ico-badge" }, icon("sparkle")), h("p", { text: fresh.length === 1 ? t("detect.textOne", { name: fresh[0].name }) : t("detect.text", { n: fresh.length }) })),
    h("div", { class: "import-list detected-list", role: "list" }, ...rows),
    h("label", { class: "field inline" }, h("span", { text: t("add.group") }), group),
    h("p", { class: "muted small", text: t("detect.hint") })
  );
  const modal = openModal({
    title: fresh.length === 1 ? t("detect.titleOne") : t("detect.title", { n: fresh.length }),
    body,
    className: "detected",
    // Fermer sans choisir = « Plus tard » : rien n'est perdu.
    onClose: () => {
      laterMarkSeen();
      hooks.refreshLater();
    },
    actions: [
      { label: t("detect.ignore"), kind: "subtle", left: true, onClick: () => laterRemove(fresh) },
      { label: t("detect.later") },
      {
        label: addLabel(),
        kind: "primary",
        onClick: () => {
          const chosen = fresh.filter((_, i) => checked.has(i));
          if (!chosen.length) return false;
          hooks.afterAdd(laterAdd(chosen, group.value || null));
        },
      },
    ],
  });
  modal.dialog.querySelector(".modal-actions .btn.primary")?.focus();
}

/** Liste « Pour plus tard ». */
export function openLaterDialog() {
  if (document.querySelector(".modal.later")) return;
  laterMarkSeen();
  hooks.refreshLater();
  const group = groupSelect(currentGroup());
  const list = h("div", { class: "import-list later-list", role: "list" });
  const addAllBtn = () => modal.dialog.querySelector(".modal-actions .btn.primary");

  const renderList = () => {
    const entries = state.config.later || [];
    const b = addAllBtn();
    if (b) b.disabled = !entries.length;
    if (!entries.length) {
      list.replaceChildren(h("div", { class: "later-empty" }, h("span", { class: "ico-badge" }, icon("clock")), h("p", { class: "muted", text: t("later.empty") })));
      return;
    }
    list.replaceChildren(
      ...entries.map((c) =>
        h(
          "div",
          { class: "import-row later-row", role: "listitem" },
          h("span", { class: "import-ico" }, appIcon(c)),
          h("span", { class: "import-name", text: c.name }),
          sourcePill(c),
          h("button", { class: "btn small", type: "button", onclick: () => {
            hooks.afterAdd(laterAdd([c], group.value || null));
            hooks.refreshLater();
            renderList();
          } }, icon("plus"), h("span", { text: t("later.add") })),
          h("button", { class: "icon-btn", type: "button", title: t("later.remove"), "aria-label": `${t("later.remove")} : ${c.name}`, onclick: () => {
            laterRemove([c]);
            hooks.refreshLater();
            renderList();
          } }, icon("close"))
        )
      )
    );
  };

  const body = h(
    "div",
    { class: "later-body" },
    h("p", { class: "muted small", text: t("later.text") }),
    list,
    h("label", { class: "field inline" }, h("span", { text: t("add.group") }), group)
  );
  const modal = openModal({
    title: t("later.title"),
    body,
    wide: true,
    className: "later",
    actions: [
      { label: t("common.close") },
      {
        label: t("later.addAll"),
        kind: "primary",
        onClick: () => {
          const entries = [...(state.config.later || [])];
          if (!entries.length) return false;
          hooks.afterAdd(laterAdd(entries, group.value || null));
          hooks.refreshLater();
        },
      },
    ],
  });
  renderList();
}
