import type { JSX } from "react";
import { DiffBlock as BaseDiffBlock } from "../DiffBlock.js";

export interface DiffReviewBlockProps {
  diffText?: string | null;
  className?: string;
}

export const DiffBlock = ({ diffText, className }: DiffReviewBlockProps): JSX.Element | null => {
  if (!diffText || !diffText.trim()) {
    return null;
  }
  return <BaseDiffBlock source={diffText} className={className ?? "diff-review-block"} />;
};

