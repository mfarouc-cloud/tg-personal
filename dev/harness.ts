// Dev-only harness: renders screens with fake data (no Telegram login needed).
import "../src/polyfills";
import "../src/style.css";
import { applyTheme } from "../src/theme/theme";
import { tg } from "../src/telegram/client";
import { renderChatList } from "../src/ui/chatlist";
import { renderChatInfo } from "../src/ui/chatInfo";
import { renderManage, memberMenu } from "../src/ui/manage";
import { renderProfile, renderPrivacy, renderSessions, renderTwoFa } from "../src/ui/account";
import { startNotifier } from "../src/features/notify";
import * as cfg from "../src/telegram/config";
import { renderTopics } from "../src/ui/topics";
import { renderContacts, renderCreateGroup, openInvite } from "../src/ui/newChat";
import { renderSettings, renderFeatures } from "../src/ui/settings";
import { renderLock } from "../src/features/passcode";
import { initials } from "../src/ui/dom";
import { renderChat } from "../src/ui/chat/view";
import { Api } from "teleproto";
import bigInt from "big-integer";
applyTheme();
const mk = (title: string, kind: string, unread: number, text: string) => ({
  title, unreadCount: unread, date: Math.floor(Date.now() / 1000) - 3600,
  message: { message: text } as any,
  isUser: kind === "user" || kind === "bot", isGroup: kind === "group", isChannel: kind === "channel" || kind === "group",
  entity: { bot: kind === "bot", broadcast: kind === "channel" },
});
const fake = [
  mk("Fedniy . فدني", "channel", 120, "Meta courses"),
  mk("ممكن تجي ؟", "group", 300, "اللهم..."),
  mk("✨ محمود درويش PS", "channel", 35, "طوّر نفسك"),
  mk("أحمد", "user", 2, "تمام"),
  mk("BotFather", "bot", 0, "Done!"),
  mk("سيجنال تريد", "group", 0, "..."),
];
(tg as any).getDialogs = async () => fake;
(window as any).initials = initials;
const screen = new URLSearchParams(location.search).get("s");
const nav = { onOpenChat: () => {}, onOpenSettings: () => renderSettings({ onBack: () => {} }) };
if (screen === "features") renderFeatures({ onBack: () => {} });
else if (screen === "settings") renderSettings({ onBack: () => {} });
else if (screen === "lock") renderLock(() => { document.title = "UNLOCKED"; });
else if (screen === "media") {
  const B = (globalThis as any).Buffer;
  const now = Math.floor(Date.now() / 1000);
  const photo = new Api.Photo({ id: bigInt(1), accessHash: bigInt(1), fileReference: B.alloc(1), date: now, dcId: 2,
    sizes: [new Api.PhotoSize({ type: "x", w: 320, h: 200, size: 48000 })] });
  const doc = (mime: string, size: number, attributes: any[]) => new Api.Document({ id: bigInt(2), accessHash: bigInt(2), fileReference: B.alloc(1), date: now, mimeType: mime, size: bigInt(size), dcId: 2, attributes });
  const peerId = new Api.PeerUser({ userId: bigInt(42) });
  const mkMsg = (id: number, media: any, message = "", extra: any = {}) => new Api.Message({ id, peerId, date: now - 100 + id, message, media, ...extra });
  const msgs = [
    mkMsg(1, new Api.MessageMediaPhoto({ photo }), "صورة للتجربة"),
    mkMsg(2, new Api.MessageMediaDocument({ document: doc("audio/ogg", 23000, [new Api.DocumentAttributeAudio({ voice: true, duration: 7 })]) })),
    mkMsg(3, new Api.MessageMediaDocument({ document: doc("application/pdf", 2_400_000, [new Api.DocumentAttributeFilename({ fileName: "report-2026.pdf" })]) }), "التقرير"),
    mkMsg(4, new Api.MessageMediaDocument({ document: doc("video/mp4", 5_000_000, [new Api.DocumentAttributeVideo({ duration: 65, w: 640, h: 360, supportsStreaming: true })]) })),
    mkMsg(5, new Api.MessageMediaPhoto({ photo }), "محتوى محمي", { noforwards: true }),
  ];
  // tiny PNG generated on a canvas
  const cv = document.createElement("canvas"); cv.width = 320; cv.height = 200;
  const cx = cv.getContext("2d")!; cx.fillStyle = "#229ed9"; cx.fillRect(0, 0, 320, 200); cx.fillStyle = "#fff"; cx.font = "40px sans-serif"; cx.fillText("PHOTO", 90, 115);
  const png = new Uint8Array(await (await new Promise<Blob>((r) => cv.toBlob((b) => r(b!), "image/png"))).arrayBuffer());
  const calls: any[] = ((window as any).calls = []);
  (tg as any).getHistory = async () => [...msgs].reverse();
  (tg as any).markRead = async () => {};
  (tg as any).downloadMedia = async (_m: any, o: any) => { o?.onProgress?.(0.5); o?.onProgress?.(1); return png; };
  (tg as any).forward = async (_t: any, m: any, _f: any, drop: boolean) => calls.push({ type: "forward", id: m.id, drop });
  (tg as any).resend = async (_t: any, m: any, file?: File) => calls.push({ type: "resend", id: m.id, file: file?.name, size: file?.size });
  // Premium stubs
  (tg as any).me = { premium: true };
  (tg as any).translate = async (_p: any, ids: number[], lang: string) => ids.map(() => `[${lang}] translated text`);
  (tg as any).transcribe = async (_p: any, msgId: number) => {
    setTimeout(() => (tg as any).emit("transcribed", { msgId, transcriptionId: "77", text: "أهلاً، دي رسالة صوتية متحوّلة لنص", pending: false }), 300);
    return { pending: true, text: "", transcriptionId: "77" };
  };
  // Real tg.sendFile/uploadLarge, with the network layer stubbed:
  const parts: any[] = ((window as any).parts = []);
  (tg as any).client = {
    invoke: async (req: any) => { parts.push({ c: req.className, p: req.filePart, t: req.fileTotalParts, n: req.bytes?.length }); return true; },
    sendFile: async (_peer: any, o: any) => { (window as any).sent = { media: o.file?.className, mime: o.file?.mimeType, file: o.file?.file?.className, parts: o.file?.file?.parts ?? o.file?.parts, name: o.file?.file?.name ?? o.file?.name, attrs: (o.file?.attributes || []).map((a: any) => a.className) };
      return new Api.Message({ id: 99, peerId, date: now, message: o.caption || "", out: true }); },
    getInputEntity: async (x: any) => x,
  };
  renderChat({ ...fake[3], id: "42", entity: { premium: true } } as any, { onBack: () => {} });
}
else if (["settings2", "profile", "privacy", "sessions", "twofa", "stories", "banner"].includes(screen ?? "")) {
  const now = Math.floor(Date.now() / 1000);
  const calls: any[] = ((window as any).calls = []);
  const me = new Api.User({ id: bigInt(1), self: true, firstName: "فاروق", lastName: "م", phone: "201000000001", username: "farouk", premium: true, accessHash: bigInt(1) });
  const sara = new Api.User({ id: bigInt(11), firstName: "سارة", accessHash: bigInt(11) });
  (tg as any).me = me;
  if (!localStorage.getItem("tg.accounts")) {
    localStorage.setItem("tg.accounts", JSON.stringify([{ slot: "0", name: "فاروق م", phone: "201000000001" }, { slot: "1", name: "حساب الشغل", phone: "201000000002" }]));
  }
  const rec = (name: string, ret?: any) => async (...a: any[]) => { calls.push({ type: name, args: a }); return ret; };
  (tg as any).getFull = async () => ({ about: "مطوّر 💻" });
  (tg as any).updateProfile = rec("updateProfile");
  (tg as any).setMyUsername = rec("setMyUsername");
  (tg as any).getPrivacy = async (k: string) => (k === "lastSeen" ? "contacts" : k === "phone" ? "nobody" : "all");
  (tg as any).setPrivacy = rec("setPrivacy");
  (tg as any).getGlobalPrivacy = async () => ({ hideReadMarks: false, archiveAndMuteNewNoncontactPeers: true });
  (tg as any).setGlobalPrivacy = rec("setGlobalPrivacy");
  (tg as any).getSessions = async () => [
    new Api.Authorization({ current: true, hash: bigInt(0), deviceModel: "PWA", platform: "iOS", systemVersion: "26.6", apiId: 1, appName: "tg-personal", appVersion: "0.6.0", dateCreated: now, dateActive: now, ip: "1.2.3.4", country: "Egypt", region: "Cairo" }),
    new Api.Authorization({ hash: bigInt(77), deviceModel: "Windows PC", platform: "Desktop", systemVersion: "11", apiId: 2, appName: "Telegram Desktop", appVersion: "5.0", dateCreated: now - 99999, dateActive: now - 3600, ip: "5.6.7.8", country: "Egypt", region: "Giza" }),
  ];
  (tg as any).endSession = rec("endSession");
  (tg as any).endOtherSessions = rec("endOtherSessions");
  (tg as any).hasPassword = async () => ({ has: true, hint: "اسم القطة" });
  (tg as any).setTwoFa = rec("setTwoFa");
  const cv = document.createElement("canvas"); cv.width = 360; cv.height = 640; const cx = cv.getContext("2d")!; cx.fillStyle = "#8e7cff"; cx.fillRect(0, 0, 360, 640); cx.fillStyle = "#fff"; cx.font = "40px sans-serif"; cx.fillText("STORY", 110, 320);
  const png = new Uint8Array(await (await new Promise<Blob>((r) => cv.toBlob((b) => r(b!), "image/png"))).arrayBuffer());
  const story = (id: number) => new Api.StoryItem({ id, date: now - 600, expireDate: now + 80000, media: new Api.MessageMediaPhoto({}), caption: "ستوري " + id });
  (tg as any).getAllStories = async () => ({ peers: [new Api.PeerStories({ peer: new Api.PeerUser({ userId: bigInt(11) }), maxReadId: 0, stories: [story(1), story(2)] })], entities: new Map([["11", sara]]) });
  (tg as any).downloadStory = async () => png;
  (tg as any).readStories = rec("readStories");
  const nav: any = { onBack: () => calls.push({ type: "back" }) };
  (window as any).cfg = cfg;
  if (screen === "settings2") renderSettings(nav);
  else if (screen === "profile") renderProfile(nav);
  else if (screen === "privacy") renderPrivacy(nav);
  else if (screen === "sessions") renderSessions(nav);
  else if (screen === "twofa") renderTwoFa(nav);
  else if (screen === "stories") {
    (tg as any).getDialogs = async () => [];
    (tg as any).getFolders = async () => [];
    renderChatList({ onOpenChat: () => {}, onOpenSettings: () => {}, onOpenPeer: () => {}, onNew: () => {} } as any);
  } else {
    (tg as any).getEntity = async () => sara;
    startNotifier({ openChatKey: () => "999", isMuted: () => false, open: (e: any) => calls.push({ type: "openFromBanner", name: e.firstName }) });
    renderSettings(nav);
    (window as any).fire = () => (tg as any).emit("newMessage", { chatId: "11", message: new Api.Message({ id: 5, peerId: new Api.PeerUser({ userId: bigInt(11) }), date: now, message: "إزيك يا فاروق؟", fromId: new Api.PeerUser({ userId: bigInt(11) }) }) });
  }
}
else if (screen === "manage" || screen === "members" || screen === "topics" || screen === "comments") {
  const now = Math.floor(Date.now() / 1000);
  const calls: any[] = ((window as any).calls = []);
  const U = (id: number, first: string, extra: any = {}) => new Api.User({ id: bigInt(id), firstName: first, accessHash: bigInt(id), ...extra });
  const sara = U(11, "سارة"), karim = U(12, "كريم"), omar = U(14, "عمر");
  const grp = new Api.Channel({ id: bigInt(21), title: "فريق الشغل", photo: new Api.ChatPhotoEmpty(), date: now, accessHash: bigInt(21), megagroup: true, creator: true, forum: screen === "topics", username: "team_x",
    defaultBannedRights: new Api.ChatBannedRights({ untilDate: 0, sendPolls: true, pinMessages: true, changeInfo: true }) });
  const ch = new Api.Channel({ id: bigInt(22), title: "قناة الأخبار", photo: new Api.ChatPhotoEmpty(), date: now, accessHash: bigInt(22), broadcast: true });
  const disc = new Api.Channel({ id: bigInt(23), title: "نقاش الأخبار", photo: new Api.ChatPhotoEmpty(), date: now, accessHash: bigInt(23), megagroup: true });
  const rec = (name: string) => async (...a: any[]) => { calls.push({ type: name, args: a.slice(1).map((x: any) => x?.firstName ?? x) }); };
  for (const fn of ["setAdmin", "setBanned", "kick", "setDefaultRights", "setSlowMode", "revokeInvite", "answerJoinRequest", "toggleHiddenHistory", "toggleProtected", "editTitle", "createTopic"]) (tg as any)[fn] = rec(fn);
  (tg as any).getFullChat = async () => ({ about: "جروب الفريق", slowmodeSeconds: 30, hiddenPrehistory: false });
  (tg as any).listInvites = async () => [new Api.ChatInviteExported({ link: "https://t.me/+PERMANENT1", adminId: bigInt(1), date: now, permanent: true, usage: 40 }), new Api.ChatInviteExported({ link: "https://t.me/+EVENT2026", adminId: bigInt(1), date: now, title: "إيفنت", usage: 3, usageLimit: 50, expireDate: now + 86400 })];
  (tg as any).createInvite = async (_c: any, o: any) => { calls.push({ type: "createInvite", o }); return new Api.ChatInviteExported({ link: "https://t.me/+NEWLINK", adminId: bigInt(1), date: now }); };
  (tg as any).joinRequests = async () => ({ users: [omar], importers: [new Api.ChatInviteImporter({ userId: bigInt(14), date: now - 600, about: "عايز أنضم" })] });
  (tg as any).getParticipants = async (_c: any, kind: string) => kind === "admins" ? { users: [karim, sara], parts: new Map<string, any>([["11", new Api.ChannelParticipantAdmin({ userId: bigInt(11), promotedBy: bigInt(12), date: now, adminRights: new Api.ChatAdminRights({ deleteMessages: true, pinMessages: true }), rank: "مشرفة" })]]) } : { users: [omar], parts: new Map() };
  (tg as any).adminLog = async () => ({ users: [sara], events: [
    new Api.ChannelAdminLogEvent({ id: bigInt(1), date: now - 100, userId: bigInt(11), action: new Api.ChannelAdminLogEventActionToggleSlowMode({ prevValue: 0, newValue: 30 }) }),
    new Api.ChannelAdminLogEvent({ id: bigInt(2), date: now - 50, userId: bigInt(11), action: new Api.ChannelAdminLogEventActionChangeTitle({ prevValue: "الفريق", newValue: "فريق الشغل" }) }) ] });
  (tg as any).getFull = async () => ({ about: "x", members: 3 });
  (tg as any).sharedMedia = async () => [];
  (tg as any).getMembers = async () => ({ users: [karim, sara, omar], parts: new Map<string, any>([["12", new Api.ChannelParticipantCreator({ userId: bigInt(12), adminRights: new Api.ChatAdminRights({}) })], ["11", new Api.ChannelParticipantAdmin({ userId: bigInt(11), promotedBy: bigInt(12), date: now, adminRights: new Api.ChatAdminRights({ deleteMessages: true }), rank: "مشرفة" })]]) });
  (tg as any).getTopics = async () => [new Api.ForumTopic({ id: 1, date: now, title: "عام", iconColor: 0, topMessage: 10, readInboxMaxId: 0, readOutboxMaxId: 0, unreadCount: 0, unreadMentionsCount: 0, unreadReactionsCount: 0, unreadPollVotesCount: 0, fromId: new Api.PeerUser({ userId: bigInt(12) }), notifySettings: new Api.PeerNotifySettings({}), peer: new Api.PeerChannel({ channelId: bigInt(21) }) }),
    new Api.ForumTopic({ id: 55, date: now, title: "الباك إند", iconColor: 0, topMessage: 60, pinned: true, readInboxMaxId: 0, readOutboxMaxId: 0, unreadCount: 4, unreadMentionsCount: 0, unreadReactionsCount: 0, unreadPollVotesCount: 0, fromId: new Api.PeerUser({ userId: bigInt(12) }), notifySettings: new Api.PeerNotifySettings({}), peer: new Api.PeerChannel({ channelId: bigInt(21) }) })];
  const tpeer = new Api.PeerChannel({ channelId: bigInt(21) });
  (tg as any).getThread = async (_p: any, top: number) => [new Api.Message({ id: top + 2, peerId: tpeer, date: now - 30, message: "رسالة في الموضوع " + top, fromId: new Api.PeerUser({ userId: bigInt(11) }), replyTo: new Api.MessageReplyHeader({ replyToMsgId: top, replyToTopId: top, forumTopic: true }) })];
  (tg as any).getByIds = async (_p: any, ids: number[]) => ids.map((id) => new Api.Message({ id, peerId: tpeer, date: now - 99, message: "بداية الموضوع" }));
  (tg as any).sendInThread = async (_p: any, text: string, top: number, replyTo?: number) => { calls.push({ type: "sendInThread", text, top, replyTo }); return new Api.Message({ id: 999, peerId: tpeer, date: now, out: true, message: text, replyTo: new Api.MessageReplyHeader({ replyToMsgId: top, replyToTopId: top }) }); };
  (tg as any).getPinned = async () => undefined;
  (tg as any).getMemberCount = async () => 3;
  (tg as any).markRead = async () => {};
  (tg as any).setTyping = async () => {};
  (tg as any).getEntity = async () => sara;
  (tg as any).getHistory = async () => [new Api.Message({ id: 5, peerId: new Api.PeerChannel({ channelId: bigInt(22) }), date: now - 60, message: "خبر مهم النهارده", post: true, views: 12345, replies: new Api.MessageReplies({ comments: true, replies: 5, repliesPts: 1, channelId: bigInt(23) }) })];
  (tg as any).getDiscussion = async (_c: any, id: number) => { calls.push({ type: "getDiscussion", id }); return { chat: disc, topId: 700 }; };
  const nav: any = { onBack: () => calls.push({ type: "back" }), onOpenChat: (d: any) => calls.push({ type: "openChat", t: d.title }), onOpenTopic: (t: any) => { calls.push({ type: "openTopic", t }); renderChat({ entity: grp, title: grp.title, isGroup: true } as any, { onBack: () => {} }, { thread: t }); }, onOpenAll: () => calls.push({ type: "all" }), onOpenInfo: () => {} };
  (window as any).grp = grp; (window as any).memberMenu = memberMenu; (window as any).users = { sara, omar };
  if (screen === "manage") renderManage({ entity: grp, title: grp.title, isGroup: true } as any, nav);
  else if (screen === "members") renderChatInfo({ entity: grp, title: grp.title, isGroup: true } as any, { ...nav, onMemberMenu: (u: any, p: any, x: number, y: number) => memberMenu(grp, u, p, x, y, () => calls.push({ type: "changed" }), nav.onOpenChat) });
  else if (screen === "topics") renderTopics({ entity: grp, title: grp.title, isGroup: true } as any, nav);
  else renderChat({ entity: ch, title: ch.title, isChannel: true } as any, { onBack: () => {}, onOpenThread: (d: any, t: any) => calls.push({ type: "openThread", chat: d.title, t }) });
}
else if (screen === "list2" || screen === "info" || screen === "contacts" || screen === "newgroup" || screen === "invite") {
  const now = Math.floor(Date.now() / 1000);
  const calls: any[] = ((window as any).calls = []);
  const U = (id: number, first: string, extra: any = {}) => new Api.User({ id: bigInt(id), firstName: first, accessHash: bigInt(id), ...extra });
  const C = (id: number, title: string, extra: any = {}) => new Api.Channel({ id: bigInt(id), title, photo: new Api.ChatPhotoEmpty(), date: now, accessHash: bigInt(id), ...extra });
  const sara = U(11, "سارة", { premium: true, contact: true, username: "sara_x", phone: "201000000011" });
  const karim = U(12, "كريم", { contact: true });
  const bot = U(13, "BotFather", { bot: true, username: "BotFather" });
  const work = C(21, "فريق الشغل", { megagroup: true, participantsCount: 42 });
  const news = C(22, "قناة الأخبار", { broadcast: true, participantsCount: 150000, username: "news" });
  const oldGroup = C(23, "جروب قديم", { megagroup: true });
  const msg = (o: any) => new Api.Message({ date: now - 300, message: "", ...o });
  const D = (entity: any, o: any = {}) => ({
    entity, title: (entity as any).title || (entity as any).firstName, date: now - (o.ago ?? 300), unreadCount: o.unread ?? 0,
    isUser: entity instanceof Api.User, isGroup: !!(entity as any).megagroup, isChannel: entity instanceof Api.Channel,
    pinned: !!o.pinned, archived: !!o.archived, message: o.message ?? msg({ id: 1, message: o.text ?? "أهلاً" }),
    dialog: { notifySettings: { muteUntil: o.muted ? 2147483647 : 0 }, unreadMark: !!o.mark, draft: o.draft ? { message: o.draft } : undefined, readOutboxMaxId: o.read ?? 0, unreadMentionsCount: o.mentions ?? 0 },
  });
  const main = [
    D(sara, { pinned: true, unread: 3, message: msg({ id: 5, out: true, message: "هكلمك بالليل" }), read: 5 }),
    D(work, { unread: 12, mentions: 1, message: Object.assign(msg({ id: 6, message: "الاجتماع الساعة 3" }), { _sender: karim }) }),
    D(news, { unread: 250, muted: true, text: "خبر عاجل" }),
    D(karim, { draft: "لسه بكتب..." }),
    D(bot, { mark: true, text: "Done!" }),
  ];
  const arch = [D(oldGroup, { archived: true, unread: 2 })];
  (tg as any).getDialogs = async (_l: number, archived: boolean) => (archived ? arch : main);
  (tg as any).getFolders = async () => [new Api.DialogFilter({ id: 2, title: new Api.TextWithEntities({ text: "شغل", entities: [] }), emoticon: "💼", pinnedPeers: [], includePeers: [new Api.InputPeerUser({ userId: bigInt(12), accessHash: bigInt(12) })], excludePeers: [], groups: true })];
  (tg as any).searchPeers = async () => ({ mine: [], global: [C(30, "قناة عامة", { broadcast: true, username: "public_ch", participantsCount: 5000 })] });
  (tg as any).searchMessages = async (q: string) => [{ msg: msg({ id: 77, peerId: new Api.PeerChannel({ channelId: bigInt(22) }), message: "فيه " + q + " هنا" }), chat: news }];
  for (const fn of ["setPinned", "setMuteUntil", "setArchived", "setUnreadMark", "leave", "deleteChat", "setBlocked"]) (tg as any)[fn] = async (...a: any[]) => calls.push({ type: fn, args: a.slice(1) });
  (tg as any).getFull = async (e: any) => e instanceof Api.User ? { about: "بحب البرمجة 💻 تابعني t.me/sara_x", commonChats: 3, blocked: false } : { about: "جروب الفريق", members: 42, online: 7, invite: "https://t.me/+AbCdEfGh123" };
  (tg as any).sharedMedia = async (_e: any, kind: string) => kind === "links" ? [msg({ id: 40, message: "شوف example.com", entities: [new Api.MessageEntityUrl({ offset: 4, length: 11 })] })] : [];
  (tg as any).getMembers = async () => ({ users: [karim, sara, bot], parts: new Map<string, any>([["12", new Api.ChannelParticipantCreator({ userId: bigInt(12), adminRights: new Api.ChatAdminRights({}) })], ["11", new Api.ChannelParticipantAdmin({ userId: bigInt(11), promotedBy: bigInt(12), date: now, adminRights: new Api.ChatAdminRights({}), rank: "مشرفة" })]]) });
  (tg as any).getContacts = async () => [karim, sara];
  (tg as any).createGroup = async (title: string, users: any[]) => { calls.push({ type: "createGroup", title, users: users.map((u: any) => u.firstName) }); return C(99, title, { megagroup: true }); };
  (tg as any).checkInvite = async () => new Api.ChatInvite({ title: "جروب المطورين", about: "نقاشات برمجة", participantsCount: 812, megagroup: true, photo: new Api.PhotoEmpty({ id: bigInt(0) }), color: 0 });
  (tg as any).joinInvite = async (h: string) => { calls.push({ type: "joinInvite", h }); return C(98, "جروب المطورين", { megagroup: true }); };
  (tg as any).profilePhoto = async () => undefined;
  const nav: any = {
    onOpenChat: (d: any, j?: number) => calls.push({ type: "openChat", title: d.title || d.entity?.title || d.entity?.firstName, jumpTo: j }),
    onOpenSettings: () => {}, onOpenPeer: (t: string) => calls.push({ type: "openPeer", t }), onNew: (k: string) => calls.push({ type: "new", k }), onBack: () => calls.push({ type: "back" }),
  };
  (window as any).nav = nav;
  if (screen === "list2") renderChatList(nav);
  else if (screen === "info") renderChatInfo((main[1] as any), nav);
  else if (screen === "contacts") renderContacts(nav);
  else if (screen === "newgroup") renderCreateGroup(nav);
  else { renderChatList(nav); void openInvite("AbCdEfGh123", nav); }
}
else if (screen === "chat2") {
  const B = (globalThis as any).Buffer;
  const now = Math.floor(Date.now() / 1000);
  const chat = new Api.Chat({ id: bigInt(555), title: "جروب التجربة", photo: new Api.ChatPhotoEmpty(), participantsCount: 1234, date: now, version: 1 });
  const peerId = new Api.PeerChat({ chatId: bigInt(555) });
  const U = (id: number, first: string) => new Api.User({ id: bigInt(id), firstName: first, premium: id === 11 });
  const users: Record<string, any> = { "11": U(11, "سارة"), "12": U(12, "كريم"), "13": U(13, "Ali") };
  const from = (id: number) => new Api.PeerUser({ userId: bigInt(id) });
  const M = (o: any) => new Api.Message({ peerId, date: now - 7200, ...o });
  const photo = new Api.Photo({ id: bigInt(1), accessHash: bigInt(1), fileReference: B.alloc(1), date: now, dcId: 2, sizes: [new Api.PhotoSize({ type: "x", w: 320, h: 200, size: 4000 })] });
  const opt = (s: string) => B.from(s);
  const ent = (C: any, text: string, part: string, extra: any = {}) => new C({ offset: text.indexOf(part), length: part.length, ...extra });
  const T2 = "أهلاً بيكم 👋 ده نص مهم عادي";
  const T3 = "شوف اللينك ده google.com وكلم @durov — وده سر مخفي واكتب npm i ودوس هنا";
  const msgs: any[] = [
    new Api.MessageService({ id: 1, peerId, date: now - 90000, fromId: from(12), action: new Api.MessageActionChatJoinedByLink({ inviterId: bigInt(11) }) }),
    M({ id: 2, fromId: from(11), date: now - 86000, message: T2, entities: [ent(Api.MessageEntityBold, T2, "نص مهم")],
        reactions: new Api.MessageReactions({ results: [new Api.ReactionCount({ reaction: new Api.ReactionEmoji({ emoticon: "❤️" }), count: 5, chosenOrder: 0 }), new Api.ReactionCount({ reaction: new Api.ReactionEmoji({ emoticon: "👍" }), count: 2 })] }) }),
    M({ id: 3, fromId: from(12), message: T3, entities: [ent(Api.MessageEntityUrl, T3, "google.com"), ent(Api.MessageEntityMention, T3, "@durov"), ent(Api.MessageEntitySpoiler, T3, "سر مخفي"), ent(Api.MessageEntityCode, T3, "npm i"), ent(Api.MessageEntityTextUrl, T3, "هنا", { url: "javascript:alert(1)" })] }),
    M({ id: 4, out: true, message: "تمام، هبص عليه", replyTo: new Api.MessageReplyHeader({ replyToMsgId: 3 }) }),
    M({ id: 5, fromId: from(13), message: "خبر مهم", fwdFrom: new Api.MessageFwdHeader({ date: now - 99999, fromName: "قناة الأخبار" }), editDate: now - 100 }),
    M({ id: 6, fromId: from(11), media: new Api.MessageMediaPoll({
        poll: new Api.Poll({ id: bigInt(9), question: new Api.TextWithEntities({ text: "نتقابل إمتى؟", entities: [] }), answers: [
          new Api.PollAnswer({ text: new Api.TextWithEntities({ text: "الصبح", entities: [] }), option: opt("a") }),
          new Api.PollAnswer({ text: new Api.TextWithEntities({ text: "بالليل", entities: [] }), option: opt("b") }) ] }),
        results: new Api.PollResults({ results: [], totalVoters: 0 }) }) }),
    M({ id: 7, fromId: from(12), groupedId: bigInt(77), media: new Api.MessageMediaPhoto({ photo }) }),
    M({ id: 8, fromId: from(12), groupedId: bigInt(77), media: new Api.MessageMediaPhoto({ photo }), message: "صور الرحلة" }),
    M({ id: 9, fromId: from(13), media: new Api.MessageMediaGeo({ geo: new Api.GeoPoint({ lat: 30.0444, long: 31.2357, accessHash: bigInt(0) }) }) }),
    M({ id: 10, fromId: from(11), media: new Api.MessageMediaContact({ phoneNumber: "201001234567", firstName: "أحمد", lastName: "علي", vcard: "", userId: bigInt(0) }) }),
    M({ id: 11, fromId: from(13), message: "اختار:", replyMarkup: new Api.ReplyInlineMarkup({ rows: [
      new Api.KeyboardInlineButtonRow({ buttons: [ new Api.KeyboardInlineButton({ text: "موافق", type: new Api.InlineButtonTypeCallback({ data: B.from("ok") }) }), new Api.KeyboardInlineButton({ text: "الموقع", type: new Api.InlineButtonTypeUrl({ url: "https://example.com" }) }) ] }) ] }) }),
    M({ id: 12, out: true, date: now - 60, message: "آخر رسالة مني", pinned: true }),
  ];
  const calls: any[] = ((window as any).calls = []);
  (tg as any).getHistory = async () => [...msgs].reverse();
  (tg as any).getOlder = async () => [];
  (tg as any).getByIds = async (_p: any, ids: number[]) => ids.map((id) => msgs.find((m) => m.id === id));
  (tg as any).getEntity = async (p: any) => users[String(p?.userId ?? p)] ?? U(99, "مجهول");
  (tg as any).getPinned = async () => msgs[11];
  (tg as any).getMemberCount = async () => 1234;
  (tg as any).markRead = async () => {};
  (tg as any).setTyping = async () => {};
  (tg as any).downloadMedia = async () => new Uint8Array(8);
  (tg as any).pressButton = async (_p: any, id: number, data: any) => { calls.push({ type: "button", id, data: B.from(data).toString() }); return { message: "تم ✓" }; };
  (tg as any).react = async (_p: any, id: number, emojis: string[]) => calls.push({ type: "react", id, emojis });
  (tg as any).vote = async (_p: any, id: number, o: any[]) => calls.push({ type: "vote", id, opts: o.map((x: any) => B.from(x).toString()) });
  (tg as any).send = async (_p: any, text: string, replyTo?: number) => { calls.push({ type: "send", text, replyTo }); return M({ id: 13 + calls.length, out: true, date: now, message: text, replyTo: replyTo ? new Api.MessageReplyHeader({ replyToMsgId: replyTo }) : undefined }); };
  (tg as any).editText = async (_p: any, id: number, text: string) => { calls.push({ type: "edit", id, text }); return M({ id, out: true, date: now, message: text, editDate: now }); };
  (tg as any).deleteMsgs = async (_p: any, ids: number[], revoke: boolean) => calls.push({ type: "delete", ids, revoke });
  (tg as any).searchInChat = async (_p: any, q: string) => msgs.filter((m) => m.message?.includes(q));
  (tg as any).me = { premium: true };
  (tg as any).sendVoice = async (_p: any, blob: Blob, duration: number, waveform: Uint8Array) => {
    const head = new Uint8Array(await blob.slice(0, 64).arrayBuffer());
    calls.push({ type: "voice", size: blob.size, mime: blob.type, duration, wf: waveform.length, magic: String.fromCharCode(...head.slice(0, 4)), opusHead: new TextDecoder().decode(head).includes("OpusHead") });
    return M({ id: 900, out: true, date: now, message: "" });
  };
  (window as any).tg = tg;
  (window as any).Api = Api;
  (window as any).mkMsg = (o: any) => M(o);
  renderChat({ entity: chat, title: "جروب التجربة", isGroup: true, dialog: { readOutboxMaxId: 4 } } as any, { onBack: () => {}, onOpenPeer: (t: string) => calls.push({ type: "openPeer", t }) });
}
else if (screen === "premium") {
  // Minimal 1-layer Lottie (red square moving), gzipped like a real .tgs
  const lottieJson = { v: "5.5.2", fr: 30, ip: 0, op: 30, w: 100, h: 100, assets: [], layers: [{ ddd: 0, ind: 1, ty: 4, nm: "sq", sr: 1, ip: 0, op: 30, st: 0, bm: 0, ao: 0, ks: { o: { a: 0, k: 100 }, r: { a: 0, k: 0 }, p: { a: 1, k: [{ t: 0, s: [30, 50, 0], i: { x: [0.5], y: [0.5] }, o: { x: [0.5], y: [0.5] } }, { t: 30, s: [70, 50, 0] }] }, a: { a: 0, k: [0, 0, 0] }, s: { a: 0, k: [100, 100, 100] } }, shapes: [{ ty: "gr", it: [{ ty: "rc", d: 1, s: { a: 0, k: [40, 40] }, p: { a: 0, k: [0, 0] }, r: { a: 0, k: 0 } }, { ty: "fl", c: { a: 0, k: [1, 0, 0, 1] }, o: { a: 0, k: 100 }, r: 1 }, { ty: "tr", p: { a: 0, k: [0, 0] }, a: { a: 0, k: [0, 0] }, s: { a: 0, k: [100, 100] }, r: { a: 0, k: 0 }, o: { a: 0, k: 100 } }] }] }] };
  const gz = async (txt: string) => new Uint8Array(await new Response(new Blob([txt]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer());
  const tgsBytes = await gz(JSON.stringify(lottieJson));
  const { playTgs, customEmojiEl } = await import("../src/features/premiumMedia");
  const { openReactionPicker } = await import("../src/ui/chat/menu");
  (tg as any).me = { premium: true };
  (tg as any).getCustomEmojiDocs = async (ids: string[]) => ids.map((id) => new Api.Document({ id: bigInt(id), accessHash: bigInt(0), fileReference: (globalThis as any).Buffer.alloc(0), date: 0, mimeType: id === "1" ? "application/x-tgsticker" : "image/webp", size: bigInt(1), dcId: 2, attributes: [] }));
  (tg as any).downloadDocument = async (d: any) => (String(d.id) === "1" ? tgsBytes : new Uint8Array(0));
  (tg as any).reactionChoices = async () => ({ standard: ["👍", "❤️", "🔥", "🤯"], custom: ["ce:1", "ce:2"] });
  const out: any[] = [];
  (window as any).picked = out;
  const sticker = document.createElement("div");
  sticker.id = "sticker";
  sticker.style.cssText = "width:120px;height:120px";
  const ce = customEmojiEl("1", 32, "😀");
  ce.id = "ce";
  document.body.append(sticker, ce);
  await playTgs(sticker, tgsBytes);
  (window as any).openPicker = () => openReactionPicker(["👍"], (k) => out.push(k));
}
else if (screen === "insight") {
  const { renderUserInsight } = await import("../src/ui/userInsight");
  const now = Math.floor(Date.now() / 1000);
  const u = new Api.User({ id: bigInt(123456789), firstName: "أحمد", lastName: "سمير", username: "ahmed_s", phone: "201001234567", premium: true, contact: true, mutualContact: true, status: new Api.UserStatusOffline({ wasOnline: now - 5400 }) } as any);
  const g1 = new Api.Channel({ id: bigInt(11), title: "جروب المطورين", megagroup: true, participantsCount: 812, photo: new Api.ChatPhotoEmpty(), date: now } as any);
  const g2 = new Api.Chat({ id: bigInt(22), title: "العيلة", participantsCount: 14, photo: new Api.ChatPhotoEmpty(), date: now, version: 1 } as any);
  const c1 = new Api.Channel({ id: bigInt(33), title: "قناة الأخبار", broadcast: true, participantsCount: 25000, username: "news", photo: new Api.ChatPhotoEmpty(), date: now } as any);
  (tg as any).userFull = async () => ({ user: u, full: { about: "مطوّر iOS 📱", commonChatsCount: 3, birthday: { day: 12, month: 5, year: 1995 }, blocked: false } });
  (tg as any).commonChats = async () => [g1, g2, c1];
  (tg as any).memberRecord = async (c: any) => (c === g1 ? { role: "admin", rank: "مشرف", joined: now - 86400 * 400 } : c === g2 ? { role: "creator", joined: now - 86400 * 900 } : { role: "member", joined: now - 86400 * 30 });
  (tg as any).messagesFrom = async (c: any) => (c === g1 ? [new Api.Message({ id: 50, date: now - 600, message: "حد جرّب Swift 6؟", peerId: new Api.PeerChannel({ channelId: bigInt(11) }) } as any), new Api.Message({ id: 40, date: now - 90000, message: "صباح الخير", peerId: new Api.PeerChannel({ channelId: bigInt(11) }) } as any)] : [new Api.Message({ id: 7, date: now - 3600, message: "هنتغدى فين؟", peerId: new Api.PeerChat({ chatId: bigInt(22) }) } as any)]);
  const opened: any[] = [];
  (window as any).opened = opened;
  await renderUserInsight(u, { onBack: () => {}, onOpenChat: (d: any, j?: number) => opened.push([d.title || d.entity?.title, j]) });
}
else if (screen === "chat") {
  (tg as any).getHistory = async () => [
    { id: 2, out: true, date: Math.floor(Date.now() / 1000), message: "تمام، اتفقنا" },
    { id: 1, out: false, date: Math.floor(Date.now() / 1000) - 60, message: "رسالة للتجربة 123" },
  ];
  (tg as any).markRead = async () => {};
  renderChat(fake[3] as any, { onBack: () => {} });
}
else renderChatList(nav);
