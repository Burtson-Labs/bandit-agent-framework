import darkTheme from "./dark.js";
import lightTheme from "./light.js";
import midnightTheme from "./midnight.js";
import draculaTheme from "./dracula.js";
import nordTheme from "./nord.js";
import tokyoNightTheme from "./tokyo-night.js";
import solarizedDarkTheme from "./solarized-dark.js";
import catppuccinMochaTheme from "./catppuccin-mocha.js";
import onyxTheme from "./onyx.js";
import charcoalTheme from "./charcoal.js";
import solarizedLightTheme from "./solarized-light.js";
import sepiaTheme from "./sepia.js";
import { createTheme, type BanditTheme, type ThemeConfig } from "./theme-base.js";

// Order here drives the order of chips in the Appearance settings tab.
// Stealth Light/Dark first (the brand defaults), Midnight third
// (legacy favorite), then a mix of community classics + new "two-tone"
// dark themes (Onyx pairs near-black bg with darker panel; Charcoal
// is the inverse — graphite bg with even-darker panel). Lighter-set
// adds Solarized Light + Sepia so the picker isn't only-dark.
const themeConfigs = {
  light: lightTheme,
  dark: darkTheme,
  midnight: midnightTheme,
  onyx: onyxTheme,
  charcoal: charcoalTheme,
  dracula: draculaTheme,
  nord: nordTheme,
  "tokyo-night": tokyoNightTheme,
  "solarized-dark": solarizedDarkTheme,
  "catppuccin-mocha": catppuccinMochaTheme,
  "solarized-light": solarizedLightTheme,
  sepia: sepiaTheme
} satisfies Record<string, ThemeConfig>;

export type RegisteredThemeId = keyof typeof themeConfigs;

const entries = Object.entries(themeConfigs) as [RegisteredThemeId, ThemeConfig][];

export const banditThemes: BanditTheme[] = entries.map(([id, config]) => createTheme(id, config));

export const banditThemeMap = new Map<RegisteredThemeId, BanditTheme>(
  banditThemes.map((theme) => [theme.id as RegisteredThemeId, theme])
);

export const DEFAULT_THEME_ID: RegisteredThemeId = "dark";

export const getThemeById = (id: RegisteredThemeId): BanditTheme => {
  const theme = banditThemeMap.get(id);
  if (!theme) {
    return banditThemeMap.get(DEFAULT_THEME_ID)!;
  }
  return theme;
};
