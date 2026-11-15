/**
 * The four Bandit Cloud voices, for the Voice settings picker. Mirrors
 * src/helpers/banditVoices.ts in the extension host (the webview is a
 * separate bundle and does not import from it); the host does the real
 * mapping of saved ids before any request.
 */
export interface BanditVoiceOption {
  id: string;
  name: string;
  detail: string;
}

export const BANDIT_VOICE_OPTIONS: readonly BanditVoiceOption[] = [
  { id: "kokoro-af_heart", name: "Heart", detail: "American · woman" },
  { id: "kokoro-am_michael", name: "Michael", detail: "American · man" },
  { id: "kokoro-bf_emma", name: "Emma", detail: "British · woman" },
  { id: "kokoro-bm_george", name: "George", detail: "British · man" }
];

export const DEFAULT_BANDIT_VOICE_ID = "kokoro-af_heart";

/**
 * Which of the four a saved value selects. The four ids map to themselves;
 * old ids follow the same family rules as the extension host, and anything
 * else shows as Heart (which is what Bandit Cloud will be sent).
 */
export function selectedBanditVoice(value: string | undefined | null): string {
  const raw = (value ?? "").trim().toLowerCase();
  const exact = BANDIT_VOICE_OPTIONS.find((o) => o.id === raw);
  if (exact) {return exact.id;}
  const kokoro = /^kokoro-([a-z])([fm])_/.exec(raw);
  if (kokoro) {
    if (kokoro[1] === "b") {return kokoro[2] === "m" ? "kokoro-bm_george" : "kokoro-bf_emma";}
    return kokoro[2] === "m" ? "kokoro-am_michael" : DEFAULT_BANDIT_VOICE_ID;
  }
  const named = /^[a-z]{2}_([a-z]{2})-([a-z0-9]+)-([a-z]+)$/.exec(raw);
  if (named) {
    const [, region, name, suffix] = named;
    if (suffix === "premium" || suffix === "ivc" || suffix === "r") {
      return name === "jessica" || name === "matilda" ? DEFAULT_BANDIT_VOICE_ID : "kokoro-am_michael";
    }
    if (name === "michael" || name === "studio" || name === "ryan") {return "kokoro-am_michael";}
    if (name === "emma") {return "kokoro-bf_emma";}
    if (name === "george") {return "kokoro-bm_george";}
    if (suffix === "standard" && region === "gb") {return "kokoro-bf_emma";}
  }
  return DEFAULT_BANDIT_VOICE_ID;
}
