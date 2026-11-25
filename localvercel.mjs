// Simula, no seu computador, o que a Vercel faz: serve a pasta public/ (com as regras do vercel.json) e chama api/[...path].js.
// Uso (opcional): AUTH_SECRET=... KV_REST_API_URL=... KV_REST_API_TOKEN=... node tests/local-vercel.mjs
// Para testar de verdade com a Vercel use:  npx vercel dev
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const handler = (await import(pathToFileURL(path.join(root, 'api', '[...path].js')).href)).default;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml' };

export function startLocalVercel(port) {
  return new Promise((r) => {
    const srv = http.createServer(async (req, res) => {
      if (req.url === '/api' || req.url.startsWith('/api/')) {
        // a Vercel entrega req.body já lido quando o conteúdo é JSON (VERCEL_PARSE_BODY=0 desliga, para testar o outro caminho)
        if (process.env.VERCEL_PARSE_BODY !== '0' && !['GET', 'HEAD'].includes(req.method) && String(req.headers['content-type'] || '').includes('application/json')) {
          const chunks = []; for await (const c of req) chunks.push(c); const raw = Buffer.concat(chunks).toString();
          try { req.body = raw ? JSON.parse(raw) : {}; } catch { req.body = raw; }
        }
        return handler(req, res);
      }
      const u = new URL(req.url, 'http://x'); let p = u.pathname;
      if (p === '/' || p === '/cardapios' || /^\/cardapio\/[^/]+$/.test(p)) p = '/index.html';          // rewrites do vercel.json
      const pub = path.join(root, 'public'), f = path.join(pub, path.normalize(p));
      if (!f.startsWith(pub) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end('Não encontrado'); return; }
      res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
    });
    srv.listen(port, () => r(srv));
  });
}
if (import.meta.url === pathToFileURL(process.argv[1]).href) startLocalVercel(Number(process.env.PORT || 3000)).then(() => console.log('local-vercel pronto'));
