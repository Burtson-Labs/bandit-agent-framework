export interface BootConfig {
  logoSrc?: string;
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
