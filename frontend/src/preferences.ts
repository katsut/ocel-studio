import type { Lang } from "./i18n.tsx";

export type Theme = "system" | "light" | "dark";

const THEME_KEY = "ocel-studio:theme";
const LANG_KEY = "ocel-studio:lang";

export function loadTheme(): Theme {
  const saved = localStorage.getItem(THEME_KEY);
  return saved === "light" || saved === "dark" ? saved : "system";
}

export function applyTheme(theme: Theme): void {
  localStorage.setItem(THEME_KEY, theme);
  if (theme === "system") {
    delete document.documentElement.dataset.theme;
  } else {
    document.documentElement.dataset.theme = theme;
  }
}

export const nextTheme = (theme: Theme): Theme =>
  theme === "system" ? "light" : theme === "light" ? "dark" : "system";

export const themeIcon = (theme: Theme): string =>
  theme === "system" ? "🖥" : theme === "light" ? "☀️" : "🌙";

export function loadLang(): Lang {
  const saved = localStorage.getItem(LANG_KEY);
  if (saved === "en" || saved === "ja") {
    return saved;
  }
  return navigator.language.startsWith("ja") ? "ja" : "en";
}

export function saveLang(lang: Lang): void {
  localStorage.setItem(LANG_KEY, lang);
}
