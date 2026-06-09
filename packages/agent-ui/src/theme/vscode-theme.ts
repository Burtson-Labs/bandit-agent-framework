import {
  createTheme,
  themePaletteKeys,
  type BanditTheme,
  type ThemeAppearance,
  type ThemePalette
} from "./theme-base";

const tokenMap: Record<keyof ThemePalette, readonly string[]> = {
  background: ["--vscode-editor-background", "--vscode-sideBar-background"],
  surface: ["--vscode-editorWidget-background", "--vscode-sideBar-background", "--vscode-editor-background"],
  panel: ["--vscode-sideBar-background", "--vscode-panel-background", "--vscode-editor-background"],
  card: ["--vscode-editorHoverWidget-background", "--vscode-panel-background", "--vscode-sideBar-background"],
  border: ["--vscode-panel-border", "--vscode-sideBar-border", "--vscode-editorWidget-border"],
  accent: ["--vscode-focusBorder", "--vscode-button-background", "--vscode-list-focusOutline"],
  textPrimary: ["--vscode-foreground", "--vscode-editor-foreground"],
  textSecondary: ["--vscode-descriptionForeground", "--vscode-editor-foreground", "--vscode-foreground"],
  textMuted: ["--vscode-disabledForeground", "--vscode-descriptionForeground"],
  success: ["--vscode-testing-iconPassed", "--vscode-debugIcon-startForeground"],
  error: ["--vscode-testing-iconFailed", "--vscode-errorForeground"],
  buttonContrast: ["--vscode-button-foreground", "--vscode-editor-background"],
  focusRing: ["--vscode-focusBorder", "--vscode-list-focusOutline"],
  codeBackground: ["--vscode-editor-background"],
  codeText: ["--vscode-editor-foreground", "--vscode-foreground"],
  codeBorder: ["--vscode-editorWidget-border", "--vscode-panel-border", "--vscode-sideBar-border"],
  codeAccent: ["--vscode-editor-selectionBackground", "--vscode-list-activeSelectionForeground", "--vscode-focusBorder"]
};

const lightFallbacks: Partial<ThemePalette> = {
  background: "#f8fafc",
  surface: "#ffffff",
  panel: "#f1f5f9",
  card: "#ffffff",
  border: "#d0d7de",
  accent: "#2563eb",
  textPrimary: "#0f172a",
  textSecondary: "#1e293b",
  textMuted: "#64748b",
  success: "#15803d",
  error: "#b91c1c",
  buttonContrast: "#f8fafc",
  focusRing: "#2563eb",
  codeBackground: "#e2e8f0",
  codeText: "#0f172a",
  codeBorder: "#cbd5f5",
  codeAccent: "#2563eb"
};

const darkFallbacks: Partial<ThemePalette> = {
  background: "#1e1e1e",
  surface: "#252526",
  panel: "#1e1e1e",
  card: "#252526",
  border: "#3c3c3c",
  accent: "#0098ff",
  textPrimary: "#f3f3f3",
  textSecondary: "#cccccc",
  textMuted: "#858585",
  success: "#4ec9b0",
  error: "#f48771",
  buttonContrast: "#1e1e1e",
  focusRing: "#0098ff",
  codeBackground: "#1e1e1e",
  codeText: "#d4d4d4",
  codeBorder: "#3c3c3c",
  codeAccent: "#569cd6"
};

const sanitizeColor = (value: string | null | undefined): string | null => {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed === "transparent" || trimmed === "initial" || trimmed === "inherit") {
    return null;
  }
  return trimmed;
};

const pickColor = (
  style: CSSStyleDeclaration,
  keys: readonly string[],
  fallback: string
): string => {
  for (const key of keys) {
    const candidate = sanitizeColor(style.getPropertyValue(key));
    if (candidate) {
      return candidate;
    }
  }
  return fallback;
};

const fallbackFor = (appearance: ThemeAppearance, key: keyof ThemePalette): string => {
  const palette = appearance === "light" ? lightFallbacks : darkFallbacks;
  return (palette[key] ?? (appearance === "light" ? darkFallbacks[key] : lightFallbacks[key])) ?? darkFallbacks[key] ?? lightFallbacks[key] ?? "";
};

const detectVsCodeDescriptor = (): { id: string; label: string; appearance: ThemeAppearance } | null => {
  if (typeof document === "undefined") {
    return null;
  }
  const classList = document.body.classList;
  if (!classList) {
    return null;
  }

  if (classList.contains("vscode-high-contrast-light")) {
    return { id: "vscode-high-contrast-light", label: "VS Code • High Contrast", appearance: "light" };
  }
  if (classList.contains("vscode-high-contrast") || classList.contains("vscode-high-contrast-dark")) {
    return { id: "vscode-high-contrast-dark", label: "VS Code • High Contrast", appearance: "dark" };
  }
  if (classList.contains("vscode-light")) {
    return { id: "vscode-light", label: "VS Code • Light", appearance: "light" };
  }
  if (classList.contains("vscode-dark")) {
    return { id: "vscode-dark", label: "VS Code • Dark", appearance: "dark" };
  }
  return null;
};

export const readVsCodeTheme = (): BanditTheme | null => {
  if (typeof document === "undefined") {
    return null;
  }
  const descriptor = detectVsCodeDescriptor();
  if (!descriptor) {
    return null;
  }
  const style = getComputedStyle(document.body);
  const appearance = descriptor.appearance;
  const overrides: Partial<ThemePalette> = {};

  for (const key of themePaletteKeys) {
    overrides[key] = pickColor(style, tokenMap[key], fallbackFor(appearance, key));
  }

  return createTheme(descriptor.id, {
    label: descriptor.label,
    appearance,
    palette: overrides
  });
};
