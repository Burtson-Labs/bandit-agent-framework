import { useMemo, useState } from "react";
import clsx from "clsx";
import {
  ArrowTopRightOnSquareIcon,
  StarIcon as StarOutlineIcon
} from "@heroicons/react/24/outline";
import { StarIcon as StarSolidIcon } from "@heroicons/react/24/solid";
import banditLogoUrl from "../../../bandit-stealth/media/bandit-stealth.png";
import {
  banditExtensionMeta,
  formatBytes,
  formatDate
} from "../marketplace/banditMeta";
import { renderReadmeMarkdown } from "../markdown/banditMarkdown";

type MarketplaceTab = "details" | "features" | "changelog";

// Static numbers that aren't queryable from the local repo. Install
// count + rating are marketplace-side state — quoting the most recent
// snapshot here keeps the page truthful between explicit refreshes.
// Bump when we look at the real marketplace listing.
const INSTALL_COUNT = 59_000;
const RATING_STARS = 4.7;
const RATING_REVIEWS = 32;

const formatInstallCount = (n: number): string => {
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  }
  if (n >= 1_000) {
    return `${(n / 1_000).toFixed(0)}K`;
  }
  return `${n}`;
};

/**
 * Hand-picked feature highlights surfaced as cards on the Features
 * tab — mirrors the structure of the real marketplace "Features"
 * panel. Keep the tagline punchy + the supporting line concise; the
 * full pitch lives in README on the Details tab.
 */
const FEATURE_CARDS: Array<{ title: string; body: string }> = [
  {
    title: "Local-first by default",
    body:
      "Point at Ollama and your code never leaves your machine. Telemetry is off by default, opt-in only."
  },
  {
    title: "Tool use you can audit",
    body:
      "Every file write streams through a unified-diff approval card. Pre-write language validation for TS / Python / JSON / C# catches mistakes before they hit disk."
  },
  {
    title: "Bring your own voice stack",
    body:
      "Speech-to-text and text-to-speech swap between Bandit cloud, OpenAI-compatible Whisper, ElevenLabs, Piper, or any custom URL — independent of the chat provider."
  },
  {
    title: "Twelve themes, IDE-sync included",
    body:
      "Stealth Light/Dark, Midnight, Onyx, Charcoal, Dracula, Nord, Tokyo Night, Solarized Dark/Light, Catppuccin Mocha, Sepia. Mirrors VS Code automatically when you'd rather not pick."
  },
  {
    title: "Cross-repo discovery",
    body:
      "Ask Bandit to \"open the auth-api repo\" — it sweeps your common project roots via find_directory and just goes."
  },
  {
    title: "Shell escape hatch",
    body:
      "Prefix any message with `!` to run it straight in VS Code's integrated terminal — full TTY, same blocked-pattern guards."
  }
];

const CHANGELOG_ENTRIES: Array<{
  version: string;
  date: string;
  bullets: string[];
}> = [
  {
    version: banditExtensionMeta.version,
    date: formatDate(banditExtensionMeta.vsixMtime).split(",")[0],
    bullets: [
      "Fence-collision hardening for bandit-* markdown blocks (4-backtick emit).",
      "Sepia + Solarized Light: composer + TopBar contrast fixes when running inside the workbench preview.",
      "Settings → Appearance now repaints the embedded panel live in the workbench."
    ]
  },
  {
    version: "1.7.350",
    date: "2026-05-22",
    bullets: [
      "OSS launch prep: docs/site regenerates on README edit.",
      "MCP Add → +GitLab / +Slack guided setup with token-paste UX."
    ]
  },
  {
    version: "1.7.300",
    date: "2026-05-01",
    bullets: [
      "Twelve-theme picker added, with VS Code mirror as the default.",
      "Composer queued-pill: type while Bandit replies, the follow-up fires automatically."
    ]
  }
];

const Star = ({ filled }: { filled: boolean }) =>
  filled ? (
    <StarSolidIcon className="ext-rating__star ext-rating__star--filled" aria-hidden="true" />
  ) : (
    <StarOutlineIcon className="ext-rating__star" aria-hidden="true" />
  );

/**
 * VS Code-faithful marketplace detail page for Bandit Stealth.
 *
 * Hero (logo + name + publisher + install/rating + action row) on top,
 * tab strip (Details/Features/Changelog), two-column body: rendered
 * README on the left, an Installation + Marketplace + Categories +
 * Resources rail on the right. Numbers in the rail are pulled from
 * apps/bandit-stealth/package.json and the latest bandit-stealth.vsix
 * stat via vite.config define — bumping the extension version or
 * re-packing the VSIX updates this surface on next reload.
 */
export function ExtensionsMarketplacePanel() {
  const [tab, setTab] = useState<MarketplaceTab>("details");
  const meta = banditExtensionMeta;
  const renderedReadme = useMemo(() => renderReadmeMarkdown(meta.readme), [meta.readme]);

  return (
    <section className="ide__editor ide__editor--marketplace">
      <div className="ide__tabs" role="tablist">
        <button
          role="tab"
          aria-selected
          className="ide__tab ide__tab--active"
        >
          <span className="ide__tab-label">Extension: {meta.displayName}</span>
          <span className="ide__tab-close" aria-hidden="true">×</span>
        </button>
      </div>
      <div className="ide__editor-body ext-marketplace">
        <header className="ext-marketplace__hero">
          <img
            src={banditLogoUrl}
            alt=""
            aria-hidden="true"
            className="ext-marketplace__logo"
          />
          <div className="ext-marketplace__hero-text">
            <h1 className="ext-marketplace__title">{meta.displayName}</h1>
            <div className="ext-marketplace__hero-row">
              <span className="ext-marketplace__publisher">{meta.publisherDisplay}</span>
              <span className="ext-marketplace__metric" title="Installs">
                <svg className="ext-marketplace__metric-icon" viewBox="0 0 16 16" aria-hidden="true">
                  <path
                    fill="currentColor"
                    d="M8 1.5a4.5 4.5 0 0 1 4.5 4.5v1H13a1 1 0 0 1 1 1v5.5a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1h.5V6A4.5 4.5 0 0 1 8 1.5Zm0 1A3.5 3.5 0 0 0 4.5 6v1h7V6A3.5 3.5 0 0 0 8 2.5Z"
                  />
                </svg>
                {formatInstallCount(INSTALL_COUNT)}
              </span>
              <span className="ext-rating">
                {[1, 2, 3, 4, 5].map((i) => (
                  <Star key={i} filled={i <= Math.round(RATING_STARS)} />
                ))}
                <span className="ext-rating__count">({RATING_REVIEWS})</span>
              </span>
            </div>
            <p className="ext-marketplace__tagline">{meta.description}</p>
            <div className="ext-marketplace__actions">
              <button className="ext-btn ext-btn--primary" type="button">
                Install
              </button>
              <button className="ext-btn ext-btn--split" type="button" title="Disable">
                <span>Disable</span>
                <span className="ext-btn__chevron" aria-hidden="true">▾</span>
              </button>
              <button className="ext-btn ext-btn--split" type="button" title="Uninstall">
                <span>Uninstall</span>
                <span className="ext-btn__chevron" aria-hidden="true">▾</span>
              </button>
              <label className="ext-auto-update">
                <input type="checkbox" defaultChecked />
                <span>Auto Update</span>
              </label>
              <button className="ext-btn ext-btn--ghost ext-btn--icon" type="button" aria-label="More actions">
                ⚙
              </button>
            </div>
          </div>
        </header>

        <nav className="ext-marketplace__tabs" role="tablist">
          {(["details", "features", "changelog"] as MarketplaceTab[]).map((id) => (
            <button
              key={id}
              role="tab"
              type="button"
              aria-selected={tab === id}
              className={clsx("ext-marketplace__tab", tab === id && "is-active")}
              onClick={() => setTab(id)}
            >
              {id.toUpperCase()}
            </button>
          ))}
        </nav>

        <div className="ext-marketplace__body">
          <article className="ext-marketplace__content">
            {tab === "details" && (
              <div
                className="ext-readme"
                dangerouslySetInnerHTML={{ __html: renderedReadme }}
              />
            )}
            {tab === "features" && (
              <div className="ext-features">
                {FEATURE_CARDS.map((card) => (
                  <article key={card.title} className="ext-feature-card">
                    <h3>{card.title}</h3>
                    <p>{card.body}</p>
                  </article>
                ))}
              </div>
            )}
            {tab === "changelog" && (
              <div className="ext-changelog">
                {CHANGELOG_ENTRIES.map((entry) => (
                  <section key={entry.version} className="ext-changelog__entry">
                    <header>
                      <h3>v{entry.version}</h3>
                      <span>{entry.date}</span>
                    </header>
                    <ul>
                      {entry.bullets.map((b, i) => (
                        <li key={i}>{b}</li>
                      ))}
                    </ul>
                  </section>
                ))}
              </div>
            )}
          </article>

          <aside className="ext-marketplace__rail">
            <section className="ext-rail-card">
              <h3>Installation</h3>
              <dl>
                <dt>Identifier</dt>
                <dd className="ext-mono">{meta.identifier}</dd>
                <dt>Version</dt>
                <dd>{meta.version}</dd>
                <dt>Last Updated</dt>
                <dd>{formatDate(meta.vsixMtime)}</dd>
                <dt>Source</dt>
                <dd>VSIX</dd>
                <dt>Size</dt>
                <dd>{formatBytes(meta.vsixSizeBytes)}</dd>
              </dl>
            </section>

            <section className="ext-rail-card">
              <h3>Marketplace</h3>
              <dl>
                <dt>Published</dt>
                <dd>{formatDate(meta.firstPublishedAt)}</dd>
                <dt>Last Released</dt>
                <dd>{formatDate(meta.vsixMtime)}</dd>
              </dl>
            </section>

            <section className="ext-rail-card">
              <h3>Categories</h3>
              <ul className="ext-chip-list">
                {meta.categories.map((c) => (
                  <li key={c} className="ext-chip">{c}</li>
                ))}
              </ul>
            </section>

            <section className="ext-rail-card">
              <h3>Resources</h3>
              <ul className="ext-resources">
                <li>
                  <a href={meta.homepage} target="_blank" rel="noreferrer">
                    Homepage <ArrowTopRightOnSquareIcon aria-hidden="true" />
                  </a>
                </li>
                <li>
                  <a href={meta.repositoryUrl} target="_blank" rel="noreferrer">
                    Repository <ArrowTopRightOnSquareIcon aria-hidden="true" />
                  </a>
                </li>
                <li>
                  <a href={meta.bugsUrl} target="_blank" rel="noreferrer">
                    Issues <ArrowTopRightOnSquareIcon aria-hidden="true" />
                  </a>
                </li>
                <li>
                  <a
                    href={`${meta.repositoryUrl}/blob/main/LICENSE`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    License · {meta.license} <ArrowTopRightOnSquareIcon aria-hidden="true" />
                  </a>
                </li>
              </ul>
            </section>
          </aside>
        </div>
      </div>
    </section>
  );
}
