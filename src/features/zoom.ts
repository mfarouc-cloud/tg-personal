// Pinch-to-zoom, double-tap zoom and pan for the full-screen photo viewer.
export function enableZoom(img: HTMLElement): void {
  let scale = 1, tx = 0, ty = 0;
  let startDist = 0, startScale = 1, lastX = 0, lastY = 0, lastTap = 0;
  const pts = new Map<number, { x: number; y: number }>();
  const apply = () => {
    if (scale <= 1) { scale = 1; tx = 0; ty = 0; }
    img.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
  };
  img.style.touchAction = "none";
  img.style.transition = "transform .05s linear";
  img.addEventListener("pointerdown", (e) => {
    img.setPointerCapture(e.pointerId);
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    lastX = e.clientX; lastY = e.clientY;
    if (pts.size === 2) {
      const [a, b] = [...pts.values()];
      startDist = Math.hypot(a.x - b.x, a.y - b.y);
      startScale = scale;
    } else {
      const now = Date.now();
      if (now - lastTap < 280) { scale = scale > 1 ? 1 : 2.5; img.style.transition = "transform .2s ease"; apply(); setTimeout(() => (img.style.transition = "transform .05s linear"), 220); }
      lastTap = now;
    }
  });
  img.addEventListener("pointermove", (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 2 && startDist) {
      const [a, b] = [...pts.values()];
      scale = Math.min(6, Math.max(1, startScale * (Math.hypot(a.x - b.x, a.y - b.y) / startDist)));
      apply();
    } else if (pts.size === 1 && scale > 1) {
      tx += e.clientX - lastX; ty += e.clientY - lastY;
      lastX = e.clientX; lastY = e.clientY;
      apply();
    }
  });
  const up = (e: PointerEvent) => { pts.delete(e.pointerId); if (pts.size < 2) startDist = 0; };
  img.addEventListener("pointerup", up);
  img.addEventListener("pointercancel", up);
  img.addEventListener("wheel", (e) => { e.preventDefault(); scale = Math.min(6, Math.max(1, scale * (e.deltaY < 0 ? 1.15 : 0.87))); apply(); }, { passive: false });
}
