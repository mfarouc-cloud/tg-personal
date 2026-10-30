// Non-file media (polls, locations, contacts, dice, link previews) and
// service messages ("X joined", "X pinned a message", …).
import { Api } from "teleproto";
import { Buffer } from "buffer";
import { el } from "../dom";
import { renderText, safeUrl, type FormatHooks } from "./format";

const txt = (v: any): string => (typeof v === "string" ? v : v?.text ?? "");

export function senderLabel(entity: any): string {
  if (!entity) return "";
  if (entity.title) return entity.title;
  return [entity.firstName, entity.lastName].filter(Boolean).join(" ") || (entity.username ? "@" + entity.username : "");
}

// ---------------- Service messages ----------------
export function serviceText(msg: Api.MessageService, actorName: string): string {
  const a: any = msg.action;
  const who = actorName || "حد";
  const names = (ids: any[] | undefined) => {
    const ents: any[] = (msg as any).actionEntities ?? [];
    return (ids ?? [])
      .map((id) => senderLabel(ents.find((e) => String(e?.id) === String(id))) || "عضو")
      .join("، ");
  };
  switch (a?.className) {
    case "MessageActionChatCreate":
      return `${who} أنشأ الجروب «${a.title}»`;
    case "MessageActionChannelCreate":
      return `اتعملت القناة «${a.title}»`;
    case "MessageActionChatEditTitle":
      return `${who} غيّر الاسم لـ «${a.title}»`;
    case "MessageActionChatEditPhoto":
      return `${who} غيّر الصورة`;
    case "MessageActionChatDeletePhoto":
      return `${who} مسح الصورة`;
    case "MessageActionChatAddUser": {
      const ids = (a.users ?? []).map(String);
      const selfJoin = ids.length === 1 && String((msg as any).senderId ?? "") === ids[0];
      return selfJoin ? `${who} انضم` : `${who} ضاف ${names(a.users)}`;
    }
    case "MessageActionChatDeleteUser": {
      const left = String((msg as any).senderId ?? "") === String(a.userId);
      return left ? `${who} خرج` : `${who} طرد ${names([a.userId])}`;
    }
    case "MessageActionChatJoinedByLink":
      return `${who} انضم من لينك دعوة`;
    case "MessageActionChatJoinedByRequest":
      return `${who} انضم بعد الموافقة على طلبه`;
    case "MessageActionPinMessage":
      return `${who} ثبّت رسالة`;
    case "MessageActionHistoryClear":
      return "السجل اتمسح";
    case "MessageActionPhoneCall": {
      const d = a.duration ? ` · ${Math.floor(a.duration / 60)}:${String(a.duration % 60).padStart(2, "0")}` : "";
      const missed = a.reason?.className === "PhoneCallDiscardReasonMissed";
      return `${a.video ? "📹" : "📞"} ${missed ? "مكالمة فايتة" : "مكالمة"}${d}`;
    }
    case "MessageActionGroupCall":
      return a.duration ? "🎙 المكالمة الجماعية خلصت" : "🎙 بدأت مكالمة جماعية";
    case "MessageActionScreenshotTaken":
      return `${who} خد سكرين شوت`;
    case "MessageActionContactSignUp":
      return `${who} انضم لتليجرام 🎉`;
    case "MessageActionSetMessagesTTL":
      return a.period ? `${who} شغّل الرسايل ذاتية الحذف` : `${who} قفل الرسايل ذاتية الحذف`;
    case "MessageActionChatMigrateTo":
    case "MessageActionChannelMigrateFrom":
      return "الجروب اتحوّل لجروب كبير";
    case "MessageActionTopicCreate":
      return `${who} عمل موضوع «${a.title}»`;
    case "MessageActionGiftPremium":
      return `${who} هادى Premium ⭐`;
    case "MessageActionGameScore":
      return `${who} جاب ${a.score} نقطة`;
    default:
      return (a?.className || "حدث").replace(/^MessageAction/, "");
  }
}

// ---------------- Special media ----------------
export interface SpecialHooks extends FormatHooks {
  onVote?: (options: Uint8Array[]) => Promise<void>;
}

/** Appends UI for poll/geo/contact/dice/webpage media. Returns true if handled. */
export function renderSpecial(container: HTMLElement, msg: Api.Message, hooks: SpecialHooks): boolean {
  const media: any = (msg as any).media;
  if (!media) return false;

  if (media instanceof Api.MessageMediaPoll) {
    container.append(renderPoll(media, hooks));
    return true;
  }
  if (media instanceof Api.MessageMediaGeo || media instanceof Api.MessageMediaGeoLive || media instanceof Api.MessageMediaVenue) {
    const v: any = media; // venue has title/address; plain geo doesn't
    const g: any = v.geo;
    if (!g || g.className === "GeoPointEmpty") return false;
    const url = `https://maps.apple.com/?ll=${g.lat},${g.long}&q=${encodeURIComponent(v.title || "موقع")}`;
    container.append(
      el("a", { class: "special-card", href: url, target: "_blank", rel: "noopener noreferrer" }, [
        el("span", { class: "sc-icon", text: media instanceof Api.MessageMediaGeoLive ? "📡" : "📍" }),
        el("span", { class: "sc-text" }, [
          el("b", { text: v.title || (media instanceof Api.MessageMediaGeoLive ? "موقع مباشر" : "موقع") }),
          el("span", { class: "hint", text: v.address || `${g.lat.toFixed(5)}, ${g.long.toFixed(5)}` }),
        ]),
      ]),
    );
    return true;
  }
  if (media instanceof Api.MessageMediaContact) {
    const name = [media.firstName, media.lastName].filter(Boolean).join(" ") || "جهة اتصال";
    const phone = media.phoneNumber ? "+" + media.phoneNumber.replace(/^\+/, "") : "";
    container.append(
      el("div", { class: "special-card" }, [
        el("span", { class: "sc-icon", text: "👤" }),
        el("span", { class: "sc-text" }, [
          el("b", { text: name }),
          phone ? el("a", { class: "link", href: "tel:" + phone, dir: "ltr", text: phone }) : el("span"),
        ]),
      ]),
    );
    return true;
  }
  if (media instanceof Api.MessageMediaDice) {
    container.append(
      el("div", { class: "dice" }, [el("span", { class: "dice-emoji", text: media.emoticon }), el("span", { text: String(media.value) })]),
    );
    return true;
  }
  if (media instanceof Api.MessageMediaWebPage) {
    const w: any = media.webpage;
    if (!w || !(w instanceof Api.WebPage)) return false;
    const url = safeUrl(w.url || "");
    const card = el(url ? "a" : "div", url ? { class: "webpage", href: url, target: "_blank", rel: "noopener noreferrer" } : { class: "webpage" }, [
      w.siteName ? el("span", { class: "wp-site", text: w.siteName }) : el("span"),
      w.title ? el("b", { class: "wp-title", text: w.title }) : el("span"),
      w.description ? el("span", { class: "wp-desc", text: w.description }) : el("span"),
    ]);
    container.append(card);
    return true;
  }
  if (media instanceof Api.MessageMediaInvoice) {
    container.append(el("div", { class: "special-card" }, [el("span", { class: "sc-icon", text: "🧾" }), el("b", { text: media.title })]));
    return true;
  }
  if (media instanceof Api.MessageMediaGame) {
    container.append(el("div", { class: "special-card" }, [el("span", { class: "sc-icon", text: "🎮" }), el("b", { text: media.game.title })]));
    return true;
  }
  if (media instanceof Api.MessageMediaStory) {
    container.append(el("div", { class: "special-card" }, [el("span", { class: "sc-icon", text: "📖" }), el("span", { text: "ستوري" })]));
    return true;
  }
  return false;
}

function renderPoll(media: Api.MessageMediaPoll, hooks: SpecialHooks): HTMLElement {
  const poll: any = media.poll;
  const results: any = media.results;
  const voters: any[] = results?.results ?? [];
  const total = results?.totalVoters ?? 0;
  const voted = voters.some((v) => v.chosen);
  const showResults = voted || poll.closed;
  const multi = !!poll.multipleChoice;
  const selected = new Set<number>();

  const kind = poll.quiz ? "اختبار" : poll.publicVoters ? "استطلاع" : "استطلاع مجهول";
  const box = el("div", { class: "poll" }, [
    el("b", { class: "poll-q" }, [renderText(txt(poll.question), poll.question?.entities, hooks)]),
    el("span", { class: "hint", text: `${kind}${poll.closed ? " · مقفول" : ""}` }),
  ]);

  const optionsEl: HTMLElement[] = [];
  (poll.answers as any[]).forEach((ans, i) => {
    const r = voters.find((v) => Buffer.from(v.option).equals(Buffer.from(ans.option)));
    const pct = total && r ? Math.round((r.voters / total) * 100) : 0;
    const mark = r?.chosen ? (poll.quiz ? (r.correct ? "✅" : "❌") : "✓") : poll.quiz && showResults && r?.correct ? "✅" : "";
    const row = el("button", { class: "poll-opt" + (showResults ? " done" : ""), disabled: showResults ? "" : null }, [
      el("span", { class: "po-text" }, [renderText(txt(ans.text), ans.text?.entities, hooks)]),
      showResults ? el("span", { class: "po-pct", text: `${mark} ${pct}%` }) : el("span", { class: "po-check" }),
      showResults ? el("i", { class: "po-bar", style: { width: pct + "%" } }) : el("i"),
    ]);
    if (!showResults) {
      row.onclick = async () => {
        if (multi) {
          if (selected.has(i)) selected.delete(i);
          else selected.add(i);
          row.classList.toggle("picked", selected.has(i));
          submit.disabled = selected.size === 0;
          return;
        }
        await doVote([ans.option]);
      };
    }
    optionsEl.push(row);
    box.append(row);
  });

  const submit = el("button", { class: "btn poll-submit", text: "تصويت", disabled: "" }) as HTMLButtonElement;
  const doVote = async (opts: Uint8Array[]) => {
    if (!hooks.onVote) return;
    for (const o of optionsEl) (o as HTMLButtonElement).disabled = true;
    try {
      await hooks.onVote(opts);
    } catch {
      for (const o of optionsEl) (o as HTMLButtonElement).disabled = false;
    }
  };
  if (multi && !showResults) {
    submit.onclick = () => void doVote([...selected].map((i) => poll.answers[i].option));
    box.append(submit);
  }
  box.append(el("span", { class: "hint", text: total ? `${total} صوت` : "لسه مفيش أصوات" }));
  return box;
}
