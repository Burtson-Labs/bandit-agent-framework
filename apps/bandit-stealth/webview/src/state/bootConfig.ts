export interface BootConfig {
  logoSrc?: string;
  /** The host puts history / new conversation / settings in the view's
   *  native title bar, so the webview hides its own toolbar. */
  nativeTitleActions?: boolean;
}

export const readBootConfig = (): BootConfig => {
  if (typeof document === "undefined") {
    return {};
  }
  const script = document.getElementById("bandit-stealth-config");
  if (!script?.textContent) {
    return {};
  }
  try {
    return JSON.parse(script.textContent) as BootConfig;
  } catch {
    return {};
  }
};
