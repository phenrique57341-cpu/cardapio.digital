// Mesa Digital - API (Netlify Functions v2 + Netlify Blobs)
// Variável de ambiente obrigatória: AUTH_SECRET (texto aleatório com 32+ caracteres)
import crypto from 'node:crypto';
import { getStore } from '@netlify/blobs';

export const config = { path: '/api/*' };

const LIMIT = 10;                       // unidades (mesas) do plano Básico
const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const E = (m, s = 400) => J({ error: m }, s);
const st = (n) => getStore({ name: n, consistency: 'strong' });
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

function secret() { const s = process.env.AUTH_SECRET; if (!s || s.length < 16) throw new Error('AUTH_SECRET_MISSING'); return s; }
function sign(p) { const a = Buffer.from(JSON.stringify(p)).toString('base64url'); return a + '.' + crypto.createHmac('sha256', secret()).update(a).digest('base64url'); }
function verify(t) {
  const [a, h] = String(t || '').split('.'); if (!a || !h) return null;
  if (!same(h, crypto.createHmac('sha256', secret()).update(a).digest('base64url'))) return null;
  try { const d = JSON.parse(Buffer.from(a, 'base64url').toString()); return d.exp > Date.now() ? d : null; } catch { return null; }
}
const token = (id, email) => sign({ sub: id, email, exp: Date.now() + 30 * 864e5 });

const ownerView = (v) => ({ id: v.id, slug: v.slug, email: v.email, plan: v.plan, hidden: !!v.hidden, name: v.name, phone: v.phone, hours: v.hours, color: v.color, logo: v.logo, insta: v.insta, face: v.face, about: v.about || '', address: v.address || '', tables: v.tables, items: v.items });
const publicView = (v) => ({ slug: v.slug, name: v.name, phone: v.phone, hours: v.hours, about: v.about || '', address: v.address || '', color: v.color, logo: v.logo, insta: v.insta, face: v.face, tables: v.tables, items: v.items.map(({ id, name, desc, price, cat, img, off }) => ({ id, name, desc, price, cat, img, off })) });

function cleanItems(a) {
  if (!Array.isArray(a) || a.length > 200) throw new Error('Cardápio com itens demais (máx. 200).');
  const seen = new Set();
  return a.map((i) => {
    const id = str(i.id, 40).replace(/[^a-zA-Z0-9_-]/g, ''); const name = str(i.name, 80); const price = Number(i.price);
    if (!id || seen.has(id)) throw new Error('Produto com identificador inválido.'); seen.add(id);
    if (!name) throw new Error('Todo produto precisa de nome.');
    if (!Number.isFinite(price) || price < 0 || price > 99999) throw new Error('Preço inválido em "' + name + '".');
    return { id, name, desc: str(i.desc, 300), price: Math.round(price * 100) / 100, cat: str(i.cat, 40) || 'Geral', img: img(i.img, 160000), off: !!i.off };
  });
}
function cleanTables(a) {
  if (!Array.isArray(a)) return [];
  return [...new Set(a.map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= 99))].sort((x, y) => x - y).slice(0, LIMIT);
}

// Índice da vitrine: só entram lojas ativas, publicadas e com pelo menos 1 produto.
const summary = (v) => ({ slug: v.slug, name: v.name, logo: v.logo && v.logo.length <= 40000 ? v.logo : '', color: v.color, hours: v.hours, about: v.about || '', address: v.address || '', insta: v.insta || '', face: v.face || '', count: v.items.length, cats: [...new Set(v.items.filter((i) => !i.off).map((i) => i.cat))].slice(0, 8) });
async function updateIndex(dir, v) {
  const list = ((await dir.get('list', { type: 'json' })) || []).filter((s) => s.slug !== v.slug);
  if (v.active && !v.hidden && v.items.length) list.push(summary(v));      // aparece sozinha quando tem produto; some só se o dono ocultar
  list.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  await dir.setJSON('list', list);
}

async function handle(req) {
  const url = new URL(req.url);
  const parts = url.pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  const [a, b] = parts; const M = req.method;
  let body = {};
  if (M !== 'GET' && M !== 'HEAD') {
    const raw = await req.text();
    if (raw.length > 5500000) return E('Dados grandes demais. Use fotos menores.', 413);
    try { body = raw ? JSON.parse(raw) : {}; } catch { return E('Requisição inválida.'); }
  }
  const users = st('users'), vendors = st('vendors'), slugs = st('slugs');
  const auth = () => verify((req.headers.get('authorization') || '').replace(/^Bearer\s+/i, ''));

  if (a === 'health' && M === 'GET') return J({ ok: true });

  // ---------- cadastro ----------
  if (a === 'signup' && M === 'POST') {
    const name = str(body.name, 80), email = str(body.email, 120).toLowerCase(), pw = String(body.password || '');
    if (!name) return E('Informe o nome do estabelecimento.');
    if (!/^\S+@\S+\.\S+$/.test(email)) return E('Informe um e-mail válido.');
    if (pw.length < 6 || pw.length > 200) return E('A senha precisa ter pelo menos 6 caracteres.');
    const id = rnd(12); let slug = '';
    for (let i = 0; i < 8 && !slug; i++) { const c = slugify(name) + '-' + rnd(2); if ((await slugs.set(c, id, { onlyIfNew: true })).modified) slug = c; }
    if (!slug) return E('Não foi possível reservar o endereço. Tente novamente.', 503);
    const salt = rnd(16), recSalt = rnd(16), code = code4();
    const user = { id, slug, salt, hash: await scrypt(pw, salt), recSalt, rec: await scrypt(norm(code), recSalt), createdAt: Date.now() };
    if (!(await users.set(email, JSON.stringify(user), { onlyIfNew: true })).modified) { await slugs.delete(slug); return E('Este e-mail já está cadastrado.', 409); }
    const v = { id, slug, email, name, phone: '', hours: '', color: '#ea580c', logo: '', insta: '', face: '', about: '', address: '', active: true, hidden: false, plan: 'basico', since: Date.now(), items: [], tables: [] };
    await vendors.setJSON(id, v);
    return J({ token: token(id, email), vendor: ownerView(v), recoveryCode: code }, 201);
  }
  if (a === 'login' && M === 'POST') {
    const email = str(body.email, 120).toLowerCase(), u = await users.get(email, { type: 'json' });
    if (!u || !same(await scrypt(String(body.password || ''), u.salt), u.hash)) return E('E-mail ou senha incorretos.', 401);
    const v = await vendors.get(u.id, { type: 'json' });
    return J({ token: token(u.id, email), vendor: ownerView(v) });
  }
  if (a === 'recover' && M === 'POST') {
    const email = str(body.email, 120).toLowerCase(), pw = String(body.password || ''), u = await users.get(email, { type: 'json' });
    if (!u || !u.rec || !same(await scrypt(norm(body.code), u.recSalt), u.rec)) return E('E-mail ou código de recuperação incorretos.', 401);
    if (pw.length < 6 || pw.length > 200) return E('A nova senha precisa ter pelo menos 6 caracteres.');
    const code = code4(); u.salt = rnd(16); u.hash = await scrypt(pw, u.salt); u.recSalt = rnd(16); u.rec = await scrypt(norm(code), u.recSalt);
    await users.setJSON(email, u);
    return J({ ok: true, recoveryCode: code });
  }

  // ---------- público (cliente) ----------
  if (a === 'public' && b && M === 'GET') {
    const id = await slugs.get(b); const v = id && await vendors.get(id, { type: 'json' });
    if (!v || !v.active) return E('Cardápio não encontrado.', 404);
    return J(publicView(v));
  }

  // ---------- vitrine: lista "Lojas" (público, só dados de vitrine; entram apenas lojas que clicaram em Publicar) ----------
  if (a === 'directory' && M === 'GET') return J({ vendors: (await st('directory').get('list', { type: 'json' })) || [] });

  // ---------- área do vendedor (exige login; o id vem do token, nunca do pedido) ----------
  const au = auth(); if (!au) return E('Sessão expirada. Entre novamente.', 401);
  const id = au.sub;
  if (a === 'me' && M === 'GET') { const v = await vendors.get(id, { type: 'json' }); return v ? J(ownerView(v)) : E('Conta não encontrada.', 404); }
  if (a === 'vendor' && M === 'PUT') {
    const v = await vendors.get(id, { type: 'json' }); if (!v) return E('Conta não encontrada.', 404);
    const color = /^#[0-9a-fA-F]{6}$/.test(body.color) ? body.color : v.color;
    const nv = { ...v, name: str(body.name, 80) || v.name, phone: str(body.phone, 30), hours: str(body.hours, 80), color, logo: img(body.logo, 80000), insta: str(body.insta, 40), face: str(body.face, 60), about: str(body.about, 200), address: str(body.address, 120), items: cleanItems(body.items), tables: cleanTables(body.tables), hidden: typeof body.hidden === 'boolean' ? body.hidden : !!v.hidden };
    await vendors.setJSON(id, nv);
    await updateIndex(st('directory'), nv);
    return J({ ok: true });
  }
  return E('Rota não encontrada.', 404);
}

// CORS apenas nas rotas públicas (cardápio e envio de pedido), usadas pelo site do cliente em outro endereço.
// As rotas do vendedor (login, produtos) NÃO recebem CORS.
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-headers': 'content-type', 'access-control-max-age': '86400' };
const isPublic = (req) => { const p = new URL(req.url).pathname; return (req.method === 'GET' && /^\/api\/(public\/|directory\/?$)/.test(p)); };

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  let r;
  try { r = await handle(req); }
  catch (e) {
    if (e.message === 'AUTH_SECRET_MISSING') r = E('Servidor sem a variável AUTH_SECRET configurada. Veja o LEIA-ME.', 500);
    else if (/Cardápio com itens|Produto com|Todo produto|Preço inválido/.test(e.message)) r = E(e.message, 400);
    else { console.error(e); r = E('Erro interno do servidor.', 500); }
  }
  if (isPublic(req)) { const h = new Headers(r.headers); for (const k in CORS) h.set(k, CORS[k]); r = new Response(r.body, { status: r.status, headers: h }); }
  return r;
};
