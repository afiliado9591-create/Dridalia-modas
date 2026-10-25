// Worker Dridalia — bindings: LOJA_DB (D1 dridalia-db), LOJA_R2 (R2 dridalia-imagens)
// Secrets: ADMIN_EMAIL, MP_TOKEN
// Tabelas: usuarios, produtos, pedidos, cupons, config (id=1, data=JSON) + sessoes, paginas, cliques (migracao-01.sql)

const FRETE = 15;
const PUB = ['nomeLoja', 'logo', 'banner', 'popupAtivo', 'popupTag', 'popupTitulo', 'popupTexto', 'popupImagem', 'popupProdutoId']; // únicas chaves da config que o público pode ver
const J = (d, s = 200) => Response.json(d, { status: s });
const jp = (s, d = []) => { try { const v = JSON.parse(s); return v ?? d; } catch { return d; } };

async function hash(pw, salt) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveBits']);
  const b = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: new TextEncoder().encode(salt), iterations: 100000, hash: 'SHA-256' }, k, 256);
  return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
}

async function sessao(env, id) {
  const token = crypto.randomUUID() + crypto.randomUUID();
  await env.LOJA_DB.prepare('INSERT INTO sessoes(token,user_id,exp) VALUES(?,?,?)').bind(token, id, Date.now() + 30 * 864e5).run();
  return token;
}

const pub = (u, env) => ({ nome: u.nome, email: u.email, codigo: u.codigo_afiliado, admin: u.email === env.ADMIN_EMAIL });

const app = {
  async fetch(req, env) {
    const u = new URL(req.url), p = u.pathname, m = req.method;
    const DB = env.LOJA_DB;
    if (!p.startsWith('/api/')) return env.ASSETS ? env.ASSETS.fetch(req) : new Response('Not found', { status: 404 });

    try {
      if (p.startsWith('/api/img/') && m === 'GET') {
        const o = await env.LOJA_R2.get(p.slice(9));
        if (!o) return new Response('Not found', { status: 404 });
        return new Response(o.body, { headers: { 'content-type': o.httpMetadata?.contentType || 'image/jpeg', 'cache-control': 'public, max-age=31536000, immutable' } });
      }

      const tk = (req.headers.get('authorization') || '').slice(7);
      const me = tk ? await DB.prepare('SELECT u.* FROM sessoes s JOIN usuarios u ON u.id=s.user_id WHERE s.token=? AND s.exp>?').bind(tk, Date.now()).first() : null;
      const admin = !!me && !!env.ADMIN_EMAIL && me.email === env.ADMIN_EMAIL;
      const body = async () => req.json().catch(() => ({}));

      if (p === '/api/store' && m === 'GET') {
        const [pr, pg, cf] = await Promise.all([
          DB.prepare('SELECT * FROM produtos ORDER BY id DESC').all(),
          DB.prepare('SELECT * FROM paginas ORDER BY id DESC').all(),
          DB.prepare('SELECT data FROM config WHERE id=1').first()
        ]);
        const all = jp(cf && cf.data, {}), config = {};
        for (const k of PUB) if (k in all) config[k] = all[k];
        const produtos = pr.results.map(x => {
          const imgs = jp(x.imagens);
          return { id: x.id, nome: x.nome, preco: x.preco, descricao: x.descricao, tamanhos: jp(x.tamanhos), cores: jp(x.cores), imagens: imgs.length ? imgs : (x.imagem ? [x.imagem] : []), faqs: jp(x.faqs) };
        });
        return J({ produtos, paginas: pg.results, config, frete: FRETE });
      }

      if (p === '/api/register' && m === 'POST') {
        const { nome, email, senha } = await body();
        if (!nome || !email || !senha || senha.length < 6) return J({ erro: 'Dados inválidos (senha mín. 6).' }, 400);
        const em = email.toLowerCase().trim();
        if (await DB.prepare('SELECT id FROM usuarios WHERE email=?').bind(em).first()) return J({ erro: 'E-mail já cadastrado.' }, 409);
        const salt = crypto.randomUUID(), codigo = 'DRI-' + crypto.randomUUID().slice(0, 5).toUpperCase();
        const r = await DB.prepare('INSERT INTO usuarios(email,nome,is_afiliado,codigo_afiliado,senha_hash,salt) VALUES(?,?,1,?,?,?)').bind(em, nome.trim(), codigo, await hash(senha, salt), salt).run();
        const user = { nome: nome.trim(), email: em, codigo_afiliado: codigo };
        return J({ token: await sessao(env, r.meta.last_row_id), user: pub(user, env) });
      }

      if (p === '/api/login' && m === 'POST') {
        const { email, senha } = await body();
        const user = await DB.prepare('SELECT * FROM usuarios WHERE email=?').bind((email || '').toLowerCase().trim()).first();
        if (!user || !user.senha_hash || user.senha_hash !== await hash(senha || '', user.salt)) return J({ erro: 'E-mail ou senha incorretos.' }, 401);
        return J({ token: await sessao(env, user.id), user: pub(user, env) });
      }

      if (p === '/api/me') return me ? J({ user: pub(me, env) }) : J({ erro: 'Sessão inválida.' }, 401);

      if (p === '/api/logout' && m === 'POST') { if (tk) await DB.prepare('DELETE FROM sessoes WHERE token=?').bind(tk).run(); return J({ ok: 1 }); }

      if (p === '/api/click' && m === 'POST') {
        const b = await body();
        if (b.ref || b.prod) await DB.prepare('INSERT INTO cliques(ref,prod,data) VALUES(?,?,?)').bind(b.ref || null, b.prod || null, new Date().toISOString()).run();
        return J({ ok: 1 });
      }

      if (p === '/api/checkout' && m === 'POST') {
        const { itens, endereco, ref } = await body();
        if (!Array.isArray(itens) || !itens.length) return J({ erro: 'Carrinho vazio.' }, 400);
        if (!endereco || !endereco.email) return J({ erro: 'Informe o e-mail.' }, 400);
        const cfgRow = await DB.prepare('SELECT data FROM config WHERE id=1').first();
        const mpToken = env.MP_TOKEN || (jp(cfgRow && cfgRow.data, {}).privado || {}).mpToken;
        if (!mpToken) return J({ erro: 'Pagamento ainda não configurado.' }, 503);
        const lista = []; let total = 0;
        for (const it of itens) { // preço SEMPRE vem do banco
          const pr = await DB.prepare('SELECT id,nome,preco FROM produtos WHERE id=?').bind(it.id).first();
          if (!pr) return J({ erro: 'Produto indisponível.' }, 400);
          const q = Math.max(1, Math.min(20, parseInt(it.qtd) || 1));
          total += pr.preco * q;
          lista.push({ title: `${pr.nome} (${it.tam}/${it.cor})`, quantity: q, unit_price: pr.preco, currency_id: 'BRL' });
        }
        lista.push({ title: 'Frete', quantity: 1, unit_price: FRETE, currency_id: 'BRL' });
        const o = await DB.prepare('INSERT INTO pedidos(email_cliente,codigo_afiliado,total,status,itens,endereco,data) VALUES(?,?,?,?,?,?,?)')
          .bind(endereco.email, ref || null, total + FRETE, 'Pendente', JSON.stringify(itens), JSON.stringify(endereco), new Date().toISOString()).run();
        const r = await fetch('https://api.mercadopago.com/checkout/preferences', {
          method: 'POST',
          headers: { authorization: 'Bearer ' + mpToken, 'content-type': 'application/json' },
          body: JSON.stringify({ items: lista, payer: { email: endereco.email }, external_reference: String(o.meta.last_row_id), back_urls: { success: req.headers.get('origin') || u.origin, failure: req.headers.get('origin') || u.origin, pending: req.headers.get('origin') || u.origin }, auto_return: 'approved' })
        });
        const d = await r.json();
        if (!d.init_point) return J({ erro: 'Falha ao criar pagamento.' }, 502);
        return J({ url: d.init_point });
      }

      if (p === '/api/afiliado' && m === 'GET') {
        if (!me) return J({ erro: 'Entre na conta.' }, 401);
        const c = await DB.prepare('SELECT COUNT(*) n FROM cliques WHERE ref=?').bind(me.codigo_afiliado).first();
        const v = await DB.prepare('SELECT COUNT(*) n, COALESCE(SUM(comissao_afiliado),0) s FROM pedidos WHERE codigo_afiliado=?').bind(me.codigo_afiliado).first();
        return J({ cliques: c.n, vendas: v.n, comissao: v.s });
      }

      // ---- somente admin ----
      if (!admin) return J({ erro: 'Não autorizado.' }, 403);

      if (p === '/api/upload' && m === 'POST') {
        const tipo = req.headers.get('content-type') || '';
        if (!tipo.startsWith('image/')) return J({ erro: 'Envie uma imagem.' }, 400);
        const buf = await req.arrayBuffer();
        if (buf.byteLength > 5e6) return J({ erro: 'Imagem acima de 5 MB.' }, 413);
        const key = crypto.randomUUID() + '.' + (tipo.split('/')[1] || 'jpg').replace('jpeg', 'jpg');
        await env.LOJA_R2.put(key, buf, { httpMetadata: { contentType: tipo } });
        return J({ url: u.origin + '/api/img/' + key });
      }

      if (p === '/api/product' && m === 'POST') {
        const b = await body(), imgs = (b.imagens || []).slice(0, 5);
        const v = [String(b.nome || '').slice(0, 120), Number(b.preco) || 0, String(b.descricao || '').slice(0, 2000), imgs[0] || '', JSON.stringify(b.tamanhos || []), JSON.stringify(b.cores || []), JSON.stringify(imgs)];
        if (b.id) await DB.prepare('UPDATE produtos SET nome=?,preco=?,descricao=?,imagem=?,tamanhos=?,cores=?,imagens=? WHERE id=?').bind(...v, b.id).run();
        else await DB.prepare('INSERT INTO produtos(nome,preco,descricao,imagem,tamanhos,cores,imagens) VALUES(?,?,?,?,?,?,?)').bind(...v).run();
        return J({ ok: 1 });
      }

      if (p.startsWith('/api/product/') && m === 'DELETE') { await DB.prepare('DELETE FROM produtos WHERE id=?').bind(p.split('/').pop()).run(); return J({ ok: 1 }); }

      if (p === '/api/page' && m === 'POST') {
        const b = await body();
        await DB.prepare('INSERT INTO paginas(titulo,imagem,descricao,link) VALUES(?,?,?,?)').bind(b.titulo, b.imagem || '', b.descricao, b.link || '').run();
        return J({ ok: 1 });
      }

      if (p.startsWith('/api/page/') && m === 'DELETE') { await DB.prepare('DELETE FROM paginas WHERE id=?').bind(p.split('/').pop()).run(); return J({ ok: 1 }); }

      if (p === '/api/ajustes') { // chaves ficam só no banco, nunca vão para o público
        const row = await DB.prepare('SELECT data FROM config WHERE id=1').first();
        const all = jp(row && row.data, {}), pv = all.privado || {};
        if (m === 'GET') return J({ mpPublicKey: pv.mpPublicKey || '', mpTokenOk: !!pv.mpToken, freteEmpresa: pv.freteEmpresa || 'superfrete', freteTokenOk: !!pv.freteToken, enderecoLoja: pv.enderecoLoja || {} });
        const b = await body();
        all.privado = { ...pv, mpPublicKey: b.mpPublicKey ?? pv.mpPublicKey, freteEmpresa: b.freteEmpresa || pv.freteEmpresa, enderecoLoja: b.enderecoLoja || pv.enderecoLoja };
        if (b.mpToken) all.privado.mpToken = b.mpToken;
        if (b.freteToken) all.privado.freteToken = b.freteToken;
        await DB.prepare('INSERT INTO config(id,data) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').bind(JSON.stringify(all)).run();
        return J({ ok: 1 });
      }

      if (p === '/api/config' && m === 'POST') {
        const b = await body();
        const row = await DB.prepare('SELECT data FROM config WHERE id=1').first();
        const all = jp(row && row.data, {}); // preserva o que já existe na config
        for (const k of PUB) if (k in b) all[k] = b[k];
        await DB.prepare('INSERT INTO config(id,data) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').bind(JSON.stringify(all)).run();
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
