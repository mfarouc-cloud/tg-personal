// Renders a message's media inside its bubble: inline photos, playable
// video/voice/audio, sticker previews, file chips — each with a 💾 save button
// (when allowed) and a full-screen viewer for photos/videos.
import { Api } from "teleproto";
import { el, toast } from "./dom";
import {
  describeMedia,
  canSave,
  isProtected,
  loadMedia,
  getCached,
  saveBlob,
  fmtSize,
  fmtDuration,
  type MediaInfo,
} from "../features/media";
import { isOn } from "../features/registry";
import { tg } from "../telegram/client";
import { playTgs } from "../features/premiumMedia";

const ICON: Record<MediaInfo["kind"], string> = {
  photo: "📷",
  video: "🎬",
  gif: "🎞",
  videoNote: "⭕",
  voice: "🎤",
  audio: "🎵",
  sticker: "🙂",
  file: "📎",
};
const LABEL: Record<MediaInfo["kind"], string> = {
  photo: "صورة",
  video: "فيديو",
  gif: "GIF",
  videoNote: "فيديو دائري",
  voice: "رسالة صوتية",
  audio: "صوت",
  sticker: "ملصق",
  file: "ملف",
};

// Lazily auto-load photos as they scroll into view.
const io =
  "IntersectionObserver" in window
    ? new IntersectionObserver(
        (entries) => {
          for (const e of entries) {
            if (!e.isIntersecting) continue;
            io!.unobserve(e.target);
            (e.target as any)._autoload?.();
          }
        },
        { rootMargin: "300px" },
      )
    : null;

/** Appends the media UI for `msg` to `container`. Returns false if no media. */
export function renderMedia(
  container: HTMLElement,
  msg: Api.Message,
  chatEntity?: any,
  onForward?: () => void,
): boolean {
  const info = describeMedia(msg);
  if (!info) return false;

  const box = el("div", { class: `media media-${info.kind}` });
  container.append(box);
  const meta = [LABEL[info.kind], fmtDuration(info.duration), fmtSize(info.size)].filter(Boolean).join(" · ");

  // Status/progress line shared by all kinds.
  const status = el("span", { class: "media-status" });
  const setProgress = (r: number) => (status.textContent = `${Math.round(r * 100)}%`);

  const load = async () => {
    status.textContent = "...";
    try {
      const res = await loadMedia(msg, info, setProgress);
      status.textContent = "";
      return res;
    } catch (e: any) {
      status.textContent = "فشل التحميل — دوس تاني";
      throw e;
    }
  };

  const saveBtn = canSave(msg, chatEntity)
    ? el("button", {
        class: "media-save",
        "aria-label": "حفظ",
        title: "حفظ",
        text: "💾",
        onclick: (e: Event) => {
          e.stopPropagation();
          void saveMedia(msg, info, setProgress, status);
        },
      })
    : null;

  const lockBadge =
    isProtected(msg, chatEntity) && !canSave(msg, chatEntity) && isOn("saveMedia")
      ? el("span", { class: "media-lock", title: "القناة دي قافلة الحفظ", text: "🔒" })
      : null;

  switch (info.kind) {
    case "photo": {
      const frame = el("button", { class: "media-frame", "aria-label": "صورة" }, [
        el("span", { class: "media-ph", text: ICON.photo + " " + meta }),
      ]);
      const show = async () => {
        const { url } = await load();
        const img = el("img", { src: url, alt: "", loading: "lazy" });
        frame.replaceChildren(img);
        frame.onclick = () => openViewer(msg, info, url, chatEntity);
      };
      frame.onclick = () => void show().catch(() => {});
      const cached = getCached(msg);
      if (cached) void show();
      else if (isOn("autoLoadPhotos") && io) {
        (frame as any)._autoload = () => void show().catch(() => {});
        io.observe(frame);
      }
      box.append(frame);
      break;
    }
    case "video":
    case "gif":
    case "videoNote": {
      const frame = el("button", { class: "media-frame", "aria-label": LABEL[info.kind] }, [
        el("span", { class: "media-ph", text: "▶ " + meta }),
      ]);
      frame.onclick = async () => {
        try {
          const { url } = await load();
          const v = el("video", { src: url, playsinline: "", controls: info.kind !== "gif" ? "" : null }) as HTMLVideoElement;
          if (info.kind === "gif") {
            v.muted = true;
            v.loop = true;
            v.autoplay = true;
          }
          frame.replaceWith(v);
          if (info.kind !== "gif") void v.play().catch(() => {});
        } catch {
          /* status shows the error */
        }
      };
      box.append(frame);
      break;
    }
    case "voice":
    case "audio": {
      const btn = el("button", { class: "media-chip", text: `${ICON[info.kind]} ▶ ${meta}` });
      btn.onclick = async () => {
        try {
          const { url } = await load();
          const a = el("audio", { src: url, controls: "", preload: "auto" }) as HTMLAudioElement;
          btn.replaceWith(a);
          void a.play().catch(() => {});
        } catch {
          /* status shows the error */
        }
      };
      box.append(btn);
      break;
    }
    case "sticker": {
      const animated = info.mime === "application/x-tgsticker";
      const frame = el("div", { class: "media-sticker", text: info.emoji || ICON.sticker });
      if (animated) {
        if (isOn("animatedStickers"))
          void load()
            .then(async ({ blob }) => playTgs(frame, new Uint8Array(await blob.arrayBuffer())))
            .catch(() => {});
      } else {
        void load()
          .then(({ url }) => {
            const node =
              info.mime === "video/webm"
                ? el("video", { src: url, autoplay: "", loop: "", muted: "", playsinline: "" })
                : el("img", { src: url, alt: info.emoji || "" });
            if (node instanceof HTMLVideoElement) node.muted = true;
            frame.replaceChildren(node);
          })
          .catch(() => {});
      }
      box.append(frame);
      break;
    }
    default: {
      box.append(
        el("div", { class: "media-chip file" }, [
          el("span", { class: "file-icon", text: ICON.file }),
          el("span", { class: "file-name", text: info.name }),
          el("span", { class: "file-size", text: fmtSize(info.size) }),
        ]),
      );
    }
  }

  const bar = el("div", { class: "media-bar" }, [status]);
  if (lockBadge) bar.append(lockBadge);
  if (onForward) {
    bar.append(
      el("button", {
        class: "media-save",
        "aria-label": "توجيه",
        title: "توجيه",
        text: "↪",
        onclick: (e: Event) => {
          e.stopPropagation();
          onForward();
        },
      }),
    );
  }
  if (saveBtn) bar.append(saveBtn);
  if ((info.kind === "voice" || info.kind === "videoNote") && isOn("voiceToText") && chatEntity) {
    bar.append(
      el("button", {
        class: "media-save",
        "aria-label": "تحويل لنص",
        title: "تحويل لنص (Premium)",
        text: "Aa",
        onclick: (e: Event) => {
          e.stopPropagation();
          void transcribeInto(box, msg, chatEntity);
        },
      }),
    );
  }
  box.append(bar);
  return true;
}

/** Premium voice-to-text. Telegram may answer "pending" and push the final
 *  text later via UpdateTranscribedAudio. */
async function transcribeInto(box: HTMLElement, msg: Api.Message, chatEntity: any): Promise<void> {
  let out = box.querySelector(".transcript") as HTMLElement | null;
  if (out) {
    out.remove(); // second tap hides it
    return;
  }
  const textEl = el("span", { text: "بيحوّل..." });
  out = el("div", { class: "transcript" }, [el("span", { class: "tr-head", text: "Aa نص الرسالة" }), textEl]);
  box.append(out);
  try {
    const r = await tg.transcribe(chatEntity, msg.id);
    textEl.textContent = r.text || (r.pending ? "بيحوّل..." : "(مفيش كلام واضح)");
    if (r.pending) {
      const off = tg.on("transcribed", (u) => {
        if (u.transcriptionId !== r.transcriptionId && u.msgId !== msg.id) return;
        textEl.textContent = u.text || textEl.textContent;
        if (!u.pending) off();
      });
      setTimeout(off, 120_000);
    }
  } catch (e: any) {
    const m = String(e?.errorMessage || e?.message || e);
    textEl.textContent = /PREMIUM/i.test(m) ? "الميزة دي محتاجة Premium" : "تعذّر التحويل: " + m;
  }
}

async function saveMedia(
  msg: Api.Message,
  info: MediaInfo,
  onProgress: (r: number) => void,
  status: HTMLElement,
): Promise<void> {
  try {
    status.textContent = "...";
    const { blob } = await loadMedia(msg, info, onProgress);
    status.textContent = "";
    const r = await saveBlob(blob, info.name);
    if (r === "downloaded") toast("اتحفظ: " + info.name);
    else if (r === "shared") toast("تمام ✓");
  } catch (e: any) {
    status.textContent = "";
    toast("تعذّر الحفظ: " + (e?.errorMessage || e?.message || ""));
  }
}

/** Full-screen photo viewer with a save button. */
function openViewer(msg: Api.Message, info: MediaInfo, url: string, chatEntity?: any): void {
  const close = () => {
    overlay.remove();
    window.removeEventListener("keydown", onKey);
  };
  const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
  const status = el("span", { class: "media-status" });
  const actions = el("div", { class: "viewer-bar" }, [
    el("button", { class: "iconbtn", text: "✕", "aria-label": "إغلاق", onclick: close }),
    status,
  ]);
  if (canSave(msg, chatEntity)) {
    actions.append(
      el("button", {
        class: "btn",
        text: "💾 حفظ",
        onclick: () => void saveMedia(msg, info, () => {}, status),
      }),
    );
  }
  const overlay = el("div", { class: "viewer", onclick: (e: Event) => e.target === overlay && close() }, [
    actions,
    el("img", { src: url, alt: "" }),
  ]);
  document.body.append(overlay);
  window.addEventListener("keydown", onKey);
}

/** Context-menu helper: save action for messages that have media. */
export function mediaMenuItem(
  msg: Api.Message,
  chatEntity?: any,
): { label: string; run: () => void } | null {
  const info = describeMedia(msg);
  if (!info || !canSave(msg, chatEntity)) return null;
  const status = el("span");
  return { label: `💾 حفظ ${LABEL[info.kind]}`, run: () => void saveMedia(msg, info, () => {}, status) };
}
