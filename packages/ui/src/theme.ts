export type ThemePref = "system" | "light" | "dark";

export const THEME_KEY = "memories-theme";

declare global {
  interface Window {
    memoriesChrome?: {
      platform: string;
      setTitleBar: (theme: "light" | "dark") => void;
      minimize?: () => void;
      toggleMaximize?: () => void;
      close?: () => void;
      isMaximized?: () => Promise<boolean>;
      onMaximized?: (listener: (maximized: boolean) => void) => () => void;
    };
  }
}

export function chromePlatform(): string | null {
  if (window.memoriesChrome?.platform) return window.memoriesChrome.platform;
  try {
    const fromUrl = new URLSearchParams(window.location.search).get("chrome");
    if (fromUrl === "darwin" || fromUrl === "win32" || fromUrl === "linux") return fromUrl;
  } catch {
    /* not a browser */
  }
  if (typeof navigator === "undefined" || !/\bElectron\b/.test(navigator.userAgent)) return null;
  if (/Windows NT/.test(navigator.userAgent)) return "win32";
  if (/Macintosh/.test(navigator.userAgent)) return "darwin";
  return "linux";
}

export function applyWindowChrome(theme: "light" | "dark") {
  const platform = chromePlatform();
  if (!platform) {
    delete document.documentElement.dataset.chrome;
    return;
  }
  document.documentElement.dataset.chrome = platform;
  window.memoriesChrome?.setTitleBar(theme);
}

export function readThemePref(): ThemePref {
  try {
    const value = localStorage.getItem(THEME_KEY);
    if (value === "light" || value === "dark" || value === "system") return value;
  } catch {
    /* private mode */
  }
  return "system";
}

export function resolvedTheme(pref: ThemePref): "light" | "dark" {
  if (pref === "light" || pref === "dark") return pref;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function applyTheme(pref: ThemePref) {
  const resolved = resolvedTheme(pref);
  document.documentElement.dataset.theme = resolved;
  document.documentElement.style.colorScheme = resolved;
  applyWindowChrome(resolved);
}

export function saveThemePref(pref: ThemePref) {
  try {
    localStorage.setItem(THEME_KEY, pref);
  } catch {
    /* private mode */
  }
  applyTheme(pref);
}
