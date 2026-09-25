// dist/esm holds the ES module build. The package itself has no "type", so
// Node would read those .js files as CommonJS; this nested package.json marks
// the directory as ESM. sideEffects repeats the root flag for bundlers that
// look at the nearest package.json.
import { writeFileSync } from "node:fs";

writeFileSync(
  new URL("../dist/esm/package.json", import.meta.url),
  `${JSON.stringify({ type: "module", sideEffects: false }, null, 2)}\n`
);
