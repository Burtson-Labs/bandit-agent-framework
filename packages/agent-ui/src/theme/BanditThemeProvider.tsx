import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { JSX, ReactNode } from "react";
import { applyTheme, themePaletteKeys, type BanditTheme } from "./theme-base";
import {
  DEFAULT_THEME_ID,
  banditThemes,
  getThemeById,
  type RegisteredThemeId
} from "./theme-registry";
import { readVsCodeTheme } from "./vscode-theme";

const STORAGE_KEY = "bandit-theme-preference";
const MANUAL_STORAGE_KEY = "bandit-theme-manual";

export type ThemePreference = "auto" | RegisteredThemeId;

interface ThemeOption {
  id: ThemePreference;
  label: string;
}

interface ThemeContextValue {
  theme: BanditTheme;
  appearance: BanditTheme["appearance"];
  preference: ThemePreference;
  setPreference: (preference: ThemePreference) => void;
  cyclePreference: () => void;
  options: readonly ThemeOption[];
  resolvedId: string;
  manualTheme: RegisteredThemeId;
  ideTheme: BanditTheme | null;
  isAuto: boolean;
}

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

const themeOptions: readonly ThemeOption[] = [
  { id: "auto", label: "IDE Sync" },
  ...banditThemes.map((theme) => ({ id: theme.id as ThemePreference, label: theme.label }))
];

const themeOrder = themeOptions.map((option) => option.id);

const isThemeId = (value: unknown): value is RegisteredThemeId =>
  typeof value === "string" && banditThemes.some((theme) => theme.id === value);

const areThemesEqual = (a: BanditTheme | null, b: BanditTheme | null): boolean => {
  if (a === b) {
    return true;
  }
  if (!a || !b) {
    return false;
  }
  if (a.id !== b.id || a.appearance !== b.appearance || a.label !== b.label) {
    return false;
  }
  for (const key of themePaletteKeys) {
    if (a.palette[key] !== b.palette[key]) {
      return false;
    }
  }
  return true;
};

const readPreference = (): ThemePreference => {
  if (typeof window === "undefined") {
    return "auto";
  }
  const stored = window.localStorage.getItem(STORAGE_KEY);
  if (stored === "auto") {
    return "auto";
  }
  if (isThemeId(stored)) {
    return stored;
  }
  return "auto";
};

const readManualTheme = (): RegisteredThemeId => {
  if (typeof window === "undefined") {
    return DEFAULT_THEME_ID;
  }
  const stored = window.localStorage.getItem(MANUAL_STORAGE_KEY);
  if (isThemeId(stored)) {
    return stored;
  }
  const preference = readPreference();
  if (preference !== "auto") {
    return preference;
  }
  return DEFAULT_THEME_ID;
};

export const BanditThemeProvider = ({ children }: { children: ReactNode }): JSX.Element => {
  const [preference, setPreferenceState] = useState<ThemePreference>(() => readPreference());
  const [manualTheme, setManualTheme] = useState<RegisteredThemeId>(() => readManualTheme());
  const [ideTheme, setIdeTheme] = useState<BanditTheme | null>(() => readVsCodeTheme());

  useEffect(() => {
    if (typeof document === "undefined") {
      return;
    }
    const observer = new MutationObserver(() => {
      setIdeTheme((current) => {
        const next = readVsCodeTheme();
        if (areThemesEqual(current, next)) {
          return current;
        }
        return next;
      });
    });
    observer.observe(document.body, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    window.localStorage.setItem(STORAGE_KEY, preference);
  }, [preference]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    window.localStorage.setItem(MANUAL_STORAGE_KEY, manualTheme);
  }, [manualTheme]);

  const theme = useMemo<BanditTheme>(() => {
    if (preference === "auto") {
      return ideTheme ?? getThemeById(manualTheme);
    }
    return getThemeById(preference);
  }, [ideTheme, manualTheme, preference]);

  const resolvedId = theme.id;

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  const setPreference = useCallback(
    (next: ThemePreference) => {
      setPreferenceState(next);
      if (next !== "auto") {
        setManualTheme(next);
      }
    },
    []
  );

  const cyclePreference = useCallback(() => {
    const currentIndex = themeOrder.indexOf(preference);
    const next = themeOrder[(currentIndex + 1) % themeOrder.length];
    setPreference(next as ThemePreference);
  }, [preference, setPreference]);

  const value = useMemo<ThemeContextValue>(
    () => ({
      theme,
      appearance: theme.appearance,
      preference,
      setPreference,
      cyclePreference,
      options: themeOptions,
      resolvedId,
      manualTheme,
      ideTheme,
      isAuto: preference === "auto"
    }),
    [theme, preference, setPreference, cyclePreference, resolvedId, manualTheme, ideTheme]
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
};

export const useBanditTheme = (): ThemeContextValue => {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error("useBanditTheme must be used within a BanditThemeProvider");
  }
  return context;
};
