// Função serverless da Vercel: atende TODAS as rotas /api/* (health, signup, login, recover, public, directory, img, me, vendor).
import { handleRequest } from './_lib/app.mjs';

async function readBody(req) {
  if (req.body !== undefined && req.body !== null) {            // a Vercel já leu o corpo (JSON)
    if (Buffer.isBuffer(req.body)) return req.body;
    if (typeof req.body === 'string') return req.body;
    return JSON.stringify(req.body);
  }
  const chunks = []; for await (const c of req) chunks.push(c); return Buffer.concat(chunks);
}

export default async function handler(req, res) {
  try {
    const proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0];
    const request = new Request(proto + '://' + (req.headers.host || 'localhost') + req.url, {
      method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : await readBody(req),
    });
    const r = await handleRequest(request);
    res.statusCode = r.status;
    r.headers.forEach((v, k) => res.setHeader(k, v));
    res.end(Buffer.from(await r.arrayBuffer()));
  } catch (e) {
    console.error('Falha na função:', e && e.message);
    res.statusCode = 500; res.setHeader('content-type', 'application/json; charset=utf-8'); res.end(JSON.stringify({ error: 'Erro interno do servidor.' }));
  }
}
