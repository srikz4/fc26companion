/**
 * Local view server (spec.md §3: loopback only, no outbound requests).
 *
 * Serves the View document and a Server-Sent Events stream. When the watcher
 * ingests a save the stream pushes `refresh`, the page refetches, and the screen
 * updates — you never press sync.
 *
 * `node:http` rather than a framework: this binds to 127.0.0.1 and serves four
 * routes, and a dependency here would be one more thing that could reach the
 * network.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';

export interface ViewProvider {
  /** Current view document. Cached by the caller; called on every request. */
  get(): unknown;
}

export interface ServerOptions {
  port: number;
  webRoot: string;
  /** Directory of locally imported player headshots; absent files 404. */
  facesRoot?: string | undefined;
  provider: ViewProvider;
  /** Bind address. Loopback unless the user opts into LAN. */
  host?: string;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

export class ViewServer {
  private readonly options: Omit<Required<ServerOptions>, 'facesRoot'> & {
    facesRoot?: string | undefined;
  };
  private readonly clients = new Set<ServerResponse>();
  private server = createServer((req, res) => {
    this.handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });

  constructor(options: ServerOptions) {
    this.options = { host: '127.0.0.1', ...options };
  }

  /** Resolves with the URL actually bound — port 0 means the OS picks one. */
  listen(): Promise<string> {
    return new Promise((done) => {
      this.server.listen(this.options.port, this.options.host, () => {
        const address = this.server.address();
        const port = typeof address === 'object' && address !== null ? address.port : this.options.port;
        const shown = this.options.host === '0.0.0.0' ? '127.0.0.1' : this.options.host;
        done(`http://${shown}:${port}`);
      });
    });
  }

  close(): void {
    for (const client of this.clients) {
      client.end();
      // An SSE response is a hanging socket; ending it is not enough to let the
      // process exit while a client is still holding the connection open.
      client.destroy();
    }
    this.clients.clear();
    this.server.closeAllConnections();
    this.server.close();
  }

  /** Tell every open page that new data is available. */
  broadcast(event: string, data: unknown = {}): void {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of this.clients) client.write(payload);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');

    if (url.pathname === '/api/view') {
      const body = JSON.stringify(this.options.provider.get());
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      });
      res.end(body);
      return;
    }

    if (url.pathname === '/api/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.write('retry: 2000\n\n');
      this.clients.add(res);

      // Keep intermediaries from closing an idle stream. Unref'd so an open page
      // never holds the process alive on its own.
      const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
      ping.unref();
      req.on('close', () => {
        clearInterval(ping);
        this.clients.delete(res);
      });
      return;
    }

    // Locally imported headshots. The importer put them on disk; the runtime
    // never fetches one.
    if (url.pathname.startsWith('/faces/') && this.options.facesRoot) {
      const id = url.pathname.slice('/faces/'.length);
      if (!/^\d{1,9}\.png$/.test(id)) {
        res.writeHead(404);
        res.end();
        return;
      }
      try {
        const body = await readFile(join(this.options.facesRoot, id));
        res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'max-age=86400' });
        res.end(body);
      } catch {
        res.writeHead(404);
        res.end();
      }
      return;
    }

    // Static files, confined to webRoot.
    const requested = url.pathname === '/' ? '/index.html' : url.pathname;
    const root = resolve(this.options.webRoot);
    const target = resolve(join(root, normalize(requested)));
    if (target !== root && !target.startsWith(root + sep)) {
      res.writeHead(403);
      res.end('forbidden');
      return;
    }

    try {
      const body = await readFile(target);
      res.writeHead(200, {
        'content-type': MIME[extname(target)] ?? 'application/octet-stream',
        'cache-control': 'no-store',
      });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end('not found');
    }
  }
}
