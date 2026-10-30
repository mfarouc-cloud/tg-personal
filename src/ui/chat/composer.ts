// Message composer: text, reply/edit bar, attachments, voice recording,
// bot reply-keyboards, typing notifications, read-only notice.
import { Api } from "teleproto";
import { el, toast } from "../dom";
import { tg } from "../../telegram/client";
import { VoiceRecorder } from "../../features/voice";
import { snippetOf } from "./bubble";
import { senderLabel } from "./special";

export interface ComposerHandlers {
  sendText: (text: string, replyTo?: number) => Promise<void>;
  editText: (msg: Api.Message, text: string) => Promise<void>;
  sendFiles: (files: File[], caption: string, replyTo?: number) => void;
  sendVoice: (blob: Blob, duration: number, waveform: Uint8Array, replyTo?: number) => Promise<void>;
  senderOf: (msg: Api.Message) => any;
  openWebApp?: (url: string) => void;
}

export interface Composer {
  root: HTMLElement;
  setReply: (msg: Api.Message | null) => void;
  setEdit: (msg: Api.Message | null) => void;
  setReplyKeyboard: (markup: any | null) => void;
  setReadOnly: (reason: string | null, action?: { label: string; run: () => void }) => void;
}

export function createComposer(peer: Api.TypeEntityLike, h: ComposerHandlers): Composer {
  let replyTo: Api.Message | null = null;
  let editing: Api.Message | null = null;
  let lastTyping = 0;

  const textarea = el("textarea", { rows: "1", placeholder: "رسالة", dir: "auto" }) as HTMLTextAreaElement;
  const sendBtn = el("button", { class: "sendbtn", text: "➤", "aria-label": "إرسال" }) as HTMLButtonElement;
  const micBtn = el("button", { class: "sendbtn mic", text: "🎤", "aria-label": "تسجيل صوتي" }) as HTMLButtonElement;
  const picker = el("input", { type: "file", multiple: "", style: { display: "none" } }) as HTMLInputElement;
  const attachBtn = el("button", { class: "attachbtn", text: "📎", "aria-label": "إرفاق", onclick: () => picker.click() });
  const kbdToggle = el("button", { class: "attachbtn", text: "⌨", "aria-label": "كيبورد البوت", style: { display: "none" } });

  const ctxBar = el("div", { class: "ctxbar", style: { display: "none" } });
  const kbdArea = el("div", { class: "reply-kbd", style: { display: "none" } });
  const roBar = el("div", { class: "readonly", style: { display: "none" } });
  const row = el("div", { class: "composer" }, [attachBtn, picker, kbdToggle, textarea, sendBtn, micBtn]);
  const recBar = el("div", { class: "composer rec", style: { display: "none" } });
  const root = el("div", { class: "composer-wrap" }, [ctxBar, row, recBar, kbdArea, roBar]);

  const refreshButtons = () => {
    const has = textarea.value.trim().length > 0;
    sendBtn.style.display = has || editing ? "" : "none";
    micBtn.style.display = has || editing || !VoiceRecorder.supported() ? "none" : "";
  };
  refreshButtons();

  textarea.oninput = () => {
    refreshButtons();
    textarea.style.height = "auto";
    textarea.style.height = Math.min(textarea.scrollHeight, 140) + "px";
    const now = Date.now();
    if (textarea.value && now - lastTyping > 5000) {
      lastTyping = now;
      void tg.setTyping(peer).catch(() => {});
    }
  };
  // Enter sends on desktop keyboards; Shift+Enter = new line. On phones Enter = newline.
  textarea.onkeydown = (e) => {
    if (e.key === "Enter" && !e.shiftKey && !matchMedia("(pointer: coarse)").matches) {
      e.preventDefault();
      void submit();
    }
  };

  const clearText = () => {
    textarea.value = "";
    textarea.style.height = "auto";
    refreshButtons();
  };

  async function submit() {
    const text = textarea.value.trim();
    if (!text) return;
    if (editing) {
      const m = editing;
      setEdit(null);
      clearText();
      await h.editText(m, text).catch((e) => toast("تعذّر التعديل: " + (e?.errorMessage || e?.message || "")));
      return;
    }
    const r = replyTo?.id;
    setReply(null);
    clearText();
    await h.sendText(text, r).catch((e) => toast("تعذّر الإرسال: " + (e?.errorMessage || e?.message || "")));
  }
  sendBtn.onclick = () => void submit();

  picker.onchange = () => {
    const files = Array.from(picker.files ?? []);
    picker.value = "";
    if (!files.length) return;
    const caption = files.length === 1 ? textarea.value.trim() : "";
    if (caption) clearText();
    const r = replyTo?.id;
    setReply(null);
    h.sendFiles(files, caption, r);
  };

  // ---- Reply / edit context bar ----
  function paintCtx(title: string, msg: Api.Message) {
    ctxBar.replaceChildren(
      el("span", { class: "ctx-icon", text: editing ? "✎" : "↩" }),
      el("div", { class: "ctx-text" }, [el("b", { text: title }), el("span", { text: snippetOf(msg) })]),
      el("button", {
        class: "iconbtn",
        text: "✕",
        "aria-label": "إلغاء",
        onclick: () => {
          if (editing) {
            setEdit(null);
            clearText();
          } else setReply(null);
        },
      }),
    );
    ctxBar.style.display = "";
  }
  function setReply(msg: Api.Message | null) {
    replyTo = msg;
    if (msg) {
      editing = null;
      paintCtx("رد على " + (msg.out ? "نفسك" : senderLabel(h.senderOf(msg)) || "رسالة"), msg);
      textarea.focus();
    } else if (!editing) ctxBar.style.display = "none";
    refreshButtons();
  }
  function setEdit(msg: Api.Message | null) {
    editing = msg;
    if (msg) {
      replyTo = null;
      paintCtx("تعديل الرسالة", msg);
      textarea.value = msg.message || "";
      textarea.dispatchEvent(new Event("input"));
      textarea.focus();
    } else if (!replyTo) ctxBar.style.display = "none";
    refreshButtons();
  }

  // ---- Bot reply keyboard ----
  let kbdOpen = true;
  kbdToggle.onclick = () => {
    kbdOpen = !kbdOpen;
    kbdArea.style.display = kbdOpen && kbdArea.childElementCount ? "" : "none";
  };
  function setReplyKeyboard(markup: any | null) {
    kbdArea.replaceChildren();
    if (!(markup instanceof Api.ReplyKeyboardMarkup)) {
      kbdArea.style.display = "none";
      kbdToggle.style.display = "none";
      return;
    }
    for (const r of markup.rows) {
      const line = el("div", { class: "kbd-row" });
      for (const b of r.buttons as any[]) {
        const btn = el("button", { class: "kbd-btn", text: b.text });
        btn.onclick = () => {
          const t = b.type;
          if (!t || t instanceof Api.ButtonTypeDefault) {
            void h.sendText(b.text).catch(() => {});
            if (markup.singleUse) setReplyKeyboard(null);
          } else if (t instanceof Api.ButtonTypeSimpleWebView) {
            h.openWebApp?.(t.url);
          } else toast("الزرار ده مش مدعوم هنا");
        };
        line.append(btn);
      }
      kbdArea.append(line);
    }
    kbdToggle.style.display = "";
    kbdArea.style.display = kbdOpen ? "" : "none";
  }

  function setReadOnly(reason: string | null, action?: { label: string; run: () => void }) {
    roBar.replaceChildren(
      action ? el("button", { class: "btn join-btn", text: action.label, onclick: action.run }) : el("span", { text: reason ?? "" }),
    );
    roBar.style.display = reason ? "" : "none";
    row.style.display = reason ? "none" : "";
  }

  // ---- Voice recording ----
  let recorder: VoiceRecorder | null = null;
  let timer = 0;
  micBtn.onclick = async () => {
    if (recorder) return;
    recorder = new VoiceRecorder();
    const time = el("span", { class: "rec-time", text: "0:00" });
    const meter = el("i", { class: "rec-meter" });
    const cancel = el("button", { class: "iconbtn", text: "✕", "aria-label": "إلغاء التسجيل" });
    const send = el("button", { class: "sendbtn", text: "✓", "aria-label": "إرسال الصوت" });
    recBar.replaceChildren(cancel, el("span", { class: "rec-dot" }), time, el("span", { class: "rec-meter-box" }, [meter]), send);
    recorder.onLevel = (l) => (meter.style.width = Math.round(l * 100) + "%");
    try {
      await recorder.start();
    } catch (e: any) {
      recorder = null;
      toast(e?.name === "NotAllowedError" ? "اسمح للتطبيق يستخدم المايك من الإعدادات" : "تعذّر بدء التسجيل");
      return;
    }
    row.style.display = "none";
    recBar.style.display = "";
    void tg.setTyping(peer, "recording").catch(() => {});
    timer = window.setInterval(() => {
      const s = Math.floor(recorder?.elapsed ?? 0);
      time.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
    }, 250);
    const finish = () => {
      clearInterval(timer);
      recBar.style.display = "none";
      row.style.display = "";
    };
    cancel.onclick = () => {
      recorder?.cancel();
      recorder = null;
      finish();
      void tg.setTyping(peer, "cancel").catch(() => {});
    };
    send.onclick = async () => {
      const r = recorder;
      recorder = null;
      finish();
      if (!r) return;
      try {
        const res = await r.stop();
        const rt = replyTo?.id;
        setReply(null);
        await h.sendVoice(res.blob, res.duration, res.waveform, rt);
      } catch (e: any) {
        toast("تعذّر إرسال الصوت: " + (e?.errorMessage || e?.message || ""));
      }
    };
  };

  return { root, setReply, setEdit, setReplyKeyboard, setReadOnly };
}
