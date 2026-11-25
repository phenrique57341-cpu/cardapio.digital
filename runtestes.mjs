// Testes automáticos da API (sem dependências):  npm test
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url)), root = path.resolve(here, '..');
const RP = 8870, AP = 8871, RED = `http://localhost:${RP}`, APP = `http://localhost:${AP}`;
const SECRET = 'segredo-de-teste-com-mais-de-32-caracteres!!';
const children = [];
function run(file, env) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [path.join(here, file)], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] }); children.push(p);
    p.stdout.on('data', (d) => { if (String(d).includes('pronto')) resolve(p); }); p.stderr.on('data', (d) => process.stderr.write(d)); p.on('error', reject);
  });
}
const stop = (p) => new Promise((r) => { p.once('exit', r); p.kill(); });
const startApp = (env = {}, extra = {}) => run('local-vercel.mjs', { PORT: String(AP), AUTH_SECRET: SECRET, KV_REST_API_URL: RED, KV_REST_API_TOKEN: 'test-token', ...env, ...extra });

let ok = 0; const bad = [];
const chk = (n, c, x) => { if (c) { ok++; console.log('PASSOU  ' + n); } else { bad.push(n); console.log('FALHOU  ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x).slice(0, 220) : '')); } };
async function call(m, p, b, tok, raw) {
  const r = await fetch(APP + p, { method: m, headers: { ...(b !== undefined ? { 'content-type': 'application/json' } : {}), ...(tok ? { authorization: 'Bearer ' + tok } : {}) }, body: raw ?? (b !== undefined ? JSON.stringify(b) : undefined) });
  const t = await r.text(); let j = {}; try { j = JSON.parse(t); } catch {} return { s: r.status, j, h: r.headers, t };
}
const dump = async () => (await fetch(RED + '/__dump')).json();
const JPG = '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=';
const dataUrl = (x) => 'data:image/jpeg;base64,' + x, JPG2 = JPG.slice(0, -4) + 'AAAA';
const cleanup = async () => { for (const p of children) try { p.kill(); } catch {} };

try {
  await run('mock-redis.mjs', { PORT: String(RP) });
  let app = await startApp();

  // ---- saúde / configuração
  let r = await call('GET', '/api/health'); chk('1) API responde e informa que banco e AUTH_SECRET estão configurados', r.s === 200 && r.j.ok && r.j.db === true && r.j.auth === true, r.j);
  chk('   /api/health não revela valores de segredos', !/test-token|segredo-de-teste/.test(r.t));

  // ---- cadastro, login, sessão
  const A = (await call('POST', '/api/signup', { name: 'Pedro Lanches', email: 'pedro@t.com', password: 'senha123' })).j;
  chk('2) Cadastro cria conta, loja e devolve token e código de recuperação', !!(A.token && A.vendor && A.vendor.slug && /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(A.recoveryCode)), A);
  chk('   E-mail repetido é recusado (409)', (await call('POST', '/api/signup', { name: 'X', email: 'pedro@t.com', password: 'senha123' })).s === 409);
  chk('   Senha fraca e e-mail inválido são recusados', (await call('POST', '/api/signup', { name: 'X', email: 'a@t.com', password: '123' })).s === 400 && (await call('POST', '/api/signup', { name: 'X', email: 'invalido', password: 'senha123' })).s === 400);
  r = await call('POST', '/api/login', { email: 'pedro@t.com', password: 'senha123' }); chk('3) Login com a senha certa', r.s === 200 && r.j.token && r.j.vendor.slug === A.vendor.slug);
  chk('   Senha errada → 401 com mensagem clara', (await call('POST', '/api/login', { email: 'pedro@t.com', password: 'errada' })).j.error === 'E-mail ou senha incorretos.');
  chk('   /api/me com sessão válida devolve a loja', (await call('GET', '/api/me', undefined, A.token)).j.slug === A.vendor.slug);
  const d0 = JSON.stringify(await dump());
  chk('   Senha e código de recuperação NÃO ficam em texto puro no banco', !d0.includes('senha123') && !d0.includes(A.recoveryCode));

  // ---- proteção das rotas administrativas
  chk('4) Sem login: não altera a loja (401)', (await call('PUT', '/api/vendor', { items: [] })).s === 401 && (await call('GET', '/api/me')).s === 401);
  const forged = (() => { const a = Buffer.from(JSON.stringify({ sub: A.vendor.id, email: 'pedro@t.com', exp: Date.now() + 1e9 })).toString('base64url'); return a + '.' + crypto.createHmac('sha256', 'outro-segredo-qualquer-0123456789').update(a).digest('base64url'); })();
  chk('   Token falsificado (assinado com outra chave) é recusado (401)', (await call('PUT', '/api/vendor', { items: [] }, forged)).s === 401 && (await call('GET', '/api/me', undefined, forged)).s === 401);
  const expired = (() => { const a = Buffer.from(JSON.stringify({ sub: A.vendor.id, email: 'pedro@t.com', exp: Date.now() - 1000 })).toString('base64url'); return a + '.' + crypto.createHmac('sha256', SECRET).update(a).digest('base64url'); })();
  chk('   Token vencido é recusado (401)', (await call('GET', '/api/me', undefined, expired)).s === 401);
  chk('   Token adulterado é recusado (401)', (await call('GET', '/api/me', undefined, A.token.slice(0, -3) + 'abc')).s === 401);

  // ---- salvar produtos + foto (persistência e fotos separadas)
  const items = [{ id: 'p1', name: 'X-Bacon', desc: 'Pão e bacon', price: 19.9, cat: 'Lanches', img: dataUrl(JPG) }, { id: 'p2', name: 'Guaraná', desc: '', price: 7, cat: 'Bebidas', img: '' }];
  r = await call('PUT', '/api/vendor', { name: 'Pedro Lanches', items, hidden: false }, A.token);
  chk('5) Painel salva produtos no servidor', r.s === 200 && r.j.vendor.items.length === 2, r.j);
  const slug = A.vendor.slug; let pub = (await call('GET', '/api/public/' + slug)).j;
  chk('   Visitante SEM conta lê produtos, preços e descrições', pub.items.length === 2 && pub.items[0].price === 19.9 && pub.items[0].desc === 'Pão e bacon');
  const iu = pub.items[0].img; chk('   A foto vem como endereço /api/img/... (e não dentro do JSON)', /^\/api\/img\/[^/]+\/p1\?v=[0-9a-f]{12}$/.test(iu), iu);
  const ir = await fetch(APP + iu); const bytes = Buffer.from(await ir.arrayBuffer());
  chk('   A foto é servida como imagem (200, image/jpeg, cache longo) e com os mesmos bytes', ir.status === 200 && ir.headers.get('content-type') === 'image/jpeg' && /immutable/.test(ir.headers.get('cache-control')) && bytes.equals(Buffer.from(JPG, 'base64')));
  let db = await dump(); const vdoc = db['vendors:' + A.vendor.id];
  chk('6) Dados realmente gravados no banco (Redis): documento da loja, índice e foto em chave separada', !!vdoc && !!db['slugs:' + slug] && !!db['directory:list'] && !!db['imgs:' + A.vendor.id + ':p1'] && !vdoc.includes('base64'));
  r = await call('PUT', '/api/vendor', { name: 'Pedro Lanches', items: pub.items }, A.token);
  chk('   Salvar de novo mandando só o endereço da foto MANTÉM a foto (sem reenviar a imagem)', (await call('GET', '/api/public/' + slug)).j.items[0].img === iu);
  const items2 = pub.items.map((i) => i.id === 'p1' ? { ...i, name: 'X-Bacon Duplo', price: 25, img: dataUrl(JPG2) } : i);
  await call('PUT', '/api/vendor', { name: 'Pedro Lanches', items: items2 }, A.token); pub = (await call('GET', '/api/public/' + slug)).j;
  chk('   Trocar a foto e o preço: o visitante vê tudo novo (a URL da foto muda)', pub.items[0].name === 'X-Bacon Duplo' && pub.items[0].price === 25 && pub.items[0].img !== iu);
  await call('PUT', '/api/vendor', { name: 'Pedro Lanches', items: pub.items.filter((i) => i.id !== 'p1') }, A.token);
  chk('   Excluir o produto apaga a foto do banco', !(await dump())['imgs:' + A.vendor.id + ':p1'] && (await call('GET', '/api/public/' + slug)).j.items.length === 1);

  // ---- vitrine
  chk('7) Vitrine "Ver cardápios" lista a loja que tem produto', (await call('GET', '/api/directory')).j.vendors.some((v) => v.slug === slug));
  await call('PUT', '/api/vendor', { name: 'Pedro Lanches', items: (await call('GET', '/api/public/' + slug)).j.items, hidden: true }, A.token);
  chk('   Ocultar tira da vitrine', !(await call('GET', '/api/directory')).j.vendors.some((v) => v.slug === slug));
  await call('PUT', '/api/vendor', { name: 'Pedro Lanches', items: (await call('GET', '/api/public/' + slug)).j.items, hidden: false }, A.token);
  chk('   Mostrar traz de volta', (await call('GET', '/api/directory')).j.vendors.some((v) => v.slug === slug));
  chk('   Resposta pública não vaza e-mail, senha, hash nem token', !/pedro@t\.com|hash|salt|"rec"|token/.test(JSON.stringify((await call('GET', '/api/public/' + slug)).j) + JSON.stringify((await call('GET', '/api/directory')).j)));

  // ---- isolamento entre lojas
  const B = (await call('POST', '/api/signup', { name: 'Burger do Joao', email: 'joao@t.com', password: 'senha123' })).j;
  await call('PUT', '/api/vendor', { name: 'Burger do Joao', items: [{ id: 'p2', name: 'Meu Item', price: 5, cat: 'G', img: '/api/img/' + slug + '/p2?v=000000000000' }] }, B.token);
  const pb = (await call('GET', '/api/public/' + B.vendor.slug)).j;
  chk('8) Loja B não vê nem altera os dados da loja A; não consegue "pegar" a foto da A', pb.items.length === 1 && pb.items[0].name === 'Meu Item' && pb.items[0].img === '' && (await call('GET', '/api/public/' + slug)).j.items[0].name === 'Guaraná');

  // ---- proteção contra tentativas de senha
  let last; for (let i = 0; i < 9; i++) last = await call('POST', '/api/login', { email: 'alvo@t.com', password: 'x' + i });
  chk('9) Muitas tentativas de login seguidas → bloqueio temporário (429)', last.s === 429, last.j);

  // ---- recuperação de senha
  r = await call('POST', '/api/recover', { email: 'pedro@t.com', code: A.recoveryCode.toLowerCase(), password: 'novasenha1' });
  chk('10) Recuperar senha com o código; o código antigo deixa de valer', r.s === 200 && (await call('POST', '/api/login', { email: 'pedro@t.com', password: 'novasenha1' })).s === 200 && (await call('POST', '/api/recover', { email: 'pedro@t.com', code: A.recoveryCode, password: 'outrasenha1' })).s === 401);

  // ---- limites
  chk('11) Corpo grande demais (>4 MB) é recusado com mensagem (413)', (await call('PUT', '/api/vendor', undefined, A.token, JSON.stringify({ items: [], x: 'a'.repeat(4100000) }))).s === 413);
  chk('    Rotas inexistentes e JSON inválido dão erro claro', (await call('GET', '/api/nao-existe', undefined, A.token)).s === 404 && (await call('POST', '/api/login', undefined, undefined, '{quebrado')).s === 400);

  // ---- persistência: reinicia a função (o banco continua em outro processo)
  await stop(app); app = await startApp();
  r = await call('POST', '/api/login', { email: 'pedro@t.com', password: 'novasenha1' });
  chk('12) Depois de REINICIAR o servidor, login e dados continuam (estão no banco, não na memória)', r.s === 200 && (await call('GET', '/api/public/' + slug)).j.items.length === 1);

  // ---- corpo não lido pela plataforma (outro caminho do handler)
  await stop(app); app = await startApp({}, { VERCEL_PARSE_BODY: '0' });
  r = await call('POST', '/api/signup', { name: 'Sem Parser', email: 'sp@t.com', password: 'senha123' });
  chk('13) A função também funciona quando a plataforma NÃO entrega o corpo já lido', r.s === 201 && r.j.vendor.name === 'Sem Parser');

  // ---- configuração incompleta: mensagens claras
  await stop(app); app = await startApp({ KV_REST_API_URL: '', KV_REST_API_TOKEN: '' });
  r = await call('GET', '/api/health'); const s2 = await call('POST', '/api/signup', { name: 'X', email: 'z@t.com', password: 'senha123' });
  chk('14) Sem banco configurado: health diz db=false e o cadastro explica o que falta (503)', r.j.ok && r.j.db === false && s2.s === 503 && /banco de dados/i.test(s2.j.error), s2.j);
  await stop(app); app = await startApp({ AUTH_SECRET: '' });
  r = await call('GET', '/api/health'); const s3 = await call('POST', '/api/signup', { name: 'X', email: 'z@t.com', password: 'senha123' });
  chk('15) Sem AUTH_SECRET: health diz auth=false e o cadastro explica o que falta (503)', r.j.ok && r.j.auth === false && s3.s === 503 && /AUTH_SECRET/.test(s3.j.error), s3.j);
  await stop(app); app = await startApp({ KV_REST_API_TOKEN: 'token-errado' });
  r = await call('GET', '/api/health'); const s4 = await call('GET', '/api/directory');
  chk('16) Banco com credencial errada: health db=false e as rotas respondem 503 (sem travar)', r.j.db === false && s4.s === 503, s4.j);
  await stop(app);

  // ---- verificações estáticas do projeto
  const files = []; (function walk(d) { for (const f of fs.readdirSync(d, { withFileTypes: true })) { if (['node_modules', '.git', '.vercel'].includes(f.name)) continue; const p = path.join(d, f.name); f.isDirectory() ? walk(p) : files.push(p); } })(root);
  const word = new RegExp('net' + 'lify', 'i');
  chk('17) Nenhuma referência ao serviço antigo de hospedagem em NENHUM arquivo do projeto', !files.some((f) => word.test(fs.readFileSync(f, 'utf8')) || word.test(f)), files.filter((f) => word.test(fs.readFileSync(f, 'utf8'))));
  chk('18) vercel.json e package.json são JSON válidos, sem dependências externas', (() => { try { const v = JSON.parse(fs.readFileSync(path.join(root, 'vercel.json'), 'utf8')), p = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')); return !!v.rewrites && !p.dependencies; } catch { return false; } })());
  const code = files.filter((f) => /\.(mjs|js|html)$/.test(f) && !f.includes(path.sep + 'tests' + path.sep)).map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  chk('19) Nenhum segredo no código: AUTH_SECRET só é lido de variável de ambiente; .env.example sem valores reais', !/AUTH_SECRET\s*=\s*['"][^'"]{8,}/.test(code) && /AUTH_SECRET=troque/.test(fs.readFileSync(path.join(root, '.env.example'), 'utf8')) && /^\.env$/m.test(fs.readFileSync(path.join(root, '.gitignore'), 'utf8')));
  chk('20) O site (public/index.html) não tem senha de administrador nem chave embutida', !/admin123|sk_live|Bearer [A-Za-z0-9]{20,}/.test(fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8')));
} finally { await cleanup(); }
console.log('\nTOTAL', ok + bad.length, '| falhas:', bad);
process.exit(bad.length ? 1 : 0);
