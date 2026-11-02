// Réorganisation par glisser-déposer, à base de Pointer Events.
// (Le glisser-déposer HTML5 est indisponible dans la WebView quand le dépôt
// de fichiers natif est activé, et il est moins fluide.)
// Les déplacements sont animés en FLIP avec transform uniquement.

const THRESHOLD = 6;

/**
 * @param {HTMLElement} root  conteneur (#content)
 * @param {{ onReorder(ids:string[]):void, onDropOnTab(id:string, group:string):void, tabsEl:HTMLElement }} opts
 * @returns {{ consumeClick(): boolean }}
 */
export function enableReorder(root, { onReorder, onDropOnTab, tabsEl }) {
  let s = null; // état du glissement en cours
  let suppressClick = false;

  root.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    const tile = e.target.closest(".tile[data-id]");
    if (!tile) return;
    const tiles = tile.parentElement;
    s = {
      tile,
      tiles,
      reorder: tiles.dataset.reorder === "1",
      id: tile.dataset.id,
      x0: e.clientX,
      y0: e.clientY,
      pointerId: e.pointerId,
      dragging: false,
      ghost: null,
      tab: null,
      raf: 0,
      lastX: e.clientX,
      lastY: e.clientY,
    };
  });

  root.addEventListener("pointermove", (e) => {
    if (!s || e.pointerId !== s.pointerId) return;
    s.lastX = e.clientX;
    s.lastY = e.clientY;
    if (!s.dragging) {
      if (Math.hypot(e.clientX - s.x0, e.clientY - s.y0) < THRESHOLD) return;
      start();
    }
    s.ghost.style.transform = `translate(${e.clientX - s.offX}px, ${e.clientY - s.offY}px) scale(1.04)`;
    hitTest(e.clientX, e.clientY);
  });

  const end = (e) => {
    if (!s || (e && e.pointerId !== s.pointerId)) return;
    const st = s;
    s = null;
    if (!st.dragging) return;
    cancelAnimationFrame(st.raf);
    suppressClick = true;
    setTimeout(() => (suppressClick = false), 0);
    st.tile.classList.remove("drag-source");
    document.body.classList.remove("dragging");
    tabsEl.querySelectorAll(".tab.drop-target").forEach((t) => t.classList.remove("drop-target"));
    // Le fantôme rejoint la place finale avant de disparaître.
    const r = st.tile.getBoundingClientRect();
    const ghost = st.ghost;
    ghost.style.transition = "transform 140ms cubic-bezier(.2,.8,.2,1), opacity 140ms";
    ghost.style.transform = `translate(${r.left}px, ${r.top}px) scale(1)`;
    if (st.tab) ghost.style.opacity = "0";
    setTimeout(() => ghost.remove(), 150);

    if (st.tab && st.tab !== "all") onDropOnTab(st.id, st.tab);
    else if (st.reorder) {
      const ids = [...st.tiles.querySelectorAll(".tile[data-id]")].map((t) => t.dataset.id);
      if (ids.join() !== st.initialOrder) onReorder(ids);
    }
  };
  root.addEventListener("pointerup", end);
  root.addEventListener("pointercancel", end);
  root.addEventListener("lostpointercapture", end);

  function start() {
    s.dragging = true;
    try {
      root.setPointerCapture(s.pointerId);
    } catch {}
    const r = s.tile.getBoundingClientRect();
    s.offX = s.x0 - r.left;
    s.offY = s.y0 - r.top;
    s.initialOrder = [...s.tiles.querySelectorAll(".tile[data-id]")].map((t) => t.dataset.id).join();
    const ghost = s.tile.cloneNode(true);
    ghost.classList.add("drag-ghost");
    ghost.classList.remove("selected");
    ghost.removeAttribute("id");
    ghost.style.width = r.width + "px";
    ghost.style.height = r.height + "px";
    ghost.style.transform = `translate(${r.left}px, ${r.top}px)`;
    document.body.append(ghost);
    s.ghost = ghost;
    s.tile.classList.add("drag-source");
    document.body.classList.add("dragging");
    autoScroll();
  }

  function hitTest(x, y) {
    // Onglet de groupe sous le pointeur -> déplacement vers ce groupe.
    const under = document.elementFromPoint(x, y);
    const tab = under?.closest?.(".tab[data-group]");
    const tabId = tab && tab.dataset.group !== "all" ? tab.dataset.group : null;
    if (tabId !== s.tab) {
      tabsEl.querySelectorAll(".tab.drop-target").forEach((t) => t.classList.remove("drop-target"));
      if (tab && tabId) tab.classList.add("drop-target");
      s.tab = tabId;
    }
    if (!s.reorder || tabId) return;
    const over = under?.closest?.(".tile[data-id]");
    if (!over || over === s.tile || over.parentElement !== s.tiles) return;
    const siblings = [...s.tiles.children];
    const from = siblings.indexOf(s.tile);
    const to = siblings.indexOf(over);
    flip(s.tiles, () => {
      if (from < to) over.after(s.tile);
      else over.before(s.tile);
    });
  }

  function flip(container, mutate) {
    const els = [...container.children];
    const before = new Map(els.map((el) => [el, el.getBoundingClientRect()]));
    mutate();
    for (const el of els) {
      const a = before.get(el);
      const b = el.getBoundingClientRect();
      const dx = a.left - b.left, dy = a.top - b.top;
      if (dx || dy) {
        el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], { duration: 160, easing: "cubic-bezier(.2,.8,.2,1)" });
      }
    }
  }

  function autoScroll() {
    if (!s || !s.dragging) return;
    const r = root.getBoundingClientRect();
    const edge = 48;
    let v = 0;
    if (s.lastY < r.top + edge) v = -Math.ceil((r.top + edge - s.lastY) / 4);
    else if (s.lastY > r.bottom - edge) v = Math.ceil((s.lastY - (r.bottom - edge)) / 4);
    if (v) {
      root.scrollTop += v;
      hitTest(s.lastX, s.lastY);
    }
    s.raf = requestAnimationFrame(autoScroll);
  }

  return {
    consumeClick() {
      return suppressClick;
    },
    get active() {
      return !!(s && s.dragging);
    },
  };
}
