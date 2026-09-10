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

const GUIDES_KEY = "ocel-studio:guides";

export function loadGuides(): boolean {
  return localStorage.getItem(GUIDES_KEY) !== "off";
}

export function applyGuides(on: boolean): void {
  localStorage.setItem(GUIDES_KEY, on ? "on" : "off");
  document.documentElement.dataset.guides = on ? "on" : "off";
}

const VIEW_KEY = "ocel-studio.view";

export function loadViewName(): string | null {
  try {
    return localStorage.getItem(VIEW_KEY);
  } catch (err) {
    console.warn(`cannot read ${VIEW_KEY}`, err);
    return null;
  }
}

export function saveViewName(name: string | null): void {
  try {
    if (name === null) {
      localStorage.removeItem(VIEW_KEY);
    } else {
      localStorage.setItem(VIEW_KEY, name);
    }
  } catch (err) {
    console.warn(`cannot write ${VIEW_KEY}`, err);
  }
}

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
