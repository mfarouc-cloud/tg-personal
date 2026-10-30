// Chat screen: header (status / typing / members), pinned bar, search,
// message list (history paging, date separators, service pills, albums),
// live updates, composer.
import { Api } from "teleproto";
import { el, mount, toast } from "../dom";
import { avatarEl } from "../avatar";
import { tg, peerKey } from "../../telegram/client";
import type { Dialog } from "../../telegram/types";
import { isOn } from "../../features/registry";
import { openForwardPicker } from "../forward";
import { premiumStar } from "../chatlist";
import { buildBubble, pill, dayLabel, snippetOf, myReactions, type Bubble, type BubbleCtx } from "./bubble";
import { serviceText, senderLabel } from "./special";
import { createComposer } from "./composer";
import { menuFor, openMenu, attachLongPress, askChoice, showAlert, copyText, translateInto } from "./menu";
import { safeUrl, parseTmeLink } from "./format";
import { dialogFor } from "../../telegram/entity";

export interface ChatNav {
  onBack: () => void;
  /** Open another chat by @username / numeric id / "+inviteHash". */
  onOpenPeer?: (target: string, postId?: number) => void;
  /** Tap on the header → chat info page. */
  onOpenInfo?: () => void;
  /** Re-open this chat (after joining). */
  onReopen?: () => void;
  /** Open a comments thread / forum topic. */
  onOpenThread?: (d: Dialog, thread: ThreadInfo) => void;
  /** Open the member-details page for a user. */
  onUserInsight?: (user: any) => void;
}

export interface ThreadInfo {
  topId: number;
  title: string;
  sub?: string;
}

type Item = { kind: "msg"; bubble: Bubble } | { kind: "svc"; node: HTMLElement; msg: Api.MessageService };

export function renderChat(dialog: Dialog, nav: ChatNav, opts: { jumpTo?: number; thread?: ThreadInfo } = {}): void {
  const entity: any = dialog.entity;
  const thread = opts.thread;
  const topId = thread?.topId;
  const name = thread?.title || dialog.title || dialog.name || senderLabel(entity) || "محادثة";
  const peer = (dialog.entity ?? dialog.inputEntity) as Api.TypeEntityLike;
  const myKey = peerKey(entity);
  const isBroadcast = !!(entity instanceof Api.Channel && entity.broadcast);
  const isGroup = !!dialog.isGroup || entity instanceof Api.Chat || !!(entity instanceof Api.Channel && entity.megagroup);
  const isBot = !!(entity instanceof Api.User && entity.bot);

  let readOutboxMaxId: number = (dialog as any).dialog?.readOutboxMaxId ?? 0;
  const items = new Map<number, Item>();
  const senders = new Map<string, any>();
  let oldestId = 0;
  let reachedStart = false;
  let loadingOlder = false;
  let detachedFromLatest = false; // true after jumping to an old message
  let newWhileAway = 0;

  // ---------- DOM ----------
  const msgList = el("div", { class: "messages" });
  const scroller = el("div", { class: "scroll chat-scroll" }, [msgList]);
  const fab = el("button", { class: "fab", "aria-label": "لآخر رسالة", style: { display: "none" } }, ["↓"]);
  const fabCount = el("span", { class: "fab-count" });
  fab.append(fabCount);
  const pinnedBar = el("button", { class: "pinned-bar", style: { display: "none" } });
  const subtitle = el("div", { class: "subtitle" });
  const titleEl = el("div", { class: "title" }, [name, ...premiumStar(entity)]);
  const avatar = avatarEl(entity, 38, name);
  const searchBtn = el("button", { class: "iconbtn", text: "🔍", "aria-label": "بحث في المحادثة" });
  const headInfo = el("button", { class: "head-info", "aria-label": "معلومات المحادثة", onclick: () => nav.onOpenInfo && (leaveListeners(), nav.onOpenInfo()) }, [
    avatar,
    el("div", { class: "chat-meta" }, [titleEl, subtitle]),
  ]);
  const topbar = el("div", { class: "topbar" }, [
    el("button", { class: "iconbtn", text: "‹", "aria-label": "رجوع", onclick: () => leave() }),
    headInfo,
    searchBtn,
  ]);

  const composer = createComposer(peer, {
    sendText: async (text, replyTo) => {
      const m = topId ? await tg.sendInThread(peer, text, topId, replyTo) : await tg.send(peer, text, replyTo);
      if (detachedFromLatest) await loadLatest();
      else addLive(m);
    },
    editText: async (m, text) => {
      const updated = await tg.editText(peer, m.id, text);
      const it = items.get(m.id);
      if (it?.kind === "msg" && updated) it.bubble.update(updated);
    },
    sendFiles: (files, caption, replyTo) => {
      files.forEach((f, i) => void uploadOne(f, i === 0 ? caption : "", replyTo));
    },
    sendVoice: async (blob, duration, waveform, replyTo) => {
      const pending = pendingBubble("🎤 رسالة صوتية", blob.size);
      try {
        const m = await tg.sendVoice(peer, blob, duration, waveform, replyTo ?? topId, topId);
        pending.node.remove();
        addLive(m);
      } catch (e) {
        pending.node.remove();
        throw e;
      }
    },
    senderOf: (m) => senderOfSync(m),
    openWebApp: (url) => void openWebApp(null, url, true),
  });

  const screen = el("div", { class: "screen" }, [topbar, pinnedBar, scroller, fab, composer.root]);
  mount(screen);
  {
    const reason = readOnlyReason();
    const e: any = entity;
    const canJoin = e instanceof Api.Channel && e.left;
    composer.setReadOnly(
      reason,
      canJoin
        ? {
            label: isBroadcast ? "📢 اشترك في القناة" : "👥 انضم للجروب",
            run: async () => {
              try {
                await tg.joinChannel(e);
                e.left = false;
                toast("انضميت ✓");
                composer.setReadOnly(readOnlyReason());
              } catch (err: any) {
                const m = String(err?.errorMessage || err?.message || "");
                toast(/INVITE_REQUEST_SENT/.test(m) ? "اتبعت طلب الانضمام ✓" : "تعذّر الانضمام: " + m);
              }
            },
          }
        : undefined,
    );
  }

  // ---------- Helpers ----------
  const atBottom = () => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 120;
  const scrollDown = (smooth = false) =>
    requestAnimationFrame(() => scroller.scrollTo({ top: scroller.scrollHeight, behavior: smooth ? "smooth" : "auto" }));

  function readOnlyReason(): string | null {
    const e: any = entity;
    if (e instanceof Api.Channel) {
      if (e.left) return isBroadcast ? "📢 انت مش مشترك في القناة دي" : "انت مش عضو في الجروب ده";
      if (isBroadcast && !(e.creator || e.adminRights?.postMessages)) return "📢 القناة دي للقراءة بس";
      if (!isBroadcast && !e.creator && !e.adminRights && (e.defaultBannedRights?.sendMessages || e.bannedRights?.sendMessages))
        return "🚫 مش مسموح بالكتابة في الجروب ده";
    }
    if (e instanceof Api.Chat && (e.left || e.deactivated)) return "انت مش عضو في الجروب ده";
    return null;
  }

  function senderOfSync(m: Api.Message): any {
    const any: any = m;
    if (any.sender) return any.sender;
    const key = peerKey(any.fromId ?? any.peerId);
    return senders.get(key);
  }
  function senderOf(m: Api.Message, fill: (e: any) => void): any {
    const known = senderOfSync(m);
    if (known) return known;
    const from = (m as any).fromId ?? (m as any).peerId;
    const key = peerKey(from);
    if (!key) return undefined;
    tg.getEntity(from)
      .then((e) => {
        senders.set(key, e);
        fill(e);
      })
      .catch(() => {});
    return undefined;
  }
  function fwdName(m: Api.Message, fill: (n: string) => void): string {
    const f: any = (m as any).fwdFrom;
    if (!f) return "";
    if (f.fromName) return f.fromName;
    if (!f.fromId) return "";
    const key = peerKey(f.fromId);
    const known = senders.get(key);
    if (known) return senderLabel(known);
    tg.getEntity(f.fromId)
      .then((e) => {
        senders.set(key, e);
        fill(senderLabel(e));
      })
      .catch(() => fill("مصدر مخفي"));
    return "";
  }

  // Batched fetch of replied-to messages that aren't loaded.
  const replyWaiters = new Map<number, ((m: Api.Message) => void)[]>();
  let replyTimer: number | undefined;
  function replyOf(id: number, fill: (m: Api.Message) => void): Api.Message | undefined {
    const it = items.get(id);
    if (it?.kind === "msg") return it.bubble.msg;
    const list = replyWaiters.get(id) ?? [];
    list.push(fill);
    replyWaiters.set(id, list);
    clearTimeout(replyTimer);
    replyTimer = window.setTimeout(async () => {
      const ids = [...replyWaiters.keys()];
      const waiters = new Map(replyWaiters);
      replyWaiters.clear();
      try {
        const res = await tg.getByIds(peer, ids);
        res.forEach((m, i) => {
          if (m && m instanceof Api.Message) waiters.get(ids[i])?.forEach((f) => f(m));
        });
      } catch {
        /* ignore */
      }
    }, 60);
    return undefined;
  }

  const bubbleCtx: BubbleCtx = {
    showSender: isGroup,
    showViews: isBroadcast,
    chatEntity: entity,
    readOutboxMaxId: () => readOutboxMaxId,
    senderOf,
    fwdName,
    replyOf,
    hooks: {
      onUsername: (u, postId) => {
        if (!nav.onOpenPeer) return false;
        nav.onOpenPeer(u, postId);
        return true;
      },
      onUserId: (id) => nav.onOpenPeer?.(id),
      onHashtag: (tag) => openSearch(tag),
      onVote: async (m, options) => {
        await tg.vote(peer, m.id, options);
        await refreshMsg(m.id);
      },
      onJump: (id) => void jumpTo(id),
      onReaction: (m, emoji) => void toggleReaction(m, emoji),
      onButton: (m, b) => void pressButton(m, b),
      onForward: (m) => openForwardPicker(m, dialog),
      onComments: isBroadcast && nav.onOpenThread ? (m) => void openComments(m) : undefined,
    },
  };

  async function openComments(m: Api.Message) {
    try {
      const { chat, topId: tid } = await tg.getDiscussion(entity, m.id);
      if (!chat) return toast("التعليقات مقفولة على البوست ده");
      leaveListeners();
      nav.onOpenThread!(dialogFor(chat), { topId: tid, title: "التعليقات", sub: name });
    } catch (e: any) {
      toast("تعذّر فتح التعليقات: " + (e?.errorMessage || e?.message || ""));
    }
  }

  // ---------- Rendering ----------
  function nodeFor(m: Api.TypeMessage): HTMLElement | null {
    if (m instanceof Api.MessageService) {
      const node = pill(serviceText(m, ""));
      const setActor = (e: any) => (node.firstElementChild!.textContent = serviceText(m, senderLabel(e)));
      const actor = senderOf(m as unknown as Api.Message, setActor);
      if (actor) setActor(actor);
      node.dataset.id = String(m.id);
      node.dataset.date = String(m.date);
      items.set(m.id, { kind: "svc", node, msg: m });
      if ((m.action as any)?.className === "MessageActionPinMessage") void refreshPinned();
      return node;
    }
    if (!(m instanceof Api.Message)) return null;
    const b = buildBubble(m, bubbleCtx);
    b.node.dataset.date = String(m.date);
    const gid = (m as any).groupedId;
    if (gid) b.node.dataset.group = String(gid);
    attachLongPress(b.node, (x, y) => openMsgMenu(b, x, y));
    items.set(m.id, { kind: "msg", bubble: b });
    return b.node;
  }

  /** Recompute date separators + album grouping classes over the whole list. */
  function relayout() {
    msgList.querySelectorAll(":scope > .pill.day").forEach((n) => n.remove());
    let lastDay = "";
    for (const node of Array.from(msgList.children) as HTMLElement[]) {
      const date = Number(node.dataset.date || 0);
      if (date) {
        const day = new Date(date * 1000).toDateString();
        if (day !== lastDay) {
          node.before(pill(dayLabel(date), "day"));
          lastDay = day;
        }
      }
    }
    // Albums: runs of consecutive bubbles sharing a groupedId look like one.
    const nodes = Array.from(msgList.children) as HTMLElement[];
    nodes.forEach((n) => n.classList.remove("grp-first", "grp-mid", "grp-last"));
    let i = 0;
    while (i < nodes.length) {
      const g = nodes[i].dataset.group;
      let j = i;
      while (g && j + 1 < nodes.length && nodes[j + 1].dataset.group === g) j++;
      if (j > i) {
        nodes[i].classList.add("grp-first");
        for (let k = i + 1; k < j; k++) nodes[k].classList.add("grp-mid");
        nodes[j].classList.add("grp-last");
      }
      i = j + 1;
    }
  }

  function renderBatch(msgs: Api.TypeMessage[], where: "append" | "prepend") {
    const frag = document.createDocumentFragment();
    const ordered = [...msgs].filter((m) => m && !items.has(m.id)).sort((a, b) => a.id - b.id);
    for (const m of ordered) {
      const n = nodeFor(m);
      if (n) frag.append(n);
    }
    if (where === "prepend") msgList.prepend(frag);
    else msgList.append(frag);
    const ids = [...items.keys()];
    oldestId = ids.length ? Math.min(...ids) : 0;
    relayout();
    syncReplyKeyboard();
  }

  function addLive(m: Api.TypeMessage) {
    if (!m || items.has(m.id)) return;
    const stick = atBottom() || (m as any).out;
    renderBatch([m], "append");
    if (stick) scrollDown(true);
    else {
      newWhileAway++;
      showFab();
    }
  }

  function syncReplyKeyboard() {
    if (!(isBot || isGroup)) return;
    const msgs = [...items.values()]
      .filter((i): i is { kind: "msg"; bubble: Bubble } => i.kind === "msg")
      .map((i) => i.bubble.msg)
      .filter((m) => !m.out && (m as any).replyMarkup)
      .sort((a, b) => b.id - a.id);
    const mk: any = msgs[0]?.replyMarkup;
    if (mk instanceof Api.ReplyKeyboardMarkup) composer.setReplyKeyboard(mk);
    else if (mk instanceof Api.ReplyKeyboardHide) composer.setReplyKeyboard(null);
  }

  function pendingBubble(label: string, size: number) {
    const bar = el("i");
    const pct = el("span", { text: "" });
    const node = el("div", { class: "bubble out uploading" }, [
      el("div", { class: "upload-row" }, [el("span", { text: "⬆ " + label }), el("span", { class: "file-size", text: size ? (size / 1048576).toFixed(1) + " MB" : "" }), pct]),
      el("div", { class: "progress" }, [bar]),
    ]);
    msgList.append(node);
    scrollDown(true);
    return {
      node,
      set: (r: number) => {
        bar.style.width = Math.round(r * 100) + "%";
        pct.textContent = Math.round(r * 100) + "%";
      },
    };
  }

  async function uploadOne(file: File, caption: string, replyTo?: number) {
    if (file.size > tg.maxUploadBytes) {
      toast(`${file.name} أكبر من المسموح`);
      return;
    }
    const ctrl = new AbortController();
    const p = pendingBubble(file.name, file.size);
    p.node.querySelector(".upload-row")!.append(
      el("button", { class: "media-save", text: "✕", "aria-label": "إلغاء", onclick: () => ctrl.abort() }),
    );
    try {
      const m = await tg.sendFile(peer, file, { caption: caption || undefined, signal: ctrl.signal, onProgress: p.set, replyTo: replyTo ?? topId, topMsgId: topId });
      p.node.remove();
      addLive(m);
    } catch (e: any) {
      p.node.remove();
      toast(ctrl.signal.aborted ? "اتلغى الرفع" : "تعذّر الإرسال: " + (e?.errorMessage || e?.message || ""));
    }
  }

  // ---------- Loading ----------
  async function loadLatest() {
    detachedFromLatest = false;
    newWhileAway = 0;
    items.clear();
    reachedStart = false;
    msgList.replaceChildren(el("div", { class: "center" }, [el("div", { class: "spinner" })]));
    try {
      const history = topId
        ? await tg.getThread(peer, topId, 50)
        : ((await tg.getHistory(peer, 50)) as unknown as Api.TypeMessage[]);
      msgList.replaceChildren();
      renderBatch(history, "append");
      if (history.length < 50) reachedStart = true;
      await ensureThreadRoot();
      await showSponsored();
      scrollDown();
      tg.markRead(peer).catch(() => {});
    } catch (e: any) {
      msgList.replaceChildren(el("div", { class: "center", text: "تعذّر تحميل الرسائل" }));
      toast(String(e?.errorMessage || e?.message || e));
    }
  }

  /** In a thread, the root post (channel post / topic start) sits on top. */
  async function ensureThreadRoot() {
    if (!topId || items.has(topId) || !reachedStart) return;
    try {
      const [root] = await tg.getByIds(peer, [topId]);
      if (root && !(root instanceof Api.MessageEmpty)) renderBatch([root], "prepend");
    } catch {
      /* ignore */
    }
  }

  async function loadOlder() {
    if (loadingOlder || reachedStart || !oldestId) return;
    loadingOlder = true;
    const spinner = el("div", { class: "center small" }, [el("div", { class: "spinner" })]);
    msgList.prepend(spinner);
    try {
      const older = topId ? await tg.getThread(peer, topId, 40, oldestId) : await tg.getOlder(peer, oldestId, 40);
      spinner.remove();
      if (older.length === 0) {
        reachedStart = true;
        await ensureThreadRoot();
        return;
      }
      const before = scroller.scrollHeight;
      renderBatch(older, "prepend");
      scroller.scrollTop += scroller.scrollHeight - before;
      if (older.length < 40) {
        reachedStart = true;
        await ensureThreadRoot();
      }
    } catch {
      spinner.remove();
    } finally {
      loadingOlder = false;
    }
  }

  async function jumpTo(id: number) {
    let it = items.get(id);
    if (!it) {
      try {
        const around = await tg.getAround(peer, id, 40);
        if (!around.some((m) => m?.id === id)) return toast("الرسالة دي مش موجودة");
        items.clear();
        msgList.replaceChildren();
        reachedStart = false;
        detachedFromLatest = true;
        renderBatch(around, "append");
        showFab();
        it = items.get(id);
      } catch {
        return toast("تعذّر فتح الرسالة");
      }
    }
    const node = it?.kind === "msg" ? it.bubble.node : it?.node;
    if (!node) return;
    node.scrollIntoView({ block: "center", behavior: "smooth" });
    node.classList.add("flash");
    setTimeout(() => node.classList.remove("flash"), 1400);
  }

  async function refreshMsg(id: number) {
    try {
      const [m] = await tg.getByIds(peer, [id]);
      const it = items.get(id);
      if (m instanceof Api.Message && it?.kind === "msg") it.bubble.update(m);
    } catch {
      /* ignore */
    }
  }

  // ---------- Scroll / FAB ----------
  function showFab() {
    fab.style.display = "";
    fabCount.textContent = newWhileAway ? String(newWhileAway) : "";
  }
  scroller.addEventListener("scroll", () => {
    if (scroller.scrollTop < 400) void loadOlder();
    if (atBottom() && !detachedFromLatest) {
      fab.style.display = "none";
      newWhileAway = 0;
    } else if (!atBottom()) showFab();
  }, { passive: true });
  fab.onclick = () => {
    if (detachedFromLatest) void loadLatest();
    else scrollDown(true);
    fab.style.display = "none";
    newWhileAway = 0;
  };

  // ---------- Pinned bar ----------
  let pinnedId = 0;
  async function refreshPinned() {
    try {
      const p = await tg.getPinned(peer);
      pinnedId = p?.id ?? 0;
      if (!p) {
        pinnedBar.style.display = "none";
        return;
      }
      pinnedBar.replaceChildren(el("span", { class: "pin-icon", text: "📌" }), el("div", { class: "ctx-text" }, [el("b", { text: "رسالة مثبّتة" }), el("span", { text: snippetOf(p) })]));
      pinnedBar.style.display = "";
    } catch {
      pinnedBar.style.display = "none";
    }
  }
  pinnedBar.onclick = () => pinnedId && void jumpTo(pinnedId);

  // ---------- Header: status / members / typing ----------
  let baseSubtitle = "";
  function statusText(s: any): string {
    if (!s) return "";
    if (s instanceof Api.UserStatusOnline) return "متصل الآن";
    if (s instanceof Api.UserStatusOffline) {
      const d = new Date(s.wasOnline * 1000);
      const today = d.toDateString() === new Date().toDateString();
      return "آخر ظهور " + (today ? "النهارده " : d.toLocaleDateString("ar-EG", { day: "numeric", month: "short" }) + " ") + d.toLocaleTimeString("ar-EG", { hour: "2-digit", minute: "2-digit" });
    }
    if (s instanceof Api.UserStatusRecently) return "آخر ظهور من قريب";
    if (s instanceof Api.UserStatusLastWeek) return "آخر ظهور الأسبوع ده";
    if (s instanceof Api.UserStatusLastMonth) return "آخر ظهور الشهر ده";
    return "";
  }
  async function paintSubtitle() {
    if (thread) {
      baseSubtitle = thread.sub || senderLabel(entity);
      if (!typingNames.size) subtitle.textContent = baseSubtitle;
      return;
    }
    if (entity instanceof Api.User) {
      baseSubtitle = entity.bot ? "بوت" : entity.self ? "" : statusText(entity.status);
    } else {
      try {
        const n = await tg.getMemberCount(entity);
        baseSubtitle = n != null ? `${n.toLocaleString("ar-EG")} ${isBroadcast ? "مشترك" : "عضو"}` : "";
      } catch {
        baseSubtitle = "";
      }
    }
    if (!typingNames.size) subtitle.textContent = baseSubtitle;
  }
  const typingNames = new Map<string, { label: string; until: number }>();
  let typingTimer: number | undefined;
  function paintTyping() {
    const now = Date.now();
    for (const [k, v] of typingNames) if (v.until < now) typingNames.delete(k);
    if (!typingNames.size) {
      subtitle.textContent = baseSubtitle;
      subtitle.classList.remove("typing");
      return;
    }
    const [first] = typingNames.values();
    subtitle.textContent = first.label;
    subtitle.classList.add("typing");
    clearTimeout(typingTimer);
    typingTimer = window.setTimeout(paintTyping, 1500);
  }

  // ---------- Actions ----------
  async function toggleReaction(m: Api.Message, emoji: string) {
    const mine = myReactions(m);
    const next = mine.includes(emoji) ? mine.filter((e) => e !== emoji) : tg.isPremium ? [...mine, emoji].slice(-3) : [emoji];
    try {
      await tg.react(peer, m.id, next);
      await refreshMsg(m.id);
    } catch (e: any) {
      const msg = String(e?.errorMessage || e?.message || "");
      toast(/REACTION_INVALID/.test(msg) ? "الرياكشن ده مش مسموح هنا" : "تعذّر: " + msg);
    }
  }

  /** Inline keyboard (layer 232: KeyboardInlineButton { text, type }). */
  async function pressButton(m: Api.Message, b: any) {
    const t = b.type;
    try {
      if (t instanceof Api.InlineButtonTypeCallback) {
        const ans = await tg.pressButton(peer, m.id, t.data);
        if (ans.url) openUrl(ans.url);
        else if (ans.message) ans.alert ? showAlert(ans.message) : toast(ans.message);
        return;
      }
      if (t instanceof Api.InlineButtonTypeUrl || t instanceof Api.InlineButtonTypeUrlAuth) return openUrl(t.url);
      if (t instanceof Api.InlineButtonTypeCopy) return void copyText(t.copyText);
      if (t instanceof Api.InlineButtonTypeWebView) return void openWebApp(m, t.url, false);
      if (t instanceof Api.InlineButtonTypeSwitchInline) return toast(`اكتب @البوت ${t.query} في أي محادثة`);
      if (t instanceof Api.InlineButtonTypeUserProfile) return nav.onOpenPeer?.(String(t.userId));
      if (t instanceof Api.InlineButtonTypeDisabled) return;
      toast("الزرار ده مش مدعوم لسه");
    } catch (e: any) {
      toast("تعذّر: " + (e?.errorMessage || e?.message || ""));
    }
  }

  /** Bot mini apps need a signed URL from Telegram (initData); fall back to the raw URL. */
  async function openWebApp(m: Api.Message | null, url: string, simple: boolean) {
    try {
      const bot = m ? ((m as any).sender ?? (await tg.getEntity((m as any).viaBotId ?? (m as any).fromId ?? peer))) : entity;
      const botInput = await tg.raw.getInputEntity(bot);
      const res: any = simple
        ? await tg.raw.invoke(new Api.messages.RequestSimpleWebView({ bot: botInput as any, url, platform: "ios" } as any))
        : await tg.raw.invoke(new Api.messages.RequestWebView({ peer: (await tg.raw.getInputEntity(peer)) as any, bot: botInput as any, url, platform: "ios" } as any));
      openUrl(res.url);
    } catch {
      openUrl(url);
    }
  }

  function openUrl(raw: string) {
    const url = safeUrl(raw);
    if (!url) return;
    const inv = url.match(/(?:t\.me|telegram\.me)\/(?:\+|joinchat\/)([\w-]{8,})/i);
    if (inv && nav.onOpenPeer) return nav.onOpenPeer("+" + inv[1]);
    const t = parseTmeLink(url);
    if (t && nav.onOpenPeer) return nav.onOpenPeer(t.username, t.postId);
    window.open(url, "_blank", "noopener,noreferrer");
  }

  const selfDeleted = new Set<number>();
  async function deleteMsg(m: Api.Message) {
    const canRevoke = m.out || isBroadcast || !!(entity as any)?.adminRights || !!(entity as any)?.creator;
    const isPrivate = entity instanceof Api.User;
    const opts = isBroadcast || !isPrivate && !(entity instanceof Api.Chat)
      ? [{ label: "مسح الرسالة", value: "all", danger: true }]
      : [
          { label: "مسح عندي بس", value: "me", danger: true },
          ...(canRevoke ? [{ label: isPrivate ? `مسح عندي وعند ${name}` : "مسح عند الكل", value: "all", danger: true }] : []),
        ];
    const choice = await askChoice("مسح الرسالة؟", opts);
    if (!choice) return;
    try {
      selfDeleted.add(m.id);
      await tg.deleteMsgs(peer, [m.id], choice === "all");
      const it = items.get(m.id);
      (it?.kind === "msg" ? it.bubble.node : it?.node)?.remove();
      items.delete(m.id);
      relayout();
    } catch (e: any) {
      selfDeleted.delete(m.id);
      toast("تعذّر المسح: " + (e?.errorMessage || e?.message || ""));
    }
  }

  async function pinToggle(m: Api.Message) {
    const unpin = !!(m as any).pinned;
    try {
      await tg.pin(peer, m.id, unpin);
      await refreshMsg(m.id);
      await refreshPinned();
      toast(unpin ? "اتلغى التثبيت" : "اتثبّتت 📌");
    } catch (e: any) {
      toast("تعذّر التثبيت: " + (e?.errorMessage || e?.message || ""));
    }
  }

  function openMsgMenu(b: Bubble, x: number, y: number) {
    const m = b.msg;
    const { items: list } = menuFor(m, {
      chatEntity: entity,
      peer,
      canWrite: !readOnlyReason(),
      isBroadcast,
      onReply: (mm) => composer.setReply(mm),
      onEdit: (mm) => composer.setEdit(mm),
      onDelete: (mm) => void deleteMsg(mm),
      onPinToggle: (mm) => void pinToggle(mm),
      onForward: (mm) => openForwardPicker(mm, dialog),
      onReaction: (mm, e) => void toggleReaction(mm, e),
      onTranslate: (mm) => void translateInto(b.body, mm, peer),
      onSenderInfo: nav.onUserInsight
        ? async (mm) => {
            let s: any = entity instanceof Api.User ? entity : await (mm as any).getSender?.().catch(() => undefined);
            if (!(s instanceof Api.User)) return toast("مش قادر أوصل لبيانات المرسل");
            leaveListeners();
            nav.onUserInsight!(s);
          }
        : undefined,
    });
    openMenu(x, y, list, { onPick: (e) => void toggleReaction(m, e), mine: myReactions(m) });
  }

  // ---------- Search in chat ----------
  function openSearch(initial = "") {
    const input = el("input", { type: "search", class: "search", placeholder: "ابحث في المحادثة", value: initial }) as HTMLInputElement;
    const results = el("div", { class: "search-results" });
    const bar = el("div", { class: "topbar search-top" }, [
      el("button", { class: "iconbtn", text: "‹", "aria-label": "قفل البحث", onclick: () => close() }),
      input,
    ]);
    const panel = el("div", { class: "search-panel" }, [bar, results]);
    screen.append(panel);
    const close = () => panel.remove();
    let t: number | undefined;
    const run = async () => {
      const q = input.value.trim();
      if (!q) return results.replaceChildren();
      results.replaceChildren(el("div", { class: "center small" }, [el("div", { class: "spinner" })]));
      try {
        const res = await tg.searchInChat(peer, q);
        results.replaceChildren(el("div", { class: "section", text: res.length ? `${res.length} نتيجة` : "مفيش نتايج" }));
        for (const m of res) {
          const who = m.out ? "أنت" : senderLabel(senderOfSync(m)) || "";
          results.append(
            el("button", {
              class: "search-hit",
              onclick: () => {
                close();
                void jumpTo(m.id);
              },
            }, [el("b", { text: who }), el("span", { text: snippetOf(m) }), el("span", { class: "hint", text: dayLabel(m.date) })]),
          );
        }
      } catch {
        results.replaceChildren(el("div", { class: "center", text: "تعذّر البحث" }));
      }
    };
    input.oninput = () => {
      clearTimeout(t);
      t = window.setTimeout(run, 350);
    };
    input.focus();
    if (initial) void run();
  }
  searchBtn.onclick = () => openSearch();

  // ---------- Sponsored (when hiding ads is off) ----------
  async function showSponsored() {
    if (isOn("hideSponsored") || !isBroadcast) return;
    const ads = await tg.getSponsored(peer);
    for (const ad of ads) {
      const body = el("div", { class: "body" }, [el("span", { class: "tag ad", text: "إعلان" + (ad.title ? " · " + ad.title : "") }), el("div", { class: "text", text: ad.message || "" })]);
      const url = ad.url ? safeUrl(ad.url) : null;
      if (url) body.append(el("a", { class: "link", href: url, target: "_blank", rel: "noopener noreferrer", text: ad.buttonText || "فتح" }));
      msgList.append(el("div", { class: "bubble in sponsored" }, [body]));
    }
  }

  // ---------- Live updates ----------
  const inThread = (m: any) => {
    if (!topId) return true;
    const rt = m.replyTo;
    return m.id === topId || rt?.replyToTopId === topId || rt?.replyToMsgId === topId;
  };
  const sameChat = (m: any) => peerKey(m.peerId) === myKey && inThread(m);
  const offs = [
    tg.on("newMessage", ({ message }) => {
      if (!sameChat(message)) return;
      if (detachedFromLatest) {
        newWhileAway++;
        showFab();
        return;
      }
      addLive(message);
      if (!message.out) tg.markRead(peer).catch(() => {});
    }),
    tg.on("editedMessage", ({ message }) => {
      if (!sameChat(message)) return;
      const it = items.get(message.id);
      if (it?.kind !== "msg") return;
      const old = it.bubble.msg.message || "";
      if (isOn("antiEdit") && old && old !== message.message && !it.bubble.body.querySelector(`.tag.edited[data-old="${CSS.escape(old)}"]`)) {
        it.bubble.body.prepend(el("span", { class: "tag edited", "data-old": old, text: `✎ الأصل: ${old}` }));
      }
      it.bubble.update(message);
    }),
    tg.on("deletedMessages", ({ chatId, ids }) => {
      // Channel/supergroup deletes name the channel. Private & basic-group
      // deletes carry account-wide ids only — those can't belong to a channel.
      if (chatId ? chatId !== myKey : entity instanceof Api.Channel) return;
      for (const id of ids) {
        if (selfDeleted.delete(id)) continue;
        const it = items.get(id);
        if (!it) continue;
        const node = it.kind === "msg" ? it.bubble.node : it.node;
        if (isOn("antiDelete") && it.kind === "msg") {
          node.classList.add("deleted");
          if (!it.bubble.body.querySelector(".tag.del")) it.bubble.body.prepend(el("span", { class: "tag del", text: "🗑 اتمسحت" }));
        } else {
          node.remove();
          items.delete(id);
        }
      }
    }),
    tg.on("readOutbox", ({ peerKey: k, maxId }) => {
      if (k !== myKey || maxId <= readOutboxMaxId) return;
      readOutboxMaxId = maxId;
      for (const it of items.values()) if (it.kind === "msg" && it.bubble.msg.out) it.bubble.setRead(it.bubble.msg.id <= maxId);
    }),
    tg.on("typing", ({ peerKey: k, userId, action }) => {
      if (k !== myKey) return;
      if (action === "SendMessageCancelAction") typingNames.delete(userId);
      else {
        const verb = /Record(Audio|Round)/.test(action) ? "بيسجّل" : /Upload/.test(action) ? "بيبعت ملف" : "بيكتب";
        let label = verb + "...";
        if (isGroup) {
          const e = senders.get(userId);
          if (e) label = `${senderLabel(e)} ${label}`;
          else
            tg.getEntity(userId)
              .then((x) => senders.set(userId, x))
              .catch(() => {});
        }
        typingNames.set(userId, { label, until: Date.now() + 6000 });
      }
      paintTyping();
    }),
    tg.on("userStatus", ({ userId, status }) => {
      if (!(entity instanceof Api.User) || String(entity.id) !== userId) return;
      (entity as any).status = status;
      baseSubtitle = statusText(status);
      if (!typingNames.size) subtitle.textContent = baseSubtitle;
    }),
    tg.on("reactions", ({ peerKey: k, msgId, reactions }) => {
      if (k !== myKey) return;
      const it = items.get(msgId);
      if (it?.kind !== "msg") return;
      (it.bubble.msg as any).reactions = reactions;
      it.bubble.update(it.bubble.msg);
    }),
  ];

  function leaveListeners() {
    offs.forEach((off) => off());
  }
  function leave() {
    leaveListeners();
    nav.onBack();
  }

  // ---------- Start ----------
  void paintSubtitle();
  if (!thread) void refreshPinned();
  if (opts.jumpTo) {
    void loadLatest().then(() => jumpTo(opts.jumpTo!));
  } else void loadLatest();
}
