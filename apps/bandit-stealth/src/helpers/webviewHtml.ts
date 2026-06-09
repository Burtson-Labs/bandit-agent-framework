/**
 * Webview HTML scaffold extracted from extension.ts.
 *
 * Why: extension.ts crossed 9k lines and bandit's self-evaluation
 * flagged it as monolithic. The HTML + CSP scaffold is self-contained
 * — it depends only on the webview, the extension URI, and the
 * package version — so it pulls out cleanly.
 *
 * Why a single `buildWebviewHtml`: an earlier v1/v2 webview split is
 * gone, so we collapse to one exported builder with the asset-version
 * helper kept internal.
 */
import * as vscode from 'vscode';
import { statSync } from 'fs';
import { getNonce } from './formatting';

export interface BuildWebviewHtmlOptions {
  /** The owning webview — we ask it for `cspSource` and `asWebviewUri`. */
  webview: vscode.Webview;
  /** Root URI of the extension, used to resolve media/ asset paths. */
  extensionUri: vscode.Uri;
  /** Installed extension version. Used as the asset cache-buster. */
  packageVersion: string;
}

/**
 * Build the cache-busting suffix for the bundled webview assets. Uses
 * `<package version>.<latest asset mtime>` so a code push with no asset
 * change still moves the URL (clears stale caches), and a hot-reloaded
 * asset change during dev also bumps the URL even at the same package
 * version. Falls back to plain `<package version>` if the stat fails.
 */
function getWebviewAssetVersion(assetPaths: string[], packageVersion: string): string {
  let latestMtime = 0;
  for (const assetPath of assetPaths) {
    try {
      const mtime = Math.floor(statSync(assetPath).mtimeMs);
      if (mtime > latestMtime) {
        latestMtime = mtime;
      }
    } catch {
      // Ignore missing stats and fall back to extension version only.
    }
  }
  return latestMtime > 0 ? `${packageVersion}.${latestMtime}` : packageVersion;
}

/** Build the full <!DOCTYPE html> document for the Bandit Stealth webview. */
export function buildWebviewHtml(options: BuildWebviewHtmlOptions): string {
  const { webview, extensionUri, packageVersion } = options;
  const nonce = getNonce();
  const stylesFile = vscode.Uri.joinPath(extensionUri, 'media', 'webview', 'webview.css');
  const scriptFile = vscode.Uri.joinPath(extensionUri, 'media', 'webview', 'webview.js');
  const assetVersion = getWebviewAssetVersion([stylesFile.fsPath, scriptFile.fsPath], packageVersion);
  const stylesUri = webview.asWebviewUri(stylesFile).with({ query: `v=${assetVersion}` });
  const scriptUri = webview.asWebviewUri(scriptFile).with({ query: `v=${assetVersion}` });
  const logoUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'logo.png'));
  const configJson = JSON.stringify({ logoSrc: logoUri.toString() }).replace(/</g, '<');
  const csp = [
    "default-src 'none'",
    `img-src ${webview.cspSource} https: data:`,
    `font-src ${webview.cspSource}`,
    `style-src ${webview.cspSource}`,
    // media-src explicitly covers <audio> sources. Without this, the
    // default-src 'none' above silently blocks Blob / data URLs used
    // for TTS playback and audio.play() rejects with a CSP error the
    // user never sees. `blob:` is required because the webview
    // decodes base64 TTS payloads into a Blob and plays via
    // URL.createObjectURL. `data:` covers any future inline audio.
    `media-src 'self' blob: data:`,
    `script-src 'nonce-${nonce}' 'strict-dynamic'`
  ].join('; ');

  return /* html */ `
      <!DOCTYPE html>
      <html lang="en">
        <head>
          <meta charset="UTF-8" />
          <meta http-equiv="Content-Security-Policy" content="${csp}" />
          <meta name="viewport" content="width=device-width, initial-scale=1.0" />
          <title>Bandit Stealth</title>
          <link rel="stylesheet" href="${stylesUri}" />
        </head>
        <body>
          <div id="root"></div>
          <script id="bandit-stealth-config" type="application/json">${configJson}</script>
          <script type="module" nonce="${nonce}" src="${scriptUri}"></script>
        </body>
      </html>
    `;
}
