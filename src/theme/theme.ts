import "./theme.css";

export type ThemeName = "dark" | "amoled" | "light";

const K_THEME = "tg.theme";
const K_ACCENT = "tg.accent";

export const ACCENT_PRESETS = [
  "#229ed9", // telegram blue
  "#38e1ff", // cyan
  "#8e7cff", // violet
  "#4fae4e", // green
  "#ff8a3d", // orange
  "#ff5c8a", // pink
  "#e6b800", // amber
];

export function currentTheme(): ThemeName {
  return (localStorage.getItem(K_THEME) as ThemeName) || "dark";
}

export function currentAccent(): string {
  return localStorage.getItem(K_ACCENT) || ACCENT_PRESETS[0];
}

export function applyTheme(name: ThemeName = currentTheme(), accent = currentAccent()): void {
  const root = document.documentElement;
  root.setAttribute("data-theme", name);
  root.style.setProperty("--accent", accent);
  root.style.setProperty("--accent-ink", pickInk(accent));
  localStorage.setItem(K_THEME, name);
  localStorage.setItem(K_ACCENT, accent);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", name === "amoled" ? "#000000" : "#0e1621");
}

/** Choose black or white text for legibility on a given accent colour. */
function pickInk(hex: string): string {
  const c = hex.replace("#", "");
  const r = parseInt(c.slice(0, 2), 16);
  const g = parseInt(c.slice(2, 4), 16);
  const b = parseInt(c.slice(4, 6), 16);
  const luma = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luma > 0.62 ? "#0b0f14" : "#ffffff";
}
