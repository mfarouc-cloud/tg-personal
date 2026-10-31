// "معلومات العضو": everything Telegram lets you see about a user, on one page —
// ID, usernames, phone, bio, birthday, exact last seen, shared groups/channels
// (with their role + join date), and their latest messages in those groups.
// Note: Telegram only exposes chats YOU share with them; nothing here can see
// groups you're not in.
import { Api } from "teleproto";
import { el, mount, toast, fmtTime } from "./dom";
import { tg, peerKey } from "../telegram/client";
import { seenFor } from "../features/seenIndex";
import { realName, dialogFor } from "../telegram/entity";
import type { Dialog } from "../telegram/types";
import { avatarEl } from "./avatar";
import { premiumStar } from "./chatlist";
import { copyText } from "./chat/menu";
import { snippetOf } from "./chat/bubble";

export interface InsightNav {
  onBack: () => void;
  onOpenChat: (d: Dialog, jumpTo?: number) => void;
}

const fmtDate = (unix: number, withTime = true) => {
  const d = new Date(unix * 1000);
  const date = d.toLocaleDateString("ar-EG", { day: "numeric", month: "long", year: "numeric" });
  return withTime ? `${date} — ${d.toLocaleTimeString("ar-EG", { hour: "2-digit", minute: "2-digit" })}` : date;
};

export function lastSeenText(s: any): { text: string; detail?: string } {
  if (!s || s instanceof Api.UserStatusEmpty) return { text: "مخفي أو قديم جدًا", detail: "اليوزر قافل آخر ظهور، أو مفتحش من زمان" };
  if (s instanceof Api.UserStatusOnline) return { text: "🟢 متصل الآن", detail: "لحد " + new Date(s.expires * 1000).toLocaleTimeString("ar-EG", { hour: "2-digit", minute: "2-digit" }) };
  if (s instanceof Api.UserStatusOffline) {
    const ago = Math.max(0, Date.now() / 1000 - s.wasOnline);
    const rel = ago < 3600 ? `من ${Math.round(ago / 60)} دقيقة` : ago < 86400 ? `من ${Math.round(ago / 3600)} ساعة` : `من ${Math.round(ago / 86400)} يوم`;
    return { text: "آخر ظهور " + rel, detail: fmtDate(s.wasOnline) };
  }
  const hidden = "التوقيت الدقيق مخفي بسبب إعدادات الخصوصية عنده (أو عندك)";
  if (s instanceof Api.UserStatusRecently) return { text: "آخر ظهور من قريب", detail: hidden };
  if (s instanceof Api.UserStatusLastWeek) return { text: "آخر ظهور خلال أسبوع", detail: hidden };
  if (s instanceof Api.UserStatusLastMonth) return { text: "آخر ظهور خلال شهر", detail: hidden };
  return { text: "غير معروف" };
}

const ROLE: Record<string, string> = { creator: "👑 المالك", admin: "⭐ أدمن", member: "عضو", left: "خرج", banned: "⛔ محظور" };

export async function renderUserInsight(userIn: any, nav: InsightNav): Promise<void> {
  const body = el("div", { class: "scroll insight" });
  mount(
    el("div", { class: "screen" }, [
      el("div", { class: "topbar" }, [
        el("button", { class: "iconbtn", text: "‹", "aria-label": "رجوع", onclick: nav.onBack }),
        el("div", { class: "title", text: "معلومات العضو" }),
        el("span"),
      ]),
      body,
    ]),
  );

  let user: any = userIn;
  let full: any;
  try {
    ({ user, full } = await tg.userFull(userIn));
  } catch (e: any) {
    toast("تعذّر جلب البيانات الكاملة: " + (e?.errorMessage || e?.message || ""));
  }

  // ---------- Header ----------
  const big = avatarEl(user, 96, undefined, true);
  big.classList.add("big");
  const flags: string[] = [];
  if (user.bot) flags.push("🤖 بوت");
  if (user.premium) flags.push("⭐ Premium");
  if (user.verified) flags.push("✔ موثّق");
  if (user.scam) flags.push("⚠️ نصب");
  if (user.fake) flags.push("⚠️ مزيف");
  if (user.deleted) flags.push("🗑 حساب محذوف");
  if (user.contact) flags.push(user.mutualContact ? "👥 جهة اتصال متبادلة" : "👤 في جهات اتصالك");
  if (full?.blocked) flags.push("🚫 محظور عندك");
  const seen = lastSeenText(user.status);
  body.append(
    el("div", { class: "info-head" }, [
      big,
      el("h2", {}, [realName(user) || "بدون اسم", ...premiumStar(user)]),
      el("div", { class: "hint", text: seen.text }),
      flags.length ? el("div", { class: "insight-flags" }, flags.map((f) => el("span", { class: "flag", text: f }))) : el("span"),
    ]),
  );

  // ---------- Data ----------
  const rows = el("div", { class: "info-rows" });
  const row = (label: string, value: string, copy?: string) =>
    rows.append(
      el("div", { class: "row" + (copy ? " nav" : ""), onclick: copy ? () => void copyText(copy).then(() => toast("اتنسخ")) : null }, [
        el("div", { class: "text" }, [el("div", { class: "label", dir: "auto", text: value }), el("div", { class: "desc", text: label + (copy ? " — دوس للنسخ" : "") })]),
      ]),
    );
  body.append(el("div", { class: "section", text: "البيانات" }), rows);
  row("الـ ID", String(user.id), String(user.id));
  const names = [user.username, ...((user.usernames ?? []) as any[]).filter((u) => u.active).map((u) => u.username)].filter(Boolean);
  for (const n of [...new Set(names)]) row("اسم المستخدم", "@" + n, "@" + n);
  if (user.phone) row("الموبايل", "+" + user.phone, "+" + user.phone);
  else row("الموبايل", "مخفي");
  if (full?.about) row("النبذة", full.about, full.about);
  if (full?.birthday) {
    const b = full.birthday;
    row("عيد الميلاد", `${b.day}/${b.month}${b.year ? "/" + b.year : ""}`);
  }
  if (user.firstName || user.lastName) row("الاسم", [user.firstName, user.lastName].filter(Boolean).join(" "));
  if (seen.detail) row("آخر ظهور", seen.detail);
  if (user.photo?.dcId) row("سيرفر الحساب (DC)", "DC" + user.photo.dcId);
  if (full?.commonChatsCount != null) row("جروبات مشتركة معاك", String(full.commonChatsCount));
  if (user.langCode) row("لغة التطبيق", user.langCode);
  let personal: any;
  if (full?.personalChannelId) {
    try {
      const ch = await tg.getEntity(new Api.PeerChannel({ channelId: full.personalChannelId }));
      personal = ch;
      rows.append(
        el("div", { class: "row nav", onclick: () => nav.onOpenChat(dialogFor(ch)) }, [
          el("div", { class: "text" }, [el("div", { class: "label", text: realName(ch) }), el("div", { class: "desc", text: "قناته الشخصية" })]),
          el("span", { class: "chev", text: "‹" }),
        ]),
      );
    } catch {
      /* ignore */
    }
  }
  rows.append(
    el("div", { class: "row nav", onclick: () => nav.onOpenChat(dialogFor(user)) }, [
      el("div", { class: "text" }, [el("div", { class: "label", text: "💬 فتح محادثة معاه" })]),
    ]),
  );

  // ---------- Common groups / channels ----------
  const groupsBox = el("div", { class: "info-rows" }, [el("div", { class: "muted pad", text: "بيحمّل..." })]);
  const ownedBox = el("div", { class: "info-rows", style: { display: "none" } });
  const tabCommon = el("button", { class: "active", text: "المشتركة" });
  const tabOwned = el("button", { text: "بتاعته" });
  const tabHint = el("div", { class: "hint pad", text: "" });
  const setTab = (owned: boolean) => {
    tabCommon.classList.toggle("active", !owned);
    tabOwned.classList.toggle("active", owned);
    groupsBox.style.display = owned ? "none" : "";
    ownedBox.style.display = owned ? "" : "none";
    tabHint.textContent = owned
      ? "قناته الشخصية + الجروبات والقنوات المشتركة اللي هو مالكها أو أدمن فيها."
      : "تليجرام بيكشف بس الأماكن اللي انت وهو فيها مع بعض.";
  };
  tabCommon.onclick = () => setTab(false);
  tabOwned.onclick = () => setTab(true);
  setTab(false);
  const msgsBox = el("div", { class: "info-rows" }, [el("div", { class: "muted pad", text: "بيحمّل..." })]);
  body.append(
    el("div", { class: "section", text: "الجروبات والقنوات" }),
    el("div", { class: "seg insight-tabs" }, [tabCommon, tabOwned]),
    tabHint,
    groupsBox,
    ownedBox,
    el("div", { class: "section", text: "آخر رسايله في الجروبات" }),
    msgsBox,
  );
  if (user.self) {
    groupsBox.replaceChildren(el("div", { class: "muted pad", text: "ده انت 🙂" }));
    msgsBox.replaceChildren();
    return;
  }

  let chats: any[] = [];
  try {
    chats = await tg.commonChats(user);
  } catch (e: any) {
    groupsBox.replaceChildren(el("div", { class: "muted pad", text: "تعذّر: " + (e?.errorMessage || e?.message || "") }));
  }
  if (!chats.length) groupsBox.replaceChildren(el("div", { class: "muted pad", text: "مفيش جروبات مشتركة" }));
  else groupsBox.replaceChildren();
  let ownedCount = 0;
  const paintTabs = () => {
    tabCommon.textContent = `المشتركة (${chats.length})`;
    tabOwned.textContent = `بتاعته (${ownedCount})`;
  };
  const chatRow = (c: any, roleText?: string, extra?: string) => {
    const roleEl = el("span", { class: "role", text: roleText ?? "…" });
    const kind = c instanceof Api.Channel && c.broadcast ? "📢 قناة" : "👥 جروب";
    const count = c.participantsCount ? ` · ${c.participantsCount.toLocaleString("ar-EG")} عضو` : "";
    const last = el("div", { class: "chat-last", text: kind + count + (c.username ? " · @" + c.username : "") + (extra ?? "") });
    const node = el("div", { class: "chat-row", onclick: () => nav.onOpenChat(dialogFor(c)) }, [
      avatarEl(c, 44),
      el("div", { class: "chat-meta" }, [el("div", { class: "chat-top" }, [el("div", { class: "chat-name", text: realName(c) }), roleEl]), last]),
    ]);
    return { node, roleEl, last };
  };
  if (personal) {
    ownedBox.append(chatRow(personal, "📌 قناته الشخصية").node);
    ownedCount++;
  }
  paintTabs();

  // Fetch role + latest messages with a small concurrency limit (avoid FLOOD_WAIT).
  const all: { m: Api.Message; chat: any }[] = [];
  const queue = chats.slice();
  const rowsByChat = new Map<any, ReturnType<typeof chatRow>>();
  for (const c of chats) {
    const r = chatRow(c);
    rowsByChat.set(c, r);
    groupsBox.append(r.node);
  }
  const worker = async () => {
    for (let c = queue.shift(); c; c = queue.shift()) {
      const rec = await tg.memberRecord(c, user);
      const r = rowsByChat.get(c)!;
      const roleText = (ROLE[rec.role] || "") + (rec.rank ? ` «${rec.rank}»` : "");
      const joined = rec.joined ? " · انضم " + fmtDate(rec.joined, false) : "";
      r.roleEl.textContent = roleText;
      r.last.append(joined);
      if ((rec.role === "creator" || rec.role === "admin") && c !== personal) {
        ownedBox.append(chatRow(c, roleText, joined).node);
        ownedCount++;
        paintTabs();
      }
      if (!(c instanceof Api.Channel && c.broadcast)) {
        try {
          for (const m of await tg.messagesFrom(c, user, 10)) all.push({ m, chat: c });
        } catch {
          /* no access to history */
        }
      }
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  // Chats from the local "seen in" index that common-chats didn't return.
  const commonKeys = new Set(chats.map((c) => peerKey(c)));
  const extra = seenFor(String(user.id)).filter((x) => !commonKeys.has(x.chatKey));
  if (extra.length) {
    groupsBox.append(el("div", { class: "hint pad", text: "شوفته قبل كده في (من سجل الجهاز):" }));
    for (const x of extra) {
      groupsBox.append(
        el("div", {
          class: "chat-row",
          onclick: async () => {
            try {
              nav.onOpenChat(dialogFor(await tg.getEntity(x.chatKey)));
            } catch {
              toast("المحادثة دي مبقتش متاحة");
            }
          },
        }, [
          el("div", { class: "chat-meta" }, [
            el("div", { class: "chat-name", text: x.title }),
            el("div", { class: "chat-last", text: "آخر رسالة شفتها: " + fmtDate(x.at, false) }),
          ]),
        ]),
      );
    }
  }
  if (!ownedCount) ownedBox.append(el("div", { class: "muted pad", text: "مش مالك ولا أدمن في أي مكان مشترك معاك" }));

  all.sort((a, b) => b.m.date - a.m.date);
  msgsBox.replaceChildren();
  if (!all.length) msgsBox.append(el("div", { class: "muted pad", text: "ملقيتلوش رسايل في الجروبات المشتركة" }));
  for (const { m, chat } of all.slice(0, 60)) {
    msgsBox.append(
      el("div", { class: "row nav insight-msg", onclick: () => nav.onOpenChat(dialogFor(chat), m.id) }, [
        el("div", { class: "text" }, [
          el("div", { class: "label", dir: "auto", text: snippetOf(m) }),
          el("div", { class: "desc", text: `${realName(chat)} · ${fmtTime(m.date)} · ${new Date(m.date * 1000).toLocaleDateString("ar-EG")}` }),
        ]),
        el("span", { class: "chev", text: "‹" }),
      ]),
    );
  }
}
