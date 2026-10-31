// Secret storage for API credentials, MTProto sessions, account list and the
// app passcode.
//
// • iOS app (Capacitor): iOS Keychain via @aparajita/capacitor-secure-storage,
//   access = afterFirstUnlockThisDeviceOnly (not synced to iCloud, not restored
//   to another device, readable in background after the first unlock).
// • Browser/PWA dev build: falls back to localStorage (no Keychain exists there).
//
// The rest of the app needs a synchronous API, so all secrets are loaded into
// memory once at boot (`initSecureStore`) and every write goes to memory
// immediately + to the Keychain asynchronously. Call `flushSecure()` before a
// page reload so pending Keychain writes are not lost.
import { Capacitor } from "@capacitor/core";

const PREFIX = "tgp_";
const mem = new Map<string, string>();
const pending = new Set<Promise<unknown>>();
let native = false;
let ready = false;

/** Keys that must never live in localStorage on the device. */
export function isSecretKey(k: string): boolean {
  return (
    k === "tg.apiId" ||
    k === "tg.apiHash" ||
    k === "tg.slot" ||
    k === "tg.accounts" ||
    k === "tg.session" ||
    k.startsWith("tg.session.") ||
    k.startsWith("tg.passcode")
  );
}

async function plugin() {
  const m = await import("@aparajita/capacitor-secure-storage");
  return m;
}

/** Load secrets into memory; on iOS migrate any legacy localStorage copies into the Keychain. */
export async function initSecureStore(): Promise<{ migrated: number; backend: "keychain" | "localStorage" }> {
  native = Capacitor.isNativePlatform();
  let migrated = 0;
  if (native) {
    const { SecureStorage, KeychainAccess } = await plugin();
    await SecureStorage.setKeyPrefix(PREFIX);
    await SecureStorage.setSynchronize(false);
    await SecureStorage.setDefaultKeychainAccess(KeychainAccess.afterFirstUnlockThisDeviceOnly);
    for (const k of await SecureStorage.keys()) {
      const v = await SecureStorage.get(k);
      if (typeof v === "string") mem.set(k, v);
    }
    // One-time migration from older builds that kept secrets in localStorage.
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (!k || !isSecretKey(k)) continue;
      const v = localStorage.getItem(k);
      if (v != null && !mem.has(k)) {
        await SecureStorage.set(k, v);
        mem.set(k, v);
      }
      localStorage.removeItem(k);
      migrated++;
    }
  }
  ready = true;
  return { migrated, backend: native ? "keychain" : "localStorage" };
}

function track(p: Promise<unknown>) {
  pending.add(p);
  p.catch((e) => console.error("[secureStore] keychain write failed", e)).finally(() => pending.delete(p));
}

export function sget(k: string): string | null {
  if (!native) return localStorage.getItem(k);
  if (!ready) console.warn("[secureStore] read before init:", k);
  return mem.get(k) ?? null;
}

export function sset(k: string, v: string): void {
  if (!native) return localStorage.setItem(k, v);
  if (mem.get(k) === v) return;
  mem.set(k, v);
  track(plugin().then(({ SecureStorage }) => SecureStorage.set(k, v)));
}

export function sremove(k: string): void {
  if (!native) return localStorage.removeItem(k);
  mem.delete(k);
  track(plugin().then(({ SecureStorage }) => SecureStorage.remove(k)));
}

/** Remove every secret (logout of all accounts). */
export async function sclear(): Promise<void> {
  if (!native) {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k && isSecretKey(k)) localStorage.removeItem(k);
    }
    return;
  }
  mem.clear();
  const { SecureStorage } = await plugin();
  await SecureStorage.clear();
}

/** Wait for queued Keychain writes (call before location.reload()). */
export async function flushSecure(): Promise<void> {
  await Promise.allSettled([...pending]);
}

/** Reload the app after making sure secrets are persisted. */
export async function safeReload(): Promise<void> {
  await flushSecure();
  location.reload();
}
