// App passcode lock. Stores only a salted SHA-256 of the PIN, never the PIN.
// Note: this is a privacy screen against someone picking up the device — the
// session itself still lives in localStorage on this browser.
import { el, mount } from "../ui/dom";

const K_HASH = "tg.passcode.hash";
const K_SALT = "tg.passcode.salt";
const PIN_LEN = 4;

async function hashPin(pin: string, salt: string): Promise<string> {
  const data = new TextEncoder().encode(salt + ":" + pin);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function hasPasscode(): boolean {
  return !!localStorage.getItem(K_HASH);
}

export async function setPasscode(pin: string): Promise<void> {
  const saltBytes = crypto.getRandomValues(new Uint8Array(16));
  const salt = Array.from(saltBytes, (b) => b.toString(16).padStart(2, "0")).join("");
  localStorage.setItem(K_SALT, salt);
  localStorage.setItem(K_HASH, await hashPin(pin, salt));
}

export function clearPasscode(): void {
  localStorage.removeItem(K_HASH);
  localStorage.removeItem(K_SALT);
}

async function verify(pin: string): Promise<boolean> {
  const salt = localStorage.getItem(K_SALT) ?? "";
  return (await hashPin(pin, salt)) === localStorage.getItem(K_HASH);
}

/** Keypad screen. `onPin` returns true to accept, false to shake & retry. */
function keypadScreen(
  title: string,
  hint: string,
  onPin: (pin: string) => Promise<boolean>,
  onCancel?: () => void,
): void {
  let pin = "";
  const dots = el("div", { class: "dots" });
  const msg = el("p", { class: "hint", text: hint });
  const paintDots = () => {
    dots.replaceChildren(
      ...Array.from({ length: PIN_LEN }, (_, i) => el("span", { class: "dot" + (i < pin.length ? " full" : "") })),
    );
  };
  const press = async (d: string) => {
    if (pin.length >= PIN_LEN) return;
    pin += d;
    paintDots();
    if (pin.length === PIN_LEN) {
      const ok = await onPin(pin);
      if (!ok) {
        dots.classList.remove("shake");
        void dots.offsetWidth; // restart animation
        dots.classList.add("shake");
        pin = "";
        setTimeout(paintDots, 250);
      }
    }
  };
  const back = () => {
    pin = pin.slice(0, -1);
    paintDots();
  };
  const keys = el("div", { class: "keypad" });
  for (const d of ["1", "2", "3", "4", "5", "6", "7", "8", "9"]) {
    keys.append(el("button", { class: "key", text: d, onclick: () => press(d) }));
  }
  keys.append(
    onCancel
      ? el("button", { class: "key ghost", text: "إلغاء", onclick: onCancel })
      : el("span", {}),
    el("button", { class: "key", text: "0", onclick: () => press("0") }),
    el("button", { class: "key ghost", text: "⌫", "aria-label": "مسح", onclick: back }),
  );
  paintDots();
  mount(
    el("div", { class: "screen" }, [
      el("div", { class: "center" }, [el("div", { class: "logo", text: "🔒" }), el("h2", { text: title }), msg, dots, keys]),
    ]),
  );
  // Physical keyboard support (desktop).
  const onKey = (e: KeyboardEvent) => {
    if (!document.body.contains(keys)) return window.removeEventListener("keydown", onKey);
    if (/^[0-9]$/.test(e.key)) press(e.key);
    else if (e.key === "Backspace") back();
  };
  window.addEventListener("keydown", onKey);
  void msg;
}

export function renderLock(onUnlock: () => void): void {
  keypadScreen("التطبيق مقفول", "ادخل الرقم السري", async (pin) => {
    if (await verify(pin)) {
      onUnlock();
      return true;
    }
    return false;
  });
}

/** Two-step PIN creation. Calls onDone(true) when saved, onDone(false) if cancelled. */
export function renderSetPasscode(onDone: (saved: boolean) => void): void {
  keypadScreen(
    "رقم سري جديد",
    `اختار ${PIN_LEN} أرقام`,
    async (first) => {
      keypadScreen(
        "أكّد الرقم السري",
        "اكتبه تاني",
        async (second) => {
          if (second !== first) {
            renderSetPasscode(onDone);
            return true;
          }
          await setPasscode(first);
          onDone(true);
          return true;
        },
        () => onDone(false),
      );
      return true;
    },
    () => onDone(false),
  );
}
