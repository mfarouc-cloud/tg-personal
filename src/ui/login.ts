import { el, mount } from "./dom";
import { tg } from "../telegram/client";
import { loadCredentials, saveCredentials, listAccounts, currentSlot, cancelNewAccount } from "../telegram/config";

type Step = "creds" | "phone" | "code" | "password";

export function renderLogin(onDone: () => void): void {
  let step: Step = loadCredentials() ? "phone" : "creds";
  let phone = "";
  let phoneCodeHash = "";

  const errBox = el("div", { class: "err" });
  const card = el("div", { class: "card" });
  // Adding a second account: offer a way back to the existing ones.
  const adding = listAccounts().length > 0 && !listAccounts().some((a) => a.slot === currentSlot());
  const screen = el("div", { class: "screen" }, [
    el("div", { class: "center" }, [
      el("div", { class: "logo", text: "✈" }),
      ...(adding ? [el("p", { class: "hint", text: "إضافة حساب جديد" })] : []),
      card,
      ...(adding
        ? [el("button", { class: "btn secondary", text: "إلغاء والرجوع لحسابك", onclick: () => cancelNewAccount() && location.reload() })]
        : []),
    ]),
  ]);

  const setErr = (m: string) => (errBox.textContent = m);
  const busy = (b: HTMLButtonElement, on: boolean, label: string) => {
    b.disabled = on;
    b.textContent = on ? "..." : label;
  };

  function renderStep() {
    card.replaceChildren();

    if (step === "creds") {
      const id = el("input", { type: "number", inputmode: "numeric", placeholder: "api_id" });
      const hash = el("input", { type: "text", placeholder: "api_hash" });
      const btn = el("button", { class: "btn", text: "حفظ ومتابعة" }) as HTMLButtonElement;
      btn.onclick = () => {
        const apiId = Number(id.value);
        const apiHash = hash.value.trim();
        if (!apiId || apiHash.length < 10) return setErr("ادخل api_id و api_hash صحيحين");
        saveCredentials({ apiId, apiHash });
        tg.init({ apiId, apiHash });
        setErr("");
        step = "phone";
        renderStep();
      };
      card.append(
        el("h2", { text: "بيانات الـ API" }),
        el("p", { class: "hint", html:
          'من <a class="link" target="_blank" href="https://my.telegram.org">my.telegram.org</a> → API development tools. تُحفظ على جهازك فقط.' }),
        field("api_id", id),
        field("api_hash", hash),
        errBox,
        btn,
      );
      return;
    }

    if (step === "phone") {
      if (!tg.isInitialised()) tg.init();
      const inp = el("input", { type: "tel", inputmode: "tel", placeholder: "+20 1xx xxx xxxx" });
      const btn = el("button", { class: "btn", text: "إرسال الكود" }) as HTMLButtonElement;
      btn.onclick = async () => {
        phone = inp.value.trim();
        if (!/^\+?\d{6,15}$/.test(phone.replace(/\s/g, ""))) return setErr("رقم غير صحيح");
        setErr("");
        busy(btn, true, "إرسال الكود");
        try {
          if (tg.state !== "connected") await tg.connect();
          if (await tg.isAuthorised()) return onDone();
          const res = await tg.sendCode(phone);
          phoneCodeHash = res.phoneCodeHash;
          step = "code";
          renderStep();
        } catch (e: any) {
          setErr(humanError(e));
        } finally {
          busy(btn, false, "إرسال الكود");
        }
      };
      card.append(
        el("h2", { text: "رقم الهاتف" }),
        el("p", { class: "hint", text: "ادخل رقمك مع كود الدولة" }),
        field("الهاتف", inp),
        errBox,
        btn,
      );
      return;
    }

    if (step === "code") {
      const inp = el("input", { type: "number", inputmode: "numeric", placeholder: "12345" });
      const btn = el("button", { class: "btn", text: "تأكيد" }) as HTMLButtonElement;
      btn.onclick = async () => {
        const code = inp.value.trim();
        if (code.length < 4) return setErr("ادخل الكود");
        setErr("");
        busy(btn, true, "تأكيد");
        try {
          const r = await tg.signInWithCode(phone, phoneCodeHash, code);
          if (r === "password") {
            step = "password";
            renderStep();
          } else {
            onDone();
          }
        } catch (e: any) {
          setErr(humanError(e));
        } finally {
          busy(btn, false, "تأكيد");
        }
      };
      card.append(
        el("h2", { text: "كود التأكيد" }),
        el("p", { class: "hint", text: `أرسلنا كوداً إلى ${phone}` }),
        field("الكود", inp),
        errBox,
        btn,
      );
      inp.focus();
      return;
    }

    if (step === "password") {
      const inp = el("input", { type: "password", placeholder: "كلمة سر التحقق بخطوتين" });
      const btn = el("button", { class: "btn", text: "دخول" }) as HTMLButtonElement;
      btn.onclick = async () => {
        if (!inp.value) return setErr("ادخل كلمة السر");
        setErr("");
        busy(btn, true, "دخول");
        try {
          await tg.signInWithPassword(inp.value);
          onDone();
        } catch (e: any) {
          setErr(humanError(e));
        } finally {
          busy(btn, false, "دخول");
        }
      };
      card.append(
        el("h2", { text: "التحقق بخطوتين" }),
        el("p", { class: "hint", text: "حسابك محمي بكلمة سر" }),
        field("كلمة السر", inp),
        errBox,
        btn,
      );
      inp.focus();
      return;
    }
  }

  renderStep();
  mount(screen);
}

function field(label: string, input: HTMLElement): HTMLElement {
  return el("div", { class: "field" }, [el("label", { text: label }), input]);
}

function humanError(e: any): string {
  const m = String(e?.errorMessage || e?.message || e);
  if (m.includes("PHONE_NUMBER_INVALID")) return "رقم الهاتف غير صحيح";
  if (m.includes("PHONE_CODE_INVALID")) return "الكود غير صحيح";
  if (m.includes("PHONE_CODE_EXPIRED")) return "انتهت صلاحية الكود، ابدأ من جديد";
  if (m.includes("PASSWORD_HASH_INVALID")) return "كلمة السر غير صحيحة";
  if (m.includes("FLOOD_WAIT")) return "محاولات كثيرة، انتظر قليلاً";
  if (m.includes("API_ID_INVALID")) return "api_id / api_hash غير صحيحين";
  return "حصل خطأ: " + m;
}
