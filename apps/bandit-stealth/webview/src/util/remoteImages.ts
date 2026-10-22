/**
 * Click-to-load for remote images in model-written markdown.
 *
 * The renderer (agent-ui `disableRemoteImages`) never emits an <img> for a
 * remote URL; it emits a `.bandit-blocked-image[data-remote-image-src]` span
 * that names the host. The webview CSP allows images only from the extension
 * itself and `data:` URIs, so even a stray <img src="https://…"> could not
 * load. When the user clicks the span, the webview asks the extension host to
 * fetch that one URL (`loadRemoteImage`); the host fetches it through the
 * SSRF-guarded fetch and answers with a `data:image/…` URI, which replaces the
 * span. Nothing is requested without the click.
 */

export interface RemoteImageResult {
  type: "remoteImageLoaded" | "remoteImageFailed";
  url: string;
  dataUri?: string;
  error?: string;
}

const SELECTOR = ".bandit-blocked-image[data-remote-image-src]";
const loaded = new Map<string, string>();
const pending = new Set<string>();
const failed = new Map<string, string>();

function spansFor(root: ParentNode, url?: string): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(SELECTOR)).filter(
    (el) => url === undefined || el.dataset.remoteImageSrc === url
  );
}

/** Replace every span whose image has been loaded (survives re-renders). */
export function applyLoadedImages(root: ParentNode = document): void {
  for (const span of spansFor(root)) {
    const url = span.dataset.remoteImageSrc ?? "";
    const dataUri = loaded.get(url);
    if (dataUri) {
      const img = document.createElement("img");
      img.src = dataUri;
      img.alt = span.textContent?.replace(/^\[image\]\s*/, "").replace(/\s*\(click to load.*\)$/, "") ?? "";
      img.className = "bandit-loaded-image";
      img.title = url;
      span.replaceWith(img);
    } else if (pending.has(url)) {
      span.dataset.state = "loading";
    } else if (failed.has(url)) {
      span.dataset.state = "failed";
      span.title = `Could not load this image: ${failed.get(url)}. Click to try again.`;
    }
  }
}

/** Apply a host reply. Only `data:image/` URIs are ever put in the page. */
export function handleRemoteImageResult(message: RemoteImageResult): void {
  pending.delete(message.url);
  if (message.type === "remoteImageLoaded" && typeof message.dataUri === "string" && /^data:image\//i.test(message.dataUri)) {
    failed.delete(message.url);
    loaded.set(message.url, message.dataUri);
  } else {
    failed.set(message.url, message.error ?? "unknown error");
  }
  applyLoadedImages();
}

/**
 * Delegated click/Enter handler plus a MutationObserver that re-applies loaded
 * images after each markdown re-render. Returns an uninstall function.
 */
export function installRemoteImageLoader(post: (message: { type: "loadRemoteImage"; url: string }) => void): () => void {
  const request = (span: HTMLElement): void => {
    const url = span.dataset.remoteImageSrc;
    if (!url || pending.has(url) || loaded.has(url)) return;
    pending.add(url);
    failed.delete(url);
    span.dataset.state = "loading";
    post({ type: "loadRemoteImage", url });
  };
  const onClick = (event: MouseEvent): void => {
    const span = (event.target as HTMLElement | null)?.closest?.<HTMLElement>(SELECTOR);
    if (!span) return;
    event.preventDefault();
    request(span);
  };
  const onKey = (event: KeyboardEvent): void => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const span = (event.target as HTMLElement | null)?.closest?.<HTMLElement>(SELECTOR);
    if (!span) return;
    event.preventDefault();
    request(span);
  };
  document.addEventListener("click", onClick);
  document.addEventListener("keydown", onKey);
  const observer = typeof MutationObserver === "function"
    ? new MutationObserver(() => {
        if (loaded.size || pending.size || failed.size) applyLoadedImages();
      })
    : null;
  observer?.observe(document.body, { childList: true, subtree: true });
  return () => {
    document.removeEventListener("click", onClick);
    document.removeEventListener("keydown", onKey);
    observer?.disconnect();
  };
}

/** Test helper. */
export function resetRemoteImagesForTests(): void {
  loaded.clear();
  pending.clear();
  failed.clear();
}
