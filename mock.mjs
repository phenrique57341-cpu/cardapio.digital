// Simula a API REST do Upstash Redis (só para testes locais). Não faz parte do site publicado.
import http from 'node:http';
import { pathToFileURL } from 'node:url';

export function startMockRedis(port, token = 'test-token') {
  const data = new Map(), exp = new Map();
  const alive = (k) => { const e = exp.get(k); if (e && e < Date.now()) { data.delete(k); exp.delete(k); return false; } return data.has(k); };
  const srv = http.createServer(async (req, res) => {
    if (req.url === '/__dump') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(Object.fromEntries([...data].filter(([k]) => alive(k))))); return; }
    let b = ''; for await (const c of req) b += c;
    const out = (code, o) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.headers.authorization !== 'Bearer ' + token) return out(401, { error: 'Unauthorized' });
    let cmd; try { cmd = JSON.parse(b); } catch { return out(400, { error: 'ERR bad body' }); }
    const [op, ...a] = cmd; let result;
    switch (String(op).toUpperCase()) {
      case 'GET': result = alive(a[0]) ? data.get(a[0]) : null; break;
      case 'SET': {
        const up = a.slice(2).map((x) => String(x).toUpperCase()); const exI = up.indexOf('EX');
        if (up.includes('NX') && alive(a[0])) { result = null; break; }
        data.set(a[0], a[1]); if (exI >= 0) exp.set(a[0], Date.now() + Number(a.slice(2)[exI + 1]) * 1000); else exp.delete(a[0]); result = 'OK'; break;
      }
      case 'DEL': { let n = 0; for (const k of a) if (alive(k)) { data.delete(k); exp.delete(k); n++; } result = n; break; }
      case 'INCR': { const live = alive(a[0]); if (!live) exp.delete(a[0]); const v = live ? Number(data.get(a[0])) : 0; data.set(a[0], String(v + 1)); result = v + 1; break; }
      case 'EXPIRE': exp.set(a[0], Date.now() + Number(a[1]) * 1000); result = 1; break;
      case 'SCAN': { const pre = String(a[a.indexOf('MATCH') + 1] || '*').replace(/\*$/, ''); result = ['0', [...data.keys()].filter((k) => alive(k) && k.startsWith(pre))]; break; }
      default: return out(400, { error: 'ERR unknown command' });
    }
    out(200, { result });
  });
  return new Promise((r) => srv.listen(port, () => r(srv)));
}
if (import.meta.url === pathToFileURL(process.argv[1]).href) startMockRedis(Number(process.env.PORT || 8870)).then(() => console.log('mock-redis pronto'));
