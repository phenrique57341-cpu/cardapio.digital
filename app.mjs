// Mesa Digital – lógica da API (independente de hospedagem). Chamada pela função da Vercel em api/[...path].js
// Variáveis de ambiente: AUTH_SECRET (obrigatória) + banco (KV_REST_API_URL / KV_REST_API_TOKEN). Nada secreto fica no código.
import crypto from 'node:crypto';
import { getStore, incr, resetLimit, ping, dbConfigured, DbErro } from './db.mjs';

const LIMIT = 10;                              // unidades (mesas) do plano Básico
const MAX_BODY = 4000000;                      // a Vercel aceita até 4,5 MB por requisição
const J = (o, s = 200, extra = {}) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra } });
const E = (m, s = 400) => J({ error: m }, s);
class Erro extends Error { constructor(m, s = 400) { super(m); this.status = s; } }
const st = (n) => getStore(n);
const rnd = (n) => crypto.randomBytes(n).toString('hex');
const ALF = 'abcdefghjkmnpqrstuvwxyz23456789';
const code4 = () => { let s = ''; for (const x of crypto.randomBytes(12)) s += ALF[x % 31]; return (s.slice(0, 4) + '-' + s.slice(4, 8) + '-' + s.slice(8, 12)).toUpperCase(); };
const norm = (c) => String(c || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const scrypt = (pw, salt) => new Promise((res, rej) => crypto.scrypt(pw, salt, 32, (e, k) => e ? rej(e) : res(k.toString('hex'))));
const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const slugify = (s) => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'loja';
const str = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
const IMG = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;
const img = (v, max) => (typeof v === 'string' && v.length <= max && IMG.test(v)) ? v : '';

// ---------- sessão (token assinado com AUTH_SECRET; a validade e o usuário são conferidos no servidor) ----------
const authOk = () => !!(process.env.AUTH_SECRET && process.env.AUTH_SECRET.length >= 16);
function secret() { if (!authOk()) throw new Error('AUTH_SECRET_MISSING'); return process.env.AUTH_SECRET; }
function sign(p) { const a = Buffer.from(JSON.stringify(p)).toString('base64url'); return a + '.' + crypto.createHmac('sha256', secret()).update(a).digest('base64url'); }
function verify(t) {
  const [a, h] = String(t || '').split('.'); if (!a || !h) return null;
  if (!same(h, crypto.createHmac('sha256', secret()).update(a).digest('base64url'))) return null;
  try { const d = JSON.parse(Buffer.from(a, 'base64url').toString()); return d.exp > Date.now() ? d : null; } catch { return null; }
}
const token = (id, email) => sign({ sub: id, email, exp: Date.now() + 30 * 864e5 });

// ---------- fotos: ficam em chaves separadas (não dentro do documento da loja) e são servidas em /api/img/... ----------
const imgUrl = (v, i) => i.ih ? '/api/img/' + v.slug + '/' + i.id + '?v=' + i.ih : (i.img || '');
const itemOut = (v, i) => ({ id: i.id, name: i.name, desc: i.desc, price: i.price, cat: i.cat, img: imgUrl(v, i), off: i.off });
const ownerView = (v) => ({ id: v.id, slug: v.slug, email: v.email, plan: v.plan, hidden: !!v.hidden, name: v.name, phone: v.phone, hours: v.hours, color: v.color, logo: v.logo, insta: v.insta, face: v.face, about: v.about || '', address: v.address || '', tables: v.tables, items: v.items.map((i) => itemOut(v, i)) });
const publicView = (v) => ({ slug: v.slug, name: v.name, phone: v.phone, hours: v.hours, about: v.about || '', address: v.address || '', color: v.color, logo: v.logo, insta: v.insta, face: v.face, tables: v.tables, items: v.items.map((i) => itemOut(v, i)) });

function cleanItems(a) {
  if (!Array.isArray(a) || a.length > 200) throw new Erro('Cardápio com itens demais (máx. 200).');
  const seen = new Set();
  return a.map((i) => {
    const id = str(i.id, 40).replace(/[^a-zA-Z0-9_-]/g, ''); const name = str(i.name, 80); const price = Number(i.price);
    if (!id || seen.has(id)) throw new Erro('Produto com identificador inválido.'); seen.add(id);
    if (!name) throw new Erro('Todo produto precisa de nome.');
    if (!Number.isFinite(price) || price < 0 || price > 99999) throw new Erro('Preço inválido em "' + name + '".');
    const raw = typeof i.img === 'string' ? i.img : '';
    const mode = img(raw, 160000) ? 'new' : raw.startsWith('/api/img/') ? 'keep' : 'none';
    return { id, name, desc: str(i.desc, 300), price: Math.round(price * 100) / 100, cat: str(i.cat, 40) || 'Geral', off: !!i.off, mode, data: mode === 'new' ? raw : '' };
  });
}
async function saveItems(S, v, cleaned) {                       // grava fotos novas, mantém as iguais, apaga as removidas
  const old = new Map(v.items.map((i) => [i.id, i])), out = [];
  for (const c of cleaned) {
    const o = old.get(c.id); let ih = '';
    if (c.mode === 'new') { ih = crypto.createHash('sha1').update(c.data).digest('hex').slice(0, 12); if (!o || o.ih !== ih) await S.imgs.set(v.id + ':' + c.id, c.data); }
    else if (c.mode === 'keep') ih = (o && o.ih) || '';
    else if (o && o.ih) await S.imgs.delete(v.id + ':' + c.id);
    out.push({ id: c.id, name: c.name, desc: c.desc, price: c.price, cat: c.cat, off: c.off, ih });
  }
  for (const [id, o] of old) if (o.ih && !cleaned.some((c) => c.id === id)) await S.imgs.delete(v.id + ':' + id);
  return out;
}
function cleanTables(a) {
  if (!Array.isArray(a)) return [];
  return [...new Set(a.map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= 99))].sort((x, y) => x - y).slice(0, LIMIT);
}

// ---------- vitrine: só lojas ativas, não ocultas e com pelo menos 1 produto ----------
const summary = (v) => ({ slug: v.slug, name: v.name, logo: v.logo && v.logo.length <= 40000 ? v.logo : '', color: v.color, hours: v.hours, about: v.about || '', address: v.address || '', insta: v.insta || '', face: v.face || '', count: v.items.length, cats: [...new Set(v.items.filter((i) => !i.off).map((i) => i.cat))].slice(0, 8) });
async function updateIndex(dir, v) {
  const list = ((await dir.get('list', { type: 'json' })) || []).filter((s) => s.slug !== v.slug);
  if (v.active && !v.hidden && v.items.length) list.push(summary(v));
  list.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  await dir.setJSON('list', list);
}

async function handle(req) {
  const url = new URL(req.url);
  const parts = url.pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  const [a, b, c] = parts; const M = req.method;
  let body = {};
  if (M !== 'GET' && M !== 'HEAD') {
    const raw = await req.text();
    if (raw.length > MAX_BODY) return E('Dados grandes demais. Use fotos menores.', 413);
    try { body = raw ? JSON.parse(raw) : {}; } catch { return E('Requisição inválida.'); }
  }
  if (a === 'health' && M === 'GET') {                       // diagnóstico: só diz SE está configurado (nunca mostra valores)
    let db = false; if (dbConfigured()) { try { db = await ping(); } catch { db = false; } }
    return J({ ok: true, db, auth: authOk() });
  }
  const users = st('users'), vendors = st('vendors'), slugs = st('slugs');
  const S = { imgs: st('imgs') };
  const auth = () => verify((req.headers.get('authorization') || '').replace(/^Bearer\s+/i, ''));

  // ---------- cadastro / login / recuperação ----------
  if (a === 'signup' && M === 'POST') {
    secret();
    const name = str(body.name, 80), email = str(body.email, 120).toLowerCase(), pw = String(body.password || '');
    if (!name) return E('Informe o nome do estabelecimento.');
    if (!/^\S+@\S+\.\S+$/.test(email)) return E('Informe um e-mail válido.');
    if (pw.length < 6 || pw.length > 200) return E('A senha precisa ter pelo menos 6 caracteres.');
    const id = rnd(12); let slug = '';
    for (let i = 0; i < 8 && !slug; i++) { const c2 = slugify(name) + '-' + rnd(2); if ((await slugs.set(c2, id, { onlyIfNew: true })).modified) slug = c2; }
    if (!slug) return E('Não foi possível reservar o endereço. Tente novamente.', 503);
    const salt = rnd(16), recSalt = rnd(16), code = code4();
    const user = { id, slug, salt, hash: await scrypt(pw, salt), recSalt, rec: await scrypt(norm(code), recSalt), createdAt: Date.now() };
    if (!(await users.set(email, JSON.stringify(user), { onlyIfNew: true })).modified) { await slugs.delete(slug); return E('Este e-mail já está cadastrado.', 409); }
    const v = { id, slug, email, name, phone: '', hours: '', color: '#ea580c', logo: '', insta: '', face: '', about: '', address: '', active: true, hidden: false, plan: 'basico', since: Date.now(), items: [], tables: [] };
    await vendors.setJSON(id, v);
    return J({ token: token(id, email), vendor: ownerView(v), recoveryCode: code }, 201);
  }
  if (a === 'login' && M === 'POST') {
    secret();
    const email = str(body.email, 120).toLowerCase();
    if ((await incr('auth:' + email, 900)) > 8) return E('Muitas tentativas. Aguarde 15 minutos e tente de novo.', 429);
    const u = await users.get(email, { type: 'json' });
    if (!u || !same(await scrypt(String(body.password || ''), u.salt), u.hash)) return E('E-mail ou senha incorretos.', 401);
    await resetLimit('auth:' + email);
    const v = await vendors.get(u.id, { type: 'json' });
    return J({ token: token(u.id, email), vendor: ownerView(v) });
  }
  if (a === 'recover' && M === 'POST') {
    const email = str(body.email, 120).toLowerCase(), pw = String(body.password || '');
    if ((await incr('auth:' + email, 900)) > 8) return E('Muitas tentativas. Aguarde 15 minutos e tente de novo.', 429);
    const u = await users.get(email, { type: 'json' });
    if (!u || !u.rec || !same(await scrypt(norm(body.code), u.recSalt), u.rec)) return E('E-mail ou código de recuperação incorretos.', 401);
    if (pw.length < 6 || pw.length > 200) return E('A nova senha precisa ter pelo menos 6 caracteres.');
    const code = code4(); u.salt = rnd(16); u.hash = await scrypt(pw, u.salt); u.recSalt = rnd(16); u.rec = await scrypt(norm(code), u.recSalt);
    await users.setJSON(email, u); await resetLimit('auth:' + email);
    return J({ ok: true, recoveryCode: code });
  }

  // ---------- público (qualquer pessoa, sem conta) ----------
  if (a === 'public' && b && M === 'GET') {
    const id = await slugs.get(b); const v = id && await vendors.get(id, { type: 'json' });
    if (!v || !v.active) return E('Cardápio não encontrado.', 404);
    return J(publicView(v));
  }
  if (a === 'directory' && M === 'GET') return J({ vendors: (await st('directory').get('list', { type: 'json' })) || [] });
  if (a === 'img' && b && c && M === 'GET') {                  // foto do produto (cacheável: a URL muda quando a foto muda)
    const id = await slugs.get(b); const data = id && await S.imgs.get(id + ':' + c);
    const m = data && /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(data);
    if (!m) return new Response('Não encontrada', { status: 404 });
    return new Response(Buffer.from(m[2], 'base64'), { status: 200, headers: { 'content-type': m[1], 'cache-control': 'public, max-age=31536000, immutable', 'x-content-type-options': 'nosniff' } });
  }

  // ---------- área do vendedor: exige sessão válida; o dono vem SEMPRE do token, nunca do que o navegador envia ----------
  const au = auth(); if (!au) return E('Sessão expirada. Entre novamente.', 401);
  const id = au.sub;
  if (a === 'me' && M === 'GET') { const v = await vendors.get(id, { type: 'json' }); return v ? J(ownerView(v)) : E('Conta não encontrada.', 404); }
  if (a === 'vendor' && M === 'PUT') {
    const v = await vendors.get(id, { type: 'json' }); if (!v) return E('Conta não encontrada.', 404);
    const color = /^#[0-9a-fA-F]{6}$/.test(body.color) ? body.color : v.color;
    const items = await saveItems(S, v, cleanItems(body.items));
    const nv = { ...v, name: str(body.name, 80) || v.name, phone: str(body.phone, 30), hours: str(body.hours, 80), color, logo: img(body.logo, 80000), insta: str(body.insta, 40), face: str(body.face, 60), about: str(body.about, 200), address: str(body.address, 120), items, tables: cleanTables(body.tables), hidden: typeof body.hidden === 'boolean' ? body.hidden : !!v.hidden };
    await vendors.setJSON(id, nv);
    await updateIndex(st('directory'), nv);
    return J({ ok: true, vendor: ownerView(nv) });
  }
  return E('Rota não encontrada.', 404);
}

export async function handleRequest(req) {
  try { return await handle(req); }
  catch (e) {
    if (e instanceof Erro) return E(e.message, e.status);
    if (e && e.message === 'AUTH_SECRET_MISSING') return E('O servidor está sem a variável AUTH_SECRET. Configure-a na Vercel (veja o README).', 503);
    if (e instanceof DbErro) return E(e.message === 'DB_NOT_CONFIGURED' ? 'O banco de dados não está configurado. Conecte o Upstash Redis ao projeto na Vercel (veja o README).' : 'Não foi possível conectar ao banco de dados. Tente de novo em instantes.', 503);
    console.error('Erro na API:', e && e.message); return E('Erro interno do servidor.', 500);
  }
}
