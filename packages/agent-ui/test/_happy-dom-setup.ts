/**
 * happy-dom implements `nodeName` as a getter on each node class (Element,
 * Text, Comment, ...) and leaves the `Node.prototype` getter returning ''.
 * DOMPurify 3.4.12+ hardens against prototype clobbering by taking that
 * getter from `Node.prototype` once, when the module loads, and calling it on
 * every node it visits — so under happy-dom every element has an empty name,
 * counts as disallowed and is unwrapped, and the node iterator then skips the
 * element's siblings. Browsers define `nodeName` on `Node.prototype`, so the
 * webview is unaffected; this suite was: the "must not break" assertions in
 * markdownSanitize.test.ts failed, and `<p><img></p>` with
 * `FORBID_TAGS: ['img']` kept the image (dompurify 3.4.7 was the last version
 * that sanitized correctly here).
 *
 * Give `Node.prototype.nodeName` a getter that dispatches to the nearest
 * subclass getter. Listed in vitest `setupFiles`, so it runs before
 * `dompurify` is imported and captures the getter.
 */
const nodeProto = Node.prototype;
const baseGetter = Object.getOwnPropertyDescriptor(nodeProto, 'nodeName')?.get;

Object.defineProperty(nodeProto, 'nodeName', {
  configurable: true,
  enumerable: false,
  get(this: Node): string {
    let proto = Object.getPrototypeOf(this);
    while (proto && proto !== nodeProto) {
      const own = Object.getOwnPropertyDescriptor(proto, 'nodeName');
      if (own?.get) {
        return own.get.call(this) as string;
      }
      proto = Object.getPrototypeOf(proto);
    }
    return baseGetter ? (baseGetter.call(this) as string) : '';
  }
});

export {};
