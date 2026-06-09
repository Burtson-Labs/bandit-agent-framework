import darkTheme from "./dark.json";
import lightTheme from "./light.json";
import midnightTheme from "./midnight.json";
import draculaTheme from "./dracula.json";
import nordTheme from "./nord.json";
import tokyoNightTheme from "./tokyo-night.json";
import solarizedDarkTheme from "./solarized-dark.json";
import catppuccinMochaTheme from "./catppuccin-mocha.json";
import onyxTheme from "./onyx.json";
import charcoalTheme from "./charcoal.json";
import solarizedLightTheme from "./solarized-light.json";
import sepiaTheme from "./sepia.json";
import { createTheme, type BanditTheme, type ThemeConfig } from "./theme-base";

// Order here drives the order of chips in the Appearance settings tab.
// Stealth Light/Dark first (the brand defaults), Midnight third
// (legacy favorite), then a mix of community classics + new "two-tone"
// dark themes (Onyx pairs near-black bg with darker panel; Charcoal
// is the inverse — graphite bg with even-darker panel). Lighter-set
// adds Solarized Light + Sepia so the picker isn't only-dark.
const themeConfigs = {
  light: lightTheme as ThemeConfig,
  dark: darkTheme as ThemeConfig,
  midnight: midnightTheme as ThemeConfig,
  onyx: onyxTheme as ThemeConfig,
  charcoal: charcoalTheme as ThemeConfig,
  dracula: draculaTheme as ThemeConfig,
  nord: nordTheme as ThemeConfig,
  "tokyo-night": tokyoNightTheme as ThemeConfig,
  "solarized-dark": solarizedDarkTheme as ThemeConfig,
  "catppuccin-mocha": catppuccinMochaTheme as ThemeConfig,
  "solarized-light": solarizedLightTheme as ThemeConfig,
  sepia: sepiaTheme as ThemeConfig
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
