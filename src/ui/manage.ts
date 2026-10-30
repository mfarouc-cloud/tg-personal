// Group / channel administration: info, member permissions, slow mode,
// invite links, join requests, admins, banned users, admin log, toggles,
// delete. Plus the per-member admin menu used by the info page.
import { Api } from "teleproto";
import { isOn } from "../features/registry";
import { el, mount, toast, fmtTime } from "./dom";
import { tg } from "../telegram/client";
import type { Dialog } from "../telegram/types";
import { displayName, dialogFor } from "../telegram/entity";
import { avatarEl } from "./avatar";
import { askChoice, askText, copyText, openMenu } from "./chat/menu";

export interface ManageNav {
  onBack: () => void;
  onOpenChat: (d: Dialog) => void;
}

// ---------------- Rights catalogues ----------------
const ADMIN_RIGHTS_GROUP: [string, string][] = [
  ["changeInfo", "تغيير معلومات الجروب"],
  ["deleteMessages", "مسح رسايل الأعضاء"],
  ["banUsers", "حظر وتقييد الأعضاء"],
  ["inviteUsers", "دعوة أعضاء ولينكات"],
  ["pinMessages", "تثبيت الرسايل"],
  ["manageTopics", "إدارة المواضيع"],
  ["manageCall", "إدارة المكالمات الجماعية"],
  ["addAdmins", "إضافة أدمنز جدد"],
  ["anonymous", "أدمن مخفي (يكتب باسم الجروب)"],
];
const ADMIN_RIGHTS_CHANNEL: [string, string][] = [
  ["changeInfo", "تغيير معلومات القناة"],
  ["postMessages", "نشر منشورات"],
  ["editMessages", "تعديل منشورات الغير"],
  ["deleteMessages", "مسح المنشورات"],
  ["inviteUsers", "دعوة مشتركين ولينكات"],
  ["postStories", "نشر ستوريز"],
  ["editStories", "تعديل الستوريز"],
  ["deleteStories", "مسح الستوريز"],
  ["manageCall", "إدارة البث المباشر"],
  ["addAdmins", "إضافة أدمنز جدد"],
];
/** Member permissions: label → banned-right keys it controls. */
const MEMBER_PERMS: [string, string[]][] = [
  ["إرسال رسايل", ["sendMessages", "sendPlain"]],
  ["إرسال صور وفيديو وملفات", ["sendMedia", "sendPhotos", "sendVideos", "sendDocs", "sendAudios", "sendVoices", "sendRoundvideos"]],
  ["ملصقات و GIF", ["sendStickers", "sendGifs", "sendGames", "sendInline"]],
  ["استطلاعات", ["sendPolls"]],
  ["معاينة اللينكات", ["embedLinks"]],
  ["إضافة أعضاء", ["inviteUsers"]],
  ["تثبيت رسايل", ["pinMessages"]],
  ["تغيير معلومات الجروب", ["changeInfo"]],
  ["إنشاء مواضيع", ["manageTopics"]],
];
const SLOW_MODES: [number, string][] = [
  [0, "مقفول"],
  [10, "10ث"],
  [30, "30ث"],
  [60, "1د"],
  [300, "5د"],
  [900, "15د"],
  [3600, "1س"],
];

function canDo(entity: any, right: string): boolean {
  return !!(entity?.creator || entity?.adminRights?.[right]);
}
const errText = (e: any) => String(e?.errorMessage || e?.message || e);

/** Sheet with on/off rows (+ optional text field). Resolves with values or null. */
function askToggles(
  title: string,
  rows: [string, string, boolean][],
  extra?: { placeholder: string; value: string },
  okLabel = "حفظ",
): Promise<{ values: Record<string, boolean>; text: string } | null> {
  return new Promise((resolve) => {
    const values: Record<string, boolean> = {};
    const done = (v: typeof values | null) => {
      overlay.remove();
      resolve(v ? { values: v, text: input?.value.trim() ?? "" } : null);
    };
    const input = extra ? (el("input", { class: "sheet-input", placeholder: extra.placeholder, value: extra.value }) as HTMLInputElement) : null;
    const list = el("div", { class: "toggle-list" });
    for (const [key, label, on] of rows) {
      values[key] = on;
      const t = el("button", { class: "toggle" + (on ? " on" : ""), role: "switch", "aria-checked": String(on), "aria-label": label });
      t.onclick = () => {
        values[key] = !values[key];
        t.classList.toggle("on", values[key]);
        t.setAttribute("aria-checked", String(values[key]));
      };
      list.append(el("div", { class: "row" }, [el("div", { class: "label", text: label }), t]));
    }
    const sheet = el("div", { class: "sheet", role: "dialog" }, [
      el("div", { class: "sheet-head" }, [
        el("div", { class: "title", text: title }),
        el("button", { class: "iconbtn", text: "✕", "aria-label": "إغلاق", onclick: () => done(null) }),
      ]),
      el("div", { class: "sheet-list" }, [...(input ? [el("div", { class: "sheet-form" }, [input])] : []), list]),
      el("div", { class: "sheet-form" }, [el("button", { class: "btn", text: okLabel, onclick: () => done(values) })]),
    ]);
    const overlay = el("div", { class: "sheet-backdrop", onclick: (e: Event) => e.target === overlay && done(null) }, [sheet]);
    document.body.append(overlay);
  });
}

// ---------------- Member admin menu (from the info page) ----------------
export function memberMenu(chat: any, user: any, part: any, x: number, y: number, onChanged: () => void, onOpenChat: (d: Dialog) => void, onInsight?: (user: any) => void): void {
  const isAdmin = part instanceof Api.ChannelParticipantAdmin || part instanceof Api.ChatParticipantAdmin;
  const isCreator = part instanceof Api.ChannelParticipantCreator || part instanceof Api.ChatParticipantCreator;
  const isBroadcast = chat instanceof Api.Channel && !!chat.broadcast;
  const items: { label: string; run: () => void; danger?: boolean }[] = [{ label: "💬 رسالة", run: () => onOpenChat(dialogFor(user)) }];
  if (onInsight && isOn("userInsight") && !user.self) items.push({ label: "🔎 معلومات العضو", run: () => onInsight(user) });
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      toast(ok);
      onChanged();
    } catch (e) {
      toast("تعذّر: " + errText(e));
    }
  };
  if (!isCreator && canDo(chat, "addAdmins")) {
    items.push({
      label: isAdmin ? "⭐ تعديل صلاحيات الأدمن" : "⭐ ترقية لأدمن",
      run: async () => {
        const current = (part as any)?.adminRights ?? {};
        const catalogue = isBroadcast ? ADMIN_RIGHTS_CHANNEL : ADMIN_RIGHTS_GROUP;
        const res = await askToggles(
          `صلاحيات ${displayName(user)}`,
          catalogue
            .filter(([k]) => chat.creator || chat.adminRights?.[k] || k === "anonymous")
            .map(([k, l]) => [k, l, isAdmin ? !!current[k] : k !== "addAdmins" && k !== "anonymous"]),
          isBroadcast ? undefined : { placeholder: "لقب الأدمن (اختياري)", value: (part as any)?.rank ?? "" },
        );
        if (res) void run(() => tg.setAdmin(chat, user, res.values, res.text), "اتحفظت الصلاحيات ⭐");
      },
    });
    if (isAdmin) items.push({ label: "⬇ إلغاء الإشراف", run: () => void run(() => tg.setAdmin(chat, user, null), "مبقاش أدمن") });
  }
  if (!isCreator && !isAdmin && canDo(chat, "banUsers") && chat instanceof Api.Channel) {
    if (!isBroadcast) {
      items.push({
        label: "🔇 تقييد (منع الكتابة)",
        run: async () => {
          const c = await askChoice(`تقييد ${displayName(user)}`, [
            { label: "ساعة", value: "3600" },
            { label: "يوم", value: "86400" },
            { label: "أسبوع", value: "604800" },
            { label: "للأبد", value: "0" },
          ]);
          if (c == null) return;
          const until = c === "0" ? 0 : Math.floor(Date.now() / 1000) + Number(c);
          const rights: Record<string, boolean> = {};
          for (const [, keys] of MEMBER_PERMS.slice(0, 4)) for (const k of keys) rights[k] = true;
          void run(() => tg.setBanned(chat, user, rights, until), "اتقيّد 🔇");
        },
      });
    }
    items.push({
      label: "👢 طرد",
      danger: true,
      run: async () => (await askChoice(`طرد ${displayName(user)}؟ (يقدر يرجع بلينك)`, [{ label: "طرد", value: "y", danger: true }])) && void run(() => tg.kick(chat, user), "اتطرد"),
    });
    items.push({
      label: "🚫 حظر",
      danger: true,
      run: async () => (await askChoice(`حظر ${displayName(user)}؟ (مش هيقدر يرجع)`, [{ label: "حظر", value: "y", danger: true }])) && void run(() => tg.setBanned(chat, user, { viewMessages: true }), "اتحظر 🚫"),
    });
  } else if (!isCreator && chat instanceof Api.Chat && canDo(chat, "banUsers")) {
    items.push({ label: "👢 طرد", danger: true, run: () => void run(() => tg.kick(chat, user), "اتطرد") });
  }
  openMenu(x, y, items);
}

// ---------------- Admin log text ----------------
function logText(ev: Api.ChannelAdminLogEvent, who: string): string {
  const a: any = ev.action;
  const name = (u: any) => displayName(u) || "عضو";
  switch (a.className) {
    case "ChannelAdminLogEventActionChangeTitle":
      return `${who} غيّر الاسم من «${a.prevValue}» لـ «${a.newValue}»`;
    case "ChannelAdminLogEventActionChangeAbout":
      return `${who} غيّر الوصف`;
    case "ChannelAdminLogEventActionChangeUsername":
      return `${who} غيّر اليوزرنيم لـ ${a.newValue ? "@" + a.newValue : "(خاص)"}`;
    case "ChannelAdminLogEventActionChangePhoto":
      return `${who} غيّر الصورة`;
    case "ChannelAdminLogEventActionUpdatePinned":
      return `${who} ${a.message?.pinned ? "ثبّت" : "شال تثبيت"} رسالة`;
    case "ChannelAdminLogEventActionEditMessage":
      return `${who} عدّل رسالة`;
    case "ChannelAdminLogEventActionDeleteMessage":
      return `${who} مسح رسالة: ${(a.message?.message || "").slice(0, 60)}`;
    case "ChannelAdminLogEventActionParticipantJoin":
      return `${who} انضم`;
    case "ChannelAdminLogEventActionParticipantLeave":
      return `${who} خرج`;
    case "ChannelAdminLogEventActionParticipantInvite":
      return `${who} ضاف عضو`;
    case "ChannelAdminLogEventActionParticipantJoinByInvite":
      return `${who} انضم بلينك دعوة`;
    case "ChannelAdminLogEventActionParticipantJoinByRequest":
      return `${who} اتقبل طلب انضمامه`;
    case "ChannelAdminLogEventActionParticipantToggleBan":
      return `${who} غيّر قيود عضو`;
    case "ChannelAdminLogEventActionParticipantToggleAdmin":
      return `${who} غيّر صلاحيات أدمن`;
    case "ChannelAdminLogEventActionDefaultBannedRights":
      return `${who} غيّر صلاحيات الأعضاء`;
    case "ChannelAdminLogEventActionToggleSlowMode":
      return `${who} ${a.newValue ? `شغّل الـ Slow mode (${a.newValue} ث)` : "قفل الـ Slow mode"}`;
    case "ChannelAdminLogEventActionTogglePreHistoryHidden":
      return `${who} ${a.newValue ? "خبّى" : "أظهر"} السجل للأعضاء الجدد`;
    case "ChannelAdminLogEventActionToggleSignatures":
      return `${who} ${a.newValue ? "شغّل" : "قفل"} توقيع المنشورات`;
    case "ChannelAdminLogEventActionToggleNoForwards":
      return `${who} ${a.newValue ? "شغّل" : "قفل"} حماية المحتوى`;
    case "ChannelAdminLogEventActionExportedInviteRevoke":
      return `${who} ألغى لينك دعوة`;
    case "ChannelAdminLogEventActionExportedInviteEdit":
      return `${who} عدّل لينك دعوة`;
    case "ChannelAdminLogEventActionStopPoll":
      return `${who} قفل استطلاع`;
    case "ChannelAdminLogEventActionSendMessage":
      return `${who} بعت رسالة`;
    default:
      void name;
      return `${who}: ${String(a.className).replace("ChannelAdminLogEventAction", "")}`;
  }
}

// ---------------- Manage page ----------------
export function renderManage(dialog: Dialog, nav: ManageNav): void {
  const entity: any = dialog.entity;
  const isChannel = entity instanceof Api.Channel;
  const isBroadcast = isChannel && !!entity.broadcast;
  const kind = isBroadcast ? "القناة" : "الجروب";
  const body = el("div", { class: "scroll" });
  mount(
    el("div", { class: "screen" }, [
      el("div", { class: "topbar" }, [
        el("button", { class: "iconbtn", text: "‹", "aria-label": "رجوع", onclick: nav.onBack }),
        el("div", { class: "title", text: "إدارة " + kind }),
      ]),
      body,
    ]),
  );
  const refresh = () => renderManage(dialog, nav);
  const section = (t: string) => body.append(el("div", { class: "section", text: t }));
  const navRow = (label: string, desc: string, run: () => void, danger = false) =>
    body.append(
      el("div", { class: "row nav", onclick: run }, [
        el("div", { class: "text" }, [el("div", { class: "label" + (danger ? " danger-text" : ""), text: label }), ...(desc ? [el("div", { class: "desc", text: desc })] : [])]),
        el("span", { class: "chev", text: "‹" }),
      ]),
    );
  const toggleRow = (label: string, desc: string, on: boolean, apply: (v: boolean) => Promise<void>) => {
    let cur = on;
    const t = el("button", { class: "toggle" + (on ? " on" : ""), role: "switch", "aria-checked": String(on), "aria-label": label });
    t.onclick = async () => {
      const next = !cur;
      t.classList.toggle("on", next);
      try {
        await apply(next);
        cur = next;
        t.setAttribute("aria-checked", String(next));
        toast("اتحفظ ✓");
      } catch (e) {
        t.classList.toggle("on", cur);
        toast("تعذّر: " + errText(e));
      }
    };
    body.append(el("div", { class: "row" }, [el("div", { class: "text" }, [el("div", { class: "label", text: label }), ...(desc ? [el("div", { class: "desc", text: desc })] : [])]), t]));
  };
  const act = async (fn: () => Promise<unknown>, ok: string, again = true) => {
    try {
      await fn();
      toast(ok);
      if (again) refresh();
    } catch (e) {
      toast("تعذّر: " + errText(e));
    }
  };

  if (!isChannel) {
    body.append(
      el("div", { class: "note" }, [
        "ده جروب عادي، وإعداداته محدودة. حوّله لسوبر جروب عشان تاخد كل أدوات الإدارة (الـ Slow mode، والصلاحيات، وسجل الأحداث، والمواضيع).",
      ]),
    );
    if (entity.creator) {
      navRow("⬆ تحويل لسوبر جروب", "مينفعش ترجع فيها", async () => {
        if (!(await askChoice("تحويل لسوبر جروب؟", [{ label: "تحويل", value: "y" }]))) return;
        void act(() => tg.raw.invoke(new Api.messages.MigrateChat({ chatId: entity.id })), "اتحوّل ✓", false).then(nav.onBack);
      });
    }
  }

  // ---- Info ----
  if (canDo(entity, "changeInfo")) {
    section("المعلومات");
    navRow("✎ الاسم", displayName(entity), async () => {
      const v = await askText("الاسم", [{ placeholder: "الاسم", value: entity.title }], "حفظ");
      if (v) void act(async () => { await tg.editTitle(entity, v[0]); entity.title = v[0]; }, "اتغيّر الاسم");
    });
    navRow("✎ الوصف", "", async () => {
      const full = await tg.getFullChat(entity).catch(() => ({}));
      const v = await askText("الوصف", [{ placeholder: "الوصف", value: (full as any).about ?? "", required: false }], "حفظ");
      if (v) void act(() => tg.editAbout(entity, v[0]), "اتغيّر الوصف", false);
    });
    navRow("🖼 الصورة", "اختار صورة جديدة", () => {
      const inp = el("input", { type: "file", accept: "image/*" }) as HTMLInputElement;
      inp.onchange = () => {
        const f = inp.files?.[0];
        if (f) void act(() => tg.editPhoto(entity, f), "اتغيّرت الصورة", false);
      };
      inp.click();
    });
    if (isChannel && entity.creator) {
      navRow("🔗 اللينك العام", entity.username ? "t.me/" + entity.username : `${kind} خاص`, async () => {
        const v = await askText(`يوزرنيم ${kind} (فاضي = خاص)`, [{ placeholder: "username", value: entity.username ?? "", required: false }], "حفظ");
        if (v) void act(async () => { await tg.setPublicUsername(entity, v[0].replace(/^@/, "")); entity.username = v[0] || undefined; }, "اتحفظ");
      });
    }
  }

  // ---- Member permissions + slow mode (groups) ----
  if (!isBroadcast && canDo(entity, "banUsers")) {
    section("صلاحيات الأعضاء");
    const banned = entity.defaultBannedRights ?? {};
    const allowedNow = (keys: string[]) => !keys.some((k) => banned[k]);
    navRow("🔐 اللي يقدر الأعضاء يعملوه", MEMBER_PERMS.filter(([, k]) => allowedNow(k)).length + ` من ${MEMBER_PERMS.length} مسموح`, async () => {
      const res = await askToggles("صلاحيات كل الأعضاء", MEMBER_PERMS.map(([label, keys]) => [keys.join(","), label, allowedNow(keys)]));
      if (!res) return;
      const allowed: Record<string, boolean> = {};
      for (const [group, on] of Object.entries(res.values)) for (const k of group.split(",")) allowed[k] = on;
      void act(async () => {
        await tg.setDefaultRights(entity, allowed);
        const b: any = {};
        for (const [k, v] of Object.entries(allowed)) b[k] = !v;
        entity.defaultBannedRights = b;
      }, "اتحفظت الصلاحيات");
    });
    if (isChannel) {
      const seg = el("div", { class: "seg wrap" });
      body.append(el("div", { class: "row" }, [el("div", { class: "text" }, [el("div", { class: "label", text: "🐢 Slow mode" }), el("div", { class: "desc", text: "أقل وقت بين رسالتين لكل عضو" })])]), el("div", { class: "row" }, [seg]));
      void tg.getFullChat(entity).then((full: any) => {
        const cur = full.slowmodeSeconds ?? 0;
        for (const [sec, label] of SLOW_MODES) {
          const b = el("button", { class: sec === cur ? "active" : "", text: label });
          b.onclick = () =>
            void act(async () => {
              await tg.setSlowMode(entity, sec);
              seg.querySelectorAll("button").forEach((x) => x.classList.remove("active"));
              b.classList.add("active");
            }, sec ? `Slow mode: ${label}` : "Slow mode اتقفل", false);
          seg.append(b);
        }
      }).catch(() => {});
    }
  }

  // ---- Invite links ----
  if (canDo(entity, "inviteUsers")) {
    section("لينكات الدعوة");
    navRow("➕ لينك دعوة جديد", "بمدة أو عدد محدود أو بموافقة", async () => {
      const v = await askText("لينك جديد", [{ placeholder: "اسم اللينك (اختياري)", required: false }, { placeholder: "أقصى عدد ينضم (اختياري)", type: "number", required: false }], "التالي");
      if (!v) return;
      const exp = await askChoice("مدة اللينك", [
        { label: "من غير مدة", value: "0" },
        { label: "يوم", value: "86400" },
        { label: "أسبوع", value: "604800" },
      ]);
      if (exp == null) return;
      const mode = await askChoice("الانضمام", [
        { label: "مباشر", value: "direct" },
        { label: "بموافقة الأدمن", value: "request" },
      ]);
      if (!mode) return;
      try {
        const inv = await tg.createInvite(entity, {
          title: v[0] || undefined,
          usageLimit: mode === "direct" && Number(v[1]) > 0 ? Number(v[1]) : undefined,
          expireDate: exp !== "0" ? Math.floor(Date.now() / 1000) + Number(exp) : undefined,
          requestNeeded: mode === "request",
        });
        await copyText(inv.link);
        refresh();
      } catch (e) {
        toast("تعذّر: " + errText(e));
      }
    });
    const linksBox = el("div");
    body.append(linksBox);
    void tg.listInvites(entity).then((invites) => {
      for (const inv of invites) {
        const expired = inv.expireDate && inv.expireDate < Date.now() / 1000;
        const desc = [
          inv.title,
          `${inv.usage ?? 0}${inv.usageLimit ? "/" + inv.usageLimit : ""} انضم`,
          inv.requestNeeded ? `${inv.requested ?? 0} طلب` : "",
          inv.permanent ? "اللينك الأساسي" : "",
          expired ? "منتهي" : inv.expireDate ? "لحد " + fmtTime(inv.expireDate) : "",
        ].filter(Boolean).join(" · ");
        const r = el("div", { class: "row nav" }, [
          el("div", { class: "text" }, [el("div", { class: "label", dir: "ltr", text: inv.link.replace("https://", "") }), el("div", { class: "desc", text: desc })]),
        ]);
        r.onclick = (e) =>
          openMenu((e as MouseEvent).clientX, (e as MouseEvent).clientY, [
            { label: "📋 نسخ", run: () => void copyText(inv.link) },
            { label: "🗑 إلغاء اللينك", run: () => void act(() => tg.revokeInvite(entity, inv.link), "اتلغى"), danger: true } as any,
          ]);
        linksBox.append(r);
      }
    }).catch(() => {});
  }

  // ---- Join requests ----
  if (canDo(entity, "inviteUsers") && isChannel) {
    const reqBox = el("div");
    body.append(reqBox);
    void tg.joinRequests(entity).then(({ users, importers }) => {
      if (!importers.length) return;
      reqBox.append(el("div", { class: "section", text: `طلبات الانضمام (${importers.length})` }));
      for (const imp of importers) {
        const u = users.find((x: any) => String(x.id) === String(imp.userId));
        if (!u) continue;
        const row = el("div", { class: "chat-row" }, [
          avatarEl(u, 40),
          el("div", { class: "chat-meta" }, [el("div", { class: "chat-name", text: displayName(u) }), el("div", { class: "chat-last", text: imp.about || fmtTime(imp.date) })]),
          el("button", { class: "btn small", text: "قبول", onclick: (e: Event) => { e.stopPropagation(); void tg.answerJoinRequest(entity, u, true).then(() => (row.remove(), toast("اتقبل ✓")), (er) => toast(errText(er))); } }),
          el("button", { class: "btn small secondary", text: "رفض", onclick: (e: Event) => { e.stopPropagation(); void tg.answerJoinRequest(entity, u, false).then(() => (row.remove(), toast("اترفض")), (er) => toast(errText(er))); } }),
        ]);
        reqBox.append(row);
      }
    }).catch(() => {});
  }

  // ---- Admins & banned ----
  if (isChannel) {
    section("الأعضاء");
    navRow("⭐ الأدمنز", "", () => void openPeopleList("admins"));
    if (canDo(entity, "banUsers")) navRow("🚫 المحظورين", "", () => void openPeopleList("banned"));
    navRow("📜 سجل الأحداث", "آخر 100 إجراء من الأدمنز", () => void openLog());
  }

  // ---- Toggles ----
  if (isChannel && (entity.creator || entity.adminRights)) {
    section("إعدادات");
    void tg.getFullChat(entity).then((full: any) => {
      if (!isBroadcast && canDo(entity, "banUsers")) {
        toggleRow("إخفاء السجل للأعضاء الجدد", "الأعضاء الجدد مش هيشوفوا الرسايل القديمة", !!full.hiddenPrehistory, (v) => tg.toggleHiddenHistory(entity, v));
      }
      if (isBroadcast && canDo(entity, "changeInfo")) {
        toggleRow("توقيع المنشورات", "اسم الأدمن يظهر تحت المنشور", !!entity.signatures, (v) => tg.toggleSignatures(entity, v));
      }
      if (entity.creator) {
        toggleRow("حماية المحتوى", "منع الحفظ والتوجيه والسكرين شوت", !!entity.noforwards, (v) => tg.toggleProtected(entity, v));
      }
      if (canDo(entity, "inviteUsers") && entity.username) {
        toggleRow("الانضمام بموافقة", "الأعضاء الجدد محتاجين موافقة أدمن", !!entity.joinRequest, (v) => tg.toggleJoinRequests(entity, v));
      }
      if (entity.creator) {
        section("منطقة خطرة");
        navRow(`🗑 حذف ${kind}`, "هيتمسح لكل الأعضاء ومينفعش يرجع", async () => {
          const c = await askChoice(`حذف ${displayName(entity)} نهائياً؟`, [{ label: "حذف نهائي", value: "y", danger: true }]);
          if (c) void act(() => tg.deleteGroupOrChannel(entity), "اتحذف", false).then(nav.onBack);
        }, true);
      }
    }).catch(() => {});
  }

  // ---- Sub-screens ----
  async function openPeopleList(kindList: "admins" | "banned") {
    const list = el("div", { class: "scroll" });
    mount(
      el("div", { class: "screen" }, [
        el("div", { class: "topbar" }, [
          el("button", { class: "iconbtn", text: "‹", "aria-label": "رجوع", onclick: refresh }),
          el("div", { class: "title", text: kindList === "admins" ? "الأدمنز" : "المحظورين" }),
        ]),
        list,
      ]),
    );
    list.append(el("div", { class: "center" }, [el("div", { class: "spinner" })]));
    try {
      const { users, parts } = await tg.getParticipants(entity, kindList);
      list.replaceChildren();
      for (const u of users) {
        const p = parts.get(String(u.id));
        const role = p instanceof Api.ChannelParticipantCreator ? "المالك" : p?.rank || (kindList === "admins" ? "أدمن" : "");
        const row = el("div", { class: "chat-row" }, [
          avatarEl(u, 42),
          el("div", { class: "chat-meta" }, [el("div", { class: "chat-name", text: displayName(u) }), el("div", { class: "chat-last", text: u.username ? "@" + u.username : "" })]),
          role ? el("span", { class: "role", text: role }) : el("span"),
        ]);
        row.onclick = (e) => {
          const ev = e as MouseEvent;
          if (kindList === "banned") {
            openMenu(ev.clientX, ev.clientY, [{ label: "✅ إلغاء الحظر", run: () => void tg.setBanned(entity, u, {}).then(() => (row.remove(), toast("اتلغى الحظر")), (er) => toast(errText(er))) }]);
          } else memberMenu(entity, u, p, ev.clientX, ev.clientY, () => void openPeopleList(kindList), nav.onOpenChat);
        };
        list.append(row);
      }
      if (!users.length) list.append(el("div", { class: "center hint", text: "مفيش حد" }));
    } catch (e) {
      list.replaceChildren(el("div", { class: "center", text: "تعذّر التحميل: " + errText(e) }));
    }
  }

  async function openLog() {
    const list = el("div", { class: "scroll" });
    mount(
      el("div", { class: "screen" }, [
        el("div", { class: "topbar" }, [el("button", { class: "iconbtn", text: "‹", "aria-label": "رجوع", onclick: refresh }), el("div", { class: "title", text: "سجل الأحداث" })]),
        list,
      ]),
    );
    list.append(el("div", { class: "center" }, [el("div", { class: "spinner" })]));
    try {
      const { events, users } = await tg.adminLog(entity);
      list.replaceChildren();
      for (const ev of events) {
        const u = users.find((x: any) => String(x.id) === String(ev.userId));
        list.append(
          el("div", { class: "row" }, [
            el("div", { class: "text" }, [el("div", { class: "label", text: logText(ev, displayName(u) || "حد") }), el("div", { class: "desc", text: fmtTime(ev.date) })]),
          ]),
        );
      }
      if (!events.length) list.append(el("div", { class: "center hint", text: "مفيش أحداث في آخر 48 ساعة" }));
    } catch (e) {
      list.replaceChildren(el("div", { class: "center", text: "تعذّر: " + errText(e) }));
    }
  }
}
