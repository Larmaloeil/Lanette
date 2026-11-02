// Accès au backend Rust (Tauri 2, API globale window.__TAURI__).
const T = window.__TAURI__;

export const invoke = (cmd, args) => T.core.invoke(cmd, args);
export const listen = (event, cb) => T.event.listen(event, cb);
export const appWindow = () => T.window.getCurrentWindow();
export const webview = () => T.webview.getCurrentWebview();

const SIZES = [16, 24, 32, 48, 64, 96, 128];

/** Taille en pixels physiques (écrans haute densité) arrondie au palier supérieur. */
export function iconPixels(cssPx) {
  const want = Math.ceil(cssPx * (window.devicePixelRatio || 1));
  return SIZES.find((s) => s >= want) || 128;
}

/** URL du protocole icon:// (servi en arrière-plan + cache disque par Rust). */
export function iconUrl(item, cssPx) {
  const src = item.icon || (item.kind === "url" ? null : item.target);
  if (!src) return null;
  return `${T.core.convertFileSrc(src, "icon")}?s=${iconPixels(cssPx)}`;
}
