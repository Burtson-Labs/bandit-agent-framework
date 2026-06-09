import { MagnifyingGlassIcon, CheckBadgeIcon } from "@heroicons/react/24/outline";
import banditLogoUrl from "../../../bandit-stealth/media/bandit-stealth.png";
import { banditExtensionMeta } from "../marketplace/banditMeta";

/**
 * VS Code-style Extensions sidebar — pared down for the workbench
 * showcase. Single INSTALLED row featuring Bandit Stealth so the
 * marketplace detail page is the focal point. Bumping the extension
 * version refreshes the pill text via banditExtensionMeta.
 */
export function ExtensionsSidebar() {
  const meta = banditExtensionMeta;
  return (
    <div className="ext-sidebar">
      <div className="ext-sidebar__search">
        <MagnifyingGlassIcon aria-hidden="true" />
        <input
          type="text"
          placeholder="Search Extensions in Marketplace"
          aria-label="Search extensions"
        />
      </div>
      <div className="ext-sidebar__section">
        <div className="ext-sidebar__section-header">
          <span>INSTALLED</span>
          <span className="ext-sidebar__count">1</span>
        </div>
        <article className="ext-sidebar__item ext-sidebar__item--active">
          <img
            src={banditLogoUrl}
            alt=""
            aria-hidden="true"
            className="ext-sidebar__icon"
          />
          <div className="ext-sidebar__item-body">
            <div className="ext-sidebar__item-title">
              <span>{meta.displayName}</span>
              <CheckBadgeIcon
                aria-hidden="true"
                className="ext-sidebar__verified"
                title="Verified publisher"
              />
            </div>
            <p className="ext-sidebar__item-desc">{meta.description}</p>
            <div className="ext-sidebar__item-meta">
              <span>{meta.publisherDisplay}</span>
              <span>v{meta.version}</span>
            </div>
          </div>
        </article>
      </div>
      <div className="ext-sidebar__section">
        <div className="ext-sidebar__section-header">
          <span>RECOMMENDED</span>
          <span className="ext-sidebar__count">0</span>
        </div>
        <p className="ext-sidebar__empty">
          Add more extensions from the marketplace to populate this list.
        </p>
      </div>
    </div>
  );
}
