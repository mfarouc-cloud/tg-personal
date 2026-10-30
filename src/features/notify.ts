// In-app message notifications (banner + optional sound) and system
// notifications while the app is in the background but still running.
// Real push (app fully closed) needs HTTPS hosting + service-worker push.
import { Api } from "teleproto";
import { el } from "../ui/dom";
import { tg, peerKey } from "../telegram/client";
import { displayName } from "../telegram/entity";
import { snippetOf } from "../ui/chat/bubble";

type Key = "inApp" | "sound" | "preview" | "system";
const DEFAULTS: Record<Key, boolean> = { inApp: true, sound: true, preview: true, system: false };

export function notifySettings(): Record<Key, boolean> {
  const out = { ...DEFAULTS };
  for (const k of Object.keys(DEFAULTS) as Key[]) {
    const v = localStorage.getItem("tg.notify." + k);
    if (v !== null) out[k] = v === "1";
  }
  return out;
}

export function setNotifySetting(k: Key, on: boolean): void {
  localStorage.setItem("tg.notify." + k, on ? "1" : "0");
}

export async function requestSystemPermission(): Promise<boolean> {
  if (!("Notification" in window)) return false;
  if (Notification.permission === "granted") return true;
  return (await Notification.requestPermission()) === "granted";
}

function beep(): void {
  try {
    const ctx = new AudioContext();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.value = 880;
    g.gain.setValueAtTime(0.0001, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.15, ctx.currentTime + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.25);
    o.connect(g).connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + 0.3);
    o.onended = () => void ctx.close();
  } catch {
    /* no audio */
  }
}

let banner: HTMLElement | null = null;
let hideTimer: number | undefined;

function showBanner(title: string, body: string, onClick: () => void): void {
  banner?.remove();
  banner = el("button", { class: "notify-banner", role: "status" }, [el("b", { text: title }), el("span", { text: body })]);
  banner.onclick = () => {
    banner?.remove();
    onClick();
  };
  document.body.append(banner);
  requestAnimationFrame(() => banner?.classList.add("show"));
  clearTimeout(hideTimer);
  hideTimer = window.setTimeout(() => {
    banner?.classList.remove("show");
    setTimeout(() => banner?.remove(), 300);
  }, 4000);
}

export interface NotifierHooks {
  /** peerKey of the chat currently on screen (null on other screens). */
  openChatKey: () => string | null;
  /** Is this chat muted? (from the chat list cache). */
  isMuted: (peerKey: string) => boolean;
  /** Open the chat a notification belongs to. */
  open: (entity: any) => void;
}

/** Start listening for new messages. Call once after login. */
export function startNotifier(h: NotifierHooks): void {
  tg.on("newMessage", async ({ message }) => {
    const m: any = message;
    if (m.out || m instanceof Api.MessageService) return;
    const key = peerKey(m.peerId);
    const s = notifySettings();
    const visibleHere = !document.hidden && h.openChatKey() === key;
    if (visibleHere || h.isMuted(key)) return;
    if (!s.inApp && !(s.system && document.hidden)) return;

    let chat: any;
    let sender: any;
    try {
      chat = m.chat ?? (await tg.getEntity(m.peerId));
      sender = m.sender ?? (m.fromId ? await tg.getEntity(m.fromId) : chat);
    } catch {
      /* names are best-effort */
    }
    const chatName = displayName(chat) || "رسالة جديدة";
    const isGroupish = chat && !(chat instanceof Api.User);
    const title = isGroupish && sender && sender !== chat ? `${displayName(sender)} · ${chatName}` : chatName;
    const body = s.preview ? snippetOf(message) : "رسالة جديدة";

    if (document.hidden && s.system && "Notification" in window && Notification.permission === "granted") {
      const n = new Notification(title, { body, tag: key });
      n.onclick = () => {
        window.focus();
        if (chat) h.open(chat);
        n.close();
      };
      return;
    }
    if (!s.inApp || document.hidden) return;
    if (s.sound) beep();
    showBanner(title, body, () => chat && h.open(chat));
  });
}
