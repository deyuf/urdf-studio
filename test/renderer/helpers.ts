import { createReadStream, statSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';

const MIME: Record<string, string> = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.stl': 'application/octet-stream', '.dae': 'application/xml'
};

// Shared by web-shell and isolated renderer tests; each caller owns its server.
export async function startStaticServer(root: string): Promise<{ url: string; close(): Promise<void> }> {
  const base = path.resolve(root);
  const server = createServer((request, response) => {
    let filePath: string;
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const pathname = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
      filePath = path.resolve(base, `.${pathname}`);
      const relative = path.relative(base, filePath);
      if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative) || !statSync(filePath).isFile()) {
        throw new Error('Not a served file');
      }
    } catch {
      response.writeHead(404).end('not found');
      return;
    }
    response.writeHead(200, { 'content-type': MIME[path.extname(filePath)] ?? 'application/octet-stream' });
    const stream = createReadStream(filePath);
    stream.on('error', () => response.destroy());
    stream.pipe(response);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not start test server');
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  };
}
