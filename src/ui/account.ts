// Account screens: profile, privacy (+ blocked), active sessions,
// two-step verification, notifications.
import { Api } from "teleproto";
import { el, mount, toast, fmtTime } from "./dom";
import { tg, type PrivacyKey } from "../telegram/client";
import { displayName, realName } from "../telegram/entity";
import { avatarEl } from "./avatar";
import { askChoice, askText } from "./chat/menu";
import { notifySettings, setNotifySetting, requestSystemPermission } from "../features/notify";

export interface AccountNav {
  onBack: () => void;
}

const errText = (e: any) => String(e?.errorMessage || e?.message || e);

function page(title: string, onBack: () => void): HTMLElement {
  const body = el("div", { class: "scroll" });
  mount(
    el("div", { class: "screen" }, [
      el("div", { class: "topbar" }, [el("button", { class: "iconbtn", text: "‹", "aria-label": "رجوع", onclick: onBack }), el("div", { class: "title", text: title })]),
      body,
    ]),
  );
  return body;
}

function navRow(label: string, desc: string, run: () => void): HTMLElement {
  return el("div", { class: "row nav", onclick: run }, [
    el("div", { class: "text" }, [el("div", { class: "label", text: label }), ...(desc ? [el("div", { class: "desc", text: desc })] : [])]),
    el("span", { class: "chev", text: "‹" }),
  ]);
}

function toggleRow(label: string, desc: string, on: boolean, apply: (v: boolean) => Promise<void> | void): HTMLElement {
  let cur = on;
  const t = el("button", { class: "toggle" + (on ? " on" : ""), role: "switch", "aria-checked": String(on), "aria-label": label });
  t.onclick = async () => {
    const next = !cur;
    t.classList.toggle("on", next);
    try {
      await apply(next);
      cur = next;
      t.setAttribute("aria-checked", String(next));
    } catch (e) {
      t.classList.toggle("on", cur);
      toast("تعذّر: " + errText(e));
    }
  };
  return el("div", { class: "row" }, [el("div", { class: "text" }, [el("div", { class: "label", text: label }), ...(desc ? [el("div", { class: "desc", text: desc })] : [])]), t]);
}

// ---------------- Profile ----------------
export function renderProfile(nav: AccountNav): void {
  const body = page("الملف الشخصي", nav.onBack);
  const paint = async () => {
    const me: any = tg.me ?? (await tg.getMe());
    body.replaceChildren();
    const av = avatarEl(me, 96, undefined, true);
    av.classList.add("big");
    const photoBtn = el("button", { class: "btn secondary small", text: "📷 تغيير الصورة" });
    photoBtn.onclick = () => {
      const inp = el("input", { type: "file", accept: "image/*,video/mp4" }) as HTMLInputElement;
      inp.onchange = async () => {
        const f = inp.files?.[0];
        if (!f) return;
        photoBtn.textContent = "بيرفع...";
        try {
          await tg.setMyPhoto(f);
          toast("الصورة اتغيّرت ✓");
          void paint();
        } catch (e) {
          toast("تعذّر: " + errText(e));
          photoBtn.textContent = "📷 تغيير الصورة";
        }
      };
      inp.click();
    };
    body.append(el("div", { class: "info-head" }, [av, el("h2", { text: realName(me) }), el("span", { class: "hint", dir: "ltr", text: me.phone ? "+" + me.phone : "" }), photoBtn]));
    let about = "";
    try {
      about = (await tg.getFull(me)).about ?? "";
    } catch {
      /* ignore */
    }
    body.append(
      navRow("الاسم", realName(me), async () => {
        const v = await askText("الاسم", [{ placeholder: "الاسم الأول", value: me.firstName ?? "" }, { placeholder: "الاسم الأخير (اختياري)", value: me.lastName ?? "", required: false }], "حفظ");
        if (!v) return;
        try {
          await tg.updateProfile({ firstName: v[0], lastName: v[1] });
          toast("اتحفظ ✓");
          void paint();
        } catch (e) {
          toast("تعذّر: " + errText(e));
        }
      }),
      navRow("النبذة", about || "اكتب حاجة عن نفسك", async () => {
        const v = await askText("النبذة (لحد 70 حرف، و140 مع Premium)", [{ placeholder: "النبذة", value: about, required: false }], "حفظ");
        if (!v) return;
        try {
          await tg.updateProfile({ about: v[0] });
          toast("اتحفظ ✓");
          void paint();
        } catch (e) {
          toast("تعذّر: " + errText(e));
        }
      }),
      navRow("اسم المستخدم", me.username ? "@" + me.username : "مفيش", async () => {
        const v = await askText("اسم المستخدم (فاضي = مسح)", [{ placeholder: "username", value: me.username ?? "", required: false }], "حفظ");
        if (!v) return;
        try {
          await tg.setMyUsername(v[0].replace(/^@/, ""));
          toast("اتحفظ ✓");
          void paint();
        } catch (e) {
          const m = errText(e);
          toast(/OCCUPIED/.test(m) ? "اليوزرنيم ده متاخد" : /INVALID/.test(m) ? "اليوزرنيم مش صالح" : "تعذّر: " + m);
        }
      }),
    );
    if (me.photo?.photoId) {
      body.append(
        el("div", { class: "row nav", onclick: async () => {
          if (!(await askChoice("مسح صورة البروفايل الحالية؟", [{ label: "مسح", value: "y", danger: true }]))) return;
          await tg.deleteMyPhoto().then(() => (toast("اتمسحت"), void paint()), (e) => toast("تعذّر: " + errText(e)));
        } }, [el("div", { class: "label danger-text", text: "🗑 مسح الصورة الحالية" })]),
      );
    }
  };
  body.append(el("div", { class: "center" }, [el("div", { class: "spinner" })]));
  void paint();
}

// ---------------- Privacy ----------------
const PRIVACY: [PrivacyKey, string][] = [
  ["lastSeen", "آخر ظهور ومتصل الآن"],
  ["phone", "رقم الموبايل"],
  ["photo", "صورة البروفايل"],
  ["bio", "النبذة"],
  ["forwards", "إظهار اسمك لما رسايلك تتوجّه"],
  ["calls", "المكالمات"],
  ["voice", "الرسايل الصوتية"],
  ["invites", "إضافتك للجروبات"],
  ["birthday", "تاريخ الميلاد"],
];
const VAL_LABEL = { all: "الكل", contacts: "جهات الاتصال", nobody: "محدش" } as const;

export function renderPrivacy(nav: AccountNav): void {
  const body = page("الخصوصية والأمان", nav.onBack);
  body.append(el("div", { class: "section", text: "مين يقدر يشوف..." }));
  for (const [key, label] of PRIVACY) {
    const desc = el("span", { text: "..." });
    const row = el("div", { class: "row nav" }, [el("div", { class: "text" }, [el("div", { class: "label", text: label }), el("div", { class: "desc" }, [desc])]), el("span", { class: "chev", text: "‹" })]);
    body.append(row);
    void tg.getPrivacy(key).then((v) => (desc.textContent = VAL_LABEL[v])).catch(() => (desc.textContent = "—"));
    row.onclick = async () => {
      const c = (await askChoice(label, [
        { label: "الكل", value: "all" },
        { label: "جهات الاتصال", value: "contacts" },
        { label: "محدش", value: "nobody" },
      ])) as "all" | "contacts" | "nobody" | null;
      if (!c) return;
      try {
        await tg.setPrivacy(key, c);
        desc.textContent = VAL_LABEL[c];
        toast("اتحفظ ✓");
      } catch (e) {
        toast("تعذّر: " + errText(e));
      }
    };
  }
  const globals = el("div");
  body.append(el("div", { class: "section", text: "الرسايل" }), globals);
  void tg.getGlobalPrivacy().then((g: any) => {
    globals.append(
      toggleRow("إخفاء وقت القراءة", "الناس مش هتشوف إمتى قريت رسايلهم (وانت كمان مش هتشوف بتاعهم)", !!g.hideReadMarks, (v) => tg.setGlobalPrivacy({ hideReadMarks: v })),
      toggleRow("أرشفة وكتم الغرباء", "المحادثات الجديدة من ناس مش عندك بتروح الأرشيف مكتومة", !!g.archiveAndMuteNewNoncontactPeers, (v) => tg.setGlobalPrivacy({ archiveAndMuteNewNoncontactPeers: v })),
      toggleRow("الغرباء لازم يكونوا Premium", "اللي مش في جهات اتصالك ميقدرش يكلمك غير لو Premium", !!g.newNoncontactPeersRequirePremium, (v) => tg.setGlobalPrivacy({ newNoncontactPeersRequirePremium: v })),
    );
  }).catch(() => {});
  body.append(el("div", { class: "section", text: "الأمان" }));
  body.append(navRow("🚫 المحظورين", "", () => renderBlocked({ onBack: () => renderPrivacy(nav) })));
  body.append(navRow("💻 الأجهزة المتصلة", "", () => renderSessions({ onBack: () => renderPrivacy(nav) })));
  body.append(navRow("🔑 التحقق بخطوتين", "", () => renderTwoFa({ onBack: () => renderPrivacy(nav) })));
}

export function renderBlocked(nav: AccountNav): void {
  const body = page("المحظورين", nav.onBack);
  body.append(el("div", { class: "center" }, [el("div", { class: "spinner" })]));
  void tg.getBlocked().then((list) => {
    body.replaceChildren();
    for (const u of list) {
      const row = el("div", { class: "chat-row" }, [
        avatarEl(u, 42),
        el("div", { class: "chat-meta" }, [el("div", { class: "chat-name", text: displayName(u) }), el("div", { class: "chat-last", text: u.username ? "@" + u.username : "" })]),
        el("button", { class: "btn small secondary", text: "إلغاء الحظر", onclick: () => void tg.setBlocked(u, false).then(() => (row.remove(), toast("اتلغى الحظر")), (e) => toast(errText(e))) }),
      ]);
      body.append(row);
    }
    if (!list.length) body.append(el("div", { class: "center hint", text: "مفيش حد محظور" }));
  }).catch((e) => body.replaceChildren(el("div", { class: "center", text: "تعذّر: " + errText(e) })));
}

// ---------------- Sessions ----------------
export function renderSessions(nav: AccountNav): void {
  const body = page("الأجهزة المتصلة", nav.onBack);
  const paint = async () => {
    body.replaceChildren(el("div", { class: "center" }, [el("div", { class: "spinner" })]));
    try {
      const list = await tg.getSessions();
      body.replaceChildren();
      const item = (a: Api.Authorization) =>
        el("div", { class: "row" + (a.current ? "" : " nav") }, [
          el("div", { class: "text" }, [
            el("div", { class: "label", text: `${a.appName} ${a.appVersion}` }),
            el("div", { class: "desc", text: [a.deviceModel, a.platform, a.systemVersion].filter(Boolean).join(" · ") }),
            el("div", { class: "desc", text: `${a.ip} · ${a.country}${a.current ? " · الجهاز ده" : " · آخر نشاط " + fmtTime(a.dateActive)}` }),
          ]),
          ...(a.current ? [] : [el("span", { class: "chev", text: "‹" })]),
        ]);
      const cur = list.find((a) => a.current);
      if (cur) body.append(el("div", { class: "section", text: "الجهاز ده" }), item(cur));
      const others = list.filter((a) => !a.current);
      if (others.length) {
        body.append(
          el("div", { class: "row nav", onclick: async () => {
            if (!(await askChoice("قفل كل الأجهزة التانية؟", [{ label: "قفل الكل", value: "y", danger: true }]))) return;
            await tg.endOtherSessions().then(() => (toast("اتقفلوا ✓"), void paint()), (e) => toast("تعذّر: " + errText(e)));
          } }, [el("div", { class: "label danger-text", text: "✋ إنهاء كل الجلسات التانية" })]),
          el("div", { class: "section", text: "أجهزة تانية" }),
        );
        for (const a of others) {
          const r = item(a);
          r.onclick = async () => {
            if (!(await askChoice(`قفل ${a.appName} على ${a.deviceModel}؟`, [{ label: "قفل الجلسة", value: "y", danger: true }]))) return;
            await tg.endSession(a.hash).then(() => (toast("اتقفلت ✓"), void paint()), (e) => toast("تعذّر: " + errText(e)));
          };
          body.append(r);
        }
      }
    } catch (e) {
      body.replaceChildren(el("div", { class: "center", text: "تعذّر: " + errText(e) }));
    }
  };
  void paint();
}

// ---------------- Two-step verification ----------------
export function renderTwoFa(nav: AccountNav): void {
  const body = page("التحقق بخطوتين", nav.onBack);
  const askEmailCode = async () => (await askText("ادخل الكود اللي وصلك على الإيميل", [{ placeholder: "الكود" }], "تأكيد"))?.[0] ?? "";
  const run = async (fn: () => Promise<void>, ok: string) => {
    try {
      await fn();
      toast(ok);
      renderTwoFa(nav);
    } catch (e) {
      const m = errText(e);
      toast(/PASSWORD_HASH_INVALID/.test(m) ? "كلمة السر الحالية غلط" : "تعذّر: " + m);
    }
  };
  body.append(el("div", { class: "center" }, [el("div", { class: "spinner" })]));
  void tg.hasPassword().then((st) => {
    body.replaceChildren(
      el("div", { class: "info-head" }, [
        el("div", { class: "logo", text: st.has ? "🔐" : "🔓" }),
        el("h2", { text: st.has ? "التحقق بخطوتين شغّال" : "التحقق بخطوتين مقفول" }),
        el("p", { class: "hint", text: st.has ? `أي جهاز جديد هيحتاج كلمة السر بعد الكود.${st.hint ? " التلميح: " + st.hint : ""}` : "ضيف كلمة سر تتطلب مع كود الدخول على أي جهاز جديد. حماية مهمة جداً لحسابك." }),
      ]),
    );
    if (!st.has) {
      body.append(
        navRow("🔑 تعيين كلمة سر", "", async () => {
          const v = await askText("كلمة سر جديدة", [
            { placeholder: "كلمة السر", type: "password" },
            { placeholder: "اكتبها تاني", type: "password" },
            { placeholder: "تلميح (اختياري)", required: false },
            { placeholder: "إيميل للاسترجاع (اختياري)", type: "email", required: false },
          ], "حفظ");
          if (!v) return;
          if (v[0] !== v[1]) return toast("كلمتين السر مش زي بعض");
          void run(() => tg.setTwoFa({ next: v[0], hint: v[2], email: v[3], askEmailCode }), "التحقق بخطوتين اتفعّل 🔐");
        }),
      );
    } else {
      body.append(
        navRow("✎ تغيير كلمة السر", "", async () => {
          const v = await askText("تغيير كلمة السر", [
            { placeholder: "كلمة السر الحالية", type: "password" },
            { placeholder: "كلمة السر الجديدة", type: "password" },
            { placeholder: "اكتب الجديدة تاني", type: "password" },
            { placeholder: "تلميح (اختياري)", required: false },
          ], "حفظ");
          if (!v) return;
          if (v[1] !== v[2]) return toast("كلمتين السر الجداد مش زي بعض");
          void run(() => tg.setTwoFa({ current: v[0], next: v[1], hint: v[3] }), "اتغيّرت ✓");
        }),
        el("div", { class: "row nav", onclick: async () => {
          const v = await askText("إلغاء التحقق بخطوتين", [{ placeholder: "كلمة السر الحالية", type: "password" }], "إلغاء الحماية");
          if (v) void run(() => tg.setTwoFa({ current: v[0] }), "اتلغى");
        } }, [el("div", { class: "label danger-text", text: "🔓 إلغاء التحقق بخطوتين" })]),
      );
    }
  }).catch((e) => body.replaceChildren(el("div", { class: "center", text: "تعذّر: " + errText(e) })));
}

// ---------------- Notifications ----------------
export function renderNotifications(nav: AccountNav): void {
  const body = page("الإشعارات", nav.onBack);
  const s = notifySettings();
  body.append(
    el("div", { class: "section", text: "والتطبيق مفتوح" }),
    toggleRow("تنبيه جوه التطبيق", "شريط فوق لما توصلك رسالة من محادثة تانية", s.inApp, (v) => setNotifySetting("inApp", v)),
    toggleRow("صوت", "صوت قصير مع التنبيه", s.sound, (v) => setNotifySetting("sound", v)),
    toggleRow("إظهار نص الرسالة", "لو قفلتها هيظهر اسم المرسل بس", s.preview, (v) => setNotifySetting("preview", v)),
    el("div", { class: "section", text: "إشعارات النظام" }),
    toggleRow("إشعارات النظام", "لما التطبيق يكون في الخلفية بس لسه شغّال", s.system, async (v) => {
      if (v && !(await requestSystemPermission())) throw new Error("مسموحش بالإشعارات من إعدادات المتصفح");
      setNotifySetting("system", v);
    }),
    el("div", { class: "note", text: "الإشعارات والتطبيق مقفول خالص (Push) محتاجة الأول نرفع التطبيق على رابط HTTPS ونضيفه للشاشة الرئيسية. ده جزء من خطوة الرفع اللي جاية." }),
  );
}
