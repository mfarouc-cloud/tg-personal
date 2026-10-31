import { Capacitor } from "@capacitor/core";
// Media helpers: describe a message's media, download it (with progress +
// an in-memory cache), and save it the way each platform expects:
//   - iPhone / iPad (and Android): the native share sheet → "Save Image",
//     "Save Video", "Save to Files".
//   - Desktop: a normal download with the real file name and extension.
import { Api } from "teleproto";
import { tg } from "../telegram/client";
import { isOn } from "./registry";

export type MediaKind =
  | "photo"
  | "video"
  | "gif"
  | "videoNote"
  | "voice"
  | "audio"
  | "sticker"
  | "file";

export interface MediaInfo {
  kind: MediaKind;
  name: string; // file name with extension, used when saving
  mime: string;
  size: number; // bytes (0 if unknown)
  duration?: number; // seconds
  emoji?: string; // sticker alt
}

const EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
  "audio/ogg": "ogg",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "application/pdf": "pdf",
  "application/zip": "zip",
  "application/x-tgsticker": "tgs",
};

/** Only real photo/document attachments count (not link previews). */
export function describeMedia(msg: Api.Message): MediaInfo | null {
  const m: any = msg;
  const media = m.media;
  const isPhoto = media instanceof Api.MessageMediaPhoto && m.photo;
  const isDoc = media instanceof Api.MessageMediaDocument && m.document;
  if (!isPhoto && !isDoc) return null;

  // Read attributes directly: teleproto's File.duration/width/height call
  // `instanceof` with an array and throw for audio/video documents.
  const doc: Api.Document | undefined = isDoc ? m.document : undefined;
  const attrs: any[] = doc?.attributes ?? [];
  const attr = <T>(cls: new (...a: any[]) => T): T | undefined => attrs.find((a) => a instanceof cls);
  const mime: string = doc?.mimeType || "image/jpeg";
  const size = doc ? Number(doc.size ?? 0) : photoSize(m.photo);
  const timed: any = attr(Api.DocumentAttributeAudio) ?? attr(Api.DocumentAttributeVideo);
  const duration = timed?.duration ? Number(timed.duration) : undefined;
  const fileName = attr(Api.DocumentAttributeFilename)?.fileName;
  const emoji = attr(Api.DocumentAttributeSticker)?.alt;

  let kind: MediaKind = "file";
  if (isPhoto) kind = "photo";
  else if (m.sticker) kind = "sticker";
  else if (m.videoNote) kind = "videoNote";
  else if (m.gif) kind = "gif";
  else if (m.video) kind = "video";
  else if (m.voice) kind = "voice";
  else if (m.audio) kind = "audio";
  else if (mime.startsWith("image/")) kind = "photo";

  const stamp = new Date((msg.date ?? 0) * 1000).toISOString().slice(0, 19).replace(/[-:T]/g, "");
  const ext = EXT[mime] || mime.split("/")[1]?.replace(/[^a-z0-9]/gi, "").slice(0, 5) || "bin";
  const prefix: Record<MediaKind, string> = {
    photo: "photo",
    video: "video",
    gif: "gif",
    videoNote: "round",
    voice: "voice",
    audio: "audio",
    sticker: "sticker",
    file: "file",
  };
  const name: string = fileName || `${prefix[kind]}_${stamp}_${msg.id}.${ext}`;
  return { kind, name, mime, size, duration, emoji };
}

function photoSize(photo?: Api.Photo): number {
  const sizes: any[] = photo?.sizes ?? [];
  let best = 0;
  for (const z of sizes) {
    const n = typeof z.size === "number" ? z.size : Array.isArray(z.sizes) ? Math.max(...z.sizes) : z.bytes?.length ?? 0;
    if (n > best) best = n;
  }
  return best;
}

/** Telegram's "restrict saving content" flag, on the message or the chat. */
export function isProtected(msg: Api.Message, chatEntity?: any): boolean {
  return !!((msg as any).noforwards || chatEntity?.noforwards);
}

/** Whether this client may save/copy this message right now. */
export function canSave(msg: Api.Message, chatEntity?: any): boolean {
  if (!isOn("saveMedia")) return false;
  return !isProtected(msg, chatEntity) || isOn("bypassRestrictions");
}

// ---- Download + cache ----
interface Cached {
  blob: Blob;
  url: string;
}
const cache = new Map<string, Cached>();
const inflight = new Map<string, Promise<Cached>>();
const MAX_CACHE_BYTES = 150 * 1024 * 1024; // keep memory bounded on phones
let cacheBytes = 0;

function keyOf(msg: Api.Message): string {
  return `${String((msg as any).chatId ?? "")}:${msg.id}`;
}

function remember(key: string, entry: Cached): void {
  cache.set(key, entry);
  cacheBytes += entry.blob.size;
  for (const [k, v] of cache) {
    if (cacheBytes <= MAX_CACHE_BYTES || k === key) break;
    URL.revokeObjectURL(v.url);
    cacheBytes -= v.blob.size;
    cache.delete(k);
  }
}

export function getCached(msg: Api.Message): Cached | undefined {
  return cache.get(keyOf(msg));
}

export function loadMedia(
  msg: Api.Message,
  info: MediaInfo,
  onProgress?: (ratio: number) => void,
): Promise<Cached> {
  const key = keyOf(msg);
  const hit = cache.get(key);
  if (hit) return Promise.resolve(hit);
  const pending = inflight.get(key);
  if (pending) return pending;
  const p = (async () => {
    const data = await tg.downloadMedia(msg, { onProgress });
    if (!data) throw new Error("الملف فاضي أو مش متاح");
    const blob = new Blob([data as unknown as BlobPart], { type: info.mime });
    const entry = { blob, url: URL.createObjectURL(blob) };
    remember(key, entry);
    return entry;
  })().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

// ---- Save ----
export type SaveResult = "shared" | "downloaded" | "cancelled";

async function saveNative(blob: Blob, name: string): Promise<SaveResult> {
  const { Filesystem, Directory } = await import("@capacitor/filesystem");
  const { Share } = await import("@capacitor/share");
  const b64: string = await new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(",")[1] ?? "");
    r.onerror = () => rej(r.error);
    r.readAsDataURL(blob);
  });
  const safe = name.replace(/[\\/:*?"<>|]/g, "_") || "file";
  const { uri } = await Filesystem.writeFile({ path: safe, data: b64, directory: Directory.Cache });
  try {
    await Share.share({ files: [uri] });
    return "shared";
  } catch (e: any) {
    if (/cancel/i.test(String(e?.message ?? e))) return "cancelled";
    throw e;
  }
}

export async function saveBlob(blob: Blob, name: string): Promise<SaveResult> {
  if (Capacitor.isNativePlatform()) return saveNative(blob, name);
  const file = new File([blob], name, { type: blob.type || "application/octet-stream" });
  const nav = navigator as Navigator & { canShare?: (d: any) => boolean };
  const touch = matchMedia("(pointer: coarse)").matches;
  // Phones: the share sheet is the only way to reach "Save to Photos".
  if (touch && nav.canShare?.({ files: [file] })) {
    try {
      await nav.share({ files: [file] });
      return "shared";
    } catch (e: any) {
      if (e?.name === "AbortError") return "cancelled";
      // fall through to a plain download
    }
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return "downloaded";
}

export function fmtSize(bytes: number): string {
  if (!bytes) return "";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

export function fmtDuration(sec?: number): string {
  if (!sec) return "";
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Original pixel size of a photo/video (largest size Telegram has), for correct aspect ratio. */
export function mediaDims(msg: Api.Message): { w: number; h: number } | null {
  const media: any = (msg as any).media;
  const photo = media?.photo;
  if (photo?.sizes?.length) {
    let best: any = null;
    for (const s of photo.sizes) if (s.w && s.h && (!best || s.w * s.h > best.w * best.h)) best = s;
    if (best) return { w: best.w, h: best.h };
  }
  const doc = media?.document;
  const v = doc?.attributes?.find((a: any) => a instanceof Api.DocumentAttributeVideo || a instanceof Api.DocumentAttributeImageSize);
  if (v?.w && v?.h) return { w: v.w, h: v.h };
  return null;
}

/**
 * Save many media files. iOS app: written to cache and handed to ONE share
 * sheet (chunks of 20) so "Save N items" works; browser: sequential downloads.
 */
export async function saveMany(
  msgs: Api.Message[],
  onProgress?: (done: number, total: number) => void,
  signal?: AbortSignal,
): Promise<number> {
  const items = msgs.map((m) => ({ m, info: describeMedia(m) })).filter((x): x is { m: Api.Message; info: MediaInfo } => !!x.info);
  let done = 0;
  if (Capacitor.isNativePlatform()) {
    const { Filesystem, Directory } = await import("@capacitor/filesystem");
    const { Share } = await import("@capacitor/share");
    for (let i = 0; i < items.length; i += 20) {
      const uris: string[] = [];
      for (const { m, info } of items.slice(i, i + 20)) {
        if (signal?.aborted) throw new Error("CANCELLED");
        const { blob } = await loadMedia(m, info);
        const b64: string = await new Promise((res, rej) => {
          const r = new FileReader();
          r.onload = () => res(String(r.result).split(",")[1] ?? "");
          r.onerror = () => rej(r.error);
          r.readAsDataURL(blob);
        });
        const { uri } = await Filesystem.writeFile({ path: `${m.id}_${info.name}`.replace(/[\\/:*?"<>|]/g, "_"), data: b64, directory: Directory.Cache });
        uris.push(uri);
        onProgress?.(++done, items.length);
      }
      try {
        await Share.share({ files: uris });
      } catch (e: any) {
        if (!/cancel/i.test(String(e?.message ?? e))) throw e;
      }
    }
    return done;
  }
  for (const { m, info } of items) {
    if (signal?.aborted) throw new Error("CANCELLED");
    const { blob } = await loadMedia(m, info);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = info.name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    onProgress?.(++done, items.length);
    await new Promise((r) => setTimeout(r, 300));
  }
  return done;
}
