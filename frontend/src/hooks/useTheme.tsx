import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";

export type ThemeId = "light" | "dark";

export interface ThemeConfig {
  id: ThemeId;
  name: string;
  subtitle: string;
  icon: typeof Moon;
  color: string; // Primary swatch
  bgColor: string; // Background swatch
  isDark: boolean;
}

export const THEMES: ThemeConfig[] = [
  {
    id: "light",
    name: "Light",
    subtitle: "Cream & coffee",
    icon: Sun,
    color: "#6b4a34",
    bgColor: "#f6f1e7",
    isDark: false,
  },
  {
    id: "dark",
    name: "Dark",
    subtitle: "Espresso",
    icon: Moon,
    color: "#d4a574",
    bgColor: "#2a2420",
    isDark: true,
  },
];

const STORAGE_KEY = "parkgrid-theme";
const DEFAULT_THEME: ThemeId = "light";

export function getInitialTheme(): ThemeId {
  if (typeof window === "undefined") return DEFAULT_THEME;
  try {
    const saved = localStorage.getItem(STORAGE_KEY) as ThemeId | null;
    if (saved && THEMES.some((t) => t.id === saved)) {
      return saved;
    }
  } catch {
    // Ignore localStorage access errors (e.g. storage disabled or private browsing)
  }
  return DEFAULT_THEME;
}

export function applyTheme(themeId: ThemeId) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.setAttribute("data-theme", themeId);

  const theme = THEMES.find((t) => t.id === themeId);
  if (theme && theme.isDark) {
    root.classList.add("dark");
  } else {
    root.classList.remove("dark");
  }
}

export function useTheme() {
  const [theme, setThemeState] = useState<ThemeId>(getInitialTheme);

  useEffect(() => {
    // Initial sync
    applyTheme(theme);

    const onThemeChange = (e: Event) => {
      const customEvent = e as CustomEvent<ThemeId>;
      if (customEvent.detail && THEMES.some((t) => t.id === customEvent.detail)) {
        setThemeState(customEvent.detail);
        applyTheme(customEvent.detail);
      }
    };

    window.addEventListener("parkgrid-theme-change", onThemeChange);
    return () => window.removeEventListener("parkgrid-theme-change", onThemeChange);
  }, [theme]);

  const setTheme = (newTheme: ThemeId) => {
    setThemeState(newTheme);
    applyTheme(newTheme);
    try {
      localStorage.setItem(STORAGE_KEY, newTheme);
      window.dispatchEvent(new CustomEvent("parkgrid-theme-change", { detail: newTheme }));
    } catch {
      // Ignore localStorage write errors (e.g. quota exceeded or storage disabled)
    }
  };

  const currentConfig = THEMES.find((t) => t.id === theme) || THEMES[0];

  return {
    theme,
    currentConfig,
    setTheme,
    themes: THEMES,
  };
}
