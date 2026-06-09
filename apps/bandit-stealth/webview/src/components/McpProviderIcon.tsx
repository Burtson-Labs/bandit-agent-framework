import type { JSX } from "react";

/**
 * Compact 16-px monochrome glyph per well-known MCP provider, plus a
 * generic "plug" fallback. Shape-only (no brand marks) so we stay
 * out of trademark-licensing weeds — they read as an at-a-glance
 * "this is the slack one" hint, not as official badges.
 */
export function McpProviderIcon({ provider }: { provider?: string | null }): JSX.Element {
  const stroke = "currentColor";
  const common = { width: 16, height: 16, fill: "none", stroke, strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  switch (provider) {
    case "slack":
      // Four short bars in a hash arrangement — evokes Slack's
      // four-quadrant logomark without copying it.
      return (
        <svg {...common} viewBox="0 0 24 24" aria-hidden="true">
          <line x1="6" y1="9" x2="6" y2="15" />
          <line x1="9" y1="6" x2="15" y2="6" />
          <line x1="18" y1="9" x2="18" y2="15" />
          <line x1="9" y1="18" x2="15" y2="18" />
        </svg>
      );
    case "github":
      return (
        <svg {...common} viewBox="0 0 24 24" aria-hidden="true">
          <path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22" />
        </svg>
      );
    case "gitlab":
      // Stylized chevron-fox shape — evokes GitLab's tanuki without
      // copying the full mark.
      return (
        <svg {...common} viewBox="0 0 24 24" aria-hidden="true">
          <polyline points="4,11 12,4 20,11 12,20" />
          <line x1="8" y1="11" x2="12" y2="20" />
          <line x1="16" y1="11" x2="12" y2="20" />
        </svg>
      );
    case "gmail":
    case "outlook":
      return (
        <svg {...common} viewBox="0 0 24 24" aria-hidden="true">
          <rect x="3" y="5" width="18" height="14" rx="2" />
          <polyline points="3,7 12,13 21,7" />
        </svg>
      );
    case "gdrive":
    case "google":
      return (
        <svg {...common} viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5h5" />
        </svg>
      );
    case "calendar":
      return (
        <svg {...common} viewBox="0 0 24 24" aria-hidden="true">
          <rect x="3" y="5" width="18" height="16" rx="2" />
          <line x1="16" y1="3" x2="16" y2="7" />
          <line x1="8" y1="3" x2="8" y2="7" />
          <line x1="3" y1="11" x2="21" y2="11" />
        </svg>
      );
    case "teams":
    case "microsoft":
      return (
        <svg {...common} viewBox="0 0 24 24" aria-hidden="true">
          <rect x="3" y="3" width="8" height="8" />
          <rect x="13" y="3" width="8" height="8" />
          <rect x="3" y="13" width="8" height="8" />
          <rect x="13" y="13" width="8" height="8" />
        </svg>
      );
    case "filesystem":
      return (
        <svg {...common} viewBox="0 0 24 24" aria-hidden="true">
          <path d="M3 7l3-3h4l2 2h9v13H3z" />
        </svg>
      );
    case "postgres":
    case "mongo":
      return (
        <svg {...common} viewBox="0 0 24 24" aria-hidden="true">
          <ellipse cx="12" cy="6" rx="8" ry="3" />
          <path d="M4 6v6c0 1.66 3.58 3 8 3s8-1.34 8-3V6" />
          <path d="M4 12v6c0 1.66 3.58 3 8 3s8-1.34 8-3v-6" />
        </svg>
      );
    default:
      // Generic plug icon for unknown providers.
      return (
        <svg {...common} viewBox="0 0 24 24" aria-hidden="true">
          <path d="M9 7v6a3 3 0 0 0 6 0V7" />
          <line x1="9" y1="2" x2="9" y2="7" />
          <line x1="15" y1="2" x2="15" y2="7" />
          <line x1="12" y1="16" x2="12" y2="22" />
        </svg>
      );
  }
}
