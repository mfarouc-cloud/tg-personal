// Stories: strip above the chat list, full-screen viewer (save, stealth view
// in Ghost mode), and posting a new story.
import { Api } from "teleproto";
import { el, toast, fmtTime } from "./dom";
import { tg, peerKey } from "../telegram/client";
import { displayName } from "../telegram/entity";
import { avatarEl } from "./avatar";
import { askChoice, askText } from "./chat/menu";
import { saveBlob } from "../features/media";
import { isOn } from "../features/registry";

interface PeerEntry {
  peer: any;
  entity: any;
  stories: Api.StoryItem[];
  maxReadId: number;
}

/** Horizontal strip of people with active stories. Returns null if none. */
export async function storiesStrip(): Promise<HTMLElement | null> {
  if (!isOn("stories")) return null;
  let data: { peers: Api.PeerStories[]; entities: Map<string, any> };
  try {
    data = await tg.getAllStories();
  } catch {
    return null;
  }
  const entries: PeerEntry[] = data.peers
    .map((p) => ({
      peer: p.peer,
      entity: data.entities.get(peerKey(p.peer)),
      stories: (p.stories ?? []).filter((s): s is Api.StoryItem => s instanceof Api.StoryItem),
      maxReadId: p.maxReadId ?? 0,
    }))
    .filter((e) => e.entity && e.stories.length);
  const strip = el("div", { class: "stories-strip" });
  strip.append(
    el("button", { class: "story-bubble add", onclick: () => void postStoryFlow() }, [
      el("div", { class: "story-ring add" }, [el("div", { class: "avatar", style: { width: "56px", height: "56px", fontSize: "26px", background: "var(--surface-2)" }, text: "+" })]),
      el("span", { text: "ستوري" }),
    ]),
  );
  // Unseen first.
  entries.sort((a, b) => Number(unseen(b)) - Number(unseen(a)));
  entries.forEach((e, i) => {
    strip.append(
      el("button", { class: "story-bubble", onclick: () => openViewer(entries, i) }, [
        el("div", { class: "story-ring" + (unseen(e) ? " unseen" : "") }, [avatarEl(e.entity, 56)]),
        el("span", { text: e.entity.self ? "ستوريك" : (displayName(e.entity).split(" ")[0] || "") }),
      ]),
    );
  });
  return strip;
}

const unseen = (e: PeerEntry) => e.stories.some((s) => s.id > e.maxReadId);

function openViewer(entries: PeerEntry[], startPeer: number): void {
  let pi = startPeer;
  let si = Math.max(0, entries[pi].stories.findIndex((s) => s.id > entries[pi].maxReadId));
  let timer: number | undefined;
  let currentUrl: string | null = null;
  const bars = el("div", { class: "story-bars" });
  const head = el("div", { class: "story-head" });
  const stage = el("div", { class: "story-stage" });
  const caption = el("div", { class: "story-caption" });
  const saveBtn = el("button", { class: "iconbtn", text: "💾", "aria-label": "حفظ الستوري" });
  const closeBtn = el("button", { class: "iconbtn", text: "✕", "aria-label": "إغلاق" });
  const overlay = el("div", { class: "story-viewer" }, [bars, el("div", { class: "story-top" }, [head, saveBtn, closeBtn]), stage, caption]);
  document.body.append(overlay);

  const close = () => {
    clearTimeout(timer);
    overlay.remove();
    if (currentUrl) URL.revokeObjectURL(currentUrl);
  };
  closeBtn.onclick = close;

  const next = () => {
    const e = entries[pi];
    if (si + 1 < e.stories.length) si++;
    else if (pi + 1 < entries.length) {
      pi++;
      si = 0;
    } else return close();
    void show();
  };
  const prev = () => {
    if (si > 0) si--;
    else if (pi > 0) {
      pi--;
      si = entries[pi].stories.length - 1;
    }
    void show();
  };
  stage.onclick = (ev) => {
    const x = (ev as MouseEvent).clientX / window.innerWidth;
    // RTL: tapping the right side goes back, left side goes forward.
    if (x > 0.5) prev();
    else next();
  };

  async function show() {
    clearTimeout(timer);
    const e = entries[pi];
    const s = e.stories[si];
    bars.replaceChildren(...e.stories.map((_, i) => el("i", { class: i < si ? "done" : i === si ? "now" : "" })));
    head.replaceChildren(avatarEl(e.entity, 34), el("div", {}, [el("b", { text: displayName(e.entity) }), el("span", { class: "hint", text: fmtTime(s.date) })]));
    caption.textContent = s.caption || "";
    stage.replaceChildren(el("div", { class: "spinner" }));
    const media: any = s.media;
    const isVideo = media instanceof Api.MessageMediaDocument;
    try {
      const data = await tg.downloadStory(s);
      if (!data) throw new Error("فاضي");
      if (currentUrl) URL.revokeObjectURL(currentUrl);
      const blob = new Blob([data as unknown as BlobPart], { type: isVideo ? "video/mp4" : "image/jpeg" });
      currentUrl = URL.createObjectURL(blob);
      const node = isVideo
        ? (el("video", { src: currentUrl, autoplay: "", playsinline: "" }) as HTMLVideoElement)
        : el("img", { src: currentUrl, alt: "" });
      stage.replaceChildren(node);
      saveBtn.style.display = s.noforwards && !isOn("bypassRestrictions") ? "none" : "";
      saveBtn.onclick = (ev) => {
        ev.stopPropagation();
        void saveBlob(blob, `story_${displayName(e.entity)}_${s.id}.${isVideo ? "mp4" : "jpg"}`);
      };
      if (node instanceof HTMLVideoElement) node.onended = next;
      else timer = window.setTimeout(next, 6000);
      if (s.id > e.maxReadId) {
        e.maxReadId = s.id;
        void tg.readStories(e.entity, s.id).catch(() => {});
      }
    } catch {
      stage.replaceChildren(el("div", { class: "hint", text: "تعذّر تحميل الستوري" }));
      timer = window.setTimeout(next, 2500);
    }
  }
  void show();
}

export async function postStoryFlow(): Promise<void> {
  const inp = el("input", { type: "file", accept: "image/*,video/mp4" }) as HTMLInputElement;
  inp.onchange = async () => {
    const f = inp.files?.[0];
    if (!f) return;
    const cap = await askText("ستوري جديد", [{ placeholder: "كلام على الستوري (اختياري)", required: false }], "التالي");
    if (!cap) return;
    const who = (await askChoice("مين يشوفها؟", [
      { label: "الكل", value: "all" },
      { label: "جهات الاتصال", value: "contacts" },
    ])) as "all" | "contacts" | null;
    if (!who) return;
    toast("بينشر...");
    try {
      await tg.postStory(f, cap[0], who);
      toast("الستوري اتنشرت ✓");
    } catch (e: any) {
      const m = String(e?.errorMessage || e?.message || e);
      toast(/PREMIUM/.test(m) ? "وصلت لحد الستوريز — Premium بيزوّده" : "تعذّر النشر: " + m);
    }
  };
  inp.click();
}
