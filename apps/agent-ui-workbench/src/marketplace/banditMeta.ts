import packageJson from "../../../bandit-stealth/package.json";
import readmeRaw from "../../../bandit-stealth/README.md?raw";

// Mirrors the shape the Extensions marketplace panel needs. Pulled
// straight from apps/bandit-stealth — bumping the extension's version
// or rewriting the README auto-refreshes the workbench preview on
// next reload, no manual edit here.

export interface BanditExtensionMeta {
  identifier: string;
  displayName: string;
  publisher: string;
  publisherDisplay: string;
  description: string;
  version: string;
  license: string;
  homepage: string;
  repositoryUrl: string;
  bugsUrl: string;
  categories: readonly string[];
  keywords: readonly string[];
  readme: string;
  /** Real on-disk size of the latest packaged .vsix, or null if it
   *  hasn't been built yet (fresh clone). */
  vsixSizeBytes: number | null;
  /** ISO timestamp of the latest packaged .vsix on disk. */
  vsixMtime: string | null;
  /** Static "first published" date — the only field we can't derive
   *  from the repo. Bump if/when we cut a new initial release. */
  firstPublishedAt: string;
}

const pkg = packageJson as unknown as {
  name: string;
  displayName: string;
  publisher: string;
  description: string;
  version: string;
  license: string;
  homepage: string;
  repository: { url: string; directory?: string };
  bugs: { url: string };
  categories?: string[];
  keywords?: string[];
};

const normaliseRepoUrl = (raw: string): string =>
  raw.replace(/^git\+/, "").replace(/\.git$/, "");

export const banditExtensionMeta: BanditExtensionMeta = {
  identifier: `${pkg.publisher}.${pkg.name}`.toLowerCase(),
  displayName: pkg.displayName,
  publisher: pkg.publisher,
  publisherDisplay: "Burtson Labs",
  description: pkg.description,
  version: pkg.version,
  license: pkg.license,
  homepage: pkg.homepage,
  repositoryUrl: normaliseRepoUrl(pkg.repository.url),
  bugsUrl: pkg.bugs.url,
  categories: pkg.categories ?? [],
  keywords: pkg.keywords ?? [],
  readme: readmeRaw,
  vsixSizeBytes: __BANDIT_VSIX_SIZE_BYTES__,
  vsixMtime: __BANDIT_VSIX_MTIME__,
  firstPublishedAt: "2026-04-18T21:06:30.000Z"
};

export const formatBytes = (bytes: number | null): string => {
  if (bytes == null) {
    return "—";
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
};

export const formatDate = (iso: string | null): string => {
  if (!iso) {
    return "—";
  }
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    return "—";
  }
  return `${d.toISOString().slice(0, 10)}, ${d
    .toISOString()
    .slice(11, 16)}`;
};
