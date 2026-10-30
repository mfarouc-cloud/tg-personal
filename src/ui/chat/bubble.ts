// One message bubble: sender, forward header, reply quote, media/special,
// formatted text, reactions, meta (edited · time · views · ✓✓), inline keyboard.
import { Api } from "teleproto";
import { customEmojiEl } from "../../features/premiumMedia";
import { el, fmtTime, colorFor } from "../dom";
import { renderMedia } from "../mediaView";
import { describeMedia } from "../../features/media";
import { renderText, type FormatHooks } from "./format";
import { renderSpecial, senderLabel } from "./special";

export interface BubbleCtx {
  showSender: boolean; // groups: show who wrote each incoming message
  showViews: boolean; // channels: 👁 count
  chatEntity: any;
  readOutboxMaxId: () => number;
  /** Sync lookup; may return undefined and later call `fill`. */
  senderOf: (msg: Api.Message, fill: (entity: any) => void) => any;
  fwdName: (msg: Api.Message, fill: (name: string) => void) => string;
  replyOf: (id: number, fill: (m: Api.Message) => void) => Api.Message | undefined;
  hooks: FormatHooks & {
    onVote: (msg: Api.Message, options: Uint8Array[]) => Promise<void>;
    onJump: (msgId: number) => void;
    onReaction: (msg: Api.Message, emoji: string) => void;
    onButton: (msg: Api.Message, button: any) => void;
    onForward?: (msg: Api.Message) => void;
    /** Channel post → open its comments thread. */
    onComments?: (msg: Api.Message) => void;
  };
}

export interface Bubble {
  node: HTMLElement;
  body: HTMLElement;
  msg: Api.Message;
  /** Re-render content after an edit / reactions update. Keeps Anti-Edit tags. */
  update: (msg: Api.Message) => void;
  setRead: (read: boolean) => void;
}

const fmtCount = (n: number) => (n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "K" : String(n));

export function snippetOf(msg: Api.Message | undefined): string {
  if (!msg) return "...";
  const m: any = msg;
  if (msg.message) return msg.message.replace(/\s+/g, " ").slice(0, 90);
  const info = describeMedia(msg);
  if (info) return { photo: "📷 صورة", video: "🎬 فيديو", gif: "GIF", videoNote: "⭕ فيديو دائري", voice: "🎤 رسالة صوتية", audio: "🎵 صوت", sticker: "ملصق " + (info.emoji ?? ""), file: "📎 " + info.name }[info.kind];
  if (m.media instanceof Api.MessageMediaPoll) return "📊 " + (m.media.poll.question?.text ?? m.media.poll.question ?? "استطلاع");
  if (m.media instanceof Api.MessageMediaGeo || m.media instanceof Api.MessageMediaVenue) return "📍 موقع";
  if (m.media instanceof Api.MessageMediaContact) return "👤 جهة اتصال";
  return "رسالة";
}

export function reactionEmoji(r: any): string {
  if (r instanceof Api.ReactionEmoji) return r.emoticon;
  if (r instanceof Api.ReactionPaid) return "⭐";
  return "✨";
}

/** Stable key used for sending: emoticon, or "ce:<documentId>" for custom emoji. */
export function reactionKey(r: any): string | undefined {
  if (r instanceof Api.ReactionEmoji) return r.emoticon;
  if (r instanceof Api.ReactionCustomEmoji) return "ce:" + String(r.documentId);
  return undefined;
}

/** Visual for a reaction key (custom emoji animate when enabled). */
export function reactionNode(key: string, size = 18): Node {
  return key.startsWith("ce:") ? customEmojiEl(key.slice(3), size, "✨") : document.createTextNode(key);
}

export function myReactions(msg: Api.Message): string[] {
  const res: any[] = (msg as any).reactions?.results ?? [];
  return res
    .filter((r) => r.chosenOrder != null && reactionKey(r.reaction))
    .sort((a, b) => a.chosenOrder - b.chosenOrder)
    .map((r) => reactionKey(r.reaction)!);
}

export function buildBubble(msg: Api.Message, ctx: BubbleCtx): Bubble {
  const out = !!msg.out;
  const body = el("div", { class: "body" });
  const head = el("div", { class: "bhead" });
  const reactionsRow = el("div", { class: "reactions" });
  const meta = el("div", { class: "meta" });
  const kbd = el("div", { class: "kbd" });
  const comments = el("div", { class: "comments" });
  const node = el("div", { class: `bubble ${out ? "out" : "in"}`, "data-id": String(msg.id) }, [head, body, reactionsRow, meta, kbd, comments]);
  let ticks: HTMLElement | null = null;

  const paintHead = (m: Api.Message) => {
    head.replaceChildren();
    // Sender name (groups, incoming)
    if (ctx.showSender && !out) {
      const nameEl = el("div", { class: "sender" });
      const setName = (ent: any) => {
        const n = senderLabel(ent) || "...";
        nameEl.textContent = n;
        nameEl.style.color = colorFor(n);
      };
      setName(ctx.senderOf(m, setName));
      head.append(nameEl);
    }
    // Forwarded from
    if ((m as any).fwdFrom) {
      const f = el("div", { class: "fwd" });
      const setF = (n: string) => (f.textContent = "↪ معاد توجيهه من " + (n || "..."));
      setF(ctx.fwdName(m, setF));
      head.append(f);
    }
    // Reply quote
    const rt: any = (m as any).replyTo;
    const replyId: number | undefined = rt?.replyToMsgId;
    if (replyId) {
      const q = el("button", { class: "reply-quote" });
      const fill = (r: Api.Message) => {
        const whoEl = el("b", { text: "رد" });
        if (r.out) whoEl.textContent = "أنت";
        else {
          const setWho = (e: any) => (whoEl.textContent = senderLabel(e) || "رد");
          const known = ctx.senderOf(r, setWho);
          if (known) setWho(known);
        }
        q.replaceChildren(whoEl, el("span", { text: rt.quoteText ? "❝ " + rt.quoteText : snippetOf(r) }));
      };
      const known = ctx.replyOf(replyId, fill);
      if (known) fill(known);
      else q.replaceChildren(el("b", { text: "رد على رسالة" }), el("span", { text: "..." }));
      q.onclick = (e) => {
        e.stopPropagation();
        ctx.hooks.onJump(replyId);
      };
      head.append(q);
    }
  };

  const paintBody = (m: Api.Message) => {
    const tags = Array.from(body.querySelectorAll(":scope > .tag"));
    body.replaceChildren(...tags);
    const fwd = ctx.hooks.onForward ? () => ctx.hooks.onForward!(m) : undefined;
    const hasMedia =
      renderMedia(body, m, ctx.chatEntity, fwd) ||
      renderSpecial(body, m, { ...ctx.hooks, onVote: (opts) => ctx.hooks.onVote(m, opts) });
    if (m.message) {
      const t = el("div", { class: "text", dir: "auto" });
      t.append(renderText(m.message, (m as any).entities, ctx.hooks));
      body.append(t);
    }
    if (!m.message && !hasMedia) body.append(el("span", { class: "hint", text: "(رسالة غير مدعومة)" }));
    node.classList.toggle("has-media", !!describeMedia(m));
  };

  const paintReactions = (m: Api.Message) => {
    reactionsRow.replaceChildren();
    const res: any[] = (m as any).reactions?.results ?? [];
    for (const r of res) {
      const key = reactionKey(r.reaction);
      const chip = el("button", { class: "rchip" + (r.chosenOrder != null ? " mine" : "") }, [
        key ? reactionNode(key) : reactionEmoji(r.reaction),
        " " + fmtCount(r.count),
      ]);
      if (key) {
        chip.onclick = (e) => {
          e.stopPropagation();
          ctx.hooks.onReaction(m, key);
        };
      }
      reactionsRow.append(chip);
    }
  };

  const paintMeta = (m: Api.Message) => {
    meta.replaceChildren();
    const any: any = m;
    if (any.editDate && !any.editHide) meta.append(el("span", { class: "edited", text: "معدّلة" }));
    if (ctx.showViews && any.views != null) meta.append(el("span", { text: "👁 " + fmtCount(any.views) }));
    meta.append(el("span", { text: m.date ? fmtTime(m.date) : "" }));
    if (out) {
      ticks = el("span", { class: "ticks" });
      meta.append(ticks);
      setRead(m.id <= ctx.readOutboxMaxId());
    }
  };

  const paintKeyboard = (m: Api.Message) => {
    kbd.replaceChildren();
    const markup: any = (m as any).replyMarkup;
    if (!(markup instanceof Api.ReplyInlineMarkup)) return;
    for (const row of markup.rows) {
      const r = el("div", { class: "kbd-row" });
      for (const b of row.buttons as any[]) {
        const t = b.type;
        const icon =
          t instanceof Api.InlineButtonTypeUrl || t instanceof Api.InlineButtonTypeUrlAuth
            ? " ↗"
            : t instanceof Api.InlineButtonTypeWebView
              ? " ⧉"
              : t instanceof Api.InlineButtonTypeCopy
                ? " 📋"
                : "";
        const btn = el("button", { class: "kbd-btn", text: (b.text || "") + icon });
        btn.onclick = (e) => {
          e.stopPropagation();
          ctx.hooks.onButton(m, b);
        };
        r.append(btn);
      }
      kbd.append(r);
    }
  };

  const paintComments = (m: Api.Message) => {
    comments.replaceChildren();
    const r: any = (m as any).replies;
    if (!r?.comments || !ctx.hooks.onComments) return;
    const n = r.replies ?? 0;
    comments.append(
      el("button", {
        class: "comments-btn",
        text: n ? `💬 ${fmtCount(n)} تعليق` : "💬 اكتب تعليق",
        onclick: (e: Event) => {
          e.stopPropagation();
          ctx.hooks.onComments!(m);
        },
      }),
    );
  };

  function setRead(read: boolean) {
    if (ticks) {
      ticks.textContent = read ? "✓✓" : "✓";
      ticks.classList.toggle("read", read);
    }
  }

  const bubble: Bubble = {
    node,
    body,
    msg,
    update: (m) => {
      bubble.msg = m;
      paintHead(m);
      paintBody(m);
      paintReactions(m);
      paintMeta(m);
      paintKeyboard(m);
      paintComments(m);
    },
    setRead,
  };
  bubble.update(msg);
  return bubble;
}

/** Centered pill for service messages and date separators. */
export function pill(text: string, cls = "service"): HTMLElement {
  return el("div", { class: `pill ${cls}` }, [el("span", { text })]);
}

export function dayLabel(unix: number): string {
  const d = new Date(unix * 1000);
  const now = new Date();
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (d.toDateString() === now.toDateString()) return "النهارده";
  if (d.toDateString() === y.toDateString()) return "امبارح";
  return d.toLocaleDateString("ar-EG", { day: "numeric", month: "long", year: d.getFullYear() === now.getFullYear() ? undefined : "numeric" });
}
