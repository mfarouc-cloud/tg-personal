// Power-user tools for the chat list: "unread only" filter and "mark all read"
// (throttled so marking many chats doesn't trip Telegram limits).
import type { Dialog } from "../telegram/types";
import { hasUnreadMark } from "../telegram/entity";
import { runThrottled } from "./bulkForward";

const K_UNREAD = "hbolt.unreadOnly";

export function unreadOnly(): boolean {
  return localStorage.getItem(K_UNREAD) === "1";
}
export function setUnreadOnly(on: boolean): void {
  localStorage.setItem(K_UNREAD, on ? "1" : "0");
}
export function isUnread(d: Dialog): boolean {
  return (d.unreadCount ?? 0) > 0 || hasUnreadMark(d);
}
export async function markAllRead(dialogs: Dialog[], markRead: (d: Dialog) => Promise<unknown>, onProgress?: (n: number, t: number) => void): Promise<number> {
  const targets = dialogs.filter(isUnread);
  const failed = await runThrottled(targets, markRead, { gapMs: 400, onProgress });
  return targets.length - failed.length;
}
