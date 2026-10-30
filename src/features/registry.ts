// Central registry of optional features. Every feature has an on/off switch,
// is persisted per device, and is listed automatically on the Features page in
// Settings. Adding a feature = one entry here + checking `isOn(id)` where used.

export type FeatureId =
  | "folderTabs"
  | "telegramFolders"
  | "stories"
  | "ghostMode"
  | "antiDelete"
  | "antiEdit"
  | "hideSponsored"
  | "copyText"
  | "forward"
  | "saveMedia"
  | "bypassRestrictions"
  | "autoLoadPhotos"
  | "passcodeLock"
  | "premiumBadges"
  | "voiceToText"
  | "translate"
  | "animatedStickers"
  | "customEmoji"
  | "userInsight";

export interface Feature {
  id: FeatureId;
  group: string;
  title: string;
  desc: string;
  default: boolean;
}

export const FEATURES: Feature[] = [
  {
    id: "voiceToText",
    group: "Premium ⭐",
    title: "تحويل الصوت لنص",
    desc: "زرار Aa على الرسايل الصوتية والفيديو الدائري يحوّلها لكلام مكتوب (من تليجرام)",
    default: true,
  },
  {
    id: "translate",
    group: "Premium ⭐",
    title: "ترجمة الرسائل",
    desc: "🌐 ترجمة أي رسالة من قايمة الضغطة المطوّلة (من تليجرام)",
    default: true,
  },
  {
    id: "premiumBadges",
    group: "Premium ⭐",
    title: "شارة Premium",
    desc: "نجمة ⭐ جنب أسماء مشتركين Premium في القايمة والمحادثة",
    default: true,
  },
  {
    id: "animatedStickers",
    group: "Premium ⭐",
    title: "الملصقات المتحرّكة",
    desc: "تشغيل الملصقات المتحركة (TGS) والفيديو (WEBM) بدل الصورة الثابتة",
    default: true,
  },
  {
    id: "customEmoji",
    group: "Premium ⭐",
    title: "الإيموجي المخصّص",
    desc: "عرض الإيموجي المخصص في الرسايل والرياكشنات وحالة الإيموجي جنب الأسماء",
    default: true,
  },
  {
    id: "userInsight",
    group: "أدوات",
    title: "معلومات العضو",
    desc: "صفحة فيها ID العضو، آخر ظهور بالتوقيت، الجروبات المشتركة ودوره فيها، وآخر رسايله في الجروبات",
    default: true,
  },
  {
    id: "folderTabs",
    group: "التنظيم",
    title: "تبويبات المجلدات",
    desc: "تقسيم المحادثات: الكل، شخصي، جروبات، قنوات، بوتات",
    default: true,
  },
  {
    id: "telegramFolders",
    group: "التنظيم",
    title: "مجلداتك من تليجرام",
    desc: "المجلدات اللي عاملها في تليجرام تظهر كتبويبات زيادة",
    default: true,
  },
  {
    id: "stories",
    group: "التنظيم",
    title: "شريط الستوريز",
    desc: "ستوريز جهات اتصالك فوق المحادثات. مع Ghost بتتفرّج من غير ما يعرفوا",
    default: true,
  },
  {
    id: "ghostMode",
    group: "الخصوصية",
    title: "الوضع الخفي (Ghost)",
    desc: "تقرأ الرسائل من غير ما الطرف التاني يشوف إنك قريت",
    default: false,
  },
  {
    id: "antiDelete",
    group: "الخصوصية",
    title: "Anti-Delete",
    desc: "الرسائل اللي تتمسح تفضل ظاهرة عندك عليها علامة 🗑",
    default: true,
  },
  {
    id: "antiEdit",
    group: "الخصوصية",
    title: "سجل التعديلات",
    desc: "لما رسالة تتعدّل يظهر النص الأصلي فوقها",
    default: true,
  },
  {
    id: "hideSponsored",
    group: "القنوات",
    title: "إخفاء الإعلانات",
    desc: "إخفاء الرسائل المموّلة في القنوات. لو قفلتها هتظهر الإعلانات زي التطبيق الرسمي",
    default: true,
  },
  {
    id: "copyText",
    group: "الرسائل",
    title: "نسخ النص",
    desc: "اضغط مطوّلاً (أو كليك يمين) على أي رسالة عشان تنسخها",
    default: true,
  },
  {
    id: "forward",
    group: "الرسائل",
    title: "إعادة التوجيه",
    desc: "توجيه أي رسالة أو ميديا لأي محادثة، مع اختيار إخفاء اسم المرسل",
    default: true,
  },
  {
    id: "saveMedia",
    group: "الوسائط",
    title: "حفظ الوسائط",
    desc: "زرار 💾 على كل صورة وفيديو وصوت وملف. على الآيفون: حفظ في الصور أو الملفات",
    default: true,
  },
  {
    id: "bypassRestrictions",
    group: "الوسائط",
    title: "تخطّي منع الحفظ",
    desc: "حفظ ونسخ المحتوى من القنوات والجروبات اللي قافلة الحفظ والتوجيه",
    default: true,
  },
  {
    id: "autoLoadPhotos",
    group: "الوسائط",
    title: "تحميل الصور تلقائياً",
    desc: "الصور تظهر جوه المحادثة لوحدها. لو قفلتها هتحمّل بس لما تدوس (توفير باقة)",
    default: true,
  },
  {
    id: "passcodeLock",
    group: "الأمان",
    title: "قفل بباسكود",
    desc: "يطلب رقم سري كل ما تفتح التطبيق",
    default: false,
  },
];

const key = (id: FeatureId) => `tg.feature.${id}`;

// Migrate values saved by v0.1.x before the registry existed.
const LEGACY: Partial<Record<FeatureId, string>> = {
  ghostMode: "tg.ghostMode",
  antiDelete: "tg.antiDelete",
  hideSponsored: "tg.hideSponsored",
  passcodeLock: "tg.passcodeLock",
};

const listeners = new Set<(id: FeatureId, on: boolean) => void>();

export function isOn(id: FeatureId): boolean {
  let v = localStorage.getItem(key(id));
  if (v === null && LEGACY[id]) v = localStorage.getItem(LEGACY[id]!);
  if (v === null) return FEATURES.find((f) => f.id === id)?.default ?? false;
  return v === "1";
}

export function setOn(id: FeatureId, on: boolean): void {
  localStorage.setItem(key(id), on ? "1" : "0");
  for (const cb of listeners) cb(id, on);
}

export function onFeatureChange(cb: (id: FeatureId, on: boolean) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

// ---- Translation target language ----
export const TRANSLATE_LANGS: [string, string][] = [
  ["ar", "العربية"],
  ["en", "English"],
  ["fr", "Français"],
  ["de", "Deutsch"],
  ["es", "Español"],
  ["tr", "Türkçe"],
  ["ru", "Русский"],
  ["fa", "فارسی"],
];
export function translateLang(): string {
  return localStorage.getItem("tg.translate.lang") || "ar";
}
export function setTranslateLang(code: string): void {
  localStorage.setItem("tg.translate.lang", code);
}
