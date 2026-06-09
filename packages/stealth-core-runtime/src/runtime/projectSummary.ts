export function describeScanResponse(data: Record<string, unknown> | undefined): string | undefined {
  if (!data) {
    return undefined;
  }
  const fileCount = Array.isArray(data.files) ? data.files.length : undefined;
  const scripts =
    data.scripts && typeof data.scripts === 'object'
      ? Object.keys(data.scripts as Record<string, unknown>).join(', ')
      : '';
  const parts: string[] = [];
  if (typeof fileCount === 'number') {
    parts.push(`${fileCount} files`);
  }
  if (scripts) {
    parts.push(`scripts: ${scripts}`);
  }
  return parts.length > 0 ? parts.join('; ') : undefined;
}

export function buildProjectSummary(data: Record<string, unknown> | undefined): string {
  if (!data) {
    return 'Project metadata unavailable.';
  }
  const files = Array.isArray(data.files) ? data.files.slice(0, 10) : [];
  const scripts =
    data.scripts && typeof data.scripts === 'object'
      ? Object.keys(data.scripts as Record<string, unknown>)
      : [];
  const pkg =
    data.packageJson && typeof data.packageJson === 'object'
      ? (data.packageJson as Record<string, unknown>)
      : undefined;
  const deps =
    pkg && typeof pkg.dependencies === 'object'
      ? Object.keys(pkg.dependencies as Record<string, unknown>)
      : [];
  return [
    files.length > 0 ? `Notable files: ${files.join(', ')}` : 'No files captured.',
    scripts.length > 0 ? `Scripts: ${scripts.join(', ')}` : 'No npm scripts found.',
    deps.length > 0 ? `Dependencies: ${deps.slice(0, 8).join(', ')}` : 'Dependencies not detected.'
  ].join(' | ');
}
