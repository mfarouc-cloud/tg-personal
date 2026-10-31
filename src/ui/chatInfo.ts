// Chat info page: big avatar, name, status/members, username, phone, bio,
// invite link, actions (mute, leave, block, clear) and shared content tabs
// (media, files, links, voice, members).
import { Api } from "teleproto";
import { isOn } from "../features/registry";
import { el, mount, toast, fmtTime } from "./dom";
import { tg } from "../telegram/client";
import type { Dialog } from "../telegram/types";
import { displayName, dialogFor, isMuted } from "../telegram/entity";
import { avatarEl } from "./avatar";
import { premiumStar } from "./chatlist";
import { askChoice, copyText } from "./chat/menu";
import { describeMedia, loadMedia, saveBlob, fmtSize, fmtDuration, canSave, saveMany } from "../features/media";
import { openGallery } from "../features/galleryViewer";
import { openForwardPicker } from "./forward";
import { renderText, safeUrl } from "./chat/format";

export interface InfoNav {
  onBack: () => void;
  onOpenChat: (d: Dialog, jumpTo?: number) => void;
  /** Batch 3 hook: admin tools for a member. */
  onMemberMenu?: (user: any, participant: any, x: number, y: number) => void;
  /** Batch 3 hook: group/channel admin settings. */
  onManage?: () => void;
  /** Member details page. */
  onUserInsight?: (user: any) => void;
}

type Tab = "media" | "files" | "links" | "voice" | "members";

export function renderChatInfo(dialog: Dialog, nav: InfoNav): void {
  const entity: any = dialog.entity;
  const isUser = entity instanceof Api.User;
  const isBroadcast = entity instanceof Api.Channel && !!entity.broadcast;
  const isGroupish = entity instanceof Api.Chat || (entity instanceof Api.Channel && !!entity.megagroup);
  const canManage = !isUser && !!(entity.creator || entity.adminRights);

  const body = el("div", { class: "scroll" });
  mount(
    el("div", { class: "screen" }, [
      el("div", { class: "topbar" }, [
        el("button", { class: "iconbtn", text: "‹", "aria-label": "رجوع", onclick: nav.onBack }),
        el("div", { class: "title", text: isUser ? "معلومات" : isBroadcast ? "معلومات القناة" : "معلومات الجروب" }),
        canManage && nav.onManage ? el("button", { class: "iconbtn", text: "✎", "aria-label": "إدارة", onclick: nav.onManage }) : el("span"),
      ]),
      body,
    ]),
  );

  // ---- Header ----
  const sub = el("div", { class: "hint" });
  const big = avatarEl(entity, 96);
  big.classList.add("big");
  body.append(
    el("div", { class: "info-head" }, [
      big,
      el("h2", {}, [displayName(entity) || dialog.title || "", ...premiumStar(entity), ...(entity.verified ? [el("span", { class: "verified", text: " ✔" })] : [])]),
      sub,
      ...(entity.scam || entity.fake ? [el("span", { class: "warn", text: entity.scam ? "⚠️ متبلّغ عنه كنصب" : "⚠️ حساب مزيف" })] : []),
    ]),
  );

  // ---- Info rows ----
  const rows = el("div", { class: "info-rows" });
  body.append(rows);
  const infoRow = (label: string, value: string | Node, onCopy?: string) =>
    el("div", { class: "row" + (onCopy ? " nav" : ""), onclick: onCopy ? () => void copyText(onCopy) : null }, [
      el("div", { class: "text" }, [el("div", { class: "label" }, [value]), el("div", { class: "desc", text: label })]),
    ]);
  if (entity.username) rows.append(infoRow("اسم المستخدم — دوس للنسخ", "@" + entity.username, `https://t.me/${entity.username}`));
  if (isUser && entity.phone) rows.append(infoRow("الموبايل", "+" + entity.phone, "+" + entity.phone));

  // ---- Actions ----
  const actions = el("div", { class: "info-actions" });
  body.append(actions);
  const action = (icon: string, label: string, run: () => void, danger = false) =>
    actions.append(el("button", { class: "info-act" + (danger ? " danger" : ""), onclick: run }, [el("span", { class: "ia-icon", text: icon }), el("span", { text: label })]));

  const muted = isMuted(dialog);
  action(muted ? "🔔" : "🔇", muted ? "إلغاء الكتم" : "كتم", async () => {
    try {
      await tg.setMuteUntil(entity, muted ? 0 : 2147483647);
      toast(muted ? "اتلغى الكتم" : "اتكتمت");
    } catch (e: any) {
      toast("تعذّر: " + (e?.errorMessage || e?.message || ""));
    }
  });
  if (!isUser) {
    action("🚪", isBroadcast ? "مغادرة" : "خروج", async () => {
      if (!(await askChoice(`الخروج من ${displayName(entity)}؟`, [{ label: "خروج", value: "y", danger: true }]))) return;
      try {
        await tg.leave(entity);
        toast("خرجت");
        nav.onBack();
      } catch (e: any) {
        toast("تعذّر: " + (e?.errorMessage || e?.message || ""));
      }
    }, true);
  } else if (!entity.self) {
    if (nav.onUserInsight && isOn("userInsight")) action("🔎", "تفاصيل", () => nav.onUserInsight!(entity));
    action("🗑", "مسح السجل", async () => {
      if (!(await askChoice("مسح كل الرسايل عندك؟", [{ label: "مسح", value: "y", danger: true }]))) return;
      await tg.deleteChat(entity, { justClear: true }).then(() => toast("اتمسح"), () => toast("تعذّر"));
    }, true);
  }

  // ---- Async details (bio, counts, invite, blocked) ----
  tg.getFull(entity)
    .then((f) => {
      if (isUser) {
        sub.textContent = entity.bot ? "بوت" : f.commonChats ? `${f.commonChats} جروب مشترك` : "";
        if (!entity.self && !entity.bot) {
          action(f.blocked ? "✅" : "🚫", f.blocked ? "إلغاء الحظر" : "حظر", async () => {
            try {
              await tg.setBlocked(entity, !f.blocked);
              toast(f.blocked ? "اتلغى الحظر" : "اتحظر");
              renderChatInfo(dialog, nav);
            } catch (e: any) {
              toast("تعذّر: " + (e?.errorMessage || e?.message || ""));
            }
          }, !f.blocked);
        }
      } else {
        const parts = [f.members != null ? `${f.members.toLocaleString("ar-EG")} ${isBroadcast ? "مشترك" : "عضو"}` : "", f.online ? `${f.online.toLocaleString("ar-EG")} متصل` : ""];
        sub.textContent = parts.filter(Boolean).join(" · ");
      }
      if (f.about) {
        const t = el("div", { class: "label about", dir: "auto" });
        t.append(renderText(f.about, autoLinks(f.about)));
        rows.prepend(el("div", { class: "row" }, [el("div", { class: "text" }, [t, el("div", { class: "desc", text: isUser ? "نبذة" : "الوصف" })])]));
      }
      if (f.invite) rows.append(infoRow("لينك الدعوة — دوس للنسخ", f.invite, f.invite));
    })
    .catch(() => {});

  // ---- Shared content tabs ----
  const tabs: [Tab, string][] = [
    ["media", "الوسائط"],
    ["files", "الملفات"],
    ["links", "اللينكات"],
    ["voice", "الصوت"],
  ];
  if (isGroupish) tabs.unshift(["members", "الأعضاء"]);
  const tabBar = el("div", { class: "tabs" });
  const panel = el("div", { class: "info-panel" });
  body.append(tabBar, panel);
  let current: Tab = tabs[0][0];
  const paintTabs = () =>
    tabBar.replaceChildren(
      ...tabs.map(([id, label]) =>
        el("button", { class: "tab" + (id === current ? " active" : ""), onclick: () => ((current = id), paintTabs(), void loadTab()) }, [label]),
      ),
    );

  // ---------- Gallery: paging, selection, fullscreen viewer ----------
  let loaded: Api.Message[] = [];
  let reachedEnd = false;
  let loadingMore = false;
  let selectingG = false;
  const picked = new Map<number, Api.Message>();
  let gridEl: HTMLElement | null = null;
  const galleryBar = el("div", { class: "gallery-bar", style: { display: "none" } });
  const selCount = el("span", { class: "count" });
  galleryBar.append(
    el("button", { class: "iconbtn", text: "✕", "aria-label": "إلغاء التحديد", onclick: () => setSelecting(false) }),
    selCount,
    el("button", { class: "btn small", text: "اختيار الكل", onclick: () => void selectAllRemote() }),
    el("button", { class: "btn small", text: "⬇ تنزيل", onclick: () => void downloadPicked() }),
    el("button", { class: "btn small primary", text: "↪ توجيه", onclick: () => forwardPicked() }),
  );
  const paintPicked = () => {
    selCount.textContent = `${picked.size} محدد`;
    panel.querySelectorAll<HTMLElement>("[data-mid]").forEach((n) => n.classList.toggle("picked", picked.has(Number(n.dataset.mid))));
  };
  function setSelecting(on: boolean) {
    selectingG = on;
    if (!on) picked.clear();
    panel.classList.toggle("gallery-selecting", on);
    galleryBar.style.display = on ? "" : "none";
    paintPicked();
  }
  function togglePick(m: Api.Message) {
    if (picked.has(m.id)) picked.delete(m.id);
    else picked.set(m.id, m);
    paintPicked();
  }
  async function selectAllRemote() {
    const ctrl = new AbortController();
    selCount.textContent = "بيجمع كل الوسائط…";
    try {
      const all = await tg.sharedMediaAll(entity, current as any, (n) => (selCount.textContent = `بيجمع… ${n}`), ctrl.signal);
      for (const m of all) if (describeMedia(m) || current === "links") picked.set(m.id, m);
      // Show everything that was fetched, so the selection is visible.
      const known = new Set(loaded.map((m) => m.id));
      const extra = all.filter((m) => !known.has(m.id));
      if (extra.length) appendItems(extra);
      reachedEnd = true;
      toast(`اتحدد ${picked.size} عنصر`);
    } catch (e: any) {
      toast("تعذّر: " + (e?.errorMessage || e?.message || ""));
    }
    paintPicked();
  }
  async function downloadPicked() {
    const list = [...picked.values()].filter((m) => describeMedia(m));
    if (!list.length) return toast("حدد وسائط الأول");
    const blocked = list.filter((m) => !canSave(m, entity));
    if (blocked.length === list.length) return toast("الحفظ مقفول في المحادثة دي");
    try {
      const n = await saveMany(list.filter((m) => canSave(m, entity)), (d, t) => (selCount.textContent = `بيحمّل ${d}/${t}`));
      toast(`اتحفظ ${n} ملف`);
    } catch (e: any) {
      toast("تعذّر: " + (e?.message || ""));
    }
    paintPicked();
  }
  function forwardPicked() {
    const list = [...picked.values()];
    if (!list.length) return toast("حدد عناصر الأول");
    openForwardPicker(list, dialog, () => setSelecting(false));
  }

  async function loadTab() {
    loaded = [];
    reachedEnd = false;
    gridEl = null;
    setSelecting(false);
    panel.replaceChildren(el("div", { class: "center small" }, [el("div", { class: "spinner" })]));
    try {
      if (current === "members") return void (await paintMembers());
      const msgs = await tg.sharedMedia(entity, current, 0, 100);
      panel.replaceChildren();
      if (!msgs.length) return void panel.append(el("div", { class: "center hint", text: "مفيش حاجة هنا" }));
      panel.append(
        el("div", { class: "gallery-tools" }, [
          el("button", { class: "btn small", text: "☑ تحديد", onclick: () => setSelecting(!selectingG) }),
        ]),
      );
      if (msgs.length < 100) reachedEnd = true;
      appendItems(msgs);
      panel.append(galleryBar);
    } catch {
      panel.replaceChildren(el("div", { class: "center hint", text: "تعذّر التحميل" }));
    }
  }

  async function loadMore() {
    if (loadingMore || reachedEnd || !loaded.length || current === "members") return;
    loadingMore = true;
    try {
      const more = await tg.sharedMedia(entity, current, loaded[loaded.length - 1].id, 100);
      if (more.length < 100) reachedEnd = true;
      appendItems(more.filter((m) => m instanceof Api.Message));
    } catch {
      /* retry on next scroll */
    }
    loadingMore = false;
  }
  body.addEventListener("scroll", () => {
    if (body.scrollTop + body.clientHeight > body.scrollHeight - 600) void loadMore();
  });

  function appendItems(msgs: Api.Message[]) {
    loaded.push(...msgs);
    if (current === "media") {
      if (!gridEl) {
        gridEl = el("div", { class: "media-grid" });
        panel.insertBefore(gridEl, galleryBar.parentNode === panel ? galleryBar : null);
      }
      for (const m of msgs) {
        const c = gridCell(m);
        if (c) gridEl.append(c);
      }
    } else {
      for (const m of msgs) {
        const r = listItem(m);
        r.dataset.mid = String(m.id);
        r.prepend(el("span", { class: "mg-check" }));
        r.addEventListener("click", (e) => {
          if (!selectingG) return;
          e.preventDefault();
          e.stopPropagation();
          togglePick(m);
        }, true);
        panel.insertBefore(r, galleryBar.parentNode === panel ? galleryBar : null);
      }
    }
    paintPicked();
  }

  function gridCell(m: Api.Message): HTMLElement | null {
    const info = describeMedia(m);
    if (!info) return null;
    const cell = el("button", { class: "mg-cell", "data-mid": String(m.id) }, [
      el("span", { class: "mg-check" }),
      ...(info.kind !== "photo" ? [el("span", { class: "mg-dur", text: "▶ " + fmtDuration(info.duration) })] : []),
    ]);
    cell.onclick = () => {
      if (selectingG) return togglePick(m);
      const mediaOnly = loaded.filter((x) => describeMedia(x));
      openGallery(mediaOnly, mediaOnly.indexOf(m), entity, {
        onOpenInChat: (mm) => nav.onOpenChat(dialog, mm.id),
        onForward: (mm) => openForwardPicker(mm, dialog),
      });
    };
    // Thumbnail: Telegram's server-side preview (sharp, small) — full file only in the viewer.
    const io = new IntersectionObserver((es) => {
      if (!es[0].isIntersecting) return;
      io.disconnect();
      void (async () => {
        for (const t of info.kind === "photo" ? [2, 1, 0] : [1, 0]) {
          try {
            const th = await tg.downloadMedia(m, { thumb: t });
            if (th && th.length > 200) {
              cell.style.backgroundImage = `url("${URL.createObjectURL(new Blob([th as unknown as BlobPart], { type: "image/jpeg" }))}")`;
              return;
            }
          } catch {
            /* next */
          }
        }
        if (info.kind === "photo") {
          const { url } = await loadMedia(m, info);
          cell.style.backgroundImage = `url("${url}")`;
        }
      })().catch(() => {});
    }, { rootMargin: "300px" });
    io.observe(cell);
    return cell;
  }

  function listItem(m: Api.Message): HTMLElement {
    const info = describeMedia(m);
    if (current === "links") {
      const urls = linksOf(m);
      return el("div", { class: "row" }, [
        el("div", { class: "text" }, [
          ...urls.slice(0, 3).map((u) => {
            const safe = safeUrl(u);
            return safe ? el("a", { class: "link", href: safe, target: "_blank", rel: "noopener noreferrer", dir: "ltr", text: u }) : el("span", { text: u });
          }),
          el("div", { class: "desc", text: (m.message || "").slice(0, 80) + " · " + fmtTime(m.date) }),
        ]),
        el("button", { class: "iconbtn", text: "↗", "aria-label": "افتح في المحادثة", onclick: () => nav.onOpenChat(dialog, m.id) }),
      ]);
    }
    const label = info ? (current === "voice" ? `${info.kind === "voice" ? "🎤" : "⭕"} ${fmtDuration(info.duration)}` : `📎 ${info.name}`) : m.message || "";
    const rowEl = el("div", { class: "row" }, [
      el("div", { class: "text" }, [el("div", { class: "label", dir: "auto", text: label }), el("div", { class: "desc", text: [info ? fmtSize(info.size) : "", fmtTime(m.date)].filter(Boolean).join(" · ") })]),
    ]);
    if (info) {
      const btn = el("button", { class: "iconbtn", text: current === "voice" ? "▶" : "💾", "aria-label": current === "voice" ? "تشغيل" : "حفظ" });
      btn.onclick = async () => {
        btn.textContent = "...";
        try {
          const { blob, url } = await loadMedia(m, info);
          if (current === "voice") {
            const a = el("audio", { src: url, controls: "" }) as HTMLAudioElement;
            rowEl.append(a);
            void a.play();
            btn.remove();
          } else {
            await saveBlob(blob, info.name);
            btn.textContent = "✓";
          }
        } catch {
          btn.textContent = "!";
        }
      };
      rowEl.append(btn);
    }
    return rowEl;
  }

  async function paintMembers() {
    const { users, parts } = await tg.getMembers(entity);
    panel.replaceChildren();
    const role = (p: any) =>
      p instanceof Api.ChannelParticipantCreator || p instanceof Api.ChatParticipantCreator
        ? "المالك"
        : p instanceof Api.ChannelParticipantAdmin || p instanceof Api.ChatParticipantAdmin
          ? (p.rank || "أدمن")
          : "";
    const sorted = [...users].sort((a, b) => (role(parts.get(String(b.id))) ? 1 : 0) - (role(parts.get(String(a.id))) ? 1 : 0));
    for (const u of sorted) {
      const p = parts.get(String(u.id));
      const r = role(p);
      const node = el("div", { class: "chat-row", onclick: () => !u.self && nav.onOpenChat(dialogFor(u)) }, [
        avatarEl(u, 42),
        el("div", { class: "chat-meta" }, [
          el("div", { class: "chat-top" }, [el("div", { class: "chat-name" }, [displayName(u), ...premiumStar(u)]), r ? el("span", { class: "role", text: r }) : el("span")]),
          el("div", { class: "chat-last", text: u.bot ? "بوت" : u.username ? "@" + u.username : "" }),
        ]),
      ]);
      if (nav.onMemberMenu && !u.self) {
        node.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          nav.onMemberMenu!(u, p, e.clientX, e.clientY);
        });
        let t: number | undefined;
        node.addEventListener("touchstart", (e) => {
          const tt = e.touches[0];
          t = window.setTimeout(() => nav.onMemberMenu!(u, p, tt.clientX, tt.clientY), 450);
        }, { passive: true });
        node.addEventListener("touchend", () => clearTimeout(t));
        node.addEventListener("touchmove", () => clearTimeout(t), { passive: true });
      }
      panel.append(node);
    }
    if (!users.length) panel.append(el("div", { class: "center hint", text: "الأعضاء مخفيين" }));
  }

  paintTabs();
  void loadTab();
}

function linksOf(m: Api.Message): string[] {
  const out: string[] = [];
  const text = m.message || "";
  for (const e of ((m as any).entities ?? []) as any[]) {
    if (e instanceof Api.MessageEntityTextUrl) out.push(e.url);
    else if (e instanceof Api.MessageEntityUrl) out.push(text.slice(e.offset, e.offset + e.length));
  }
  const wp: any = (m as any).media?.webpage;
  if (wp?.url && !out.includes(wp.url)) out.push(wp.url);
  return out;
}

/** Bios don't carry entities: detect plain URLs/@mentions so they're tappable. */
function autoLinks(text: string): Api.TypeMessageEntity[] {
  const ents: Api.TypeMessageEntity[] = [];
  const re = /(https?:\/\/\S+|t\.me\/\S+|@[A-Za-z]\w{3,31})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    ents.push(
      m[0].startsWith("@")
        ? new Api.MessageEntityMention({ offset: m.index, length: m[0].length })
        : new Api.MessageEntityUrl({ offset: m.index, length: m[0].length }),
    );
  }
  return ents;
}
