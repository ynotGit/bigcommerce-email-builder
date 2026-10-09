import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { PACKAGE_ROOT } from './config.js';
import { listLocalTemplates, readLocalTemplate } from './store.js';
import { lintTemplate, summariseClients } from './lint.js';
import { adminName, folderName } from './names.js';
import { listFixtures, renderEmail } from './render.js';
import { settingsPath } from './settings.js';
import type { Config, RenderRequest } from './types.js';

const uiFile = path.join(PACKAGE_ROOT, 'assets', 'ui.html');
const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
const escapeHtml = (text: string) => text.replace(/[&<>"]/g, (c) => HTML_ESCAPES[c] ?? c);

export interface PreviewServer {
  url: string;
  close: () => void;
}

function json(res: http.ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

function templateSummary(config: Config) {
  return listLocalTemplates(config).map((typeId) => {
    let locales = ['en'];
    try {
      const keys = Object.keys(readLocalTemplate(config, typeId)?.translations ?? {});
      if (keys.length) locales = keys;
    } catch { /* surfaced when the template renders */ }
    return { typeId, name: adminName(typeId), folder: folderName(typeId), fixtures: listFixtures(config, typeId), locales };
  });
}

export function startServer(config: Config): Promise<PreviewServer> {
  const clients = new Set<http.ServerResponse>();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const params: RenderRequest = {
      typeId: url.searchParams.get('type'),
      fixture: url.searchParams.get('fixture') || 'default',
      locale: url.searchParams.get('locale') || undefined,
    };
    try {
      if (url.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(fs.readFileSync(uiFile));
      }
      if (url.pathname === '/api/templates') {
        return json(res, { scope: config.scope, templates: templateSummary(config) });
      }
      if (url.pathname === '/api/render') {
        const { html: _html, ...meta } = await renderEmail(config, params);
        let compat: { line: number; title: string; clients: string }[] = [];
        let compatError: string | null = null;
        try {
          compat = params.typeId
            ? lintTemplate(config, params.typeId).map((i) => ({ line: i.line, title: i.title, clients: summariseClients(i.clients) }))
            : [];
        } catch (err) {
          compatError = (err as Error).message;
        }
        return json(res, { ...meta, compat, compatError });
      }
      if (url.pathname === '/frame') {
        const out = await renderEmail(config, params);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        if (out.error) {
          return res.end(
            `<!doctype html><meta charset="utf-8"><body style="margin:0;padding:24px;font:14px/1.5 ui-monospace,Menlo,Consolas,monospace;color:#8c1d18;background:#fff8f7;white-space:pre-wrap">${escapeHtml(out.error)}</body>`,
          );
        }
        // Links open in a new tab instead of navigating the preview away.
        const base = '<base target="_blank">';
        return res.end(/<head[^>]*>/i.test(out.html) ? out.html.replace(/<head[^>]*>/i, (m) => m + base) : base + out.html);
      }
      if (url.pathname === '/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
        res.write('retry: 1000\n\n');
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return undefined;
      }
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    } catch (err) {
      return json(res, { error: (err as Error).message }, 500);
    }
  });

  let timer: NodeJS.Timeout | undefined;
  const notify = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      for (const client of clients) client.write('event: change\ndata: {}\n\n');
    }, 60);
  };
  const watchers: fs.FSWatcher[] = [];
  fs.mkdirSync(config.templatesDir, { recursive: true });
  fs.mkdirSync(config.fixturesDir, { recursive: true });
  for (const target of [config.templatesDir, config.fixturesDir, settingsPath(config)]) {
    if (!fs.existsSync(target)) continue;
    const recursive = fs.statSync(target).isDirectory();
    watchers.push(fs.watch(target, { recursive }, notify));
  }

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    // Bound to localhost only: this is a development tool, not something to expose on a network.
    server.listen(config.port, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : config.port;
      resolve({
        url: `http://localhost:${port}`,
        close: () => {
          watchers.forEach((w) => w.close());
          clients.forEach((c) => c.end());
          server.close();
        },
      });
    });
  });
}
