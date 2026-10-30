// Chat list: built-in tabs + your Telegram folders, archive, pinned/muted,
// drafts, global search (chats, people, public channels, messages),
// long-press actions, "new" menu.
import { Api } from "teleproto";
import { customEmojiEl } from "../features/premiumMedia";
import { el, mount, fmtTime, toast } from "./dom";
import { tg, peerKey } from "../telegram/client";
import type { Dialog } from "../telegram/types";
import { isOn } from "../features/registry";
import { displayName, isMuted, hasUnreadMark, inFolder, folderTitle, dialogFor } from "../telegram/entity";
import { avatarEl } from "./avatar";
import { openMenu, attachLongPress, askChoice } from "./chat/menu";
import { snippetOf } from "./chat/bubble";
import { parseTmeLink } from "./chat/format";
import { storiesStrip } from "./stories";

export interface ChatListNav {
  onOpenChat: (dialog: Dialog, jumpTo?: number) => void;
  onOpenSettings: () => void;
  /** @username, numeric id, or "+inviteHash". */
  onOpenPeer: (target: string, postId?: number) => void;
  onNew: (kind: "contacts" | "group" | "channel" | "link") => void;
}

type BuiltIn = "all" | "personal" | "groups" | "channels" | "bots";
const BUILT_INS: { id: BuiltIn; label: string }[] = [
  { id: "all", label: "الكل" },
  { id: "personal", label: "شخصي" },
  { id: "groups", label: "جروبات" },
  { id: "channels", label: "قنوات" },
  { id: "bots", label: "بوتات" },
];

export function folderOf(d: Dialog): Exclude<BuiltIn, "all"> {
  if (d.isUser) return (d.entity as any)?.bot ? "bots" : "personal";
  if (d.isGroup) return "groups";
  if (d.isChannel) return "channels";
  return "personal";
}

/** ⭐ next to Premium users (when the badge feature is on). */
export function premiumStar(entity: any): HTMLElement[] {
  if (!isOn("premiumBadges") || !entity?.premium) return [];
  const st = entity.emojiStatus;
  const docId = st?.documentId;
  const live = !st?.until || st.until > Date.now() / 1000;
  if (docId != null && live && isOn("customEmoji")) {
    const n = customEmojiEl(String(docId), 18, "⭐");
    n.classList.add("emoji-status");
    n.title = "Telegram Premium";
    return [n];
  }
  return [el("span", { class: "premium-star", title: "Telegram Premium", text: "⭐" })];
}

const K_TAB = "tg.folder";
let currentTab: string = localStorage.getItem(K_TAB) || "all";
let mainCache: Dialog[] = [];
let archiveCache: Dialog[] = [];
let folders: any[] = [];
let detach: (() => void) | null = null;
let strip: HTMLElement | null = null;

/** For notifications: is this chat muted (per the loaded list)? */
export function isMutedPeer(key: string): boolean {
  const d = [...mainCache, ...archiveCache].find((x) => peerKey(x.entity) === key);
  return d ? isMuted(d) : false;
}

/** Dialogs loaded so far (used by the forward picker). Fetches if empty. */
export async function getDialogsCached(): Promise<Dialog[]> {
  if (!mainCache.length) mainCache = (await tg.getDialogs(200)) as unknown as Dialog[];
  return mainCache;
}

/** Recognise things typed into search that we can open directly. */
function parseTarget(q: string): { label: string; target: string } | null {
  const s = q.trim();
  const invite = s.match(/(?:t\.me|telegram\.me)\/(?:\+|joinchat\/)([\w-]{8,})/i);
  if (invite) return { label: "انضم من لينك الدعوة", target: "+" + invite[1] };
  const link = parseTmeLink(s);
  if (link) return { label: "افتح @" + link.username, target: link.username };
  if (/^@[A-Za-z]\w{3,31}$/.test(s)) return { label: "افتح " + s, target: s.slice(1) };
  return null;
}

export function renderChatList(nav: ChatListNav, mode: "main" | "archive" = "main"): void {
  detach?.();
  const archive = mode === "archive";
  let query = "";

  const list = el("div", { class: "scroll" });
  const search = el("input", { type: "search", placeholder: archive ? "ابحث في الأرشيف" : "ابحث أو اكتب @يوزر أو لينك", class: "search" }) as HTMLInputElement;
  const statusEl = el("span", { class: "conn" });
  const topbar = el("div", { class: "topbar" }, [
    archive
      ? el("button", { class: "iconbtn", text: "‹", "aria-label": "رجوع", onclick: () => renderChatList(nav, "main") })
      : el("button", { class: "iconbtn", text: "⚙", "aria-label": "الإعدادات", onclick: nav.onOpenSettings }),
    el("div", { class: "title" }, [archive ? "📦 الأرشيف" : "المحادثات", statusEl]),
    archive ? el("span") : el("button", { class: "iconbtn", text: "✏️", "aria-label": "جديد", onclick: (e: MouseEvent) => openNewMenu(e) }),
  ]);
  const tabs = el("div", { class: "tabs", role: "tablist" });
  const showTabs = !archive && (isOn("folderTabs") || isOn("telegramFolders"));
  const screen = el("div", { class: "screen" }, [topbar, el("div", { class: "searchbar" }, [search]), ...(showTabs ? [tabs] : []), list]);
  mount(screen);

  const cache = () => (archive ? archiveCache : mainCache);
  const paintConn = () => (statusEl.textContent = tg.state === "connected" ? "" : " · بيتصل...");
  paintConn();

  function openNewMenu(e: MouseEvent) {
    openMenu(e.clientX, e.clientY + 20, [
      { label: "👤 محادثة جديدة", run: () => nav.onNew("contacts") },
      { label: "👥 جروب جديد", run: () => nav.onNew("group") },
      { label: "📢 قناة جديدة", run: () => nav.onNew("channel") },
      { label: "🔗 دخول بلينك أو يوزرنيم", run: () => nav.onNew("link") },
    ]);
  }

  // ---------------- Tabs ----------------
  function tabDefs(): { id: string; label: string; match: (d: Dialog) => boolean }[] {
    const defs: { id: string; label: string; match: (d: Dialog) => boolean }[] = [];
    if (isOn("folderTabs")) {
      for (const b of BUILT_INS) defs.push({ id: b.id, label: b.label, match: (d) => b.id === "all" || folderOf(d) === b.id });
    } else defs.push({ id: "all", label: "الكل", match: () => true });
    if (isOn("telegramFolders")) {
      for (const f of folders) defs.push({ id: "f:" + f.id, label: (f.emoticon ? f.emoticon + " " : "") + folderTitle(f), match: (d) => inFolder(d, f) });
    }
    return defs;
  }
  function currentMatch(): (d: Dialog) => boolean {
    if (archive) return () => true;
    return tabDefs().find((t) => t.id === currentTab)?.match ?? (() => true);
  }
  function paintTabs() {
    if (!showTabs) return;
    const defs = tabDefs();
    if (!defs.some((d) => d.id === currentTab)) currentTab = "all";
    const pool = folders.length ? [...mainCache, ...archiveCache] : mainCache;
    tabs.replaceChildren(
      ...defs.map((t) => {
        const unread = pool.filter((d) => t.match(d) && (!d.archived || t.id.startsWith("f:")) && ((d.unreadCount ?? 0) > 0 || hasUnreadMark(d)) && !isMuted(d)).length;
        return el(
          "button",
          {
            class: "tab" + (currentTab === t.id ? " active" : ""),
            role: "tab",
            "aria-selected": String(currentTab === t.id),
            onclick: () => {
              currentTab = t.id;
              localStorage.setItem(K_TAB, t.id);
              paintTabs();
              paint();
              list.scrollTop = 0;
            },
          },
          [t.label, ...(unread ? [el("span", { class: "tab-count", text: String(unread) })] : [])],
        );
      }),
    );
  }

  // ---------------- Rows ----------------
  function lastLine(d: Dialog): (Node | string)[] {
    const draft = d.dialog?.draft?.message;
    if (draft) return [el("span", { class: "draft", text: "مسودة: " }), draft];
    const m: any = d.message;
    if (!m) return [""];
    let prefix = "";
    if (m.out) prefix = "أنت: ";
    else if (d.isGroup && m.sender) prefix = (displayName(m.sender).split(" ")[0] || "") + ": ";
    if (m instanceof Api.MessageService) return [el("span", { class: "svc", text: "رسالة نظام" })];
    return [prefix ? el("span", { class: "prefix", text: prefix }) : "", snippetOf(m)];
  }

  function row(d: Dialog): HTMLElement {
    const ent: any = d.entity;
    const name = displayName(ent) || d.title || d.name || "بدون اسم";
    const muted = isMuted(d);
    const unread = d.unreadCount ?? 0;
    const right: (Node | string)[] = [];
    const mentions = d.dialog?.unreadMentionsCount ?? 0;
    if (mentions) right.push(el("span", { class: "badge mention-badge", text: "@" }));
    if (unread > 0) right.push(el("span", { class: "badge" + (muted ? " muted" : ""), text: unread > 999 ? Math.floor(unread / 1000) + "K" : String(unread) }));
    else if (hasUnreadMark(d)) right.push(el("span", { class: "badge" + (muted ? " muted" : ""), text: " " }));
    else if (d.pinned) right.push(el("span", { class: "pin", text: "📌" }));
    const m: any = d.message;
    const ticks = m?.out ? el("span", { class: "list-ticks", text: (m.id <= (d.dialog?.readOutboxMaxId ?? 0)) ? "✓✓" : "✓" }) : null;

    const node = el("div", { class: "chat-row" + (d.pinned ? " pinned" : ""), onclick: () => nav.onOpenChat(d) }, [
      avatarEl(ent, 52, name),
      el("div", { class: "chat-meta" }, [
        el("div", { class: "chat-top" }, [
          el("div", { class: "chat-name" }, [name, ...premiumStar(ent), ...(muted ? [el("span", { class: "muted-icon", text: " 🔇" })] : [])]),
          el("div", { class: "chat-time" }, [...(ticks ? [ticks] : []), d.date ? fmtTime(d.date) : ""]),
        ]),
        el("div", { class: "chat-top" }, [el("div", { class: "chat-last" }, lastLine(d)), ...right]),
      ]),
    ]);
    attachLongPress(node, (x, y) => rowMenu(d, x, y));
    return node;
  }

  async function act(fn: () => Promise<unknown>, ok: string) {
    try {
      await fn();
      toast(ok);
      await load();
    } catch (e: any) {
      toast("تعذّر: " + (e?.errorMessage || e?.message || ""));
    }
  }

  function rowMenu(d: Dialog, x: number, y: number) {
    const ent: any = d.entity;
    const muted = isMuted(d);
    const unread = (d.unreadCount ?? 0) > 0 || hasUnreadMark(d);
    const items: { label: string; run: () => unknown }[] = [
      { label: d.pinned ? "📌 إلغاء التثبيت" : "📌 تثبيت", run: () => void act(() => tg.setPinned(ent, !d.pinned), d.pinned ? "اتلغى التثبيت" : "اتثبّتت") },
      {
        label: muted ? "🔔 إلغاء الكتم" : "🔇 كتم",
        run: async () => {
          if (muted) return void act(() => tg.setMuteUntil(ent, 0), "اتلغى الكتم");
          const c = await askChoice("كتم الإشعارات", [
            { label: "ساعة", value: "3600" },
            { label: "8 ساعات", value: "28800" },
            { label: "يومين", value: "172800" },
            { label: "للأبد", value: "forever" },
          ]);
          if (!c) return;
          const until = c === "forever" ? 2147483647 : Math.floor(Date.now() / 1000) + Number(c);
          void act(() => tg.setMuteUntil(ent, until), "اتكتمت 🔇");
        },
      },
      { label: d.archived || archive ? "📤 إخراج من الأرشيف" : "📦 أرشفة", run: () => void act(() => tg.setArchived(ent, !(d.archived || archive)), d.archived || archive ? "خرجت من الأرشيف" : "اتأرشفت") },
      { label: unread ? "✓ تعليم كمقروء" : "● تعليم كغير مقروء", run: () => void act(() => tg.setUnreadMark(ent, !unread), "تمام") },
    ];
    if (ent instanceof Api.User && !ent.self) {
      items.push({
        label: "🗑 مسح المحادثة",
        run: async () => {
          const c = await askChoice(`مسح المحادثة مع ${displayName(ent)}؟`, [
            { label: "مسح عندي بس", value: "me" },
            { label: "مسح عندي وعنده", value: "all" },
          ]);
          if (c) void act(() => tg.deleteChat(ent, { revoke: c === "all" }), "اتمسحت");
        },
      });
      if (!ent.bot) items.push({ label: "🚫 حظر", run: async () => (await askChoice(`حظر ${displayName(ent)}؟`, [{ label: "حظر", value: "y", danger: true }])) && void act(() => tg.setBlocked(ent, true), "اتحظر") });
      else items.push({ label: "🛑 إيقاف البوت", run: async () => (await askChoice("إيقاف البوت ومسح المحادثة؟", [{ label: "إيقاف", value: "y", danger: true }])) && void act(async () => { await tg.setBlocked(ent, true); await tg.deleteChat(ent); }, "البوت وقف") });
    } else if (ent instanceof Api.Channel || ent instanceof Api.Chat) {
      items.push({
        label: ent instanceof Api.Channel && ent.broadcast ? "🚪 مغادرة القناة" : "🚪 الخروج من الجروب",
        run: async () => (await askChoice(`الخروج من ${displayName(ent)}؟`, [{ label: "خروج", value: "y", danger: true }])) && void act(() => tg.leave(ent), "خرجت"),
      });
    }
    openMenu(x, y, items.map((i) => ({ ...i, run: () => void i.run() })));
  }

  // ---------------- Paint ----------------
  function paint() {
    if (query) return void paintSearch();
    list.replaceChildren();
    const frag = document.createDocumentFragment();
    if (!archive && strip && currentTab === "all" && isOn("stories")) frag.append(strip);
    if (!archive && archiveCache.length && currentTab === "all") {
      const unread = archiveCache.filter((d) => (d.unreadCount ?? 0) > 0).length;
      frag.append(
        el("div", { class: "chat-row archive-row", onclick: () => renderChatList(nav, "archive") }, [
          el("div", { class: "avatar", style: { width: "52px", height: "52px", background: "var(--surface-2)", fontSize: "22px" }, text: "📦" }),
          el("div", { class: "chat-meta" }, [
            el("div", { class: "chat-name", text: "الأرشيف" }),
            el("div", { class: "chat-last", text: archiveCache.slice(0, 4).map((d) => displayName(d.entity) || d.title).join("، ") }),
          ]),
          ...(unread ? [el("span", { class: "badge muted", text: String(unread) })] : []),
        ]),
      );
    }
    const match = currentMatch();
    const pool = currentTab.startsWith("f:") ? [...mainCache, ...archiveCache] : cache();
    const items = pool.filter(match);
    for (const d of items) frag.append(row(d));
    if (!items.length) frag.append(el("div", { class: "center hint", text: archive ? "الأرشيف فاضي" : "مفيش محادثات هنا" }));
    list.append(frag);
  }

  let searchSeq = 0;
  async function paintSearch() {
    const seq = ++searchSeq;
    const q = query.toLowerCase();
    list.replaceChildren();
    const target = parseTarget(query);
    if (target) list.append(el("button", { class: "chat-row open-target", onclick: () => nav.onOpenPeer(target.target) }, [el("span", { class: "sc-icon", text: "🔗" }), el("b", { text: target.label })]));
    const local = [...mainCache, ...archiveCache].filter((d) => (displayName(d.entity) || d.title || "").toLowerCase().includes(q) || ((d.entity as any)?.username || "").toLowerCase().includes(q.replace(/^@/, "")));
    if (local.length) {
      list.append(el("div", { class: "section", text: "محادثاتك" }));
      for (const d of local.slice(0, 30)) list.append(row(d));
    }
    if (query.length < 2) return;
    const globalBox = el("div");
    const msgBox = el("div");
    list.append(globalBox, msgBox);
    try {
      const [peers, msgs] = await Promise.all([tg.searchPeers(query).catch(() => ({ mine: [], global: [] })), tg.searchMessages(query).catch(() => [])]);
      if (seq !== searchSeq) return;
      const known = new Set(local.map((d) => peerKey(d.entity)));
      const others = [...peers.mine, ...peers.global].filter((e) => !known.has(peerKey(e)));
      if (others.length) {
        globalBox.append(el("div", { class: "section", text: "نتايج عامة" }));
        for (const e of others) {
          const sub = e.username ? "@" + e.username : "";
          const count = e.participantsCount ? ` · ${e.participantsCount.toLocaleString("ar-EG")} ${e.broadcast ? "مشترك" : "عضو"}` : "";
          globalBox.append(
            el("div", { class: "chat-row", onclick: () => nav.onOpenChat(dialogFor(e)) }, [
              avatarEl(e, 46),
              el("div", { class: "chat-meta" }, [el("div", { class: "chat-name" }, [displayName(e), ...premiumStar(e)]), el("div", { class: "chat-last", text: sub + count })]),
            ]),
          );
        }
      }
      if (msgs.length) {
        msgBox.append(el("div", { class: "section", text: "رسائل" }));
        for (const r of msgs) {
          msgBox.append(
            el("div", { class: "chat-row", onclick: () => nav.onOpenChat(dialogFor(r.chat), r.msg.id) }, [
              avatarEl(r.chat, 46),
              el("div", { class: "chat-meta" }, [
                el("div", { class: "chat-top" }, [el("div", { class: "chat-name", text: displayName(r.chat) }), el("div", { class: "chat-time", text: fmtTime(r.msg.date) })]),
                el("div", { class: "chat-last", text: snippetOf(r.msg) }),
              ]),
            ]),
          );
        }
      }
      if (!local.length && !others.length && !msgs.length && !target) list.append(el("div", { class: "center hint", text: "مفيش نتايج" }));
    } catch {
      /* offline */
    }
  }

  let searchTimer: number | undefined;
  search.oninput = () => {
    query = search.value.trim();
    if (showTabs) tabs.style.display = query ? "none" : "";
    clearTimeout(searchTimer);
    searchTimer = window.setTimeout(paint, query ? 300 : 0);
  };

  // ---------------- Load ----------------
  async function load() {
    try {
      const [main, arch, fl] = await Promise.all([
        tg.getDialogs(200, false),
        tg.getDialogs(100, true).catch(() => []),
        isOn("telegramFolders") ? tg.getFolders().catch(() => []) : Promise.resolve([]),
      ]);
      mainCache = main as unknown as Dialog[];
      archiveCache = arch as unknown as Dialog[];
      folders = fl;
      paintTabs();
      if (!query) paint();
      if (!archive && isOn("stories")) {
        void storiesStrip().then((st) => {
          strip = st;
          if (!query && currentTab === "all") paint();
        });
      }
    } catch (e: any) {
      if (!cache().length) list.replaceChildren(el("div", { class: "center", text: "تعذّر تحميل المحادثات" }));
      toast(String(e?.errorMessage || e?.message || e));
    }
  }

  let timer: number | undefined;
  const offs = [
    tg.on("newMessage", () => {
      clearTimeout(timer);
      timer = window.setTimeout(load, 800);
    }),
    tg.on("connState", paintConn),
  ];
  detach = () => offs.forEach((o) => o());

  if (cache().length) {
    paintTabs();
    paint();
  } else list.append(el("div", { class: "center" }, [el("div", { class: "spinner" })]));
  void load();
}
