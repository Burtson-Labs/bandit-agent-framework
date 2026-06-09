import type { JSX } from "react";
import { classNames } from "../utils/classNames";

const DIFF_META_PATTERN =
  /^(diff --git|index|--- |\+\+\+|rename |similarity |new file|deleted file|\\ No newline)/;
const HUNK_HEADER_PATTERN = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

const getLineClassName = (line: string): string => {
  return classNames(
    "diff-line",
    line.startsWith("@@") && "diff-hunk",
    line.startsWith("+") && "diff-add",
    line.startsWith("-") && "diff-del",
    DIFF_META_PATTERN.test(line) && "diff-meta"
  );
};

export interface DiffBlockProps {
  source?: string | null;
  className?: string;
}

export const DiffBlock = ({ source, className }: DiffBlockProps): JSX.Element | null => {
  if (!source || !source.trim()) {
    return null;
  }

  const normalizedLines = source.replace(/\r\n/g, "\n").split("\n");
  let oldLine = 0;
  let newLine = 0;

  const getLineNumbers = (line: string): { oldNumber: number | null; newNumber: number | null } => {
    if (line.startsWith("@@")) {
      const match = line.match(HUNK_HEADER_PATTERN);
      if (match) {
        oldLine = Number.parseInt(match[1], 10);
        newLine = Number.parseInt(match[2], 10);
      }
      return { oldNumber: null, newNumber: null };
    }
    if (DIFF_META_PATTERN.test(line)) {
      return { oldNumber: null, newNumber: null };
    }
    if (line.startsWith("+")) {
      const current = newLine;
      newLine += 1;
      return { oldNumber: null, newNumber: current };
    }
    if (line.startsWith("-")) {
      const current = oldLine;
      oldLine += 1;
      return { oldNumber: current, newNumber: null };
    }
    if (line.startsWith(" ")) {
      const currentOld = oldLine;
      const currentNew = newLine;
      oldLine += 1;
      newLine += 1;
      return { oldNumber: currentOld, newNumber: currentNew };
    }
    return { oldNumber: null, newNumber: null };
  };

  const formatNumber = (value: number | null): string => {
    return typeof value === "number" ? value.toString() : "";
  };

  return (
    <pre className={classNames("diff-block", className)}>
      <code className="language-diff">
        {normalizedLines.map((line, index) => {
          const { oldNumber, newNumber } = getLineNumbers(line);
          return (
            <span key={`diff-line-${index}`} className={getLineClassName(line)}>
              <span className="diff-line__numbers" aria-hidden="true">
                <span>{formatNumber(oldNumber)}</span>
                <span>{formatNumber(newNumber)}</span>
              </span>
              <span className="diff-line__content">{line.length ? line : "\u00a0"}</span>
            </span>
          );
        })}
      </code>
    </pre>
  );
};
