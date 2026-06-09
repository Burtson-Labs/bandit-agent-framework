import type { JSX } from "react";
import { KeyIcon } from "@heroicons/react/24/outline";

export function ApiKeyBanner({ onSetup }: { onSetup: () => void }): JSX.Element {
  return (
    <div className="api-key-banner" role="alert">
      <div className="api-key-banner__icon" aria-hidden="true">
        <KeyIcon />
      </div>
      <div className="api-key-banner__body">
        <p className="api-key-banner__title">An API key is required to run agents.</p>
        <p className="api-key-banner__description">
          You can review history and plan output, but Bandit Stealth needs a Bandit AI key before it can execute steps.
        </p>
      </div>
      <div className="api-key-banner__actions">
        <button type="button" className="stealth-button" onClick={onSetup}>
          Add API key
        </button>
      </div>
    </div>
  );
}
