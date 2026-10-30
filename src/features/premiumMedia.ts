// Animated stickers (TGS = gzipped Lottie JSON), video stickers (WEBM) and
// Premium custom emoji. Animations only run while visible to save battery.
import lottie from "lottie-web/build/player/lottie_light_canvas";
import { Api } from "teleproto";
import { Buffer } from "buffer";
// @ts-ignore — internal helper, same gzip implementation teleproto uses
import { GZIPPacked } from "teleproto/tl/core/GZIPPacked";
import { el } from "../ui/dom";
import { tg } from "../telegram/client";
import { isOn } from "./registry";

// ---------------- gzip ----------------
async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream !== "undefined") {
    const stream = new Blob([bytes as unknown as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  return new Uint8Array(GZIPPacked.ungzip(Buffer.from(bytes)));
}

// ---------------- Lottie with visibility-based play/pause ----------------
const visibility =
  "IntersectionObserver" in window
    ? new IntersectionObserver((entries) => {
        for (const e of entries) {
          const anim = (e.target as any)._anim;
          if (!anim) continue;
          if (e.isIntersecting) anim.play();
          else anim.pause();
        }
      })
    : null;

/** Plays a .tgs sticker inside `container`. */
export async function playTgs(container: HTMLElement, tgs: Uint8Array, loop = true): Promise<void> {
  const json = JSON.parse(new TextDecoder().decode(await gunzip(tgs)));
  container.replaceChildren();
  const anim = lottie.loadAnimation({
    container,
    renderer: "canvas",
    loop,
    autoplay: true,
    animationData: json,
    rendererSettings: { clearCanvas: true, preserveAspectRatio: "xMidYMid meet" } as any,
  });
  (container as any)._anim = anim;
  visibility?.observe(container);
  // Free memory once the node leaves the DOM.
  const mo = new MutationObserver(() => {
    if (!container.isConnected) {
      anim.destroy();
      visibility?.unobserve(container);
      mo.disconnect();
    }
  });
  mo.observe(document.body, { childList: true, subtree: true });
}

// ---------------- Custom emoji ----------------
const docCache = new Map<string, Api.Document>();
const bytesCache = new Map<string, Promise<Uint8Array | undefined>>();
const pending = new Map<string, ((d: Api.Document | undefined) => void)[]>();
let batchTimer: number | undefined;
const CACHE = "tg-emoji-v1";

function fetchDoc(id: string): Promise<Api.Document | undefined> {
  const hit = docCache.get(id);
  if (hit) return Promise.resolve(hit);
  return new Promise((resolve) => {
    const list = pending.get(id) ?? [];
    list.push(resolve);
    pending.set(id, list);
    clearTimeout(batchTimer);
    batchTimer = window.setTimeout(async () => {
      const ids = [...pending.keys()];
      const waiting = new Map(pending);
      pending.clear();
      try {
        const docs = await tg.getCustomEmojiDocs(ids);
        for (const d of docs) docCache.set(String(d.id), d);
      } catch {
        /* resolve undefined below */
      }
      for (const [k, fns] of waiting) fns.forEach((f) => f(docCache.get(k)));
    }, 40);
  });
}

function docBytes(doc: Api.Document): Promise<Uint8Array | undefined> {
  const id = String(doc.id);
  let p = bytesCache.get(id);
  if (!p) {
    p = (async () => {
      try {
        const c = await caches.open(CACHE);
        const r = await c.match(`/e/${id}`);
        if (r) return new Uint8Array(await r.arrayBuffer());
      } catch {
        /* no cache api */
      }
      const data = await tg.downloadDocument(doc);
      if (data && data.length) {
        try {
          const c = await caches.open(CACHE);
          await c.put(`/e/${id}`, new Response(data as unknown as BodyInit));
        } catch {
          /* ignore */
        }
      }
      return data;
    })();
    bytesCache.set(id, p);
  }
  return p;
}

/** Render a document (sticker / custom emoji) into `box` by its mime type. */
export async function renderDocInto(box: HTMLElement, doc: Api.Document): Promise<boolean> {
  const data = await docBytes(doc);
  if (!data || !data.length) return false;
  if (doc.mimeType === "application/x-tgsticker") {
    if (!isOn("animatedStickers")) return false;
    await playTgs(box, data);
    return true;
  }
  const url = URL.createObjectURL(new Blob([data as unknown as BlobPart], { type: doc.mimeType }));
  if (doc.mimeType === "video/webm") {
    const v = el("video", { src: url, autoplay: "", loop: "", playsinline: "" }) as HTMLVideoElement;
    v.muted = true;
    box.replaceChildren(v);
  } else box.replaceChildren(el("img", { src: url, alt: "" }));
  return true;
}

/**
 * A custom emoji: shows the fallback text first, swaps in the real (possibly
 * animated) emoji when it loads. `size` in px.
 */
export function customEmojiEl(documentId: string, size: number, fallback: (Node | string)[] | string): HTMLElement {
  const box = el("span", { class: "custom-emoji", style: { width: size + "px", height: size + "px" } }, typeof fallback === "string" ? [fallback] : fallback);
  if (!isOn("customEmoji")) return box;
  void fetchDoc(documentId).then(async (doc) => {
    if (doc) await renderDocInto(box, doc).catch(() => false);
  });
  return box;
}
