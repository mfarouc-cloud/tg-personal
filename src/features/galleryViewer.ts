// Fullscreen swipe viewer for a list of media messages (photos + videos).
// Swipe / arrow keys / buttons move between items; pinch/double-tap zoom on photos.
import { Api } from "teleproto";
import { el, toast } from "../ui/dom";
import { describeMedia, loadMedia, saveBlob, canSave } from "./media";
import { enableZoom } from "./zoom";

export function openGallery(
  msgs: Api.Message[],
  start: number,
  chatEntity: any,
  opts: { onOpenInChat?: (m: Api.Message) => void; onForward?: (m: Api.Message) => void } = {},
): void {
  const list = msgs.filter((m) => {
    const k = describeMedia(m)?.kind;
    return k === "photo" || k === "video" || k === "gif";
  });
  let idx = Math.max(0, list.indexOf(msgs[start]));
  const stage = el("div", { class: "gstage" });
  const counter = el("span", { class: "counter" });
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    stage.querySelectorAll("video").forEach((v) => (v as HTMLVideoElement).pause());
    overlay.remove();
    window.removeEventListener("keydown", onKey);
    window.removeEventListener("popstate", onPop);
    if (history.state?.hboltViewer) history.back();
  };
  // A system "back" closes the viewer instead of leaving the media tab.
  const onPop = () => {
    if (!history.state?.hboltViewer) close();
  };
  const cur = () => list[idx];
  const bar = el("div", { class: "viewer-bar" }, [
    el("button", { class: "iconbtn", text: "✕", "aria-label": "إغلاق", onclick: close }),
    counter,
    el("button", {
      class: "iconbtn",
      text: "💾",
      "aria-label": "حفظ",
      onclick: async () => {
        const m = cur();
        const info = describeMedia(m);
        if (!info || !canSave(m, chatEntity)) return toast("الحفظ مقفول هنا");
        const { blob } = await loadMedia(m, info);
        await saveBlob(blob, info.name);
      },
    }),
    ...(opts.onForward ? [el("button", { class: "iconbtn", text: "↪", "aria-label": "توجيه", onclick: () => opts.onForward!(cur()) })] : []),
    ...(opts.onOpenInChat ? [el("button", { class: "iconbtn", text: "💬", "aria-label": "في المحادثة", onclick: () => (close(), opts.onOpenInChat!(cur())) })] : []),
  ]);
  const prev = el("button", { class: "gnav prev", text: "›", "aria-label": "السابق", onclick: () => go(-1) });
  const next = el("button", { class: "gnav next", text: "‹", "aria-label": "التالي", onclick: () => go(1) });
  const overlay = el("div", { class: "gviewer", role: "dialog" }, [bar, stage, prev, next]);
  // Keep every touch inside the viewer so nothing underneath reacts to swipes.
  for (const t of ["touchstart", "touchmove", "touchend", "click"]) overlay.addEventListener(t, (e) => e.stopPropagation());
  document.body.append(overlay);
  history.pushState({ hboltViewer: true }, "");
  window.addEventListener("popstate", onPop);

  let seq = 0;
  async function show() {
    const my = ++seq;
    const m = cur();
    counter.textContent = `${idx + 1} / ${list.length}`;
    prev.style.visibility = idx > 0 ? "" : "hidden";
    next.style.visibility = idx < list.length - 1 ? "" : "hidden";
    stage.replaceChildren(el("div", { class: "spinner" }));
    const info = describeMedia(m)!;
    try {
      const { url } = await loadMedia(m, info);
      if (my !== seq) return;
      if (info.kind === "photo") {
        const img = el("img", { src: url, alt: "", decoding: "async" });
        enableZoom(img);
        stage.replaceChildren(img);
      } else {
        const v = el("video", { src: url, controls: "", playsinline: "", "webkit-playsinline": "", autoplay: "" }) as HTMLVideoElement;
        v.playsInline = true;
        if (info.kind === "gif") (v.muted = true), (v.loop = true);
        stage.replaceChildren(v);
      }
      // Preload neighbours for instant swipes.
      for (const j of [idx + 1, idx - 1]) {
        const n = list[j];
        const ni = n && describeMedia(n);
        if (ni?.kind === "photo") void loadMedia(n, ni).catch(() => {});
      }
    } catch {
      if (my === seq) stage.replaceChildren(el("div", { class: "hint", text: "تعذّر التحميل" }));
    }
  }
  function go(d: number) {
    const n = idx + d;
    if (n < 0 || n >= list.length) return;
    stage.querySelectorAll("video").forEach((v) => (v as HTMLVideoElement).pause());
    idx = n;
    void show();
  }
  // Swipe (only when the photo isn't zoomed in)
  let sx = 0, sy = 0, tracking = false;
  stage.addEventListener("touchstart", (e) => {
    if (e.touches.length !== 1) return (tracking = false);
    const img = stage.querySelector("img") as HTMLElement | null;
    tracking = !img || !/scale\((?!1\))/.test(img.style.transform || "");
    sx = e.touches[0].clientX;
    sy = e.touches[0].clientY;
  }, { passive: true });
  stage.addEventListener("touchend", (e) => {
    if (!tracking) return;
    const dx = e.changedTouches[0].clientX - sx;
    const dy = e.changedTouches[0].clientY - sy;
    if (Math.abs(dy) > 120 && Math.abs(dy) > Math.abs(dx)) return close();
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy)) go(dx < 0 ? 1 : -1);
  });
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") close();
    if (e.key === "ArrowLeft") go(1);
    if (e.key === "ArrowRight") go(-1);
  };
  window.addEventListener("keydown", onKey);
  void show();
}
