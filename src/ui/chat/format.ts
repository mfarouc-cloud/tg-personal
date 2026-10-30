// Renders Telegram message text + entities into DOM nodes (never innerHTML).
// Offsets/lengths are UTF-16 code units, which is exactly how JS strings index.
import { Api } from "teleproto";
import { customEmojiEl } from "../../features/premiumMedia";
import { el } from "../dom";

export interface FormatHooks {
  /** @username or t.me/<name> link tapped. Return true if handled in-app. */
  onUsername?: (username: string, postId?: number) => boolean;
  /** Mention of a user without a username (MentionName). */
  onUserId?: (userId: string) => void;
  /** #hashtag tapped. */
  onHashtag?: (tag: string) => void;
}

type Ent = Api.TypeMessageEntity & { offset: number; length: number };

const SAFE_SCHEMES = /^(https?:|tg:|mailto:|tel:)/i;

export function safeUrl(raw: string): string | null {
  let url = raw.trim();
  if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) url = "https://" + url; // bare domain
  return SAFE_SCHEMES.test(url) ? url : null;
}

/** Parse t.me / telegram.me links → { username, postId }. */
export function parseTmeLink(url: string): { username: string; postId?: number } | null {
  const m = url.match(/^(?:https?:\/\/)?(?:www\.)?(?:t\.me|telegram\.me|telegram\.dog)\/([A-Za-z0-9_]{4,})(?:\/(\d+))?\/?(?:[?#].*)?$/i);
  if (!m || /^(joinchat|addstickers|share|proxy|socks|c|s)$/i.test(m[1])) return null;
  return { username: m[1], postId: m[2] ? Number(m[2]) : undefined };
}

function linkEl(href: string, label: (Node | string)[], hooks: FormatHooks): HTMLElement {
  const url = safeUrl(href);
  if (!url) return el("span", {}, label);
  const a = el("a", { class: "link", href: url, target: "_blank", rel: "noopener noreferrer" }, label);
  const tme = parseTmeLink(url);
  const inv = url.match(/(?:t\.me|telegram\.me)\/(?:\+|joinchat\/)([\w-]{8,})/i);
  if ((tme || inv) && hooks.onUsername) {
    a.addEventListener("click", (e) => {
      const handled = inv ? hooks.onUsername!("+" + inv[1]) : hooks.onUsername!(tme!.username, tme!.postId);
      if (handled) e.preventDefault();
    });
  }
  return a;
}

function wrap(ent: Ent, text: string, children: (Node | string)[], hooks: FormatHooks): Node {
  const raw = text.slice(ent.offset, ent.offset + ent.length);
  if (ent instanceof Api.MessageEntityCustomEmoji) return customEmojiEl(String(ent.documentId), 20, children);
  if (ent instanceof Api.MessageEntityBold) return el("b", {}, children);
  if (ent instanceof Api.MessageEntityItalic) return el("i", {}, children);
  if (ent instanceof Api.MessageEntityUnderline) return el("u", {}, children);
  if (ent instanceof Api.MessageEntityStrike) return el("s", {}, children);
  if (ent instanceof Api.MessageEntityCode) return el("code", { class: "code" }, children);
  if (ent instanceof Api.MessageEntityPre) return el("pre", { class: "pre", dir: "ltr" }, children);
  if (ent instanceof Api.MessageEntityBlockquote) return el("blockquote", { class: "quote" }, children);
  if (ent instanceof Api.MessageEntitySpoiler) {
    const s = el("span", { class: "spoiler", role: "button", "aria-label": "نص مخفي" }, children);
    s.addEventListener("click", (e) => {
      if (!s.classList.contains("shown")) {
        e.stopPropagation();
        s.classList.add("shown");
      }
    });
    return s;
  }
  if (ent instanceof Api.MessageEntityUrl) return linkEl(raw, children, hooks);
  if (ent instanceof Api.MessageEntityTextUrl) return linkEl(ent.url, children, hooks);
  if (ent instanceof Api.MessageEntityEmail) return linkEl("mailto:" + raw, children, hooks);
  if (ent instanceof Api.MessageEntityPhone) return linkEl("tel:" + raw.replace(/[^\d+]/g, ""), children, hooks);
  if (ent instanceof Api.MessageEntityMention) {
    const s = el("span", { class: "mention", role: "link" }, children);
    s.addEventListener("click", (e) => {
      e.stopPropagation();
      hooks.onUsername?.(raw.replace(/^@/, ""));
    });
    return s;
  }
  if (ent instanceof Api.MessageEntityMentionName) {
    const s = el("span", { class: "mention", role: "link" }, children);
    s.addEventListener("click", (e) => {
      e.stopPropagation();
      hooks.onUserId?.(String(ent.userId));
    });
    return s;
  }
  if (ent instanceof Api.MessageEntityHashtag || ent instanceof Api.MessageEntityCashtag) {
    const s = el("span", { class: "mention", role: "link" }, children);
    s.addEventListener("click", (e) => {
      e.stopPropagation();
      hooks.onHashtag?.(raw);
    });
    return s;
  }
  if (ent instanceof Api.MessageEntityBotCommand) return el("span", { class: "mention" }, children);
  // CustomEmoji & unknown: keep the fallback text as-is.
  const frag = document.createDocumentFragment();
  frag.append(...children);
  return frag;
}

/** Text + entities → DocumentFragment. Handles nesting; clips overlaps. */
export function renderText(text: string, entities: Api.TypeMessageEntity[] | undefined, hooks: FormatHooks = {}): DocumentFragment {
  const ents = ((entities ?? []) as Ent[])
    .filter((e) => e.length > 0 && e.offset >= 0 && e.offset < text.length)
    .sort((a, b) => a.offset - b.offset || b.length - a.length);

  const build = (start: number, end: number, pool: Ent[]): (Node | string)[] => {
    const out: (Node | string)[] = [];
    let cursor = start;
    let i = 0;
    while (i < pool.length) {
      const e = pool[i];
      if (e.offset < cursor) {
        i++; // overlapping a previous sibling: skip (clip)
        continue;
      }
      const eEnd = Math.min(e.offset + e.length, end);
      if (e.offset > cursor) out.push(text.slice(cursor, e.offset));
      // children = entities fully inside this one
      const inner: Ent[] = [];
      let j = i + 1;
      while (j < pool.length && pool[j].offset < eEnd) {
        if (pool[j].offset + pool[j].length <= eEnd) inner.push(pool[j]);
        j++;
      }
      out.push(wrap(e, text, build(e.offset, eEnd, inner), hooks));
      cursor = eEnd;
      i = j;
    }
    if (cursor < end) out.push(text.slice(cursor, end));
    return out;
  };

  const frag = document.createDocumentFragment();
  frag.append(...build(0, text.length, ents));
  return frag;
}
