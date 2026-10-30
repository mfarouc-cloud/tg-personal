// Profile pictures: instant blurred preview (Telegram's stripped thumb, sent
// inline with the chat) → real small photo loaded when visible, cached in
// memory and in the Cache API so it survives app restarts.
import { Api, utils } from "teleproto";
import { Buffer } from "buffer";
import { el, initials, colorFor } from "./dom";
import { tg } from "../telegram/client";
import { displayName, realName } from "../telegram/entity";

const mem = new Map<string, string>(); // photoId → object URL
const inflight = new Map<string, Promise<string | null>>();
const CACHE = "tg-avatars-v1";

function photoOf(entity: any): { id: string; stripped?: Uint8Array } | null {
  const p = entity?.photo;
  if (!p || p instanceof Api.UserProfilePhotoEmpty || p instanceof Api.ChatPhotoEmpty) return null;
  if (p.photoId == null) return null;
  return { id: String(p.photoId), stripped: p.strippedThumb };
}

async function fromCacheStorage(id: string): Promise<string | null> {
  try {
    const c = await caches.open(CACHE);
    const r = await c.match(`/avatar/${id}`);
    if (!r) return null;
    return URL.createObjectURL(await r.blob());
  } catch {
    return null;
  }
}

async function toCacheStorage(id: string, blob: Blob): Promise<void> {
  try {
    const c = await caches.open(CACHE);
    await c.put(`/avatar/${id}`, new Response(blob, { headers: { "content-type": "image/jpeg" } }));
  } catch {
    /* private mode / quota — fine */
  }
}

export function loadAvatar(entity: any): Promise<string | null> {
  const ph = photoOf(entity);
  if (!ph) return Promise.resolve(null);
  const hit = mem.get(ph.id);
  if (hit) return Promise.resolve(hit);
  const running = inflight.get(ph.id);
  if (running) return running;
  const p = (async () => {
    let url = await fromCacheStorage(ph.id);
    if (!url) {
      const bytes = await tg.profilePhoto(entity).catch(() => undefined);
      if (!bytes) return null;
      const blob = new Blob([bytes as unknown as BlobPart], { type: "image/jpeg" });
      void toCacheStorage(ph.id, blob);
      url = URL.createObjectURL(blob);
    }
    mem.set(ph.id, url);
    return url;
  })().finally(() => inflight.delete(ph.id));
  inflight.set(ph.id, p);
  return p;
}

function strippedUrl(stripped: Uint8Array): string | null {
  try {
    const jpg = utils.strippedPhotoToJpg(Buffer.from(stripped));
    return URL.createObjectURL(new Blob([jpg as unknown as BlobPart], { type: "image/jpeg" }));
  } catch {
    return null;
  }
}

const io =
  "IntersectionObserver" in window
    ? new IntersectionObserver(
        (entries) => {
          for (const e of entries) {
            if (!e.isIntersecting) continue;
            io!.unobserve(e.target);
            (e.target as any)._load?.();
          }
        },
        { rootMargin: "200px" },
      )
    : null;

/** Round avatar for any user/chat. `size` in px. */
export function avatarEl(entity: any, size = 52, nameOverride?: string, asPerson = false): HTMLElement {
  const name = nameOverride || (asPerson ? realName(entity) : displayName(entity)) || "?";
  const node = el("div", {
    class: "avatar",
    style: { width: size + "px", height: size + "px", fontSize: Math.round(size * 0.36) + "px", background: colorFor(name) },
  });
  if (entity?.self && !asPerson) {
    node.textContent = "🔖";
    node.style.background = "var(--accent)";
    return node;
  }
  node.textContent = initials(name);
  const ph = photoOf(entity);
  if (!ph) return node;

  const show = (url: string, blurred = false) => {
    node.textContent = "";
    node.style.backgroundImage = `url("${url}")`;
    node.classList.add("has-photo");
    node.classList.toggle("blurred", blurred);
  };
  const cached = mem.get(ph.id);
  if (cached) {
    show(cached);
    return node;
  }
  if (ph.stripped?.length) {
    const s = strippedUrl(ph.stripped);
    if (s) show(s, true);
  }
  const load = () => void loadAvatar(entity).then((url) => url && show(url));
  if (io) {
    (node as any)._load = load;
    io.observe(node);
  } else load();
  return node;
}
