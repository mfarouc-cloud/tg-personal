import { safeReload } from "../telegram/secureStore";
import { el, mount, toast } from "./dom";
import { tg } from "../telegram/client";
import { clearAll, listAccounts, currentSlot, switchAccount, startNewAccount, removeCurrentAccount } from "../telegram/config";
import { realName } from "../telegram/entity";
import { avatarEl } from "./avatar";
import { askChoice } from "./chat/menu";
import { renderProfile, renderPrivacy, renderSessions, renderTwoFa, renderNotifications } from "./account";
import { postStoryFlow } from "./stories";
import { premiumStar } from "./chatlist";
import { customEmojiEl } from "../features/premiumMedia";
import {
  applyTheme,
  currentTheme,
  currentAccent,
  ACCENT_PRESETS,
  type ThemeName,
} from "../theme/theme";
import {
  FEATURES,
  isOn,
  setOn,
  type FeatureId,
  TRANSLATE_LANGS,
  translateLang,
  setTranslateLang,
} from "../features/registry";
import { renderSetPasscode, clearPasscode, hasPasscode } from "../features/passcode";

export interface SettingsNav {
  onBack: () => void;
}

const VERSION = "0.9.0";

export function renderSettings(nav: SettingsNav): void {
  const back = () => renderSettings(nav);
  const topbar = el("div", { class: "topbar" }, [
    el("button", { class: "iconbtn", text: "‹", "aria-label": "رجوع", onclick: nav.onBack }),
    el("div", { class: "title", text: "الإعدادات" }),
  ]);
  const body = el("div", { class: "scroll" });
  mount(el("div", { class: "screen" }, [topbar, body]));

  const navRow = (label: string, desc: string, run: () => void) =>
    el("div", { class: "row nav", onclick: run }, [
      el("div", { class: "text" }, [el("div", { class: "label", text: label }), ...(desc ? [el("div", { class: "desc", text: desc })] : [])]),
      el("span", { class: "chev", text: "‹" }),
    ]);

  // ---- Account card ----
  const me: any = tg.me;
  if (me) {
    body.append(
      el("div", { class: "account-card", onclick: () => renderProfile({ onBack: back }) }, [
        avatarEl(me, 64, undefined, true),
        el("div", { class: "text" }, [
          el("div", { class: "label" }, [realName(me), ...premiumStar(me)]),
          el("div", { class: "desc", dir: "ltr", text: [me.phone ? "+" + me.phone : "", me.username ? "@" + me.username : ""].filter(Boolean).join(" · ") }),
        ]),
        el("span", { class: "chev", text: "‹" }),
      ]),
    );
  }

  // ---- Accounts ----
  const accounts = listAccounts();
  body.append(el("div", { class: "section", text: "الحسابات" }));
  for (const a of accounts) {
    const current = a.slot === currentSlot();
    body.append(
      el("div", {
        class: "row" + (current ? "" : " nav"),
        onclick: current
          ? null
          : () => {
              switchAccount(a.slot);
              void safeReload();
            },
      }, [
        el("div", { class: "text" }, [el("div", { class: "label", text: a.name || "حساب" }), el("div", { class: "desc", dir: "ltr", text: a.phone ? "+" + a.phone : "" })]),
        el("span", { class: "check-mark", text: current ? "✓" : "" }),
      ]),
    );
  }
  body.append(
    navRow("➕ إضافة حساب", "كل حساب ليه جلسة لوحده على الجهاز ده", () => {
      startNewAccount();
      void safeReload();
    }),
  );

  // ---- Account settings ----
  body.append(el("div", { class: "section", text: "الحساب" }));
  body.append(
    navRow("👤 الملف الشخصي", "الاسم، الصورة، النبذة، اليوزرنيم", () => renderProfile({ onBack: back })),
    navRow("🔒 الخصوصية والأمان", "آخر ظهور، الرقم، المحظورين…", () => renderPrivacy({ onBack: back })),
    navRow("💻 الأجهزة المتصلة", "", () => renderSessions({ onBack: back })),
    navRow("🔑 التحقق بخطوتين", "", () => renderTwoFa({ onBack: back })),
    navRow("📖 نشر ستوري", "", () => void postStoryFlow()),
    navRow("🔔 الإشعارات", "", () => renderNotifications({ onBack: back })),
  );
  if (tg.isPremium) body.append(navRow("✨ حالة الإيموجي", "إيموجي جنب اسمك (Premium)", () => void pickEmojiStatus(back)));

  // ---- Features (all optional features live on their own page) ----
  const enabled = FEATURES.filter((f) => isOn(f.id)).length;
  body.append(el("div", { class: "section", text: "الإضافات" }));
  body.append(navRow("⚡ المميزات", `${enabled} من ${FEATURES.length} شغّالة`, () => renderFeatures({ onBack: back })));

  // ---- Appearance ----
  body.append(el("div", { class: "section", text: "المظهر" }));
  const seg = el("div", { class: "seg" });
  const themes: [ThemeName, string][] = [
    ["dark", "داكن"],
    ["amoled", "أسود AMOLED"],
    ["light", "فاتح"],
  ];
  const segBtns: Record<string, HTMLButtonElement> = {};
  for (const [val, label] of themes) {
    const b = el("button", {
      class: currentTheme() === val ? "active" : "",
      text: label,
      onclick: () => {
        applyTheme(val);
        for (const k in segBtns) segBtns[k].classList.toggle("active", k === val);
      },
    }) as HTMLButtonElement;
    segBtns[val] = b;
    seg.append(b);
  }
  body.append(el("div", { class: "row" }, [el("div", { class: "label", text: "الثيم" }), seg]));
  const swatches = el("div", { class: "swatches" });
  const repaintSwatches = () => {
    swatches.replaceChildren();
    for (const color of ACCENT_PRESETS) {
      swatches.append(
        el("button", {
          class: "swatch" + (currentAccent().toLowerCase() === color ? " active" : ""),
          style: { background: color },
          "aria-label": color,
          onclick: () => {
            applyTheme(currentTheme(), color);
            repaintSwatches();
          },
        }),
      );
    }
    const picker = el("input", { type: "color", value: currentAccent(), "aria-label": "لون مخصص", style: { width: "34px", height: "34px", border: "none", background: "none" } }) as HTMLInputElement;
    picker.oninput = () => {
      applyTheme(currentTheme(), picker.value);
      repaintSwatches();
    };
    swatches.append(picker);
  };
  repaintSwatches();
  body.append(el("div", { class: "section", text: "لون التمييز" }), swatches);

  // ---- Log out ----
  body.append(el("div", { class: "section", text: "" }));
  body.append(
    el("div", { class: "row nav", onclick: async () => {
      const others = listAccounts().filter((a) => a.slot !== currentSlot()).length;
      const c = await askChoice(others ? "تسجيل الخروج من الحساب ده؟ (حساباتك التانية هتفضل)" : "تسجيل الخروج ومسح الجلسة من الجهاز ده؟", [
        { label: "تسجيل الخروج", value: "y", danger: true },
      ]);
      if (!c) return;
      try {
        await tg.logOut();
      } catch {
        /* still remove locally */
      }
      try {
        await tg.disconnect();
      } catch {
        /* ignore */
      }
      const next = removeCurrentAccount();
      if (!next) {
        clearPasscode();
        await clearAll();
      }
      void safeReload();
    } }, [el("div", { class: "label danger-text", text: "🚪 تسجيل الخروج" })]),
  );
  body.append(el("div", { class: "section", text: `نسخة ${VERSION} — عميل شخصي. المكالمات والمحادثات السرّية غير مدعومة في نسخة الويب.` }));
}

/** Features page: every optional feature, grouped, each with its own on/off. */
export function renderFeatures(nav: SettingsNav): void {
  const topbar = el("div", { class: "topbar" }, [
    el("button", { class: "iconbtn", text: "‹", "aria-label": "رجوع", onclick: nav.onBack }),
    el("div", { class: "title", text: "المميزات" }),
  ]);
  const body = el("div", { class: "scroll" });
  mount(el("div", { class: "screen" }, [topbar, body]));

  const groups = [...new Set(FEATURES.map((f) => f.group))];
  for (const group of groups) {
    body.append(el("div", { class: "section", text: group }));
    if (group.startsWith("Premium")) {
      body.append(
        el("div", { class: "row" }, [
          el("div", { class: "text" }, [
            el("div", {
              class: "label",
              text: tg.isPremium ? "⭐ حسابك Premium" : "حسابك مش Premium",
            }),
            el("div", {
              class: "desc",
              text: tg.isPremium
                ? "رفع لحد 4GB، تحميل أسرع، تحويل الصوت لنص وترجمة — كلها شغّالة"
                : "المميزات دي من تليجرام نفسه ومحتاجة اشتراك Premium على حسابك",
            }),
          ]),
        ]),
      );
    }
    for (const f of FEATURES.filter((x) => x.group === group)) {
      body.append(featureRow(f.id, f.title, f.desc, () => renderFeatures(nav)));
      if (f.id === "translate" && isOn("translate")) {
        const sel = el("select", { class: "select", "aria-label": "لغة الترجمة" }) as HTMLSelectElement;
        for (const [code, label] of TRANSLATE_LANGS) {
          const o = el("option", { value: code, text: label }) as HTMLOptionElement;
          if (code === translateLang()) o.selected = true;
          sel.append(o);
        }
        sel.onchange = () => setTranslateLang(sel.value);
        body.append(el("div", { class: "row" }, [el("div", { class: "label", text: "ترجم إلى" }), sel]));
      }
      if (f.id === "passcodeLock" && isOn("passcodeLock") && hasPasscode()) {
        body.append(
          el("div", {
            class: "row nav",
            onclick: () =>
              renderSetPasscode((saved) => {
                if (saved) toast("اتغيّر الرقم السري");
                renderFeatures(nav);
              }),
          }, [el("div", { class: "label", text: "تغيير الرقم السري" }), el("span", { class: "chev", text: "‹" })]),
        );
      }
    }
  }
  body.append(el("div", { class: "section", text: "الإعدادات دي محفوظة على الجهاز ده بس." }));
}

function featureRow(id: FeatureId, title: string, desc: string, rerender: () => void): HTMLElement {
  let on = isOn(id);
  const tog = el("button", {
    class: "toggle" + (on ? " on" : ""),
    role: "switch",
    "aria-checked": String(on),
    "aria-label": title,
  });
  tog.onclick = () => {
    const next = !on;
    if (id === "passcodeLock") {
      if (next) {
        // Only switch on after a PIN has actually been set.
        renderSetPasscode((saved) => {
          if (saved) {
            setOn("passcodeLock", true);
            toast("القفل اتفعّل");
          }
          rerender();
        });
      } else {
        clearPasscode();
        setOn("passcodeLock", false);
        rerender();
      }
      return;
    }
    on = next;
    setOn(id, on);
    tog.classList.toggle("on", on);
    tog.setAttribute("aria-checked", String(on));
  };
  return el("div", { class: "row" }, [
    el("div", { class: "text" }, [el("div", { class: "label", text: title }), el("div", { class: "desc", text: desc })]),
    tog,
  ]);
}

/** Premium emoji status: pick from recent/default statuses, choose duration, or clear. */
async function pickEmojiStatus(onDone: () => void): Promise<void> {
  const grid = el("div", { class: "reaction-grid status-grid" }, [el("div", { class: "muted pad", text: "..." })]);
  const close = () => overlay.remove();
  const sheet = el("div", { class: "sheet", role: "dialog" }, [
    el("div", { class: "sheet-head" }, [el("div", { class: "title", text: "حالة الإيموجي" })]),
    grid,
    el("button", {
      class: "sheet-opt danger",
      text: "شيل الحالة",
      onclick: async () => {
        close();
        try {
          await tg.setEmojiStatus(null, 0);
          toast("اتشالت");
          onDone();
        } catch (e: any) {
          toast("تعذّر: " + (e?.errorMessage || e?.message || ""));
        }
      },
    }),
  ]);
  const overlay = el("div", { class: "sheet-backdrop", onclick: (e: Event) => e.target === overlay && close() }, [sheet]);
  document.body.append(overlay);
  let ids: string[] = [];
  try {
    ids = await tg.emojiStatusChoices();
  } catch {
    /* empty */
  }
  grid.replaceChildren();
  if (!ids.length) grid.append(el("div", { class: "muted pad", text: "مفيش حالات متاحة دلوقتي" }));
  for (const id of ids.slice(0, 60)) {
    grid.append(
      el("button", {
        class: "mr",
        "aria-label": "حالة",
        onclick: async () => {
          close();
          const d = await askChoice("لمدة قد إيه؟", [
            { label: "ساعة", value: "3600" },
            { label: "8 ساعات", value: "28800" },
            { label: "يوم", value: "86400" },
            { label: "أسبوع", value: "604800" },
            { label: "على طول", value: "0" },
          ]);
          if (d == null) return;
          const secs = Number(d);
          try {
            await tg.setEmojiStatus(id, secs ? Math.floor(Date.now() / 1000) + secs : 0);
            toast("اتغيّرت الحالة ✨");
            onDone();
          } catch (e: any) {
            toast("تعذّر: " + (e?.errorMessage || e?.message || ""));
          }
        },
      }, [customEmojiEl(id, 30, "⭐")]),
    );
  }
}
