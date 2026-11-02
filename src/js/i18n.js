// Mini système de traduction : t("section.cle", { variable }).
import fr from "../locales/fr.js";

export const LOCALES = { fr };
let dict = fr;

export function setLanguage(code) {
  dict = LOCALES[code] || fr;
  document.documentElement.lang = LOCALES[code] ? code : "fr";
}

export function t(key, vars) {
  let v = key.split(".").reduce((o, k) => (o == null ? o : o[k]), dict);
  if (v == null) v = key.split(".").reduce((o, k) => (o == null ? o : o[k]), fr);
  if (typeof v !== "string") return key;
  if (vars) v = v.replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? ""));
  return v;
}

/** Traduit les éléments statiques marqués data-i18n / data-i18n-title / data-i18n-placeholder. */
export function applyStatic(root = document) {
  root.querySelectorAll("[data-i18n]").forEach((el) => (el.textContent = t(el.dataset.i18n)));
  root.querySelectorAll("[data-i18n-title]").forEach((el) => {
    el.title = t(el.dataset.i18nTitle);
    el.setAttribute("aria-label", el.title);
  });
  root.querySelectorAll("[data-i18n-placeholder]").forEach((el) => (el.placeholder = t(el.dataset.i18nPlaceholder)));
}

/** Affichage lisible d'un raccourci : "Alt+Space" -> "Alt+Espace". */
export function formatHotkey(accel) {
  const names = { Space: "Espace", Escape: "Échap", Enter: "Entrée", Delete: "Suppr", Backspace: "Retour" };
  return (accel || "").split("+").map((p) => names[p] || p).join("+");
}
