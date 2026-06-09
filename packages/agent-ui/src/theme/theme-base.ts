export type ThemeAppearance = "light" | "dark";

export type ThemeId = string;

export interface ThemePalette {
  background: string;
  surface: string;
  panel: string;
  card: string;
  border: string;
  accent: string;
  textPrimary: string;
  textSecondary: string;
  textMuted: string;
  success: string;
  error: string;
  buttonContrast: string;
  focusRing: string;
  codeBackground: string;
  codeText: string;
  codeBorder: string;
  codeAccent: string;
}

export const themePaletteKeys: readonly (keyof ThemePalette)[] = [
  "background",
  "surface",
  "panel",
  "card",
  "border",
  "accent",
  "textPrimary",
  "textSecondary",
  "textMuted",
  "success",
  "error",
  "buttonContrast",
  "focusRing",
  "codeBackground",
  "codeText",
  "codeBorder",
  "codeAccent"
] as const;

export interface ThemeConfig {
  label: string;
  appearance: ThemeAppearance;
  palette: Partial<ThemePalette>;
}

export interface BanditTheme {
  id: ThemeId;
  label: string;
  appearance: ThemeAppearance;
  palette: ThemePalette;
}

export const basePalette: ThemePalette = {
  background: "#020617",
  surface: "#0f172a",
  panel: "#020617",
  card: "#090f1c",
  border: "#334155",
  accent: "#38bdf8",
  textPrimary: "#f8fafc",
  textSecondary: "#e2e8f0",
  textMuted: "#94a3b8",
  success: "#4ade80",
  error: "#f87171",
  buttonContrast: "#020617",
  focusRing: "#38bdf8",
  codeBackground: "#0f172a",
  codeText: "#e2e8f0",
  codeBorder: "#1f2937",
  codeAccent: "#38bdf8"
};

export const createTheme = (id: ThemeId, config: ThemeConfig): BanditTheme => ({
  id,
  label: config.label,
  appearance: config.appearance,
  palette: {
    ...basePalette,
    ...config.palette
  }
});

const HEX_COLOR = /^#(?<value>[\da-f]{3}|[\da-f]{6})$/i;

const hexToRgb = (value: string): string | null => {
  const match = value.match(HEX_COLOR);
  if (!match?.groups?.value) {
    return null;
  }
  const raw = match.groups.value;
  if (raw.length === 3) {
    const r = parseInt(raw[0] + raw[0], 16);
    const g = parseInt(raw[1] + raw[1], 16);
    const b = parseInt(raw[2] + raw[2], 16);
    return `${r}, ${g}, ${b}`;
  }
  if (raw.length === 6) {
    const r = parseInt(raw.slice(0, 2), 16);
    const g = parseInt(raw.slice(2, 4), 16);
    const b = parseInt(raw.slice(4, 6), 16);
    return `${r}, ${g}, ${b}`;
  }
  return null;
};

const setColorVariable = (root: HTMLElement, name: string, value: string): void => {
  root.style.setProperty(`--bandit-${name}`, value);
  const rgb = hexToRgb(value);
  if (rgb) {
    root.style.setProperty(`--bandit-${name}-rgb`, rgb);
  }
};

const setRawVariable = (root: HTMLElement, name: string, value: string): void => {
  root.style.setProperty(`--bandit-${name}`, value);
};

const removeThemeClasses = (target: DOMTokenList): void => {
  const classesToRemove: string[] = [];
  target.forEach((className) => {
    if (className.startsWith("bandit-theme-")) {
      classesToRemove.push(className);
    }
    if (className.startsWith("stealth-theme-")) {
      classesToRemove.push(className);
    }
  });
  if (classesToRemove.length > 0) {
    target.remove(...classesToRemove);
  }
};

export const applyTheme = (theme: BanditTheme): void => {
  if (typeof document === "undefined") {
    return;
  }
  const root = document.documentElement;
  const body = document.body;
  setColorVariable(root, "background", theme.palette.background);
  setColorVariable(root, "surface", theme.palette.surface);
  setColorVariable(root, "panel", theme.palette.panel);
  setColorVariable(root, "card", theme.palette.card);
  setColorVariable(root, "border", theme.palette.border);
  setColorVariable(root, "accent", theme.palette.accent);
  setColorVariable(root, "text-primary", theme.palette.textPrimary);
  setColorVariable(root, "text-secondary", theme.palette.textSecondary);
  setColorVariable(root, "text-muted", theme.palette.textMuted);
  setColorVariable(root, "success", theme.palette.success);
  setColorVariable(root, "error", theme.palette.error);
  setColorVariable(root, "focus-ring", theme.palette.focusRing);
  setRawVariable(root, "button-contrast", theme.palette.buttonContrast);
  setColorVariable(root, "code-background", theme.palette.codeBackground);
  setColorVariable(root, "code-text", theme.palette.codeText);
  setColorVariable(root, "code-border", theme.palette.codeBorder);
  setColorVariable(root, "code-accent", theme.palette.codeAccent);

  removeThemeClasses(body.classList);
  body.classList.add(`bandit-theme-${theme.id}`);
  if (theme.appearance === "light") {
    body.classList.add("stealth-theme-light");
    body.classList.remove("stealth-theme-dark");
  } else {
    body.classList.add("stealth-theme-dark");
    body.classList.remove("stealth-theme-light");
  }

  root.style.setProperty("color-scheme", theme.appearance);
  root.dataset.banditTheme = theme.id;
  root.dataset.banditAppearance = theme.appearance;
  if (theme.id.startsWith("vscode-")) {
    root.dataset.banditThemeSource = "vscode";
  } else {
    delete root.dataset.banditThemeSource;
  }
};
