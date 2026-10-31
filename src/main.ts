import "./polyfills";
import "./style.css";
import { applyTheme } from "./theme/theme";
import { el, mount, toast } from "./ui/dom";
import { tg } from "./telegram/client";
import { hasCredentials, upsertCurrentAccount } from "./telegram/config";
import { startNotifier } from "./features/notify";
import { isMutedPeer } from "./ui/chatlist";
import { peerKey } from "./telegram/client";
import { renderLogin } from "./ui/login";
import { renderChatList } from "./ui/chatlist";
import { renderChat } from "./ui/chat/view";
import { dialogFor } from "./telegram/entity";
import { renderSettings } from "./ui/settings";
import { renderUserInsight } from "./ui/userInsight";
import { renderChatInfo } from "./ui/chatInfo";
import { renderManage, memberMenu } from "./ui/manage";
import { renderTopics } from "./ui/topics";
import type { ThreadInfo } from "./ui/chat/view";
import { Api } from "teleproto";
import { renderContacts, renderCreateGroup, createChannel, openByLink, openInvite } from "./ui/newChat";
import type { Dialog } from "./telegram/types";
import { isOn } from "./features/registry";
import { hasPasscode, renderLock } from "./features/passcode";
import { initSecureStore } from "./telegram/secureStore";

applyTheme();

/** peerKey of the chat on screen (for notifications). */
let openChatKey: string | null = null;

function openList(): void {
  openChatKey = null;
  renderChatList({
    onOpenChat: (d: Dialog, jumpTo?: number) => openChat(d, jumpTo),
    onOpenSettings: () => openSettings(),
    onOpenPeer: (t, postId) => void openPeer(t, postId),
    onNew: (kind) => openNew(kind),
  });
}

const newNav = {
  onBack: () => openList(),
  onOpenChat: (d: Dialog) => openChat(d),
  onOpenPeer: (t: string) => void openPeer(t),
};

function openNew(kind: "contacts" | "group" | "channel" | "link"): void {
  if (kind === "contacts") renderContacts(newNav);
  else if (kind === "group") renderCreateGroup(newNav);
  else if (kind === "channel") void createChannel(newNav);
  else void openByLink(newNav);
}

function openChat(d: Dialog, jumpTo?: number, thread?: ThreadInfo, forceAll = false): void {
  const e: any = d.entity;
  // Forum groups open on their topics list (unless asked for the plain chat).
  if (!thread && !forceAll && !jumpTo && e instanceof Api.Channel && e.forum) {
    return renderTopics(d, {
      onBack: () => openList(),
      onOpenTopic: (t) => openChat(d, undefined, t),
      onOpenAll: () => openChat(d, undefined, undefined, true),
      onOpenInfo: () => openInfo(d),
    });
  }
  openChatKey = peerKey(e);
  renderChat(
    d,
    {
      onBack: () => (thread && e.forum ? openChat(d) : openList()),
      onOpenPeer: (t, postId) => void openPeer(t, postId),
      onOpenInfo: () => openInfo(d),
      onReopen: () => openChat(d, undefined, thread),
      onOpenThread: (dd, t) => openChat(dd, undefined, t),
      onUserInsight: (u) => openInsight(u, () => openChat(d, undefined, thread)),
    },
    { jumpTo, thread },
  );
}

function openInfo(d: Dialog): void {
  openChatKey = null;
  const e: any = d.entity;
  renderChatInfo(d, {
    onBack: () => openChat(d),
    onOpenChat: (dd, jumpTo) => openChat(dd, jumpTo),
    onMemberMenu: (user, part, x, y) => memberMenu(e, user, part, x, y, () => openInfo(d), (dd) => openChat(dd), (u) => openInsight(u, () => openInfo(d))),
    onUserInsight: (u) => openInsight(u, () => openInfo(d)),
    onManage: () => renderManage(d, { onBack: () => openInfo(d), onOpenChat: (dd) => openChat(dd) }),
  });
}

/** Member-details page; `back` returns to wherever it was opened from. */
function openInsight(user: any, back: () => void): void {
  openChatKey = null;
  void renderUserInsight(user, { onBack: back, onOpenChat: (dd, jumpTo) => openChat(dd, jumpTo) });
}

/** Open a chat from @username, t.me link, numeric user id, or "+inviteHash". */
async function openPeer(target: string, postId?: number): Promise<void> {
  if (target.startsWith("+")) return openInvite(target.slice(1), { onOpenChat: (d) => openChat(d) });
  try {
    const entity: any = await tg.getEntity(/^\d+$/.test(target) ? target : target.replace(/^@/, ""));
    openChat(dialogFor(entity), postId);
  } catch {
    toast("مش لاقي " + target);
  }
}

function openSettings(): void {
  openChatKey = null;
  renderSettings({ onBack: () => openList() });
}

/** getMe also tells teleproto about Premium; remember who's on this slot. */
function loadMe(): void {
  void tg
    .getMe()
    .then((me: any) =>
      upsertCurrentAccount({
        id: String(me.id),
        name: [me.firstName, me.lastName].filter(Boolean).join(" "),
        phone: me.phone,
        username: me.username,
      }),
    )
    .catch(() => {});
}

let notifierStarted = false;
function startBackground(): void {
  if (notifierStarted) return;
  notifierStarted = true;
  startNotifier({
    openChatKey: () => openChatKey,
    isMuted: (k) => isMutedPeer(k),
    open: (entity) => openChat(dialogFor(entity)),
  });
}

function afterLogin(): void {
  tg.startUpdates();
  startBackground();
  loadMe();
  openList();
}

function showBootError(msg: string): void {
  mount(
    el("div", { class: "screen" }, [
      el("div", { class: "center" }, [
        el("div", { class: "logo", text: "⚠" }),
        el("p", { class: "err", text: msg }),
        el("button", { class: "btn", text: "إعادة المحاولة", onclick: () => boot() }),
      ]),
    ]),
  );
}

let booted = false;

async function boot(): Promise<void> {
  booted = true;
  mount(
    el("div", { class: "screen" }, [
      el("div", { class: "center" }, [el("div", { class: "spinner" })]),
    ]),
  );

  if (!hasCredentials()) {
    renderLogin(afterLogin);
    return;
  }

  try {
    tg.init();
    await tg.connect();
    if (await tg.isAuthorised()) {
      tg.startUpdates();
      startBackground();
      loadMe();
      presence(!document.hidden);
      openList();
    } else {
      renderLogin(afterLogin);
    }
  } catch (e: any) {
    const m = String(e?.errorMessage || e?.message || e);
    toast(m);
    showBootError("تعذّر الاتصال بتليجرام. " + m);
  }
}

function locked(): boolean {
  return isOn("passcodeLock") && hasPasscode();
}

// Online presence: online while the app is open & visible (never in Ghost mode).
let presenceTimer: number | undefined;
function presence(visible: boolean) {
  if (!booted || tg.state !== "connected") return;
  clearInterval(presenceTimer);
  void tg.setOnline(visible).catch(() => {});
  if (visible) presenceTimer = window.setInterval(() => void tg.setOnline(true).catch(() => {}), 55_000);
}
tg.on("connState", (s) => s === "connected" && presence(!document.hidden));

// Re-lock after the app has been in the background for over a minute.
let hiddenAt = 0;
document.addEventListener("visibilitychange", () => {
  presence(!document.hidden);
  if (document.hidden) {
    hiddenAt = Date.now();
  } else if (locked() && hiddenAt && Date.now() - hiddenAt > 60_000) {
    renderLock(() => (booted ? openList() : boot()));
  }
});

// Secrets (API keys, sessions, passcode) are loaded from the iOS Keychain
// before anything reads them.
void initSecureStore()
  .then((r) => r.migrated && console.info(`[secureStore] migrated ${r.migrated} secrets to ${r.backend}`))
  .catch((e) => console.error("[secureStore] init failed", e))
  .finally(() => {
    if (locked()) renderLock(() => boot());
    else boot();
  });
