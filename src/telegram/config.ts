// Persists the API credentials and the MTProto session(s) in localStorage.
// api_id / api_hash come from https://my.telegram.org (API development tools).
//
// Multiple accounts: each account lives in a numbered "slot" with its own
// session. Slot "0" keeps the original key ("tg.session") so existing logins
// survive the upgrade.

const K_API_ID = "tg.apiId";
const K_API_HASH = "tg.apiHash";
const K_SLOT = "tg.slot";
const K_ACCOUNTS = "tg.accounts";

export interface ApiCredentials {
  apiId: number;
  apiHash: string;
}

export interface AccountMeta {
  slot: string;
  id?: string;
  name?: string;
  phone?: string;
  username?: string;
}

export function loadCredentials(): ApiCredentials | null {
  const idRaw = localStorage.getItem(K_API_ID);
  const hash = localStorage.getItem(K_API_HASH);
  if (!idRaw || !hash) return null;
  const apiId = Number(idRaw);
  if (!Number.isFinite(apiId) || apiId <= 0) return null;
  return { apiId, apiHash: hash };
}

export function saveCredentials(creds: ApiCredentials): void {
  localStorage.setItem(K_API_ID, String(creds.apiId));
  localStorage.setItem(K_API_HASH, creds.apiHash.trim());
}

export function hasCredentials(): boolean {
  return loadCredentials() !== null;
}

// ---------------- slots ----------------
export function currentSlot(): string {
  return localStorage.getItem(K_SLOT) || "0";
}

const sessionKey = (slot: string) => (slot === "0" ? "tg.session" : `tg.session.${slot}`);

export function loadSession(): string {
  return localStorage.getItem(sessionKey(currentSlot())) ?? "";
}

export function saveSession(value: string): void {
  localStorage.setItem(sessionKey(currentSlot()), value);
}

export function listAccounts(): AccountMeta[] {
  try {
    const list = JSON.parse(localStorage.getItem(K_ACCOUNTS) || "[]") as AccountMeta[];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function writeAccounts(list: AccountMeta[]): void {
  localStorage.setItem(K_ACCOUNTS, JSON.stringify(list));
}

/** Record who is signed in on the current slot (called after getMe). */
export function upsertCurrentAccount(meta: Omit<AccountMeta, "slot">): void {
  const slot = currentSlot();
  const list = listAccounts().filter((a) => a.slot !== slot);
  list.push({ slot, ...meta });
  list.sort((a, b) => Number(a.slot) - Number(b.slot));
  writeAccounts(list);
}

/** Prepare an empty slot for signing in another account and switch to it. */
export function startNewAccount(): void {
  const used = new Set(listAccounts().map((a) => Number(a.slot)));
  used.add(Number(currentSlot()));
  let n = 0;
  while (used.has(n)) n++;
  localStorage.setItem(K_SLOT, String(n));
  localStorage.removeItem(sessionKey(String(n)));
}

export function switchAccount(slot: string): void {
  localStorage.setItem(K_SLOT, slot);
}

/** Forget the current account; returns the slot to switch to (or null if none left). */
export function removeCurrentAccount(): string | null {
  const slot = currentSlot();
  localStorage.removeItem(sessionKey(slot));
  const rest = listAccounts().filter((a) => a.slot !== slot);
  writeAccounts(rest);
  const next = rest[0]?.slot ?? null;
  if (next) localStorage.setItem(K_SLOT, next);
  else localStorage.removeItem(K_SLOT);
  return next;
}

/** Abandon a half-finished "add account" (no session saved) and go back. */
export function cancelNewAccount(): boolean {
  const slot = currentSlot();
  if (listAccounts().some((a) => a.slot === slot)) return false;
  const back = listAccounts()[0]?.slot;
  if (!back) return false;
  localStorage.removeItem(sessionKey(slot));
  localStorage.setItem(K_SLOT, back);
  return true;
}

/** Wipe everything (last account logged out). */
export function clearAll(): void {
  localStorage.removeItem(K_API_ID);
  localStorage.removeItem(K_API_HASH);
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const key = localStorage.key(i);
    if (key && (key === "tg.session" || key.startsWith("tg.session.") || key === K_ACCOUNTS || key === K_SLOT)) {
      localStorage.removeItem(key);
    }
  }
}
