// Local "seen in" index: while you browse groups, remember which chats each
// sender wrote in (ids + titles only, on this device). The member-details page
// uses it to add chats that `messages.getCommonChats` doesn't return anymore
// (e.g. groups you left or that were converted). Nothing leaves the device.
const K = "hbolt.seenIn";
type Entry = Record<string, { t: string; at: number }>; // chatKey -> title, lastSeen
let cache: Record<string, Entry> | null = null;
let dirty = false;

function load(): Record<string, Entry> {
  if (!cache) {
    try {
      cache = JSON.parse(localStorage.getItem(K) || "{}");
    } catch {
      cache = {};
    }
  }
  return cache!;
}
function flushSoon(): void {
  if (dirty) return;
  dirty = true;
  setTimeout(() => {
    dirty = false;
    const c = load();
    const users = Object.keys(c);
    if (users.length > 5000) users.slice(0, users.length - 5000).forEach((u) => delete c[u]);
    try {
      localStorage.setItem(K, JSON.stringify(c));
    } catch {
      /* quota */
    }
  }, 2000);
}
export function recordSeen(userId: string, chatKey: string, chatTitle: string, date: number): void {
  const c = load();
  const e = (c[userId] ||= {});
  if (!e[chatKey] || e[chatKey].at < date) {
    e[chatKey] = { t: chatTitle, at: date };
    flushSoon();
  }
}
export function seenFor(userId: string): { chatKey: string; title: string; at: number }[] {
  const e = load()[userId] || {};
  return Object.entries(e)
    .map(([chatKey, v]) => ({ chatKey, title: v.t, at: v.at }))
    .sort((a, b) => b.at - a.at);
}
