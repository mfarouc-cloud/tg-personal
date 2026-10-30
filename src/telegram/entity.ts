// Small helpers about users/chats/dialogs shared by several screens.
import { Api } from "teleproto";
import type { Dialog } from "./types";
import { peerKey } from "./client";

/** Name as shown for a chat (your own chat = "Saved Messages"). */
export function displayName(entity: any): string {
  if (!entity) return "";
  if (entity.self) return "الرسائل المحفوظة";
  return realName(entity);
}

/** The person's/chat's actual name, even for yourself. */
export function realName(entity: any): string {
  if (!entity) return "";
  if (entity.title) return entity.title;
  const n = [entity.firstName, entity.lastName].filter(Boolean).join(" ");
  if (n) return n;
  if (entity.username) return "@" + entity.username;
  if (entity.deleted) return "حساب محذوف";
  return "";
}

/** Minimal Dialog for chats opened outside the list (mentions, links, search). */
export function dialogFor(entity: any): Dialog {
  return {
    entity,
    title: displayName(entity),
    isUser: entity instanceof Api.User,
    isGroup: entity instanceof Api.Chat || (entity instanceof Api.Channel && !!entity.megagroup),
    isChannel: entity instanceof Api.Channel,
  };
}

export function muteUntil(d: Dialog): number {
  return Number(d.dialog?.notifySettings?.muteUntil ?? 0);
}

export function isMuted(d: Dialog): boolean {
  return muteUntil(d) > Date.now() / 1000;
}

export function hasUnreadMark(d: Dialog): boolean {
  return !!d.dialog?.unreadMark;
}

const txt = (v: any): string => (typeof v === "string" ? v : v?.text ?? "");

export function folderTitle(f: any): string {
  return txt(f.title) || "مجلد";
}

/** Does a dialog belong to a Telegram chat folder (DialogFilter rules)? */
export function inFolder(d: Dialog, f: any): boolean {
  const key = peerKey(d.entity);
  const has = (list: any[] | undefined) => (list ?? []).some((p) => peerKey(p) === key);
  if (has(f.excludePeers)) return false;
  if (has(f.pinnedPeers) || has(f.includePeers)) return true;
  if (!(f instanceof Api.DialogFilter)) return false; // chatlists: explicit peers only

  const e: any = d.entity;
  const isUser = e instanceof Api.User;
  const isBot = isUser && !!e.bot;
  const isGroup = e instanceof Api.Chat || (e instanceof Api.Channel && !!e.megagroup);
  const isBroadcast = e instanceof Api.Channel && !!e.broadcast;
  const ok =
    (f.contacts && isUser && !isBot && !!e.contact) ||
    (f.nonContacts && isUser && !isBot && !e.contact) ||
    (f.groups && isGroup) ||
    (f.broadcasts && isBroadcast) ||
    (f.bots && isBot);
  if (!ok) return false;
  if (f.excludeMuted && isMuted(d)) return false;
  if (f.excludeRead && !(d.unreadCount ?? 0) && !hasUnreadMark(d)) return false;
  if (f.excludeArchived && d.archived) return false;
  return true;
}
