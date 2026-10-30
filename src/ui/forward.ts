// Forwarding: a bottom-sheet chat picker + the forward logic.
//
// Normal chats      → real Telegram forward (optionally without the
//                     "Forwarded from" header via dropAuthor).
// Protected chats   → Telegram refuses forwards, so (when "bypass
//                     restrictions" is on) we download the media and send it
//                     again as a new message with the same caption.
import { Api } from "teleproto";
import { el, toast, initials, colorFor } from "./dom";
import { tg } from "../telegram/client";
import type { Dialog } from "../telegram/types";
import { getDialogsCached } from "./chatlist";
import { describeMedia, isProtected, loadMedia } from "../features/media";
import { isOn } from "../features/registry";

const K_HIDE = "tg.fwd.hideSender";

interface Target {
  title: string;
  peer: Api.TypeEntityLike;
}

export function canForward(msg: Api.Message, chatEntity?: any): boolean {
  if (!isOn("forward")) return false;
  return !isProtected(msg, chatEntity) || isOn("bypassRestrictions");
}

async function forwardTo(
  msg: Api.Message,
  src: Dialog,
  target: Target,
  hideSender: boolean,
  onStatus: (s: string) => void,
): Promise<void> {
  const srcPeer = (src.entity ?? src.inputEntity) as Api.TypeEntityLike;

  const resend = async () => {
    if (!isOn("bypassRestrictions")) throw new Error("القناة دي قافلة التوجيه");
    const info = describeMedia(msg);
    let file: File | undefined;
    if (info) {
      onStatus("بيحمّل...");
      const { blob } = await loadMedia(msg, info, (r) => onStatus(`بيحمّل ${Math.round(r * 100)}%`));
      file = new File([blob], info.name, { type: info.mime });
    }
    onStatus(file ? "بيرفع..." : "بيبعت...");
    await tg.resend(target.peer, msg, file, (r) => onStatus(`بيرفع ${Math.round(r * 100)}%`));
  };

  if (isProtected(msg, src.entity)) return resend();
  try {
    onStatus("بيوجّه...");
    await tg.forward(target.peer, msg, srcPeer, hideSender);
  } catch (e: any) {
    const m = String(e?.errorMessage || e?.message || e);
    if (/FORWARDS_RESTRICTED|NOFORWARDS/i.test(m)) return resend();
    throw e;
  }
}

/** Opens the "forward to…" sheet for `msg` coming from chat `src`. */
export function openForwardPicker(msg: Api.Message, src: Dialog): void {
  const protectedSrc = isProtected(msg, src.entity);
  let hide = localStorage.getItem(K_HIDE) === "1";
  let busy = false;
  let filter = "";
  let dialogs: Dialog[] = [];

  const close = () => {
    if (busy) return;
    overlay.remove();
  };

  const status = el("div", { class: "hint sheet-status" });
  const search = el("input", { type: "search", class: "search", placeholder: "ابحث عن محادثة" }) as HTMLInputElement;
  const list = el("div", { class: "sheet-list" }, [el("div", { class: "center" }, [el("div", { class: "spinner" })])]);

  const hideToggle = el("button", {
    class: "toggle" + (hide ? " on" : ""),
    role: "switch",
    "aria-checked": String(hide),
    "aria-label": "إخفاء اسم المرسل",
  });
  hideToggle.onclick = () => {
    hide = !hide;
    localStorage.setItem(K_HIDE, hide ? "1" : "0");
    hideToggle.classList.toggle("on", hide);
    hideToggle.setAttribute("aria-checked", String(hide));
  };

  const options = protectedSrc
    ? el("div", { class: "row" }, [
        el("div", { class: "text" }, [
          el("div", { class: "label", text: "🔒 القناة دي قافلة التوجيه" }),
          el("div", { class: "desc", text: "هيتبعت كرسالة جديدة (تحميل وإعادة رفع)، من غير اسم المصدر" }),
        ]),
      ])
    : el("div", { class: "row" }, [
        el("div", { class: "text" }, [
          el("div", { class: "label", text: "إخفاء اسم المرسل" }),
          el("div", { class: "desc", text: 'الرسالة توصل من غير "Forwarded from"' }),
        ]),
        hideToggle,
      ]);

  const sheet = el("div", { class: "sheet", role: "dialog", "aria-label": "توجيه إلى" }, [
    el("div", { class: "sheet-head" }, [
      el("div", { class: "title", text: "توجيه إلى" }),
      el("button", { class: "iconbtn", text: "✕", "aria-label": "إغلاق", onclick: close }),
    ]),
    el("div", { class: "searchbar" }, [search]),
    options,
    status,
    list,
  ]);
  const overlay = el("div", { class: "sheet-backdrop", onclick: (e: Event) => e.target === overlay && close() }, [sheet]);
  document.body.append(overlay);

  const send = async (t: Target, rowEl: HTMLElement) => {
    if (busy) return;
    busy = true;
    rowEl.classList.add("sending");
    try {
      await forwardTo(msg, src, t, hide, (s) => (status.textContent = s));
      busy = false;
      close();
      toast(`اتبعت لـ ${t.title} ✓`);
    } catch (e: any) {
      busy = false;
      rowEl.classList.remove("sending");
      status.textContent = "";
      toast("تعذّر التوجيه: " + (e?.errorMessage || e?.message || ""));
    }
  };

  const row = (t: Target, icon?: string) => {
    const r: HTMLElement = el("button", { class: "chat-row sheet-row" }, [
      el("div", {
        class: "avatar small",
        style: { background: icon ? "var(--accent)" : colorFor(t.title) },
        text: icon || initials(t.title),
      }),
      el("div", { class: "chat-name", text: t.title }),
    ]);
    r.onclick = () => void send(t, r);
    return r;
  };

  const paint = () => {
    list.replaceChildren();
    const saved = { title: "الرسائل المحفوظة", peer: "me" as unknown as Api.TypeEntityLike };
    if (!filter || saved.title.includes(filter)) list.append(row(saved, "🔖"));
    const items = dialogs
      .filter((d) => {
        const ent: any = d.entity;
        // Skip channels where you can't post.
        if (d.isChannel && !d.isGroup && !(ent?.creator || ent?.adminRights)) return false;
        return !filter || (d.title || d.name || "").toLowerCase().includes(filter);
      })
      .slice(0, 150);
    for (const d of items) {
      list.append(row({ title: d.title || d.name || "بدون اسم", peer: (d.entity ?? d.inputEntity) as Api.TypeEntityLike }));
    }
  };
  search.oninput = () => {
    filter = search.value.trim().toLowerCase();
    paint();
  };

  getDialogsCached()
    .then((d) => {
      dialogs = d;
      paint();
    })
    .catch(() => list.replaceChildren(el("div", { class: "center", text: "تعذّر تحميل المحادثات" })));
}
