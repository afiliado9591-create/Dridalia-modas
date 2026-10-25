// Worker Dridalia — bindings: DB (D1), BUCKET (R2), ASSETS (opcional, se servir o index por aqui)
// Secrets: ADMIN_EMAIL, MP_TOKEN   |   Tabelas assumidas (ajuste se o seu SQL for diferente):
// users(id, nome, email UNIQUE, hash, salt, codigo)
// sessions(token, user_id, exp)
// products(id INTEGER PK AUTOINCREMENT, nome, preco REAL, descricao, tamanhos, cores, imagens)  -- listas em JSON texto
// pages(id INTEGER PK AUTOINCREMENT, titulo, imagem, descricao, link)
// config(chave PRIMARY KEY, valor)
// clicks(id INTEGER PK AUTOINCREMENT, ref, prod, data)
// orders(id INTEGER PK AUTOINCREMENT, ref, total, itens, endereco, status, data)

const FRETE = 15;
const J = (d, s = 200) => Response.json(d, { status: s });
const jp = (s) => { try { return JSON.parse(s || '[]'); } catch { return []; } };

async function hash(pw, salt) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveBits']);
  const b = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: new TextEncoder().encode(salt), iterations: 100000, hash: 'SHA-256' }, k, 256);
  return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
}

async function sessao(env, user) {
  const token = crypto.randomUUID() + crypto.randomUUID();
  await env.DB.prepare('INSERT INTO sessions(token,user_id,exp) VALUES(?,?,?)').bind(token, user.id, Date.now() + 30 * 864e5).run();
  return token;
}

const pub = (u, env) => ({ nome: u.nome, email: u.email, codigo: u.codigo, admin: u.email === env.ADMIN_EMAIL });

const app = {
  async fetch(req, env) {
    const u = new URL(req.url), p = u.pathname, m = req.method;
    if (!p.startsWith('/api/')) return env.ASSETS ? env.ASSETS.fetch(req) : new Response('Not found', { status: 404 });

    try {
      // imagens do R2 (público)
      if (p.startsWith('/api/img/') && m === 'GET') {
        const o = await env.BUCKET.get(p.slice(9));
        if (!o) return new Response('Not found', { status: 404 });
        return new Response(o.body, { headers: { 'content-type': o.httpMetadata?.contentType || 'image/jpeg', 'cache-control': 'public, max-age=31536000, immutable' } });
      }

      const tk = (req.headers.get('authorization') || '').slice(7);
      const me = tk ? await env.DB.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.exp>?').bind(tk, Date.now()).first() : null;
      const admin = !!me && me.email === env.ADMIN_EMAIL;
      const body = async () => req.json().catch(() => ({}));

      if (p === '/api/store' && m === 'GET') {
        const [pr, pg, cf] = await Promise.all([
          env.DB.prepare('SELECT * FROM products ORDER BY id DESC').all(),
          env.DB.prepare('SELECT * FROM pages ORDER BY id DESC').all(),
          env.DB.prepare('SELECT * FROM config').all()
        ]);
        const config = {}; for (const r of cf.results) config[r.chave] = r.valor === 'true' ? true : r.valor === 'false' ? false : r.valor;
        return J({
          produtos: pr.results.map(x => ({ ...x, tamanhos: jp(x.tamanhos), cores: jp(x.cores), imagens: jp(x.imagens) })),
          paginas: pg.results, config, frete: FRETE
        });
      }

      if (p === '/api/register' && m === 'POST') {
        const { nome, email, senha } = await body();
        if (!nome || !email || !senha || senha.length < 6) return J({ erro: 'Dados inválidos (senha mín. 6).' }, 400);
        const em = email.toLowerCase().trim();
        if (await env.DB.prepare('SELECT id FROM users WHERE email=?').bind(em).first()) return J({ erro: 'E-mail já cadastrado.' }, 409);
        const salt = crypto.randomUUID(), codigo = 'DRI-' + crypto.randomUUID().slice(0, 5).toUpperCase();
        const r = await env.DB.prepare('INSERT INTO users(nome,email,hash,salt,codigo) VALUES(?,?,?,?,?)').bind(nome.trim(), em, await hash(senha, salt), salt, codigo).run();
        const user = { id: r.meta.last_row_id, nome: nome.trim(), email: em, codigo };
        return J({ token: await sessao(env, user), user: pub(user, env) });
      }

      if (p === '/api/login' && m === 'POST') {
        const { email, senha } = await body();
        const user = await env.DB.prepare('SELECT * FROM users WHERE email=?').bind((email || '').toLowerCase().trim()).first();
        if (!user || user.hash !== await hash(senha || '', user.salt)) return J({ erro: 'E-mail ou senha incorretos.' }, 401);
        return J({ token: await sessao(env, user), user: pub(user, env) });
      }

      if (p === '/api/me') return me ? J({ user: pub(me, env) }) : J({ erro: 'Sessão inválida.' }, 401);

      if (p === '/api/logout' && m === 'POST') { if (tk) await env.DB.prepare('DELETE FROM sessions WHERE token=?').bind(tk).run(); return J({ ok: 1 }); }

      if (p === '/api/click' && m === 'POST') {
        const b = await body();
        if (b.ref || b.prod) await env.DB.prepare('INSERT INTO clicks(ref,prod,data) VALUES(?,?,?)').bind(b.ref || null, b.prod || null, new Date().toISOString()).run();
        return J({ ok: 1 });
      }

      if (p === '/api/checkout' && m === 'POST') {
        const { itens, endereco, ref } = await body();
        if (!Array.isArray(itens) || !itens.length) return J({ erro: 'Carrinho vazio.' }, 400);
        const lista = []; let total = 0;
        for (const it of itens) { // preço SEMPRE vem do banco, nunca do navegador
          const pr = await env.DB.prepare('SELECT id,nome,preco FROM products WHERE id=?').bind(it.id).first();
          if (!pr) return J({ erro: 'Produto indisponível.' }, 400);
          const q = Math.max(1, Math.min(20, parseInt(it.qtd) || 1));
          total += pr.preco * q;
          lista.push({ title: `${pr.nome} (${it.tam}/${it.cor})`, quantity: q, unit_price: pr.preco, currency_id: 'BRL' });
        }
        lista.push({ title: 'Frete', quantity: 1, unit_price: FRETE, currency_id: 'BRL' });
        const o = await env.DB.prepare('INSERT INTO orders(ref,total,itens,endereco,status,data) VALUES(?,?,?,?,?,?)')
          .bind(ref || null, total + FRETE, JSON.stringify(itens), JSON.stringify(endereco), 'pendente', new Date().toISOString()).run();
        const r = await fetch('https://api.mercadopago.com/checkout/preferences', {
          method: 'POST',
          headers: { authorization: 'Bearer ' + env.MP_TOKEN, 'content-type': 'application/json' },
          body: JSON.stringify({ items: lista, payer: { email: endereco?.email }, external_reference: String(o.meta.last_row_id), back_urls: { success: u.origin, failure: u.origin, pending: u.origin }, auto_return: 'approved' })
        });
        const d = await r.json();
        if (!d.init_point) return J({ erro: 'Falha ao criar pagamento.' }, 502);
        return J({ url: d.init_point });
      }

      // ---- somente admin ----
      if (!admin) return J({ erro: 'Não autorizado.' }, 403);

      if (p === '/api/upload' && m === 'POST') {
        const tipo = req.headers.get('content-type') || '';
        if (!tipo.startsWith('image/')) return J({ erro: 'Envie uma imagem.' }, 400);
        const buf = await req.arrayBuffer();
        if (buf.byteLength > 5e6) return J({ erro: 'Imagem acima de 5 MB.' }, 413);
        const key = crypto.randomUUID() + '.' + (tipo.split('/')[1] || 'jpg').replace('jpeg', 'jpg');
        await env.BUCKET.put(key, buf, { httpMetadata: { contentType: tipo } });
        return J({ url: u.origin + '/api/img/' + key });
      }

      if (p === '/api/product' && m === 'POST') {
        const b = await body();
        const v = [String(b.nome || '').slice(0, 120), Number(b.preco) || 0, String(b.descricao || '').slice(0, 2000), JSON.stringify(b.tamanhos || []), JSON.stringify(b.cores || []), JSON.stringify((b.imagens || []).slice(0, 5))];
        if (b.id) await env.DB.prepare('UPDATE products SET nome=?,preco=?,descricao=?,tamanhos=?,cores=?,imagens=? WHERE id=?').bind(...v, b.id).run();
        else await env.DB.prepare('INSERT INTO products(nome,preco,descricao,tamanhos,cores,imagens) VALUES(?,?,?,?,?,?)').bind(...v).run();
        return J({ ok: 1 });
      }

      if (p.startsWith('/api/product/') && m === 'DELETE') { await env.DB.prepare('DELETE FROM products WHERE id=?').bind(p.split('/').pop()).run(); return J({ ok: 1 }); }

      if (p === '/api/page' && m === 'POST') {
        const b = await body();
        await env.DB.prepare('INSERT INTO pages(titulo,imagem,descricao,link) VALUES(?,?,?,?)').bind(b.titulo, b.imagem || '', b.descricao, b.link || '').run();
        return J({ ok: 1 });
      }

      if (p.startsWith('/api/page/') && m === 'DELETE') { await env.DB.prepare('DELETE FROM pages WHERE id=?').bind(p.split('/').pop()).run(); return J({ ok: 1 }); }

      if (p === '/api/config' && m === 'POST') {
        const b = await body();
        for (const k of ['nomeLoja', 'logo', 'banner', 'popupAtivo', 'popupTag', 'popupTitulo', 'popupTexto', 'popupImagem'])
          if (k in b) await env.DB.prepare('INSERT INTO config(chave,valor) VALUES(?,?) ON CONFLICT(chave) DO UPDATE SET valor=excluded.valor').bind(k, String(b[k])).run();
        return J({ ok: 1 });
      }

      return J({ erro: 'Rota não encontrada.' }, 404);
    } catch (e) {
      console.error(e);
      return J({ erro: 'Erro interno: ' + (e && e.message ? e.message : e) }, 500); // depuração: remova a mensagem depois que tudo funcionar
    }
  }
};

// CORS: permite o site (outro domínio) chamar o Worker em workers.dev
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS', 'access-control-allow-headers': 'authorization,content-type' };
export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    const r = await app.fetch(req, env);
    const n = new Response(r.body, r);
    for (const k in CORS) n.headers.set(k, CORS[k]);
    return n;
  }
};
