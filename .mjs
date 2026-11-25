// Banco de dados: Upstash Redis via API REST (integração oficial da Vercel). Sem dependências npm.
// Variáveis (a Vercel preenche sozinha ao conectar o banco ao projeto):
//   KV_REST_API_URL e KV_REST_API_TOKEN   (ou UPSTASH_REDIS_REST_URL e UPSTASH_REDIS_REST_TOKEN)
const URL_ = () => (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/+$/, '');
const TOKEN = () => process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';
export const dbConfigured = () => !!(URL_() && TOKEN());
export class DbErro extends Error {}

async function cmd(args) {
  if (!dbConfigured()) throw new DbErro('DB_NOT_CONFIGURED');
  let r;
  try { r = await fetch(URL_(), { method: 'POST', headers: { authorization: 'Bearer ' + TOKEN(), 'content-type': 'application/json' }, body: JSON.stringify(args) }); }
  catch { throw new DbErro('DB_UNREACHABLE'); }
  let j; try { j = await r.json(); } catch { throw new DbErro('DB_BAD_RESPONSE'); }
  if (!r.ok || j.error) throw new DbErro('DB_ERROR');
  return j.result;
}

// Mesma interface usada pela API: get / set (onlyIfNew = SET NX, atômico) / setJSON / delete / list
export function getStore(name) {
  const k = (key) => name + ':' + key;
  return {
    async get(key, opt) { const v = await cmd(['GET', k(key)]); if (v == null) return null; return opt && opt.type === 'json' ? JSON.parse(v) : v; },
    async set(key, value, opt) { const args = ['SET', k(key), typeof value === 'string' ? value : String(value)]; if (opt && opt.onlyIfNew) args.push('NX'); return { modified: (await cmd(args)) === 'OK' }; },
    async setJSON(key, value) { await cmd(['SET', k(key), JSON.stringify(value)]); return { modified: true }; },
    async delete(key) { await cmd(['DEL', k(key)]); },
    async list() { let cursor = '0'; const keys = []; do { const [c, ks] = await cmd(['SCAN', cursor, 'MATCH', name + ':*', 'COUNT', '200']); cursor = String(c); for (const x of ks) keys.push(x.slice(name.length + 1)); } while (cursor !== '0' && keys.length < 5000); return { blobs: keys.map((key) => ({ key })) }; },
  };
}
// limite de tentativas (contador com validade)
export async function incr(key, ttlSec) { const n = await cmd(['INCR', 'rl:' + key]); if (n === 1) await cmd(['EXPIRE', 'rl:' + key, String(ttlSec)]); return n; }
export async function resetLimit(key) { await cmd(['DEL', 'rl:' + key]); }
export async function ping() { await cmd(['SET', 'health:ping', '1', 'EX', '60']); return (await cmd(['GET', 'health:ping'])) === '1'; }
