// Tiny DOM helpers — keeps the UI framework-free and the bundle lean.

type Attrs = Record<string, any>;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = String(v);
    else if (k === "html") node.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") {
      node.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (k === "style" && typeof v === "object") {
      Object.assign(node.style, v);
    } else {
      node.setAttribute(k, String(v));
    }
  }
  for (const c of children) node.append(c);
  return node;
}

export function clear(node: HTMLElement): void {
  node.replaceChildren();
}

export function mount(screen: HTMLElement): void {
  const app = document.getElementById("app")!;
  app.replaceChildren(screen);
}

let toastEl: HTMLDivElement | null = null;
let toastTimer: number | undefined;
export function toast(msg: string, ms = 2200): void {
  if (!toastEl) {
    toastEl = el("div", { class: "toast" });
    document.body.append(toastEl);
  }
  toastEl.textContent = msg;
  toastEl.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toastEl?.classList.remove("show"), ms);
}

export function initials(name: string): string {
  // Work on whole code points and skip emoji/symbols, so names that start
  // with an emoji don't render a broken half-character ("�").
  const words = name
    .trim()
    .split(/\s+/)
    .map((w) => Array.from(w).filter((ch) => /[\p{L}\p{N}]/u.test(ch)))
    .filter((w) => w.length > 0);
  if (words.length === 0) return Array.from(name.trim())[0] ?? "?";
  if (words.length === 1) return words[0].slice(0, 2).join("").toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}

const PALETTE = ["#e17076", "#7bc862", "#65aadd", "#a695e7", "#ee7aae", "#6ec9cb", "#f0a35e"];
export function colorFor(key: string): string {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

export function fmtTime(unix: number): string {
  const d = new Date(unix * 1000);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) {
    return d.toLocaleTimeString("ar-EG", { hour: "2-digit", minute: "2-digit" });
  }
  return d.toLocaleDateString("ar-EG", { day: "numeric", month: "short" });
}
