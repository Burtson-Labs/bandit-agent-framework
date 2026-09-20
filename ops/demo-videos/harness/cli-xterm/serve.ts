/**
 * Tiny static server for the CLI xterm harness.
 *
 *   node --import tsx ops/demo-videos/harness/cli-xterm/serve.ts
 *   open http://127.0.0.1:4177/
 *
 * Later: spawn `bandit` under node-pty and bridge WS ↔ xterm.
 */
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { CLI_XTERM_HARNESS } from './config.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || CLI_XTERM_HARNESS.defaultPort);

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://127.0.0.1:${port}`);
  if (url.pathname === '/' || url.pathname === '/index.html') {
    const html = fs.readFileSync(path.join(__dirname, 'index.html'));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }
  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, harness: CLI_XTERM_HARNESS.id }));
    return;
  }
  res.writeHead(404).end('not found');
});

server.listen(port, '127.0.0.1', () => {
  console.log(`[cli-xterm] http://127.0.0.1:${port}/  (fixture terminal — PTY bridge TBD)`);
});
