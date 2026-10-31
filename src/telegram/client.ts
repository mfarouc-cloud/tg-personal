// Thin wrapper around teleproto (GramJS-compatible MTProto client) tuned for
// a browser PWA. Owns the client lifecycle, auth flow, data fetching, and a
// small pub/sub for live updates (new / edited / deleted messages).
import {
  TelegramClient,
  Api,
  sessions,
  password as pwdHelper,
  WebSocketTransport,
  utils,
} from "teleproto";
import { NewMessage } from "teleproto/events";
import type { NewMessageEvent } from "teleproto/events";
import {
  loadCredentials,
  loadSession,
  saveSession,
  type ApiCredentials,
} from "./config";
import { isOn } from "../features/registry";
import bigInt from "big-integer";
import { Buffer } from "buffer";

const { StringSession } = sessions;

export type ConnState = "disconnected" | "connecting" | "connected";

export interface TGEventMap {
  newMessage: { chatId: string; message: Api.Message };
  editedMessage: { chatId: string; message: Api.Message };
  deletedMessages: { chatId: string | null; ids: number[] };
  transcribed: { msgId: number; transcriptionId: string; text: string; pending: boolean };
  /** Outgoing messages up to maxId were read by the other side. */
  readOutbox: { peerKey: string; maxId: number };
  /** Someone is typing / recording in a chat. */
  typing: { peerKey: string; userId: string; action: string };
  userStatus: { userId: string; status: Api.TypeUserStatus };
  reactions: { peerKey: string; msgId: number; reactions: Api.MessageReactions };
  connState: ConnState;
}

type Listener<K extends keyof TGEventMap> = (payload: TGEventMap[K]) => void;

class TG {
  private client: TelegramClient | null = null;
  private creds: ApiCredentials | null = null;
  private listeners: { [K in keyof TGEventMap]: Set<Listener<K>> } = {
    newMessage: new Set(),
    editedMessage: new Set(),
    deletedMessages: new Set(),
    transcribed: new Set(),
    readOutbox: new Set(),
    typing: new Set(),
    userStatus: new Set(),
    reactions: new Set(),
    connState: new Set(),
  };

  state: ConnState = "disconnected";

  on<K extends keyof TGEventMap>(evt: K, cb: Listener<K>): () => void {
    this.listeners[evt].add(cb);
    return () => this.listeners[evt].delete(cb);
  }

  private emit<K extends keyof TGEventMap>(evt: K, payload: TGEventMap[K]): void {
    for (const cb of this.listeners[evt]) {
      try {
        cb(payload);
      } catch (e) {
        console.error("[tg] listener error", e);
      }
    }
  }

  private setState(s: ConnState): void {
    this.state = s;
    this.emit("connState", s);
  }

  get raw(): TelegramClient {
    if (!this.client) throw new Error("client not initialised");
    return this.client;
  }

  isInitialised(): boolean {
    return this.client !== null;
  }

  /** Build the client from stored credentials + session. Does not connect. */
  init(creds?: ApiCredentials): void {
    this.creds = creds ?? loadCredentials();
    if (!this.creds) throw new Error("no API credentials");
    const session = new StringSession(loadSession());
    this.client = new TelegramClient(session, this.creds.apiId, this.creds.apiHash, {
      // Browsers can't open raw TCP sockets — force secure WebSocket
      // (wss://<dc>.web.telegram.org/apiws), same as Telegram Web.
      transport: new WebSocketTransport(),
      connectionRetries: 5,
      autoReconnect: true,
      retryDelay: 2000,
      appVersion: "tg-personal 0.5.0",
      deviceModel: "PWA",
      systemVersion: navigator.userAgent.slice(0, 40),
    });
    // Debug switch: localStorage.setItem("tg.log", "debug") then reload.
    const lvl = localStorage.getItem("tg.log");
    if (lvl) this.client.setLogLevel(lvl as any);
  }

  async connect(): Promise<void> {
    if (!this.client) this.init();
    if (this.state === "connected") return;
    this.setState("connecting");
    await this.raw.connect();
    this.setState("connected");
    this.persist();
  }

  async disconnect(): Promise<void> {
    if (this.client) await this.raw.disconnect();
    this.setState("disconnected");
  }

  private persist(): void {
    if (!this.client) return;
    const s = this.raw.session.save();
    if (typeof s === "string") saveSession(s);
  }

  /** True if the stored session is already authorised. */
  async isAuthorised(): Promise<boolean> {
    try {
      return await this.raw.checkAuthorization();
    } catch {
      return false;
    }
  }

  // ---- Auth flow ----
  async sendCode(phone: string): Promise<{ phoneCodeHash: string; viaApp: boolean }> {
    if (!this.creds) throw new Error("no creds");
    const res = await this.raw.sendCode(
      { apiId: this.creds.apiId, apiHash: this.creds.apiHash },
      phone.trim(),
    );
    return { phoneCodeHash: res.phoneCodeHash, viaApp: res.isCodeViaApp };
  }

  /** Returns "ok" | "password" (2FA needed). Throws on bad/expired code. */
  async signInWithCode(
    phone: string,
    phoneCodeHash: string,
    code: string,
  ): Promise<"ok" | "password"> {
    try {
      await this.raw.invoke(
        new Api.auth.SignIn({
          phoneNumber: phone.trim(),
          phoneCodeHash,
          phoneCode: code.trim(),
        }),
      );
      this.persist();
      return "ok";
    } catch (err: any) {
      if (String(err?.errorMessage || err?.message).includes("SESSION_PASSWORD_NEEDED")) {
        return "password";
      }
      throw err;
    }
  }

  async signInWithPassword(pw: string): Promise<void> {
    const pwInfo = await this.raw.invoke(new Api.account.GetPassword());
    const check = await pwdHelper.computeCheck(pwInfo, pw);
    await this.raw.invoke(new Api.auth.CheckPassword({ password: check }));
    this.persist();
  }

  // ---- Data ----
  /** The signed-in user. Calling getMe also tells teleproto the account is
   *  Premium, which raises upload limits and parallel download workers. */
  me: Api.User | null = null;

  async getMe(): Promise<Api.User> {
    this.me = (await this.raw.getMe()) as Api.User;
    return this.me;
  }

  get isPremium(): boolean {
    return !!this.me?.premium;
  }

  /** Max upload size for this account: 512 KB × (8000 Premium | 4000 free) parts. */
  get maxUploadBytes(): number {
    return (this.isPremium ? 8000 : 4000) * 512 * 1024;
  }

  // ---- Premium: voice/video-note → text ----
  async transcribe(
    peer: Api.TypeEntityLike,
    msgId: number,
  ): Promise<{ pending: boolean; text: string; transcriptionId: string }> {
    const res = await this.raw.invoke(
      new Api.messages.TranscribeAudio({ peer: (await this.raw.getInputEntity(peer)) as any, msgId }),
    );
    return { pending: !!res.pending, text: res.text, transcriptionId: String(res.transcriptionId) };
  }

  // ---- Premium: in-chat translation ----
  async translate(peer: Api.TypeEntityLike, ids: number[], toLang: string): Promise<string[]> {
    const res = await this.raw.invoke(
      new Api.messages.TranslateText({ peer: (await this.raw.getInputEntity(peer)) as any, id: ids, toLang }),
    );
    return res.result.map((r) => r.text);
  }

  // ---- Sending files (streams big files in 512 KB parts) ----
  /**
   * Upload a File without loading it all into memory (teleproto's browser path
   * calls file.arrayBuffer() on the whole file, which breaks at multi-GB).
   * Returns an InputFile handle that sendFile accepts.
   */
  /** True while an upload is paused waiting for connection / foreground. */
  uploadStalled = false;

  /** Resolves once the app is in the foreground and MTProto is connected again. */
  private waitResumable(signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const check = () => {
        if (signal?.aborted) {
          cleanup();
          reject(new Error("CANCELLED"));
        } else if (document.visibilityState === "visible" && this.state === "connected") {
          cleanup();
          resolve();
        } else if (document.visibilityState === "visible" && this.state === "disconnected") {
          void this.connect().catch(() => {});
        }
      };
      const timer = window.setInterval(check, 2000);
      const off = this.on("connState", check);
      document.addEventListener("visibilitychange", check);
      const cleanup = () => {
        clearInterval(timer);
        (off as any)?.();
        document.removeEventListener("visibilitychange", check);
      };
      check();
    });
  }

  async uploadLarge(
    file: File,
    onProgress?: (ratio: number) => void,
    signal?: AbortSignal,
  ): Promise<Api.InputFileBig | Api.InputFile> {
    const PART = 512 * 1024;
    const total = Math.ceil(file.size / PART) || 1;
    if (file.size > this.maxUploadBytes) throw new Error("FILE_TOO_BIG");
    const big = file.size > 10 * 1024 * 1024;
    const idBytes = crypto.getRandomValues(new Uint8Array(8));
    let idHex = "";
    for (const b of idBytes) idHex += b.toString(16).padStart(2, "0");
    const fileId = bigInt(idHex, 16);
    let next = 0;
    let done = 0;
    const worker = async () => {
      while (next < total) {
        if (signal?.aborted) throw new Error("CANCELLED");
        const part = next++;
        const bytes = Buffer.from(await file.slice(part * PART, (part + 1) * PART).arrayBuffer());
        for (let attempt = 0; ; attempt++) {
          try {
            await this.raw.invoke(
              big
                ? new Api.upload.SaveBigFilePart({ fileId, filePart: part, fileTotalParts: total, bytes })
                : new Api.upload.SaveFilePart({ fileId, filePart: part, bytes }),
            );
            break;
          } catch (e: any) {
            if (signal?.aborted) throw e;
            const msg = String(e?.errorMessage || e?.message || "");
            const flood = /FLOOD_WAIT_(\d+)/.exec(msg) || (e?.seconds ? [, String(e.seconds)] : null);
            if (flood) {
              await new Promise((r) => setTimeout(r, (Number(flood[1]) + 1) * 1000));
              continue;
            }
            // Hard API errors (bad part, file too big…) are final.
            if (/^[A-Z0-9_]+$/.test(msg) && !/TIMEOUT|CONNECTION|NETWORK/.test(msg) && attempt >= 3) throw e;
            // Network loss / app sent to background (iOS suspends the WebView and
            // drops the socket): wait until the app is visible + reconnected, then
            // re-send this same part with the same fileId so the upload resumes.
            this.uploadStalled = true;
            await this.waitResumable(signal);
            this.uploadStalled = false;
            await new Promise((r) => setTimeout(r, Math.min(1000 * (attempt + 1), 5000)));
          }
        }
        onProgress?.(++done / total);
      }
    };
    const workers = this.isPremium ? 6 : 4;
    await Promise.all(Array.from({ length: Math.min(workers, total) }, worker));
    return big
      ? new Api.InputFileBig({ id: fileId, parts: total, name: file.name })
      : new Api.InputFile({ id: fileId, parts: total, name: file.name, md5Checksum: "" });
  }

  async sendFile(
    peer: Api.TypeEntityLike,
    file: File,
    opts: {
      caption?: string;
      onProgress?: (r: number) => void;
      signal?: AbortSignal;
      asDocument?: boolean;
      replyTo?: number;
      topMsgId?: number;
    } = {},
  ): Promise<Api.Message> {
    const isImage = /^image\/(jpeg|png|webp)$/.test(file.type) && file.size < 10 * 1024 * 1024;
    const isVideo = file.type.startsWith("video/");
    const isAudio = file.type.startsWith("audio/");
    const attributes: any[] = [new Api.DocumentAttributeFilename({ fileName: file.name })];
    if (isVideo && !opts.asDocument) {
      const meta = await videoMeta(file);
      attributes.push(new Api.DocumentAttributeVideo({ duration: meta.duration, w: meta.w, h: meta.h, supportsStreaming: true }));
    }
    if (isAudio && !opts.asDocument) {
      attributes.push(new Api.DocumentAttributeAudio({ duration: Math.round((await mediaDuration(file)) || 0) }));
    }
    const handle = await this.uploadLarge(file, opts.onProgress, opts.signal);
    if (isImage && !opts.asDocument) {
      return (await this.raw.sendFile(peer, { file: handle, caption: opts.caption, replyTo: opts.replyTo, topMsgId: opts.topMsgId } as any)) as Api.Message;
    }
    const media = new Api.InputMediaUploadedDocument({
      file: handle,
      mimeType: file.type || "application/octet-stream",
      attributes,
      forceFile: !!opts.asDocument || (!isVideo && !isAudio),
    });
    return (await this.raw.sendFile(peer, { file: media, caption: opts.caption, replyTo: opts.replyTo, topMsgId: opts.topMsgId } as any)) as Api.Message;
  }

  /** Real voice note (OGG/Opus + waveform), shows as a voice message everywhere. */
  async sendVoice(
    peer: Api.TypeEntityLike,
    ogg: Blob,
    duration: number,
    waveform: Uint8Array,
    replyTo?: number,
    topMsgId?: number,
  ): Promise<Api.Message> {
    const file = new File([ogg], `voice_${Date.now()}.ogg`, { type: "audio/ogg" });
    const handle = await this.uploadLarge(file);
    const media = new Api.InputMediaUploadedDocument({
      file: handle,
      mimeType: "audio/ogg",
      attributes: [new Api.DocumentAttributeAudio({ voice: true, duration, waveform: Buffer.from(waveform) })],
    });
    return (await this.raw.sendFile(peer, { file: media, replyTo, topMsgId, voiceNote: true } as any)) as Api.Message;
  }

  async getDialogs(limit = 60, archived = false) {
    const dialogs = await this.raw.getDialogs({ limit, archived } as any);
    this.persist();
    return dialogs;
  }

  // ================= Chat list management =================
  private async inputPeer(entity: any): Promise<any> {
    return this.raw.getInputEntity(entity);
  }

  /** Your Telegram chat folders (excluding the built-in "All chats"). */
  async getFolders(): Promise<(Api.DialogFilter | Api.DialogFilterChatlist)[]> {
    const res: any = await this.raw.invoke(new Api.messages.GetDialogFilters());
    const list: any[] = Array.isArray(res) ? res : res.filters ?? [];
    return list.filter((f) => f instanceof Api.DialogFilter || f instanceof Api.DialogFilterChatlist);
  }

  async setArchived(entity: any, archived: boolean): Promise<void> {
    await this.raw.invoke(
      new Api.folders.EditPeerFolders({
        folderPeers: [new Api.InputFolderPeer({ peer: await this.inputPeer(entity), folderId: archived ? 1 : 0 })],
      }),
    );
  }

  async setPinned(entity: any, pinned: boolean): Promise<void> {
    await this.raw.invoke(
      // teleproto casts any entity to InputDialogPeer itself (tl/runtime/inputCasts).
      new Api.messages.ToggleDialogPin({ peer: entity, pinned }),
    );
  }

  /** Mute until a unix time (0 = unmute, 2147483647 = forever). */
  async setMuteUntil(entity: any, until: number): Promise<void> {
    await this.raw.invoke(
      new Api.account.UpdateNotifySettings({
        peer: entity, // cast to InputNotifyPeer by teleproto
        settings: new Api.InputPeerNotifySettings({ muteUntil: until }),
      }),
    );
  }

  async setUnreadMark(entity: any, unread: boolean): Promise<void> {
    if (!unread) await this.raw.markAsRead(entity).catch(() => {});
    await this.raw.invoke(
      new Api.messages.MarkDialogUnread({ peer: entity, unread }),
    );
  }

  /** Leave a group/channel. */
  async leave(entity: any): Promise<void> {
    if (entity instanceof Api.Channel) {
      await this.raw.invoke(new Api.channels.LeaveChannel({ channel: await this.inputPeer(entity) }));
    } else if (entity instanceof Api.Chat) {
      await this.raw.invoke(new Api.messages.DeleteChatUser({ chatId: entity.id, userId: new Api.InputUserSelf() }));
    }
  }

  /** Delete a private chat (optionally for both sides) or clear its history. */
  async deleteChat(entity: any, opts: { revoke?: boolean; justClear?: boolean } = {}): Promise<void> {
    await this.raw.invoke(
      new Api.messages.DeleteHistory({
        peer: await this.inputPeer(entity),
        maxId: 0,
        revoke: !!opts.revoke,
        justClear: !!opts.justClear,
      }),
    );
  }

  async setBlocked(user: any, blocked: boolean): Promise<void> {
    const id = await this.inputPeer(user);
    await this.raw.invoke(blocked ? new Api.contacts.Block({ id }) : new Api.contacts.Unblock({ id }));
  }

  async joinChannel(entity: any): Promise<void> {
    await this.raw.invoke(new Api.channels.JoinChannel({ channel: await this.inputPeer(entity) }));
  }

  /** Preview an invite link hash (t.me/+HASH or t.me/joinchat/HASH). */
  async checkInvite(hash: string): Promise<Api.TypeChatInvite> {
    return this.raw.invoke(new Api.messages.CheckChatInvite({ hash }));
  }

  /** Join via invite hash; returns the joined chat entity. */
  async joinInvite(hash: string): Promise<any> {
    const res: any = await this.raw.invoke(new Api.messages.ImportChatInvite({ hash }));
    return res.chats?.[0];
  }

  /** People, groups and channels matching `q` (yours first, then public). */
  async searchPeers(q: string): Promise<{ mine: any[]; global: any[] }> {
    const res = await this.raw.invoke(new Api.contacts.Search({ q, limit: 30 }));
    const byKey = new Map<string, any>();
    for (const u of res.users) byKey.set(peerKey(u), u);
    for (const c of res.chats) byKey.set(peerKey(c), c);
    const pick = (peers: Api.TypePeer[]) => peers.map((p) => byKey.get(peerKey(p))).filter(Boolean);
    return { mine: pick(res.myResults), global: pick(res.results) };
  }

  /** Message search across all chats. Each result carries its chat entity. */
  async searchMessages(q: string, limit = 30): Promise<{ msg: Api.Message; chat: any }[]> {
    const res: any = await this.raw.invoke(
      new Api.messages.SearchGlobal({
        q,
        filter: new Api.InputMessagesFilterEmpty(),
        minDate: 0,
        maxDate: 0,
        offsetRate: 0,
        offsetPeer: new Api.InputPeerEmpty(),
        offsetId: 0,
        limit,
      }),
    );
    const byKey = new Map<string, any>();
    for (const u of res.users ?? []) byKey.set(peerKey(u), u);
    for (const c of res.chats ?? []) byKey.set(peerKey(c), c);
    return (res.messages ?? [])
      .filter((m: any) => m instanceof Api.Message)
      .map((m: any) => ({ msg: m, chat: byKey.get(peerKey(m.peerId)) }))
      .filter((r: any) => r.chat);
  }

  /** About / bio, counts, invite link for the info page. */
  async getFull(entity: any): Promise<{ about?: string; members?: number; online?: number; invite?: string; blocked?: boolean; commonChats?: number }> {
    if (entity instanceof Api.User) {
      const r = await this.raw.invoke(new Api.users.GetFullUser({ id: await this.inputPeer(entity) }));
      return { about: r.fullUser.about, blocked: !!r.fullUser.blocked, commonChats: r.fullUser.commonChatsCount };
    }
    if (entity instanceof Api.Channel) {
      const r = await this.raw.invoke(new Api.channels.GetFullChannel({ channel: await this.inputPeer(entity) }));
      const f = r.fullChat as Api.ChannelFull;
      return { about: f.about, members: f.participantsCount, online: f.onlineCount, invite: (f.exportedInvite as any)?.link };
    }
    if (entity instanceof Api.Chat) {
      const r = await this.raw.invoke(new Api.messages.GetFullChat({ chatId: entity.id }));
      const f = r.fullChat as Api.ChatFull;
      const parts: any = f.participants;
      return { about: f.about, members: parts?.participants?.length ?? entity.participantsCount, invite: (f.exportedInvite as any)?.link };
    }
    return {};
  }

  /** Shared media of a chat by kind. */
  // ---------- Member details ("معلومات العضو") ----------
  /** Full profile of a user (bio, birthday, personal channel, common-chat count…). */
  async userFull(user: any): Promise<{ user: Api.User; full: Api.UserFull }> {
    const r = await this.raw.invoke(new Api.users.GetFullUser({ id: await this.inputPeer(user) }));
    const u = (r.users.find((x: any) => String(x.id) === String(user.id)) as Api.User) ?? user;
    return { user: u, full: r.fullUser };
  }

  /** Groups/channels that you and this user are both in (Telegram only exposes shared ones). */
  async commonChats(user: any, limit = 100): Promise<any[]> {
    const r = await this.raw.invoke(
      new Api.messages.GetCommonChats({ userId: utils.getInputUser(await this.inputPeer(user)), maxId: bigInt(0), limit }),
    );
    return r.chats.filter((c: any) => !(c instanceof Api.ChatForbidden) && !(c instanceof Api.ChannelForbidden));
  }

  /** The user's membership record in a chat: role, rank, join date. */
  async memberRecord(chat: any, user: any): Promise<{ role: "creator" | "admin" | "member" | "left" | "banned"; rank?: string; joined?: number }> {
    try {
      if (chat instanceof Api.Channel) {
        const r = await this.raw.invoke(new Api.channels.GetParticipant({ channel: chat as any, participant: await this.inputPeer(user) }));
        const p: any = r.participant;
        const role =
          p instanceof Api.ChannelParticipantCreator ? "creator"
          : p instanceof Api.ChannelParticipantAdmin ? "admin"
          : p instanceof Api.ChannelParticipantBanned ? "banned"
          : p instanceof Api.ChannelParticipantLeft ? "left"
          : "member";
        return { role, rank: p.rank, joined: p.date };
      }
      if (chat instanceof Api.Chat) {
        const f = await this.raw.invoke(new Api.messages.GetFullChat({ chatId: chat.id }));
        const parts: any = (f.fullChat as Api.ChatFull).participants;
        const p = parts?.participants?.find((x: any) => String(x.userId) === String(user.id));
        if (!p) return { role: "left" };
        const role = p instanceof Api.ChatParticipantCreator ? "creator" : p instanceof Api.ChatParticipantAdmin ? "admin" : "member";
        return { role, joined: p.date };
      }
    } catch {
      /* not visible */
    }
    return { role: "member" };
  }

  /** Latest messages this user sent in a given chat. */
  async messagesFrom(chat: any, user: any, limit = 10): Promise<Api.Message[]> {
    const res = (await this.raw.getMessages(chat, { fromUser: user, limit } as any)) as unknown as Api.Message[];
    return res.filter((m) => m instanceof Api.Message);
  }

  async sharedMedia(entity: any, kind: "media" | "files" | "links" | "voice" | "music", offsetId = 0): Promise<Api.Message[]> {
    const filter =
      kind === "media"
        ? new Api.InputMessagesFilterPhotoVideo()
        : kind === "files"
          ? new Api.InputMessagesFilterDocument()
          : kind === "links"
            ? new Api.InputMessagesFilterUrl()
            : kind === "voice"
              ? new Api.InputMessagesFilterRoundVoice()
              : new Api.InputMessagesFilterMusic();
    return (await this.raw.getMessages(entity, { filter, limit: 60, offsetId } as any)) as unknown as Api.Message[];
  }

  /** Group/channel members (recent first). */
  async getMembers(entity: any, offset = 0, limit = 100): Promise<{ users: any[]; parts: Map<string, any> }> {
    if (entity instanceof Api.Chat) {
      const r = await this.raw.invoke(new Api.messages.GetFullChat({ chatId: entity.id }));
      const parts = new Map<string, any>();
      for (const p of ((r.fullChat as any).participants?.participants ?? []) as any[]) parts.set(String(p.userId), p);
      return { users: r.users, parts };
    }
    const r: any = await this.raw.invoke(
      new Api.channels.GetParticipants({
        channel: await this.inputPeer(entity),
        filter: new Api.ChannelParticipantsRecent(),
        offset,
        limit,
        hash: bigInt(0),
      }),
    );
    const parts = new Map<string, any>();
    for (const p of r.participants ?? []) parts.set(String(p.userId ?? peerKey(p.peer)), p);
    return { users: r.users ?? [], parts };
  }

  async getContacts(): Promise<Api.User[]> {
    const r: any = await this.raw.invoke(new Api.contacts.GetContacts({ hash: bigInt(0) }));
    return (r.users ?? []) as Api.User[];
  }

  async addContact(phone: string, firstName: string, lastName = ""): Promise<Api.User | undefined> {
    const r = await this.raw.invoke(
      new Api.contacts.ImportContacts({
        contacts: [new Api.InputPhoneContact({ clientId: bigInt(Date.now()), phone, firstName, lastName })],
      }),
    );
    return r.users[0] as Api.User | undefined;
  }

  /** New supergroup with optional members. */
  async createGroup(title: string, users: any[]): Promise<any> {
    const r: any = await this.raw.invoke(new Api.channels.CreateChannel({ title, about: "", megagroup: true }));
    const chat = r.chats[0];
    if (users.length) {
      const inputs = await Promise.all(users.map((u) => this.inputPeer(u)));
      await this.raw.invoke(new Api.channels.InviteToChannel({ channel: await this.inputPeer(chat), users: inputs }));
    }
    return chat;
  }

  async createChannel(title: string, about: string): Promise<any> {
    const r: any = await this.raw.invoke(new Api.channels.CreateChannel({ title, about, broadcast: true }));
    return r.chats[0];
  }

  // ================= Groups & channels: administration =================
  /** Promote/demote. `rights` null = remove admin. Works for supergroups/channels and basic groups. */
  async setAdmin(chat: any, user: any, rights: Partial<Record<string, boolean>> | null, rank = ""): Promise<void> {
    if (chat instanceof Api.Chat) {
      await this.raw.invoke(new Api.messages.EditChatAdmin({ chatId: chat.id, userId: await this.inputPeer(user), isAdmin: !!rights }));
      return;
    }
    await this.raw.invoke(
      new Api.channels.EditAdmin({
        channel: await this.inputPeer(chat),
        userId: await this.inputPeer(user),
        adminRights: new Api.ChatAdminRights(rights ?? {}),
        rank: rights ? rank : "",
      }),
    );
  }

  /** Restrict / ban a member. Empty rights = lift all restrictions. */
  async setBanned(chat: any, user: any, rights: Partial<Record<string, boolean>>, untilDate = 0): Promise<void> {
    await this.raw.invoke(
      new Api.channels.EditBanned({
        channel: await this.inputPeer(chat),
        participant: await this.inputPeer(user),
        bannedRights: new Api.ChatBannedRights({ ...rights, untilDate }),
      }),
    );
  }

  /** Remove from the group without a permanent ban. */
  async kick(chat: any, user: any): Promise<void> {
    if (chat instanceof Api.Chat) {
      await this.raw.invoke(new Api.messages.DeleteChatUser({ chatId: chat.id, userId: await this.inputPeer(user) }));
      return;
    }
    await this.setBanned(chat, user, { viewMessages: true });
    await this.setBanned(chat, user, {});
  }

  async getParticipants(chat: any, kind: "admins" | "banned" | "search", q = ""): Promise<{ users: any[]; parts: Map<string, any> }> {
    const filter =
      kind === "admins"
        ? new Api.ChannelParticipantsAdmins()
        : kind === "banned"
          ? new Api.ChannelParticipantsKicked({ q })
          : new Api.ChannelParticipantsSearch({ q });
    const r: any = await this.raw.invoke(
      new Api.channels.GetParticipants({ channel: await this.inputPeer(chat), filter, offset: 0, limit: 200, hash: bigInt(0) }),
    );
    const parts = new Map<string, any>();
    for (const p of r.participants ?? []) parts.set(String(p.userId ?? peerKey(p.peer)), p);
    return { users: r.users ?? [], parts };
  }

  /** Default permissions for all members (true = allowed). */
  async setDefaultRights(chat: any, allowed: Record<string, boolean>): Promise<void> {
    const banned: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(allowed)) banned[k] = !v;
    await this.raw.invoke(
      new Api.messages.EditChatDefaultBannedRights({ peer: await this.inputPeer(chat), bannedRights: new Api.ChatBannedRights({ ...banned, untilDate: 0 }) }),
    );
  }

  async setSlowMode(chat: any, seconds: number): Promise<void> {
    await this.raw.invoke(new Api.channels.ToggleSlowMode({ channel: await this.inputPeer(chat), seconds }));
  }

  async editTitle(chat: any, title: string): Promise<void> {
    if (chat instanceof Api.Chat) await this.raw.invoke(new Api.messages.EditChatTitle({ chatId: chat.id, title }));
    else await this.raw.invoke(new Api.channels.EditTitle({ channel: await this.inputPeer(chat), title }));
  }

  async editAbout(chat: any, about: string): Promise<void> {
    await this.raw.invoke(new Api.messages.EditChatAbout({ peer: await this.inputPeer(chat), about }));
  }

  async editPhoto(chat: any, file: File): Promise<void> {
    const handle = await this.uploadLarge(file);
    const photo = new Api.InputChatUploadedPhoto({ file: handle });
    if (chat instanceof Api.Chat) await this.raw.invoke(new Api.messages.EditChatPhoto({ chatId: chat.id, photo }));
    else await this.raw.invoke(new Api.channels.EditPhoto({ channel: await this.inputPeer(chat), photo }));
  }

  /** Public @username for a group/channel ("" = make private). */
  async setPublicUsername(chat: any, username: string): Promise<void> {
    await this.raw.invoke(new Api.channels.UpdateUsername({ channel: await this.inputPeer(chat), username }));
  }

  async toggleSignatures(chat: any, on: boolean): Promise<void> {
    await this.raw.invoke(new Api.channels.ToggleSignatures({ channel: await this.inputPeer(chat), signaturesEnabled: on }));
  }

  async toggleHiddenHistory(chat: any, hidden: boolean): Promise<void> {
    await this.raw.invoke(new Api.channels.TogglePreHistoryHidden({ channel: await this.inputPeer(chat), enabled: hidden }));
  }

  /** "Restrict saving content" for this chat. */
  async toggleProtected(chat: any, on: boolean): Promise<void> {
    await this.raw.invoke(new Api.messages.ToggleNoForwards({ peer: await this.inputPeer(chat), enabled: on }));
  }

  async toggleJoinRequests(chat: any, on: boolean): Promise<void> {
    await this.raw.invoke(new Api.channels.ToggleJoinRequest({ channel: await this.inputPeer(chat), enabled: on }));
  }

  async deleteGroupOrChannel(chat: any): Promise<void> {
    if (chat instanceof Api.Chat) await this.raw.invoke(new Api.messages.DeleteChat({ chatId: chat.id }));
    else await this.raw.invoke(new Api.channels.DeleteChannel({ channel: await this.inputPeer(chat) }));
  }

  // ---- invite links ----
  async createInvite(chat: any, o: { title?: string; expireDate?: number; usageLimit?: number; requestNeeded?: boolean } = {}): Promise<Api.ChatInviteExported> {
    return (await this.raw.invoke(
      new Api.messages.ExportChatInvite({ peer: await this.inputPeer(chat), ...o }),
    )) as Api.ChatInviteExported;
  }

  async listInvites(chat: any, revoked = false): Promise<Api.ChatInviteExported[]> {
    const r: any = await this.raw.invoke(
      new Api.messages.GetExportedChatInvites({ peer: await this.inputPeer(chat), adminId: new Api.InputUserSelf(), revoked, limit: 50 }),
    );
    return (r.invites ?? []).filter((i: any) => i instanceof Api.ChatInviteExported);
  }

  async revokeInvite(chat: any, link: string): Promise<void> {
    await this.raw.invoke(new Api.messages.EditExportedChatInvite({ peer: await this.inputPeer(chat), link, revoked: true }));
  }

  // ---- join requests ----
  async joinRequests(chat: any): Promise<{ users: any[]; importers: any[] }> {
    const r: any = await this.raw.invoke(
      new Api.messages.GetChatInviteImporters({
        requested: true,
        peer: await this.inputPeer(chat),
        offsetDate: 0,
        offsetUser: new Api.InputUserEmpty(),
        limit: 100,
      }),
    );
    return { users: r.users ?? [], importers: r.importers ?? [] };
  }

  async answerJoinRequest(chat: any, user: any, approve: boolean): Promise<void> {
    await this.raw.invoke(
      new Api.messages.HideChatJoinRequest({ peer: await this.inputPeer(chat), userId: await this.inputPeer(user), approved: approve }),
    );
  }

  /** Recent admin actions ("سجل الأحداث"). */
  async adminLog(chat: any): Promise<{ events: Api.ChannelAdminLogEvent[]; users: any[] }> {
    const r: any = await this.raw.invoke(
      new Api.channels.GetAdminLog({ channel: await this.inputPeer(chat), q: "", maxId: bigInt(0), minId: bigInt(0), limit: 100 }),
    );
    return { events: r.events ?? [], users: r.users ?? [] };
  }

  /** Full channel/chat object for the manage page (slow mode, flags…). */
  async getFullChat(chat: any): Promise<any> {
    if (chat instanceof Api.Chat) return (await this.raw.invoke(new Api.messages.GetFullChat({ chatId: chat.id }))).fullChat;
    return (await this.raw.invoke(new Api.channels.GetFullChannel({ channel: await this.inputPeer(chat) }))).fullChat;
  }

  // ================= Threads: channel comments & forum topics =================
  /** Channel post → its comment thread in the linked discussion group. */
  async getDiscussion(channel: any, msgId: number): Promise<{ chat: any; topId: number }> {
    const r: any = await this.raw.invoke(new Api.messages.GetDiscussionMessage({ peer: await this.inputPeer(channel), msgId }));
    const top = r.messages[r.messages.length - 1];
    const key = peerKey(top.peerId);
    const chat = r.chats.find((c: any) => peerKey(c) === key);
    return { chat, topId: top.id };
  }

  async getThread(peer: any, topId: number, limit = 50, offsetId = 0): Promise<Api.TypeMessage[]> {
    return (await this.raw.getMessages(peer, { replyTo: topId, limit, offsetId } as any)) as unknown as Api.TypeMessage[];
  }

  async sendInThread(peer: any, text: string, topId: number, replyTo?: number): Promise<Api.Message> {
    return (await this.raw.sendMessage(peer, { message: text, replyTo: replyTo ?? topId, topMsgId: topId } as any)) as Api.Message;
  }

  async getTopics(peer: any): Promise<Api.ForumTopic[]> {
    const r: any = await this.raw.invoke(
      new Api.messages.GetForumTopics({ peer: await this.inputPeer(peer), offsetDate: 0, offsetId: 0, offsetTopic: 0, limit: 100 }),
    );
    return (r.topics ?? []).filter((t: any) => t instanceof Api.ForumTopic);
  }

  async createTopic(peer: any, title: string): Promise<void> {
    await this.raw.invoke(
      new Api.messages.CreateForumTopic({ peer: await this.inputPeer(peer), title, randomId: bigInt(Math.floor(Math.random() * 1e15)) } as any),
    );
  }

  // ================= Account =================
  async updateProfile(o: { firstName?: string; lastName?: string; about?: string }): Promise<void> {
    const u: any = await this.raw.invoke(new Api.account.UpdateProfile(o));
    if (u instanceof Api.User) this.me = u;
  }

  async setMyUsername(username: string): Promise<void> {
    const u: any = await this.raw.invoke(new Api.account.UpdateUsername({ username }));
    if (u instanceof Api.User) this.me = u;
  }

  async setMyPhoto(file: File): Promise<void> {
    const handle = await this.uploadLarge(file);
    const isVideo = file.type.startsWith("video/");
    await this.raw.invoke(new Api.photos.UploadProfilePhoto(isVideo ? { video: handle } : { file: handle }));
    await this.getMe();
  }

  async deleteMyPhoto(): Promise<void> {
    const me: any = this.me ?? (await this.getMe());
    const p = me?.photo;
    if (!p?.photoId) return;
    const photos: any = await this.raw.invoke(new Api.photos.GetUserPhotos({ userId: new Api.InputUserSelf(), offset: 0, maxId: bigInt(0), limit: 1 }));
    const ph = photos.photos?.[0];
    if (ph) await this.raw.invoke(new Api.photos.DeletePhotos({ id: [new Api.InputPhoto({ id: ph.id, accessHash: ph.accessHash, fileReference: ph.fileReference })] }));
    await this.getMe();
  }

  /** Sign this device out of the account on Telegram's side. */
  async logOut(): Promise<void> {
    await this.raw.invoke(new Api.auth.LogOut());
  }

  async getBlocked(): Promise<any[]> {
    const r: any = await this.raw.invoke(new Api.contacts.GetBlocked({ offset: 0, limit: 200 }));
    return [...(r.users ?? []), ...(r.chats ?? [])];
  }

  // ---- privacy ----
  /** Simplified privacy: "all" | "contacts" | "nobody" (exceptions are kept as-is server-side when unchanged). */
  async getPrivacy(key: PrivacyKey): Promise<"all" | "contacts" | "nobody"> {
    const r: any = await this.raw.invoke(new Api.account.GetPrivacy({ key: privacyKey(key) }));
    const rules: any[] = r.rules ?? [];
    if (rules.some((x) => x instanceof Api.PrivacyValueAllowAll)) return "all";
    if (rules.some((x) => x instanceof Api.PrivacyValueAllowContacts)) return "contacts";
    return "nobody";
  }

  async setPrivacy(key: PrivacyKey, value: "all" | "contacts" | "nobody"): Promise<void> {
    const rule =
      value === "all"
        ? new Api.InputPrivacyValueAllowAll()
        : value === "contacts"
          ? new Api.InputPrivacyValueAllowContacts()
          : new Api.InputPrivacyValueDisallowAll();
    await this.raw.invoke(new Api.account.SetPrivacy({ key: privacyKey(key), rules: [rule] }));
  }

  async getGlobalPrivacy(): Promise<Api.GlobalPrivacySettings> {
    return this.raw.invoke(new Api.account.GetGlobalPrivacySettings());
  }

  async setGlobalPrivacy(patch: Partial<Record<string, boolean>>): Promise<void> {
    const cur: any = await this.getGlobalPrivacy();
    const next: any = {};
    for (const k of ["archiveAndMuteNewNoncontactPeers", "keepArchivedUnmuted", "keepArchivedFolders", "hideReadMarks", "newNoncontactPeersRequirePremium"]) {
      next[k] = k in patch ? patch[k] : !!cur[k];
    }
    await this.raw.invoke(new Api.account.SetGlobalPrivacySettings({ settings: new Api.GlobalPrivacySettings(next) }));
  }

  // ---- sessions ----
  async getSessions(): Promise<Api.Authorization[]> {
    const r = await this.raw.invoke(new Api.account.GetAuthorizations());
    return r.authorizations;
  }

  async endSession(hash: any): Promise<void> {
    await this.raw.invoke(new Api.account.ResetAuthorization({ hash }));
  }

  async endOtherSessions(): Promise<void> {
    await this.raw.invoke(new Api.auth.ResetAuthorizations());
  }

  // ---- two-step verification ----
  async hasPassword(): Promise<{ has: boolean; hint?: string; email?: boolean }> {
    const p: any = await this.raw.invoke(new Api.account.GetPassword());
    return { has: !!p.hasPassword, hint: p.hint, email: !!p.hasRecovery };
  }

  /** Set / change / remove (newPassword "") the 2FA password. */
  async setTwoFa(o: { current?: string; next?: string; hint?: string; email?: string; askEmailCode?: () => Promise<string> }): Promise<void> {
    await (this.raw as any).updateTwoFaSettings({
      currentPassword: o.current || undefined,
      newPassword: o.next || undefined,
      hint: o.hint ?? "",
      email: o.email || undefined,
      emailCodeCallback: o.askEmailCode ? async () => (await o.askEmailCode!()) : undefined,
      onEmailCodeError: () => {},
    });
  }

  // ---- stories ----
  async getAllStories(): Promise<{ peers: Api.PeerStories[]; entities: Map<string, any> }> {
    const r: any = await this.raw.invoke(new Api.stories.GetAllStories({}));
    const entities = new Map<string, any>();
    for (const u of r.users ?? []) entities.set(peerKey(u), u);
    for (const c of r.chats ?? []) entities.set(peerKey(c), c);
    return { peers: r.peerStories ?? [], entities };
  }

  /** Mark stories seen — skipped in Ghost mode (stealth viewing). */
  async readStories(peer: any, maxId: number): Promise<void> {
    if (isOn("ghostMode")) return;
    await this.raw.invoke(new Api.stories.ReadStories({ peer: await this.inputPeer(peer), maxId }));
  }

  async downloadStory(story: Api.StoryItem): Promise<Uint8Array | undefined> {
    const out = await this.raw.downloadMedia(story.media as any, {});
    if (!out || typeof out === "string") return undefined;
    return out as unknown as Uint8Array;
  }

  async postStory(file: File, caption: string, audience: "all" | "contacts"): Promise<void> {
    const handle = await this.uploadLarge(file);
    const isVideo = file.type.startsWith("video/");
    const media = isVideo
      ? new Api.InputMediaUploadedDocument({
          file: handle,
          mimeType: file.type,
          attributes: [new Api.DocumentAttributeVideo({ duration: 10, w: 720, h: 1280, supportsStreaming: true })],
        })
      : new Api.InputMediaUploadedPhoto({ file: handle });
    await this.raw.invoke(
      new Api.stories.SendStory({
        peer: new Api.InputPeerSelf(),
        media,
        caption,
        privacyRules: [audience === "all" ? new Api.InputPrivacyValueAllowAll() : new Api.InputPrivacyValueAllowContacts()],
        randomId: bigInt(Math.floor(Math.random() * 1e15)),
      }),
    );
  }

  /** Small profile photo bytes (undefined when the chat has none). */
  async profilePhoto(entity: any, big = false): Promise<Uint8Array | undefined> {
    const out = await this.raw.downloadProfilePhoto(entity, { isBig: big });
    if (!out || typeof out === "string" || !(out as any).length) return undefined;
    return out as unknown as Uint8Array;
  }

  async getHistory(peer: Api.TypeEntityLike, limit = 40): Promise<Api.Message[]> {
    const msgs = await this.raw.getMessages(peer, { limit });
    return msgs as unknown as Api.Message[];
  }

  async send(peer: Api.TypeEntityLike, text: string, replyTo?: number): Promise<Api.Message> {
    return (await this.raw.sendMessage(peer, { message: text, replyTo })) as Api.Message;
  }

  /** Older history: messages strictly before `offsetId` (newest first). */
  async getOlder(peer: Api.TypeEntityLike, offsetId: number, limit = 40): Promise<Api.TypeMessage[]> {
    return (await this.raw.getMessages(peer, { limit, offsetId } as any)) as unknown as Api.TypeMessage[];
  }

  /** History centred on a message id (for jumping to replies / pinned / search). */
  async getAround(peer: Api.TypeEntityLike, msgId: number, limit = 40): Promise<Api.TypeMessage[]> {
    return (await this.raw.getMessages(peer, {
      limit,
      offsetId: msgId + 1,
      addOffset: -Math.floor(limit / 2),
    } as any)) as unknown as Api.TypeMessage[];
  }

  async getByIds(peer: Api.TypeEntityLike, ids: number[]): Promise<(Api.TypeMessage | undefined)[]> {
    return (await this.raw.getMessages(peer, { ids } as any)) as unknown as (Api.TypeMessage | undefined)[];
  }

  async searchInChat(peer: Api.TypeEntityLike, query: string, limit = 50): Promise<Api.Message[]> {
    return (await this.raw.getMessages(peer, { search: query, limit } as any)) as unknown as Api.Message[];
  }

  async getPinned(peer: Api.TypeEntityLike): Promise<Api.Message | undefined> {
    const res = (await this.raw.getMessages(peer, {
      limit: 1,
      filter: new Api.InputMessagesFilterPinned(),
    } as any)) as unknown as Api.Message[];
    return res[0];
  }

  async editText(peer: Api.TypeEntityLike, msgId: number, text: string): Promise<Api.Message> {
    return (await this.raw.editMessage(peer, { message: msgId, text })) as Api.Message;
  }

  async deleteMsgs(peer: Api.TypeEntityLike, ids: number[], revoke: boolean): Promise<void> {
    await this.raw.deleteMessages(peer, ids, { revoke });
  }

  async pin(peer: Api.TypeEntityLike, msgId: number, unpin = false): Promise<void> {
    if (unpin) await this.raw.unpinMessage(peer, msgId);
    else await this.raw.pinMessage(peer, msgId, { notify: false } as any);
  }

  /**
   * Set the full list of my reactions on a message (empty = remove).
   * Keys: a plain emoji ("👍") or "ce:<documentId>" for Premium custom emoji.
   */
  async react(peer: Api.TypeEntityLike, msgId: number, keys: string[]): Promise<void> {
    await this.raw.invoke(
      new Api.messages.SendReaction({
        peer: (await this.raw.getInputEntity(peer)) as any,
        msgId,
        reaction: keys.map((k) =>
          k.startsWith("ce:")
            ? new Api.ReactionCustomEmoji({ documentId: bigInt(k.slice(3)) })
            : new Api.ReactionEmoji({ emoticon: k }),
        ),
      }),
    );
  }

  // ================= Premium: custom emoji, statuses, reactions =================
  /** Custom emoji documents by id (max 200 per call). */
  async getCustomEmojiDocs(ids: string[]): Promise<Api.Document[]> {
    const out: Api.Document[] = [];
    for (let i = 0; i < ids.length; i += 200) {
      const chunk = ids.slice(i, i + 200).map((x) => bigInt(x));
      const r = await this.raw.invoke(new Api.messages.GetCustomEmojiDocuments({ documentId: chunk }));
      for (const d of r) if (d instanceof Api.Document) out.push(d);
    }
    return out;
  }

  async downloadDocument(doc: Api.Document, thumb?: number): Promise<Uint8Array | undefined> {
    const out = await this.raw.downloadMedia(new Api.MessageMediaDocument({ document: doc }), { thumb } as any);
    if (!out || typeof out === "string") return undefined;
    return out as unknown as Uint8Array;
  }

  /** Suggested + recent emoji statuses (custom emoji document ids). */
  async emojiStatusChoices(): Promise<string[]> {
    const ids = new Set<string>();
    for (const req of [new Api.account.GetRecentEmojiStatuses({ hash: bigInt(0) }), new Api.account.GetDefaultEmojiStatuses({ hash: bigInt(0) })]) {
      try {
        const r: any = await this.raw.invoke(req);
        for (const st of r.statuses ?? []) if (st.documentId != null) ids.add(String(st.documentId));
      } catch {
        /* ignore */
      }
    }
    return [...ids];
  }

  /** Set (documentId) or clear (null) my emoji status; until = unix time or 0. */
  async setEmojiStatus(documentId: string | null, until = 0): Promise<void> {
    const emojiStatus = documentId
      ? new Api.EmojiStatus({ documentId: bigInt(documentId), until: until || undefined })
      : new Api.EmojiStatusEmpty();
    await this.raw.invoke(new Api.account.UpdateEmojiStatus({ emojiStatus }));
    await this.getMe();
  }

  /** Standard reactions available to everyone + my recent / top custom ones. */
  async reactionChoices(): Promise<{ standard: string[]; custom: string[] }> {
    const standard: string[] = [];
    const custom: string[] = [];
    try {
      const r: any = await this.raw.invoke(new Api.messages.GetAvailableReactions({ hash: 0 }));
      for (const a of r.reactions ?? []) if (!a.inactive) standard.push(a.reaction);
    } catch {
      /* ignore */
    }
    for (const req of [new Api.messages.GetRecentReactions({ limit: 50, hash: bigInt(0) }), new Api.messages.GetTopReactions({ limit: 50, hash: bigInt(0) })]) {
      try {
        const r: any = await this.raw.invoke(req);
        for (const x of r.reactions ?? []) {
          if (x instanceof Api.ReactionCustomEmoji) {
            const k = "ce:" + String(x.documentId);
            if (!custom.includes(k)) custom.push(k);
          }
        }
      } catch {
        /* ignore */
      }
    }
    return { standard, custom };
  }

  /** Press an inline-keyboard callback button. Returns the bot's answer. */
  async pressButton(peer: Api.TypeEntityLike, msgId: number, data: Uint8Array): Promise<Api.messages.BotCallbackAnswer> {
    return await this.raw.invoke(
      new Api.messages.GetBotCallbackAnswer({
        peer: (await this.raw.getInputEntity(peer)) as any,
        msgId,
        data: Buffer.from(data),
      }),
    );
  }

  async vote(peer: Api.TypeEntityLike, msgId: number, options: Uint8Array[]): Promise<void> {
    await this.raw.invoke(
      new Api.messages.SendVote({
        peer: (await this.raw.getInputEntity(peer)) as any,
        msgId,
        options: options.map((o) => Buffer.from(o)),
      }),
    );
  }

  /** Tell the chat we're typing / recording (skipped in Ghost mode). */
  async setTyping(peer: Api.TypeEntityLike, action: "typing" | "recording" | "cancel" = "typing"): Promise<void> {
    if (isOn("ghostMode")) return;
    const a =
      action === "recording"
        ? new Api.SendMessageRecordAudioAction()
        : action === "cancel"
          ? new Api.SendMessageCancelAction()
          : new Api.SendMessageTypingAction();
    await this.raw.invoke(new Api.messages.SetTyping({ peer: (await this.raw.getInputEntity(peer)) as any, action: a }));
  }

  /** Online / offline presence (never goes online in Ghost mode). */
  async setOnline(online: boolean): Promise<void> {
    if (online && isOn("ghostMode")) return;
    await this.raw.invoke(new Api.account.UpdateStatus({ offline: !online }));
  }

  async getEntity(id: Api.TypeEntityLike): Promise<any> {
    return this.raw.getEntity(id);
  }

  /** Member / subscriber count for groups and channels. */
  async getMemberCount(entity: any): Promise<number | undefined> {
    if (entity instanceof Api.Chat) return entity.participantsCount;
    if (entity instanceof Api.Channel) {
      if (entity.participantsCount) return entity.participantsCount;
      const full = await this.raw.invoke(new Api.channels.GetFullChannel({ channel: entity as any }));
      return (full.fullChat as Api.ChannelFull).participantsCount;
    }
    return undefined;
  }

  async downloadMedia(
    message: Api.Message,
    opts: { onProgress?: (ratio: number) => void; signal?: AbortSignal; thumb?: number } = {},
  ): Promise<Uint8Array | undefined> {
    const out = await this.raw.downloadMedia(message, {
      thumb: opts.thumb,
      signal: opts.signal,
      progressCallback: opts.onProgress
        ? (done: any, total: any) => {
            const t = Number(total);
            if (t > 0) opts.onProgress!(Math.min(1, Number(done) / t));
          }
        : undefined,
    });
    if (out == null || typeof out === "string") return undefined;
    return out as unknown as Uint8Array;
  }

  /** Real Telegram forward. `dropAuthor` = no "Forwarded from" header. */
  async forward(
    target: Api.TypeEntityLike,
    msg: Api.Message,
    fromPeer: Api.TypeEntityLike,
    dropAuthor: boolean,
  ): Promise<void> {
    await this.raw.forwardMessages(target, { messages: [msg.id], fromPeer, dropAuthor });
  }

  /**
   * Re-send a message as a brand-new one (used when the source chat blocks
   * forwarding). Media is re-uploaded with its original attributes so voice
   * notes stay voice notes, round videos stay round, stickers stay stickers.
   */
  async resend(
    target: Api.TypeEntityLike,
    msg: Api.Message,
    file?: File,
    onProgress?: (ratio: number) => void,
  ): Promise<void> {
    const m: any = msg;
    if (!file) {
      await this.raw.sendMessage(target, { message: msg.message || "" });
      return;
    }
    const doc: Api.Document | undefined = m.document;
    await this.raw.sendFile(target, {
      file,
      caption: msg.message || undefined,
      attributes: doc?.attributes,
      voiceNote: !!m.voice,
      videoNote: !!m.videoNote,
      supportsStreaming: !!m.video,
      forceDocument: !m.photo && !m.video && !m.voice && !m.videoNote && !m.sticker && !m.gif && !m.audio,
      progressCallback: onProgress ? (p: number) => onProgress(p) : undefined,
    } as any);
  }

  /** Respect Ghost mode: only mark read when it is off. */
  async markRead(peer: Api.TypeEntityLike): Promise<void> {
    if (isOn("ghostMode")) return;
    await this.raw.markAsRead(peer);
  }

  /** Sponsored posts for a broadcast channel (only used when hideSponsored is off). */
  async getSponsored(peer: Api.TypeEntityLike): Promise<Api.SponsoredMessage[]> {
    try {
      const input = await this.raw.getInputEntity(peer);
      const res = await this.raw.invoke(new Api.messages.GetSponsoredMessages({ peer: input as any }));
      return res instanceof Api.messages.SponsoredMessages ? res.messages : [];
    } catch {
      return [];
    }
  }

  // ---- Live updates ----
  private updatesStarted = false;
  startUpdates(): void {
    if (this.updatesStarted) return;
    this.updatesStarted = true;
    // New + edited messages via the high-level event builder.
    this.raw.addEventHandler((event: NewMessageEvent) => {
      const msg = event.message as Api.Message;
      this.emit("newMessage", { chatId: String(msg.chatId ?? ""), message: msg });
    }, new NewMessage({}));

    // Raw updates for edits and deletions (Anti-Delete feeds on these).
    this.raw.addEventHandler((update: Api.TypeUpdate) => {
      if (update instanceof Api.UpdateEditMessage || update instanceof Api.UpdateEditChannelMessage) {
        const msg = (update as any).message as Api.Message;
        if (msg) this.emit("editedMessage", { chatId: String(msg.chatId ?? ""), message: msg });
      } else if (update instanceof Api.UpdateReadHistoryOutbox) {
        this.emit("readOutbox", { peerKey: peerKey(update.peer), maxId: update.maxId });
      } else if (update instanceof Api.UpdateReadChannelOutbox) {
        this.emit("readOutbox", {
          peerKey: peerKey(new Api.PeerChannel({ channelId: update.channelId })),
          maxId: update.maxId,
        });
      } else if (update instanceof Api.UpdateUserTyping) {
        const key = peerKey(new Api.PeerUser({ userId: update.userId }));
        this.emit("typing", { peerKey: key, userId: String(update.userId), action: update.action.className });
      } else if (update instanceof Api.UpdateChatUserTyping) {
        this.emit("typing", {
          peerKey: peerKey(new Api.PeerChat({ chatId: update.chatId })),
          userId: peerKey(update.fromId),
          action: update.action.className,
        });
      } else if (update instanceof Api.UpdateChannelUserTyping) {
        this.emit("typing", {
          peerKey: peerKey(new Api.PeerChannel({ channelId: update.channelId })),
          userId: peerKey(update.fromId),
          action: update.action.className,
        });
      } else if (update instanceof Api.UpdateUserStatus) {
        this.emit("userStatus", { userId: String(update.userId), status: update.status });
      } else if (update instanceof Api.UpdateMessageReactions) {
        this.emit("reactions", { peerKey: peerKey(update.peer), msgId: update.msgId, reactions: update.reactions });
      } else if (update instanceof Api.UpdateTranscribedAudio) {
        this.emit("transcribed", {
          msgId: update.msgId,
          transcriptionId: String(update.transcriptionId),
          text: update.text,
          pending: !!update.pending,
        });
      } else if (update instanceof Api.UpdateDeleteMessages) {
        this.emit("deletedMessages", { chatId: null, ids: update.messages });
      } else if (update instanceof Api.UpdateDeleteChannelMessages) {
        this.emit("deletedMessages", {
          chatId: peerKey(new Api.PeerChannel({ channelId: update.channelId })),
          ids: update.messages,
        });
      }
    });
  }
}

export const tg = new TG();

// ---- helpers for media metadata (used when sending) ----
function mediaDuration(file: File): Promise<number> {
  return videoMeta(file).then((m) => m.duration);
}

function videoMeta(file: File): Promise<{ duration: number; w: number; h: number }> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement(file.type.startsWith("audio/") ? "audio" : "video") as HTMLVideoElement;
    const done = (r: { duration: number; w: number; h: number }) => {
      URL.revokeObjectURL(url);
      resolve(r);
    };
    const timer = setTimeout(() => done({ duration: 0, w: 0, h: 0 }), 5000);
    v.preload = "metadata";
    v.onloadedmetadata = () => {
      clearTimeout(timer);
      done({
        duration: Number.isFinite(v.duration) ? Math.round(v.duration) : 0,
        w: v.videoWidth || 0,
        h: v.videoHeight || 0,
      });
    };
    v.onerror = () => {
      clearTimeout(timer);
      done({ duration: 0, w: 0, h: 0 });
    };
    v.src = url;
  });
}

/** Stable string key for any peer/entity (marked id, e.g. -100… for channels). */
export function peerKey(p: any): string {
  try {
    return String(utils.getPeerId(p));
  } catch {
    return "";
  }
}

export type PrivacyKey = "lastSeen" | "phone" | "photo" | "forwards" | "calls" | "invites" | "voice" | "bio" | "birthday";

function privacyKey(k: PrivacyKey): any {
  switch (k) {
    case "lastSeen":
      return new Api.InputPrivacyKeyStatusTimestamp();
    case "phone":
      return new Api.InputPrivacyKeyPhoneNumber();
    case "photo":
      return new Api.InputPrivacyKeyProfilePhoto();
    case "forwards":
      return new Api.InputPrivacyKeyForwards();
    case "calls":
      return new Api.InputPrivacyKeyPhoneCall();
    case "invites":
      return new Api.InputPrivacyKeyChatInvite();
    case "voice":
      return new Api.InputPrivacyKeyVoiceMessages();
    case "bio":
      return new Api.InputPrivacyKeyAbout();
    case "birthday":
      return new Api.InputPrivacyKeyBirthday();
  }
}
