// New chat flows: contacts list (+ add contact), new group, new channel,
// open by link/username, and invite-link preview + join.
import { Api } from "teleproto";
import { el, mount, toast } from "./dom";
import { tg } from "../telegram/client";
import type { Dialog } from "../telegram/types";
import { displayName, dialogFor } from "../telegram/entity";
import { avatarEl } from "./avatar";
import { askText } from "./chat/menu";

export interface NewNav {
  onBack: () => void;
  onOpenChat: (d: Dialog) => void;
  onOpenPeer: (target: string) => void;
}

function statusLine(u: any): string {
  const s = u.status;
  if (s instanceof Api.UserStatusOnline) return "متصل الآن";
  if (s instanceof Api.UserStatusRecently) return "آخر ظهور من قريب";
  if (s instanceof Api.UserStatusOffline) return "آخر ظهور " + new Date(s.wasOnline * 1000).toLocaleDateString("ar-EG", { day: "numeric", month: "short" });
  return u.username ? "@" + u.username : "";
}

function screenWith(title: string, onBack: () => void, right?: HTMLElement) {
  const body = el("div", { class: "scroll" });
  mount(
    el("div", { class: "screen" }, [
      el("div", { class: "topbar" }, [
        el("button", { class: "iconbtn", text: "‹", "aria-label": "رجوع", onclick: onBack }),
        el("div", { class: "title", text: title }),
        right ?? el("span"),
      ]),
      body,
    ]),
  );
  return body;
}

/** Contacts → start a private chat. */
export function renderContacts(nav: NewNav): void {
  const body = screenWith("محادثة جديدة", nav.onBack);
  const search = el("input", { type: "search", class: "search", placeholder: "ابحث في جهات الاتصال" }) as HTMLInputElement;
  const list = el("div");
  body.append(el("div", { class: "searchbar" }, [search]));
  body.append(
    el("button", { class: "chat-row", onclick: () => void addContact() }, [el("span", { class: "sc-icon", text: "➕" }), el("b", { text: "إضافة جهة اتصال" })]),
    el("button", { class: "chat-row", onclick: () => renderCreateGroup(nav) }, [el("span", { class: "sc-icon", text: "👥" }), el("b", { text: "جروب جديد" })]),
    el("button", { class: "chat-row", onclick: () => void createChannel(nav) }, [el("span", { class: "sc-icon", text: "📢" }), el("b", { text: "قناة جديدة" })]),
    el("div", { class: "section", text: "جهات الاتصال" }),
    list,
  );
  let contacts: Api.User[] = [];
  const paint = () => {
    const q = search.value.trim().toLowerCase();
    list.replaceChildren(
      ...contacts
        .filter((u) => !q || displayName(u).toLowerCase().includes(q) || (u.username || "").toLowerCase().includes(q))
        .map((u) =>
          el("div", { class: "chat-row", onclick: () => nav.onOpenChat(dialogFor(u)) }, [
            avatarEl(u, 44),
            el("div", { class: "chat-meta" }, [el("div", { class: "chat-name", text: displayName(u) }), el("div", { class: "chat-last", text: statusLine(u) })]),
          ]),
        ),
    );
    if (!list.childElementCount) list.append(el("div", { class: "center hint", text: contacts.length ? "مفيش نتايج" : "مفيش جهات اتصال" }));
  };
  search.oninput = paint;
  list.append(el("div", { class: "center" }, [el("div", { class: "spinner" })]));
  tg.getContacts()
    .then((c) => {
      contacts = c.sort((a, b) => displayName(a).localeCompare(displayName(b), "ar"));
      paint();
    })
    .catch(() => list.replaceChildren(el("div", { class: "center", text: "تعذّر تحميل جهات الاتصال" })));

  async function addContact() {
    const v = await askText("إضافة جهة اتصال", [
      { placeholder: "رقم الموبايل بكود الدولة (+20...)", type: "tel" },
      { placeholder: "الاسم الأول" },
      { placeholder: "الاسم الأخير (اختياري)", required: false },
    ], "إضافة");
    if (!v) return;
    try {
      const u = await tg.addContact(v[0], v[1], v[2]);
      if (!u) return toast("الرقم ده مش على تليجرام");
      toast("اتضافت ✓");
      nav.onOpenChat(dialogFor(u));
    } catch (e: any) {
      toast("تعذّر: " + (e?.errorMessage || e?.message || ""));
    }
  }
}

/** Pick members → name → create supergroup. */
export function renderCreateGroup(nav: NewNav): void {
  const picked = new Map<string, Api.User>();
  const next = el("button", { class: "btn small", text: "التالي" }) as HTMLButtonElement;
  const body = screenWith("جروب جديد", () => renderContacts(nav), next);
  const chips = el("div", { class: "chips" });
  const search = el("input", { type: "search", class: "search", placeholder: "ضيف أعضاء" }) as HTMLInputElement;
  const list = el("div");
  body.append(chips, el("div", { class: "searchbar" }, [search]), list);
  let contacts: Api.User[] = [];

  const paintChips = () => {
    chips.replaceChildren(
      ...[...picked.values()].map((u) =>
        el("button", { class: "chip", onclick: () => toggle(u) }, [displayName(u).split(" ")[0], " ✕"]),
      ),
    );
    next.textContent = picked.size ? `التالي (${picked.size})` : "تخطي";
  };
  const toggle = (u: Api.User) => {
    const k = String(u.id);
    if (picked.has(k)) picked.delete(k);
    else picked.set(k, u);
    paintChips();
    paint();
  };
  const paint = () => {
    const q = search.value.trim().toLowerCase();
    list.replaceChildren(
      ...contacts
        .filter((u) => !q || displayName(u).toLowerCase().includes(q))
        .map((u) =>
          el("div", { class: "chat-row" + (picked.has(String(u.id)) ? " picked" : ""), onclick: () => toggle(u) }, [
            avatarEl(u, 44),
            el("div", { class: "chat-meta" }, [el("div", { class: "chat-name", text: displayName(u) })]),
            el("span", { class: "check", text: picked.has(String(u.id)) ? "✓" : "" }),
          ]),
        ),
    );
  };
  search.oninput = paint;
  paintChips();
  tg.getContacts()
    .then((c) => {
      contacts = c.sort((a, b) => displayName(a).localeCompare(displayName(b), "ar"));
      paint();
    })
    .catch(() => {});

  next.onclick = async () => {
    const v = await askText("اسم الجروب", [{ placeholder: "اسم الجروب" }], "إنشاء");
    if (!v) return;
    try {
      next.disabled = true;
      const chat = await tg.createGroup(v[0], [...picked.values()]);
      toast("الجروب اتعمل 🎉");
      nav.onOpenChat(dialogFor(chat));
    } catch (e: any) {
      next.disabled = false;
      toast("تعذّر: " + (e?.errorMessage || e?.message || ""));
    }
  };
}

export async function createChannel(nav: NewNav): Promise<void> {
  const v = await askText("قناة جديدة", [{ placeholder: "اسم القناة" }, { placeholder: "وصف (اختياري)", required: false }], "إنشاء");
  if (!v) return;
  try {
    const ch = await tg.createChannel(v[0], v[1]);
    toast("القناة اتعملت 📢");
    nav.onOpenChat(dialogFor(ch));
  } catch (e: any) {
    toast("تعذّر: " + (e?.errorMessage || e?.message || ""));
  }
}

/** Ask for a t.me link / @username / invite link and open it. */
export async function openByLink(nav: NewNav): Promise<void> {
  const v = await askText("دخول بلينك أو يوزرنيم", [{ placeholder: "t.me/... أو @username" }], "فتح");
  if (!v) return;
  const s = v[0];
  const invite = s.match(/(?:t\.me|telegram\.me)\/(?:\+|joinchat\/)([\w-]{8,})/i) || s.match(/^\+([\w-]{8,})$/);
  if (invite) return nav.onOpenPeer("+" + invite[1]);
  const user = s.match(/(?:t\.me|telegram\.me)\/([A-Za-z]\w{3,})/i)?.[1] ?? s.replace(/^@/, "");
  nav.onOpenPeer(user);
}

/** Invite link: preview the chat and join. */
export async function openInvite(hash: string, nav: { onOpenChat: (d: Dialog) => void }): Promise<void> {
  let info: any;
  try {
    info = await tg.checkInvite(hash);
  } catch (e: any) {
    const m = String(e?.errorMessage || e?.message || "");
    return toast(/EXPIRED|INVALID/.test(m) ? "اللينك ده انتهى أو مش صحيح" : "تعذّر فتح اللينك");
  }
  if (info instanceof Api.ChatInviteAlready || info instanceof Api.ChatInvitePeek) {
    return nav.onOpenChat(dialogFor(info.chat));
  }
  const inv = info as Api.ChatInvite;
  const close = () => overlay.remove();
  const joinBtn = el("button", { class: "btn", text: inv.requestNeeded ? "اطلب الانضمام" : inv.broadcast ? "اشترك في القناة" : "انضم للجروب" }) as HTMLButtonElement;
  joinBtn.onclick = async () => {
    joinBtn.disabled = true;
    try {
      const chat = await tg.joinInvite(hash);
      close();
      if (chat) nav.onOpenChat(dialogFor(chat));
      else toast("اتبعت طلب الانضمام ✓");
    } catch (e: any) {
      joinBtn.disabled = false;
      const m = String(e?.errorMessage || e?.message || "");
      toast(/INVITE_REQUEST_SENT/.test(m) ? "اتبعت طلب الانضمام ✓ — هيتقبل من الأدمن" : "تعذّر الانضمام: " + m);
      if (/INVITE_REQUEST_SENT/.test(m)) close();
    }
  };
  const sheet = el("div", { class: "sheet small invite", role: "dialog" }, [
    el("div", { class: "center" }, [
      el("div", { class: "avatar", style: { width: "80px", height: "80px", fontSize: "30px" }, text: inv.broadcast ? "📢" : "👥" }),
      el("h2", { text: inv.title }),
      el("span", { class: "hint", text: `${(inv.participantsCount ?? 0).toLocaleString("ar-EG")} ${inv.broadcast ? "مشترك" : "عضو"}` }),
      ...(inv.about ? [el("p", { class: "about", text: inv.about })] : []),
      joinBtn,
      el("button", { class: "btn secondary", text: "إلغاء", onclick: close }),
    ]),
  ]);
  const overlay = el("div", { class: "sheet-backdrop", onclick: (e: Event) => e.target === overlay && close() }, [sheet]);
  document.body.append(overlay);
}
