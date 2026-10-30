// Long-press / right-click menu for a message, plus small shared dialogs.
import { Api } from "teleproto";
import { el, toast } from "../dom";
import { tg } from "../../telegram/client";
import { isOn, translateLang } from "../../features/registry";
import { isProtected } from "../../features/media";
import { mediaMenuItem } from "../mediaView";
import { canForward } from "../forward";
import { customEmojiEl } from "../../features/premiumMedia";

export type MenuItem = { label: string; run: () => void; danger?: boolean };

export const QUICK_REACTIONS = ["👍", "❤️", "🔥", "😂", "😮", "😢", "🙏", "👏"];

export interface MenuCtx {
  chatEntity: any;
  peer: Api.TypeEntityLike;
  canWrite: boolean;
  isBroadcast: boolean;
  onReply: (m: Api.Message) => void;
  onEdit: (m: Api.Message) => void;
  onDelete: (m: Api.Message) => void;
  onPinToggle: (m: Api.Message) => void;
  onForward: (m: Api.Message) => void;
  onReaction: (m: Api.Message, emoji: string) => void;
  onTranslate: (m: Api.Message) => void;
  onSenderInfo?: (m: Api.Message) => void;
}

export function messageLink(entity: any, msgId: number): string | null {
  if (!(entity instanceof Api.Channel)) return null;
  if (entity.username) return `https://t.me/${entity.username}/${msgId}`;
  return `https://t.me/c/${String(entity.id)}/${msgId}`;
}

export function menuFor(m: Api.Message, ctx: MenuCtx): { items: MenuItem[]; reactions: boolean } {
  const items: MenuItem[] = [];
  const allowed = !isProtected(m, ctx.chatEntity) || isOn("bypassRestrictions");
  if (ctx.canWrite) items.push({ label: "↩ رد", run: () => ctx.onReply(m) });
  if (isOn("copyText") && allowed && m.message) items.push({ label: "📋 نسخ النص", run: () => void copyText(m.message) });
  const link = messageLink(ctx.chatEntity, m.id);
  if (link) items.push({ label: "🔗 نسخ لينك الرسالة", run: () => void copyText(link) });
  if (m.out && !(m as any).fwdFrom && (m.message || (m as any).media)) {
    items.push({ label: "✎ تعديل", run: () => ctx.onEdit(m) });
  }
  items.push({ label: (m as any).pinned ? "📌 إلغاء التثبيت" : "📌 تثبيت", run: () => ctx.onPinToggle(m) });
  const save = mediaMenuItem(m, ctx.chatEntity);
  if (save) items.push(save);
  if (canForward(m, ctx.chatEntity)) items.push({ label: "↪ إعادة توجيه", run: () => ctx.onForward(m) });
  if (isOn("translate") && m.message) items.push({ label: "🌐 ترجمة", run: () => ctx.onTranslate(m) });
  const fromUser = (m as any).fromId instanceof Api.PeerUser;
  if (ctx.onSenderInfo && isOn("userInsight") && !m.out && (fromUser || ctx.chatEntity instanceof Api.User))
    items.push({ label: "🔎 معلومات المرسل", run: () => ctx.onSenderInfo!(m) });
  items.push({ label: "🗑 مسح", run: () => ctx.onDelete(m), danger: true });
  return { items, reactions: true };
}

// ---------------- Generic popup menu ----------------
export function openMenu(
  x: number,
  y: number,
  items: MenuItem[],
  reactions?: { onPick: (emoji: string) => void; mine: string[] },
): void {
  const close = () => {
    backdrop.remove();
    menu.remove();
  };
  const backdrop = el("div", {
    class: "menu-backdrop",
    onclick: close,
    oncontextmenu: (e: Event) => {
      e.preventDefault();
      close();
    },
  });
  const menu = el("div", { class: "menu", role: "menu" });
  if (reactions) {
    const row = el("div", { class: "menu-reactions" });
    for (const r of QUICK_REACTIONS) {
      row.append(
        el("button", {
          class: "mr" + (reactions.mine.includes(r) ? " mine" : ""),
          text: r,
          "aria-label": r,
          onclick: () => {
            close();
            reactions.onPick(r);
          },
        }),
      );
    }
    row.append(
      el("button", {
        class: "mr more",
        text: "➕",
        "aria-label": "كل الرياكشنات",
        onclick: () => {
          close();
          void openReactionPicker(reactions.mine, reactions.onPick);
        },
      }),
    );
    menu.append(row);
  }
  for (const it of items) {
    menu.append(
      el("button", {
        role: "menuitem",
        class: it.danger ? "danger" : "",
        text: it.label,
        onclick: () => {
          close();
          it.run();
        },
      }),
    );
  }
  document.body.append(backdrop, menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.max(8, Math.min(x - r.width / 2, window.innerWidth - r.width - 8)) + "px";
  menu.style.top = Math.max(8, Math.min(y, window.innerHeight - r.height - 8)) + "px";
}

/** Long-press (touch) + right-click (desktop) on a node. */
export function attachLongPress(node: HTMLElement, onOpen: (x: number, y: number) => void): void {
  let timer: number | undefined;
  let sx = 0;
  let sy = 0;
  node.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    onOpen(e.clientX, e.clientY);
  });
  node.addEventListener(
    "touchstart",
    (e) => {
      const t = e.touches[0];
      sx = t.clientX;
      sy = t.clientY;
      timer = window.setTimeout(() => {
        navigator.vibrate?.(10);
        onOpen(sx, sy);
      }, 450);
    },
    { passive: true },
  );
  node.addEventListener(
    "touchmove",
    (e) => {
      const t = e.touches[0];
      if (Math.abs(t.clientX - sx) > 10 || Math.abs(t.clientY - sy) > 10) clearTimeout(timer);
    },
    { passive: true },
  );
  node.addEventListener("touchend", () => clearTimeout(timer));
  node.addEventListener("touchcancel", () => clearTimeout(timer));
}

/** Bottom action sheet; resolves with the chosen value or null. */
export function askChoice(title: string, options: { label: string; value: string; danger?: boolean }[]): Promise<string | null> {
  return new Promise((resolve) => {
    const done = (v: string | null) => {
      overlay.remove();
      resolve(v);
    };
    const sheet = el("div", { class: "sheet small", role: "dialog" }, [
      el("div", { class: "sheet-head" }, [el("div", { class: "title", text: title })]),
      ...options.map((o) =>
        el("button", { class: "sheet-opt" + (o.danger ? " danger" : ""), text: o.label, onclick: () => done(o.value) }),
      ),
      el("button", { class: "sheet-opt muted", text: "إلغاء", onclick: () => done(null) }),
    ]);
    const overlay = el("div", { class: "sheet-backdrop", onclick: (e: Event) => e.target === overlay && done(null) }, [sheet]);
    document.body.append(overlay);
  });
}

/** Simple alert-style modal (used for bot callback alerts). */
export function showAlert(text: string): void {
  void askChoice(text, [{ label: "تمام", value: "ok" }]);
}

export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = el("textarea", { style: { position: "fixed", opacity: "0" } }) as HTMLTextAreaElement;
    ta.value = text;
    document.body.append(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
  toast("اتنسخ ✓");
}

/** Premium in-chat translation shown under the text (tap again to hide). */
export async function translateInto(body: HTMLElement, msg: Api.Message, peer: Api.TypeEntityLike): Promise<void> {
  const existing = body.querySelector(".translation");
  if (existing) {
    existing.remove();
    return;
  }
  const textEl = el("span", { text: "بيترجم..." });
  body.append(el("div", { class: "translation" }, [el("span", { class: "tr-head", text: "🌐 ترجمة" }), textEl]));
  try {
    const [text] = await tg.translate(peer, [msg.id], translateLang());
    textEl.textContent = text || "(مفيش ترجمة)";
  } catch (e: any) {
    const m = String(e?.errorMessage || e?.message || e);
    textEl.textContent = /PREMIUM/i.test(m) ? "الترجمة محتاجة Premium" : "تعذّر الترجمة: " + m;
  }
}

/** Bottom sheet with one or more text inputs. Resolves with values or null. */
export function askText(
  title: string,
  fields: { placeholder: string; value?: string; type?: string; required?: boolean }[],
  okLabel = "تمام",
): Promise<string[] | null> {
  return new Promise((resolve) => {
    const done = (v: string[] | null) => {
      overlay.remove();
      resolve(v);
    };
    const inputs = fields.map(
      (f) =>
        el("input", {
          class: "sheet-input",
          placeholder: f.placeholder,
          value: f.value ?? "",
          type: f.type ?? "text",
          dir: "auto",
        }) as HTMLInputElement,
    );
    const ok = el("button", { class: "btn", text: okLabel }) as HTMLButtonElement;
    const check = () => (ok.disabled = fields.some((f, i) => f.required !== false && !inputs[i].value.trim()));
    inputs.forEach((i) => {
      i.oninput = check;
      i.onkeydown = (e) => e.key === "Enter" && !ok.disabled && ok.click();
    });
    check();
    ok.onclick = () => done(inputs.map((i) => i.value.trim()));
    const sheet = el("div", { class: "sheet small", role: "dialog" }, [
      el("div", { class: "sheet-head" }, [
        el("div", { class: "title", text: title }),
        el("button", { class: "iconbtn", text: "✕", "aria-label": "إغلاق", onclick: () => done(null) }),
      ]),
      el("div", { class: "sheet-form" }, [...inputs, ok]),
    ]);
    const overlay = el("div", { class: "sheet-backdrop", onclick: (e: Event) => e.target === overlay && done(null) }, [sheet]);
    document.body.append(overlay);
    setTimeout(() => inputs[0]?.focus(), 50);
  });
}

/** Full reaction picker: all standard reactions + (Premium) recent/top custom emoji. */
export async function openReactionPicker(mine: string[], onPick: (key: string) => void): Promise<void> {
  const grid = el("div", { class: "reaction-grid" }, [el("div", { class: "muted pad", text: "..." })]);
  const sheet = el("div", { class: "sheet", role: "dialog" }, [
    el("div", { class: "sheet-head" }, [el("div", { class: "title", text: "اختار رياكشن" })]),
    grid,
  ]);
  const overlay = el("div", { class: "sheet-backdrop", onclick: (e: Event) => e.target === overlay && overlay.remove() }, [sheet]);
  document.body.append(overlay);
  let choices: { standard: string[]; custom: string[] };
  try {
    choices = await tg.reactionChoices();
  } catch {
    choices = { standard: QUICK_REACTIONS, custom: [] };
  }
  const btn = (key: string) =>
    el(
      "button",
      {
        class: "mr" + (mine.includes(key) ? " mine" : ""),
        "aria-label": key.startsWith("ce:") ? "إيموجي مخصص" : key,
        onclick: () => {
          overlay.remove();
          onPick(key);
        },
      },
      [key.startsWith("ce:") ? customEmojiEl(key.slice(3), 26, "✨") : key],
    );
  grid.replaceChildren();
  if (choices.custom.length && tg.isPremium && isOn("customEmoji")) {
    grid.append(el("div", { class: "grid-label", text: "مخصّص ⭐" }), ...choices.custom.slice(0, 48).map(btn));
    grid.append(el("div", { class: "grid-label", text: "الكل" }));
  }
  grid.append(...choices.standard.map(btn));
}
