// Forum groups: list of topics → each opens as a thread.
import { el, mount, toast, fmtTime, colorFor } from "./dom";
import { tg } from "../telegram/client";
import type { Dialog } from "../telegram/types";
import { displayName } from "../telegram/entity";
import { askText } from "./chat/menu";
import type { ThreadInfo } from "./chat/view";

export interface TopicsNav {
  onBack: () => void;
  onOpenTopic: (thread: ThreadInfo) => void;
  /** Show the group as one plain chat instead. */
  onOpenAll: () => void;
  onOpenInfo: () => void;
}

export function renderTopics(dialog: Dialog, nav: TopicsNav): void {
  const entity: any = dialog.entity;
  const name = displayName(entity);
  const list = el("div", { class: "scroll" });
  const canCreate = !!(entity.creator || entity.adminRights?.manageTopics || !entity.defaultBannedRights?.manageTopics);
  mount(
    el("div", { class: "screen" }, [
      el("div", { class: "topbar" }, [
        el("button", { class: "iconbtn", text: "‹", "aria-label": "رجوع", onclick: nav.onBack }),
        el("button", { class: "head-info", onclick: nav.onOpenInfo }, [el("div", { class: "chat-meta" }, [el("div", { class: "title", text: name }), el("div", { class: "subtitle", text: "المواضيع" })])]),
        el("button", { class: "iconbtn", text: "☰", "aria-label": "كل الرسايل", title: "عرض كل الرسايل", onclick: nav.onOpenAll }),
      ]),
      list,
    ]),
  );

  const load = async () => {
    list.replaceChildren(el("div", { class: "center" }, [el("div", { class: "spinner" })]));
    try {
      const topics = await tg.getTopics(entity);
      list.replaceChildren();
      if (canCreate) {
        list.append(
          el("button", {
            class: "chat-row",
            onclick: async () => {
              const v = await askText("موضوع جديد", [{ placeholder: "اسم الموضوع" }], "إنشاء");
              if (!v) return;
              try {
                await tg.createTopic(entity, v[0]);
                toast("الموضوع اتعمل ✓");
                void load();
              } catch (e: any) {
                toast("تعذّر: " + (e?.errorMessage || e?.message || ""));
              }
            },
          }, [el("span", { class: "sc-icon", text: "➕" }), el("b", { text: "موضوع جديد" })]),
        );
      }
      const sorted = [...topics].sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.topMessage - a.topMessage);
      for (const t of sorted) {
        const icon = t.id === 1 ? "#" : t.closed ? "🔒" : "💬";
        list.append(
          el("div", { class: "chat-row", onclick: () => nav.onOpenTopic({ topId: t.id, title: t.title, sub: name }) }, [
            el("div", { class: "avatar", style: { width: "44px", height: "44px", fontSize: "18px", background: colorFor(t.title) }, text: icon }),
            el("div", { class: "chat-meta" }, [
              el("div", { class: "chat-top" }, [
                el("div", { class: "chat-name" }, [t.title, ...(t.pinned ? [el("span", { class: "pin", text: " 📌" })] : [])]),
                el("div", { class: "chat-time", text: t.date ? fmtTime(t.date) : "" }),
              ]),
              el("div", { class: "chat-top" }, [
                el("div", { class: "chat-last", text: t.closed ? "مقفول" : "" }),
                ...(t.unreadCount ? [el("span", { class: "badge", text: String(t.unreadCount) })] : []),
              ]),
            ]),
          ]),
        );
      }
      if (!sorted.length) list.append(el("div", { class: "center hint", text: "مفيش مواضيع" }));
    } catch (e: any) {
      list.replaceChildren(el("div", { class: "center", text: "تعذّر تحميل المواضيع" }));
      toast(String(e?.errorMessage || e?.message || ""));
    }
  };
  void load();
}
