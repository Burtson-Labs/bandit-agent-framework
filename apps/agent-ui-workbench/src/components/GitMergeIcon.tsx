import type { SVGProps } from "react";

/**
 * Inline git-merge glyph matching the lucide / VS Code source-control
 * visual: two stacked dots on the left rail merging into a third dot
 * on the right rail via an arched join. Kept inline so we don't pull
 * the entire lucide-react package just for one icon.
 */
export function GitMergeIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <circle cx="6" cy="6" r="2.25" />
      <circle cx="6" cy="18" r="2.25" />
      <circle cx="18" cy="18" r="2.25" />
      <path d="M6 8.25v7.5" />
      <path d="M8.25 6h2.25a6 6 0 0 1 6 6v3.75" />
    </svg>
  );
}
