// Smart link resolver: resolves @username, numeric ids, t.me/c/<id> and
// invite hashes, remembering what each link pointed to (local cache, on the
// device only). When an invite link is expired/revoked, it falls back to the
// chat that link resolved to before, or to a public username of that chat.
import { Api } from "teleproto";
import { tg } from "../telegram/client";

const K = "hbolt.linkCache";
type Rec = { kind: "user" | "chat" | "channel"; id: string; username?: string; title?: string; at: number };

function load(): Record<string, Rec> {
  try {
    return JSON.parse(localStorage.getItem(K) || "{}");
  } catch {
    return {};
  }
}
function save(map: Record<string, Rec>): void {
  const keys = Object.keys(map);
  if (keys.length > 2000) keys.sort((a, b) => map[a].at - map[b].at).slice(0, keys.length - 2000).forEach((k) => delete map[k]);
  localStorage.setItem(K, JSON.stringify(map));
}
export function remember(key: string, entity: any): void {
  if (!entity) return;
  const kind = entity instanceof Api.User ? "user" : entity instanceof Api.Channel ? "channel" : "chat";
  const map = load();
  map[key.toLowerCase()] = { kind, id: String(entity.id), username: entity.username, title: entity.title || entity.firstName, at: Date.now() };
  save(map);
}
function peerOf(r: Rec): any {
  if (r.kind === "user") return new Api.PeerUser({ userId: r.id as any });
  if (r.kind === "channel") return new Api.PeerChannel({ channelId: r.id as any });
  return new Api.PeerChat({ chatId: r.id as any });
}
async function fromCache(key: string): Promise<any | null> {
  const r = load()[key.toLowerCase()];
  if (!r) return null;
  try {
    return await tg.getEntity(peerOf(r));
  } catch {
    /* not in session cache any more */
  }
  if (r.username) {
    try {
      return await tg.getEntity(r.username);
    } catch {
      /* gone */
    }
  }
  return null;
}

export type Resolved =
  | { type: "entity"; entity: any; note?: string }
  | { type: "invite"; hash: string }
  | { type: "fail"; reason: string };

/** Resolve a target from a link/username/id. */
export async function resolveTarget(target: string): Promise<Resolved> {
  const t = target.trim();
  // Invite links
  if (t.startsWith("+")) {
    const hash = t.slice(1);
    const key = "+" + hash;
    try {
      const inv: any = await tg.checkInvite(hash);
      if (inv instanceof Api.ChatInviteAlready || inv instanceof Api.ChatInvitePeek) {
        remember(key, inv.chat);
        return { type: "entity", entity: inv.chat };
      }
      return { type: "invite", hash };
    } catch (e: any) {
      const msg = String(e?.errorMessage || e?.message || "");
      const cached = await fromCache(key);
      if (cached) return { type: "entity", entity: cached, note: "اللينك منتهي — فتحت المحادثة اللي كان بيوديها" };
      return { type: "fail", reason: /EXPIRED|INVALID/.test(msg) ? "لينك الدعوة منتهي أو اتلغى، ومفيش نسخة محفوظة له" : msg || "تعذّر" };
    }
  }
  // Private post links: c/<channelId>
  const c = /^c\/(\d+)/.exec(t);
  const key = t.replace(/^@/, "").toLowerCase();
  try {
    let entity: any;
    if (c) entity = await tg.getEntity(new Api.PeerChannel({ channelId: c[1] as any }));
    else entity = await tg.getEntity(/^-?\d+$/.test(key) ? key : key);
    remember(key, entity);
    return { type: "entity", entity };
  } catch {
    const cached = await fromCache(key);
    if (cached) return { type: "entity", entity: cached, note: "اليوزرنيم اتغيّر — فتحت الحساب المحفوظ" };
    return { type: "fail", reason: "مش لاقي " + t };
  }
}
