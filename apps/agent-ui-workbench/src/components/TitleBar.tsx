import {
  Squares2X2Icon,
  ChatBubbleLeftRightIcon,
  SwatchIcon
} from "@heroicons/react/24/outline";
import { useBanditTheme, type ThemePreference } from "@burtson-labs/agent-ui";
import banditLogoUrl from "../../../bandit-stealth/media/bandit-stealth.png";

interface TitleBarProps {
  title: string;
}

/**
 * macOS-style title bar with traffic lights on the left, centered
 * project title, and a Bandit Panel pill on the right. The settings
 * icon doubles as a theme picker — clicking it cycles through the
 * registered Bandit themes via the same provider the extension uses,
 * so the workbench preview reflects what changing themes in
 * Settings → Appearance actually does. Purely cosmetic chrome
 * otherwise.
 */
export function TitleBar({ title }: TitleBarProps) {
  const { preference, setPreference, options } = useBanditTheme();
  return (
    <header className="ide__titlebar">
      <div className="ide__traffic">
        <span className="ide__traffic-light ide__traffic-light--close" />
        <span className="ide__traffic-light ide__traffic-light--min" />
        <span className="ide__traffic-light ide__traffic-light--max" />
      </div>
      <div className="ide__titlebar-title">{title}</div>
      <div className="ide__titlebar-actions">
        <button className="ide__icon-btn" aria-label="Layout">
          <Squares2X2Icon className="ide__titlebar-icon" aria-hidden="true" />
        </button>
        <button className="ide__icon-btn" aria-label="Notifications">
          <ChatBubbleLeftRightIcon className="ide__titlebar-icon" aria-hidden="true" />
        </button>
        <div className="ide__theme-picker">
          <SwatchIcon className="ide__titlebar-icon" aria-hidden="true" />
          <select
            aria-label="Theme"
            value={preference}
            onChange={(event) => setPreference(event.target.value as ThemePreference)}
          >
            {options.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        <button className="ide__agents-btn">
          <img src={banditLogoUrl} alt="" aria-hidden="true" className="ide__agents-logo" />
          Bandit Panel
        </button>
      </div>
    </header>
  );
}
