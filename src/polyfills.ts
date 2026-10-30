// Browser polyfill fixes required by teleproto (MTProto).
//
// 1) Buffer aliases
//    Node's Buffer exposes both `readBigUInt64BE` and the lowercase alias
//    `readBigUint64BE` (likewise readUint32LE, writeBigUint64LE, ...). The
//    `buffer` npm polyfill only ships the "UInt" spelling; teleproto calls the
//    "Uint" one — so we add the missing aliases.
//
// 2) crypto.randomFillSync / randomFill offset bug
//    The browser `randomfill` package (used by crypto-browserify) builds its
//    view as `new Uint8Array(buf.buffer, offset, size)` — ignoring
//    `buf.byteOffset`. teleproto fills the MTProto padding of a *subarray*
//    (byteOffset 24), so the random bytes landed 24 bytes too early and
//    overwrote the tail of every outgoing message. Telegram then answered with
//    INPUT_CONSTRUCTOR_INVALID / bad_msg_notification 64 (invalid container).
import { Buffer } from "buffer";
// @ts-ignore — resolved to crypto-browserify by vite-plugin-node-polyfills
import nodeCrypto from "crypto";

// ---- 1) Buffer aliases ----
const proto = Buffer.prototype as unknown as Record<string, unknown>;
for (const name of Object.getOwnPropertyNames(proto)) {
  if (!name.includes("UInt")) continue;
  const alias = name.replace("UInt", "Uint");
  if (typeof proto[name] === "function" && !(alias in proto)) {
    Object.defineProperty(proto, alias, {
      value: proto[name],
      writable: true,
      configurable: true,
    });
  }
}
const g = globalThis as unknown as { Buffer?: typeof Buffer };
if (!g.Buffer) g.Buffer = Buffer;

// ---- 2) Correct randomFill(Sync) that respects byteOffset ----
const MAX_CHUNK = 65536; // getRandomValues limit per call

function fillRandom(buf: ArrayBufferView, offset = 0, size?: number): void {
  const len = size ?? buf.byteLength - offset;
  if (offset < 0 || len < 0 || offset + len > buf.byteLength) {
    throw new RangeError("randomFill: offset/size out of range");
  }
  const view = new Uint8Array(buf.buffer, buf.byteOffset + offset, len);
  for (let i = 0; i < view.length; i += MAX_CHUNK) {
    globalThis.crypto.getRandomValues(view.subarray(i, i + MAX_CHUNK));
  }
}

const c = nodeCrypto as any;
if (c && typeof globalThis.crypto?.getRandomValues === "function") {
  c.randomFillSync = (buf: ArrayBufferView, offset?: number, size?: number) => {
    fillRandom(buf, offset ?? 0, size);
    return buf;
  };
  c.randomFill = (buf: ArrayBufferView, a?: any, b?: any, cb?: any) => {
    // Supports (buf, cb) | (buf, offset, cb) | (buf, offset, size, cb)
    let offset = 0;
    let size: number | undefined;
    let done: (err: Error | null, b?: ArrayBufferView) => void;
    if (typeof a === "function") done = a;
    else if (typeof b === "function") {
      offset = a;
      done = b;
    } else {
      offset = a;
      size = b;
      done = cb;
    }
    try {
      fillRandom(buf, offset, size);
      queueMicrotask(() => done(null, buf));
    } catch (e) {
      queueMicrotask(() => done(e as Error));
    }
  };
}
