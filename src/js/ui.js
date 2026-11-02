// Composants d'interface : création d'éléments, icônes SVG, fenêtres modales,
// menus contextuels, notifications. Aucun innerHTML avec des données
// utilisateur (noms de fichiers) : tout passe par textContent.
import { t } from "./i18n.js";

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "text") el.textContent = v;
    else if (k === "dataset") Object.assign(el.dataset, v);
    else if (k === "style" && typeof v === "object") {
      for (const [prop, val] of Object.entries(v)) el.style.setProperty(prop.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase()), val);
    }
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, "");
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

// Icônes au trait (24×24), dessinées pour l'application.
const PATHS = {
  search: "M10.5 4a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13zM20 20l-4.8-4.8",
  plus: "M12 5v14M5 12h14",
  settings: "M12 9.2a2.8 2.8 0 1 1 0 5.6 2.8 2.8 0 0 1 0-5.6zM19.4 13.5l1.4 1.1-1.8 3.1-1.7-.6a7 7 0 0 1-1.9 1.1L15 20h-3.6l-.4-1.8a7 7 0 0 1-1.9-1.1l-1.7.6-1.8-3.1 1.4-1.1a7 7 0 0 1 0-2.2L3.6 10.2l1.8-3.1 1.7.6A7 7 0 0 1 9 6.6L9.4 4.8H13l.4 1.8a7 7 0 0 1 1.9 1.1l1.7-.6 1.8 3.1-1.4 1.1a7 7 0 0 1 0 2.2z",
  grid: "M4 4h6.5v6.5H4zM13.5 4H20v6.5h-6.5zM4 13.5h6.5V20H4zM13.5 13.5H20V20h-6.5z",
  list: "M8.5 6H20M8.5 12H20M8.5 18H20M4 6h.01M4 12h.01M4 18h.01",
  close: "M6 6l12 12M18 6L6 18",
  minimize: "M6 12h12",
  star: "M12 3.8l2.5 5.2 5.7.8-4.1 4 1 5.6L12 16.7l-5.1 2.7 1-5.6-4.1-4 5.7-.8z",
  folder: "M3.5 7.5A1.5 1.5 0 0 1 5 6h4.2l2 2H19a1.5 1.5 0 0 1 1.5 1.5v8A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5z",
  file: "M7 3.5h6.5L18 8v12.5H7zM13.5 3.5V8H18",
  globe: "M12 3.5a8.5 8.5 0 1 1 0 17 8.5 8.5 0 0 1 0-17zM3.5 12h17M12 3.5c2.3 2.4 3.4 5.2 3.4 8.5s-1.1 6.1-3.4 8.5c-2.3-2.4-3.4-5.2-3.4-8.5S9.7 5.9 12 3.5z",
  app: "M5 5h14v14H5zM5 9h14",
  shield: "M12 3.5l7 2.8v5.2c0 4.3-2.9 7.6-7 9-4.1-1.4-7-4.7-7-9V6.3z",
  play: "M8 5.5v13l10.5-6.5z",
  edit: "M4.5 19.5l1-4L15.8 5.2a2 2 0 0 1 2.9 0l.1.1a2 2 0 0 1 0 2.9L8.5 18.5zM13.5 7.5l3 3",
  trash: "M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13M10 11v5.5M14 11v5.5",
  move: "M4 7.5A1.5 1.5 0 0 1 5.5 6h4l2 2h7A1.5 1.5 0 0 1 20 9.5v8a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5zM10 13.5h6M13.5 11l2.5 2.5-2.5 2.5",
  location: "M4 7.5A1.5 1.5 0 0 1 5.5 6h4l2 2h7A1.5 1.5 0 0 1 20 9.5v8a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5zM12 11v5M9.5 13.5H14.5",
  warning: "M12 4l9 15.5H3zM12 10v4.5M12 17h.01",
  check: "M5 12.5l4.5 4.5L19 7.5",
  download: "M12 4v11M7.5 10.5L12 15l4.5-4.5M5 19.5h14",
  upload: "M12 15V4M7.5 8.5L12 4l4.5 4.5M5 19.5h14",
  import: "M4 5.5h16v13H4zM8 12h8M12 8.5v7",
  link: "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1",
  rename: "M4 7h10M4 12h7M4 17h5M14.5 18.5l.6-2.6 4.7-4.7a1.4 1.4 0 0 1 2 2l-4.7 4.7z",
  keyboard: "M3.5 6.5h17v11h-17zM7 10h.01M10 10h.01M13 10h.01M16 10h.01M8 14h8",
  chevron: "M9 6l6 6-6 6",
  sun: "M12 8a4 4 0 1 1 0 8 4 4 0 0 1 0-8zM12 2.5v2M12 19.5v2M4.6 4.6L6 6M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4L6 18M18 6l1.4-1.4",
  moon: "M19.5 14.5A8 8 0 0 1 9.5 4.5a8 8 0 1 0 10 10z",
  monitor: "M3.5 5h17v11h-17zM9 20h6M12 16v4",
  rocket: "M5 19l3.5-1 8.8-8.8a4.5 4.5 0 0 0-3.5-3.5L5 14.5zM14 6l4 4M5 19l1-3.5",
};

export function icon(name, cls = "") {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("class", "ico " + cls);
  svg.setAttribute("aria-hidden", "true");
  const p = document.createElementNS(ns, "path");
  p.setAttribute("d", PATHS[name] || PATHS.app);
  svg.append(p);
  return svg;
}

// ---------------------------------------------------------------------------
// Pile des calques (modales, menus) : la touche Échap ferme le dernier.
const stack = [];
const layer = () => document.getElementById("layer");

export function topLayer() {
  return stack[stack.length - 1] || null;
}
export function hasLayer() {
  return stack.length > 0;
}
export function closeTop() {
  const top = topLayer();
  if (top) top.close();
  return !!top;
}
export function closeMenus() {
  for (let i = stack.length - 1; i >= 0; i--) if (stack[i].type === "menu") stack[i].close();
}

function focusables(root) {
  return [...root.querySelectorAll("button, input, select, textarea, [tabindex]:not([tabindex='-1'])")].filter(
    (e) => !e.disabled && e.offsetParent !== null
  );
}

/**
 * Ouvre une fenêtre modale.
 * actions : [{ label, kind: "primary"|"danger"|"", onClick, left }]
 * onClick peut renvoyer false pour garder la modale ouverte.
 */
export function openModal({ title, body, actions = [], wide = false, onClose, className = "" }) {
  closeMenus();
  const prevFocus = document.activeElement;
  const footer = actions.length
    ? h(
        "footer",
        { class: "modal-actions" },
        actions.map((a) =>
          h("button", {
            class: `btn ${a.kind || ""} ${a.left ? "left" : ""}`,
            type: "button",
            text: a.label,
            onclick: async () => {
              const r = await a.onClick?.();
              if (r !== false) entry.close();
            },
          })
        )
      )
    : null;
  const dialog = h(
    "div",
    { class: `modal ${wide ? "wide" : ""} ${className}`, role: "dialog", "aria-modal": "true", "aria-label": title },
    h("header", { class: "modal-head" }, h("h2", { text: title }), h("button", { class: "icon-btn", type: "button", "aria-label": t("common.close"), onclick: () => entry.close() }, icon("close"))),
    h("div", { class: "modal-body" }, body),
    footer
  );
  const backdrop = h("div", { class: "backdrop", onpointerdown: (e) => e.target === backdrop && entry.close() }, dialog);

  const entry = {
    type: "modal",
    el: backdrop,
    dialog,
    closed: false,
    close() {
      if (entry.closed) return;
      entry.closed = true;
      stack.splice(stack.indexOf(entry), 1);
      backdrop.classList.remove("open");
      setTimeout(() => backdrop.remove(), 140);
      onClose?.();
      if (prevFocus && document.contains(prevFocus)) prevFocus.focus();
      else document.getElementById("search")?.focus();
    },
    onKey(e) {
      if (e.key === "Escape") {
        e.preventDefault();
        entry.close();
        return true;
      }
      if (e.key === "Tab") {
        const f = focusables(dialog);
        if (!f.length) return true;
        const i = f.indexOf(document.activeElement);
        const next = e.shiftKey ? (i <= 0 ? f.length - 1 : i - 1) : i === f.length - 1 ? 0 : i + 1;
        f[next].focus();
        e.preventDefault();
        return true;
      }
      if (e.key === "Enter" && !e.shiftKey && document.activeElement?.tagName === "INPUT" && document.activeElement.type !== "checkbox") {
        const primary = dialog.querySelector(".modal-actions .btn.primary");
        if (primary) {
          e.preventDefault();
          primary.click();
          return true;
        }
      }
      return false; // laisser le comportement natif (saisie, cases à cocher…)
    },
  };
  stack.push(entry);
  layer().append(backdrop);
  requestAnimationFrame(() => {
    backdrop.classList.add("open");
    const first = dialog.querySelector("[autofocus]") || focusables(dialog.querySelector(".modal-body"))[0] || dialog.querySelector(".btn.primary");
    first?.focus();
    if (first?.select && first.type === "text") first.select();
  });
  return entry;
}

/**
 * Menu contextuel positionné au point (x, y), navigable au clavier.
 * entries : [{ label, icon, onClick, danger, disabled, checked, sub: () => entries } | { sep: true } | { header }]
 */
export function openMenu(x, y, entries) {
  closeMenus();
  const items = [];
  const menu = h("div", { class: "menu", role: "menu" });
  for (const e of entries) {
    if (e.sep) {
      menu.append(h("div", { class: "menu-sep" }));
      continue;
    }
    if (e.header) {
      menu.append(h("div", { class: "menu-header", text: e.header }));
      continue;
    }
    const btn = h(
      "button",
      {
        class: `menu-item ${e.danger ? "danger" : ""}`,
        role: "menuitem",
        type: "button",
        disabled: e.disabled,
        tabindex: "-1",
        onclick: () => {
          if (e.sub) {
            const r = btn.getBoundingClientRect();
            openMenu(r.right - 4, r.top, e.sub());
            return;
          }
          entry.close();
          e.onClick?.();
        },
        onpointerenter: () => focusItem(items.indexOf(btn)),
      },
      e.icon ? icon(e.icon) : h("span", { class: "ico-space" }),
      h("span", { class: "menu-label", text: e.label }),
      e.checked ? icon("check", "menu-check") : null,
      e.sub ? icon("chevron", "menu-chev") : null
    );
    items.push(btn);
    menu.append(btn);
  }
  let active = -1;
  function focusItem(i) {
    if (i < 0 || i >= items.length) return;
    active = i;
    items[i].focus({ preventScroll: true });
  }
  const shield = h("div", { class: "menu-shield", onpointerdown: (ev) => { ev.preventDefault(); entry.close(); }, oncontextmenu: (ev) => { ev.preventDefault(); entry.close(); } });
  const wrap = h("div", { class: "menu-layer" }, shield, menu);
  const prevFocus = document.activeElement;
  const entry = {
    type: "menu",
    el: wrap,
    closed: false,
    close() {
      if (entry.closed) return;
      entry.closed = true;
      const i = stack.indexOf(entry);
      if (i >= 0) stack.splice(i, 1);
      wrap.remove();
      if (prevFocus && document.contains(prevFocus) && !stack.length) prevFocus.focus({ preventScroll: true });
    },
    onKey(e) {
      const enabled = items.map((b, i) => (b.disabled ? -1 : i)).filter((i) => i >= 0);
      const pos = enabled.indexOf(active);
      if (e.key === "ArrowDown") focusItem(enabled[(pos + 1) % enabled.length]);
      else if (e.key === "ArrowUp") focusItem(enabled[(pos - 1 + enabled.length) % enabled.length]);
      else if (e.key === "Enter" || e.key === " " || e.key === "ArrowRight") {
        if (active >= 0 && (e.key !== "ArrowRight" || entries.filter((x) => !x.sep && !x.header)[active]?.sub)) items[active].click();
      } else if (e.key === "Escape" || e.key === "ArrowLeft") entry.close();
      else if (e.key === "Tab") entry.close();
      else return true;
      e.preventDefault();
      return true;
    },
  };
  stack.push(entry);
  layer().append(wrap);
  // Positionnement : reste dans la fenêtre.
  const r = menu.getBoundingClientRect();
  const px = Math.max(6, Math.min(x, innerWidth - r.width - 6));
  const py = Math.max(6, Math.min(y, innerHeight - r.height - 6));
  menu.style.left = `${px}px`;
  menu.style.top = `${py}px`;
  requestAnimationFrame(() => {
    menu.classList.add("open");
    focusItem(items.findIndex((b) => !b.disabled));
  });
  return entry;
}

// ---------------------------------------------------------------------------
// Notifications éphémères, avec action facultative (ex. « Annuler »).
export function toast(message, { action, onAction, kind = "", duration = 4200 } = {}) {
  const box = document.getElementById("toasts");
  const el = h(
    "div",
    { class: `toast ${kind}`, role: "status" },
    kind === "error" ? icon("warning") : null,
    h("span", { text: message }),
    action ? h("button", { class: "toast-action", type: "button", text: action, onclick: () => { onAction?.(); dismiss(); } }) : null
  );
  box.append(el);
  while (box.children.length > 3) box.firstChild.remove();
  requestAnimationFrame(() => el.classList.add("open"));
  let timer = setTimeout(dismiss, duration);
  el.addEventListener("pointerenter", () => clearTimeout(timer));
  el.addEventListener("pointerleave", () => (timer = setTimeout(dismiss, 1800)));
  function dismiss() {
    clearTimeout(timer);
    el.classList.remove("open");
    setTimeout(() => el.remove(), 160);
  }
  return dismiss;
}

/** Petite boîte de saisie (renommer, nouveau groupe). */
export function prompt({ title, value = "", placeholder = "", okLabel }) {
  return new Promise((resolve) => {
    let result = null;
    const input = h("input", { class: "input", type: "text", value, placeholder, autofocus: true, spellcheck: "false", maxlength: "120" });
    openModal({
      title,
      body: input,
      onClose: () => resolve(result),
      actions: [
        { label: t("common.cancel") },
        {
          label: okLabel || t("common.ok"),
          kind: "primary",
          onClick: () => {
            const v = input.value.trim();
            if (!v) {
              input.focus();
              return false;
            }
            result = v;
          },
        },
      ],
    });
  });
}

export function confirmBox({ title, text, okLabel, danger = true }) {
  return new Promise((resolve) => {
    let result = false;
    openModal({
      title,
      body: h("p", { class: "muted", text }),
      onClose: () => resolve(result),
      actions: [
        { label: t("common.cancel") },
        { label: okLabel || t("common.ok"), kind: danger ? "danger" : "primary", onClick: () => (result = true) },
      ],
    });
  });
}

export function toggle(label, checked, onChange, sub) {
  const input = h("input", { type: "checkbox", class: "switch-input", checked, onchange: (e) => onChange(e.target.checked) });
  return h(
    "label",
    { class: "switch-row" },
    h("span", { class: "switch-text" }, h("span", { text: label }), sub ? h("small", { class: "muted", text: sub }) : null),
    input,
    h("span", { class: "switch", "aria-hidden": "true" })
  );
}

export function segmented(options, value, onChange) {
  const wrap = h("div", { class: "seg", role: "radiogroup" });
  for (const o of options) {
    const b = h(
      "button",
      {
        type: "button",
        class: `seg-btn ${o.value === value ? "active" : ""}`,
        role: "radio",
        "aria-checked": String(o.value === value),
        title: o.title || o.label || "",
        onclick: () => {
          wrap.querySelectorAll(".seg-btn").forEach((x) => {
            x.classList.toggle("active", x === b);
            x.setAttribute("aria-checked", String(x === b));
          });
          onChange(o.value);
        },
      },
      o.icon ? icon(o.icon) : null,
      o.label ? h("span", { text: o.label }) : null
    );
    wrap.append(b);
  }
  return wrap;
}
