import {
  CodeBracketIcon,
  ExclamationCircleIcon,
  ExclamationTriangleIcon,
  CpuChipIcon
} from "@heroicons/react/24/outline";

interface StatusBarProps {
  branch: string;
  errors: number;
  warnings: number;
  modelLabel: string;
}

/**
 * Bottom-of-window strip matching the VS Code status bar: branch +
 * dirty marker + counts on the left, signed-in Bandit model chip on
 * the right. Counts are wired to the terminal mock so the badges
 * aren't lying about errors/warnings present elsewhere in the
 * workbench.
 */
export function StatusBar({ branch, errors, warnings, modelLabel }: StatusBarProps) {
  return (
    <footer className="ide__statusbar">
      <div className="ide__statusbar-left">
        <span className="ide__statusbar-item" title="Active branch">
          <CodeBracketIcon className="ide__statusbar-icon" aria-hidden="true" />
          {branch}*
        </span>
        <span className="ide__statusbar-item" title="Project name">bandit-agent-framework</span>
        <span className="ide__statusbar-item ide__statusbar-counts" title="Errors and warnings">
          <span className="ide__statusbar-count ide__statusbar-count--error">
            <ExclamationCircleIcon className="ide__statusbar-icon" aria-hidden="true" />
            {errors}
          </span>
          <span className="ide__statusbar-count ide__statusbar-count--warn">
            <ExclamationTriangleIcon className="ide__statusbar-icon" aria-hidden="true" />
            {warnings}
          </span>
        </span>
      </div>
      <div className="ide__statusbar-right">
        <span className="ide__statusbar-item ide__statusbar-model">
          <CpuChipIcon className="ide__statusbar-icon" aria-hidden="true" />
          Bandit · {modelLabel} · tools
        </span>
      </div>
    </footer>
  );
}
