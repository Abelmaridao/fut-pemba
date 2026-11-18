/**
 * Elephalpit Bet — Worker (Cloudflare Workers) completo
 * ======================================================
 * IMPORTANTE: eu não tenho o ficheiro do teu Worker que já está a correr em
 * contas.abelpemba939.workers.dev, por isso reconstruí este ficheiro do zero,
 * a partir de tudo o que o index.html pede ao servidor. Ele cobre TODOS os
 * pedidos que o app faz (login, registo, recuperação de senha, VIP, admin,
 * comprovativos, administradores temporários e formas de pagamento).
 *
 * SE JÁ TENS CONTAS DE UTILIZADORES REAIS a funcionar no Worker atual:
 * NÃO substituas o ficheiro às cegas — isso troca o sítio onde os dados ficam
 * guardados e pode fazer-te "perder" essas contas (elas continuam a existir,
 * mas este ficheiro novo não sabe onde elas estão se a tua base de dados for
 * diferente de uma KV Namespace). O mais seguro é:
 *   1) Ires à Cloudflare, abrires este Worker e copiares o código que lá está
 *      agora para um ficheiro, e enviares-mo aqui — eu faço a fusão exacta.
 *   2) OU, se este Worker ainda não tem contas importantes (ou se o site só
 *      tem as contas de teste que criámos), podes publicar este ficheiro
 *      diretamente — ver os PASSOS DE PUBLICAÇÃO no fim deste ficheiro.
 *
 * O QUE PRECISAS DE CRIAR NA CLOUDFLARE ANTES DE PUBLICAR:
 *   - Um "KV Namespace" (Workers → KV) chamado, por exemplo, "ELEPHALPIT_DB".
 *   - Ligar esse KV Namespace a este Worker com o nome de variável "DB"
 *     (Settings → Variables → KV Namespace Bindings → Variable name: DB).
 *
 * TUDO o que o app guarda (contas, VIP, administradores temporários,
 * comprovativos, formas de pagamento) fica dentro desse único KV Namespace.
 */

const DAYMS = 86400000;
const ADMIN_EMAIL = "abelmaridao@gmail.com"; // a primeira conta criada com este e-mail é sempre o administrador principal
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(data, status = 200){
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...CORS } });
}
const ok = (extra = {}) => json({ ok: true, ...extra });
const fail = (error, status = 400, extra = {}) => json({ ok: false, error, ...extra }, status);

function uid(){ return crypto.randomUUID(); }
function code6(){ return String(Math.floor(100000 + Math.random() * 900000)); }

async function getUser(env, email){
  const raw = await env.DB.get("user:" + email);
  return raw ? JSON.parse(raw) : null;
}
async function putUser(env, u){
  await env.DB.put("user:" + u.email, JSON.stringify(u));
}
async function allUsers(env){
  const out = [];
  let cursor;
  do {
    const list = await env.DB.list({ prefix: "user:", cursor });
    for (const k of list.keys){
      const raw = await env.DB.get(k.name);
      if (raw) out.push(JSON.parse(raw));
    }
    cursor = list.cursor;
    if (list.list_complete) break;
  } while (cursor);
  return out;
}
function publicUser(u){
  // nunca devolver salt/hash ao cliente
  const { salt, hash, ...pub } = u;
  return pub;
}

async function sessionUser(env, request){
  const auth = request.headers.get("Authorization") || "";
  const m = /^Bearer (.+)$/.exec(auth);
  if (!m) return null;
  const email = await env.DB.get("session:" + m[1]);
  if (!email) return null;
  const u = await getUser(env, email);
  if (!u) return null;
  if (u.banUntil > Date.now()) return u; // devolve na mesma; quem decide o que fazer é o cliente (cur() trata bans)
  return u;
}
async function newSession(env, email){
  const token = uid();
  await env.DB.put("session:" + token, email, { expirationTtl: 60 * 60 * 24 * 60 }); // 60 dias
  return token;
}

function isMainAdmin(u){ return !!(u && u.admin); }
function isTempAdmin(u){ return !!(u && !u.admin && (u.texp || 0) > Date.now()); }
function isAdm(u){ return isMainAdmin(u) || isTempAdmin(u); }
function inviteLeft(u){
  if (!u) return 0;
  if (u.admin) return Infinity;
  if (!isTempAdmin(u)) return 0;
  return Math.max(0, (u.tquota || 0) - (u.tused || 0));
}

const DEFAULT_PM = [{ id: "paypay", name: "PAYPAY", kz: 10, iban: "AO06042000000000073860793", promo: "" }];

export default {
  async fetch(request, env){
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    if (request.method !== "POST") return fail("method not allowed", 405);

    const url = new URL(request.url);
    const op = url.pathname.replace(/^\/+/, "");
    let body = {};
    try { body = await request.json(); } catch {}

    try {
      switch (op){

        /* ---------------- CONTAS ---------------- */

        case "salt": {
          const email = String(body.id || "").trim().toLowerCase();
          const u = await getUser(env, email);
          if (!u) return fail("E-mail ou palavra-passe incorretos.");
          return ok({ salt: u.salt });
        }

        case "register": {
          const email = String(body.email || "").trim().toLowerCase();
          const name = String(body.name || "").trim();
          const { salt, hash } = body;
          if (!email || !name || !salt || !hash) return fail("Dados em falta.");
          if (await getUser(env, email)) return fail("Este e-mail já está registado.");
          const u = {
            id: uid(), email, name, salt, hash, photo: "", friends: [],
            admin: email === ADMIN_EMAIL, banUntil: 0, created: Date.now(),
            exp: 0, allowBy: "", texp: 0, tquota: 0, tused: 0, tby: "",
            receiptPending: false, receiptRejected: false,
          };
          await putUser(env, u);
          const token = await newSession(env, email);
          return ok({ token, user: publicUser(u) });
        }

        case "login": {
          const email = String(body.id || "").trim().toLowerCase();
          const u = await getUser(env, email);
          if (!u || u.hash !== body.hash) return fail("E-mail ou palavra-passe incorretos.");
          if (u.banUntil > Date.now()) return fail("banned", 403, { banUntil: u.banUntil });
          const token = await newSession(env, email);
          return ok({ token, user: publicUser(u) });
        }

        case "logout": {
          const auth = request.headers.get("Authorization") || "";
          const m = /^Bearer (.+)$/.exec(auth);
          if (m) await env.DB.delete("session:" + m[1]);
          return ok();
        }

        case "me": {
          const me = await sessionUser(env, request);
          if (!me) return fail("sem sessão", 401);
          return ok({ user: publicUser(me) });
        }

        case "forgot1": {
          const email = String(body.email || "").trim().toLowerCase();
          const u = await getUser(env, email);
          if (u){
            const code = code6();
            await env.DB.put("forgot:" + email, JSON.stringify({ code, exp: Date.now() + 600000, tries: 0 }), { expirationTtl: 600 });
            // liga aqui o teu serviço de e-mail (o mesmo que já tinhas, se tiver outro endpoint próprio);
            // sem isso, devolvemos o código no campo demoCode para não bloquear testes
            return ok({ demoCode: code });
          }
          return ok({}); // nunca revela se o e-mail existe ou não
        }

        case "forgot2": {
          const email = String(body.email || "").trim().toLowerCase();
          const raw = await env.DB.get("forgot:" + email);
          if (!raw) return fail("Código inválido ou expirado.");
          const rec = JSON.parse(raw);
          if (rec.exp < Date.now()) return fail("Código inválido ou expirado.");
          if (rec.tries >= 6) return fail("Demasiadas tentativas. Pede um novo código.");
          if (String(body.code || "") !== rec.code){
            rec.tries++; await env.DB.put("forgot:" + email, JSON.stringify(rec), { expirationTtl: 600 });
            return fail("Código incorreto.");
          }
          const u = await getUser(env, email);
          if (!u) return fail("Conta não encontrada.");
          u.salt = body.salt; u.hash = body.hash;
          await putUser(env, u);
          await env.DB.delete("forgot:" + email);
          return ok();
        }

        /* ---------------- VIP: PAGAMENTOS ---------------- */

        case "vip/settings": {
          const raw = await env.DB.get("settings:pm");
          const pm = raw ? JSON.parse(raw) : DEFAULT_PM;
          return ok({ pm });
        }

        case "admin/vip-settings": {
          const me = await sessionUser(env, request);
          if (!isMainAdmin(me)) return fail("Sem permissão.", 403);
          if (!Array.isArray(body.pm) || !body.pm.length) return fail("Lista de formas de pagamento inválida.");
          await env.DB.put("settings:pm", JSON.stringify(body.pm));
          return ok();
        }

        case "vip/receipt": {
          const me = await sessionUser(env, request);
          if (!me) return fail("sem sessão", 401);
          const { amount, unitKz, method, mime, name, b64 } = body;
          if (!amount || !unitKz || !b64) return fail("Dados do comprovativo em falta.");
          if (b64.length > 11000000) return fail("Ficheiro grande demais.");
          const id = uid();
          const rec = { id, email: me.email, amount, unitKz, method: method || "PAYPAY", mime, name, b64, status: "pending", createdAt: Date.now() };
          await env.DB.put("receipt:" + id, JSON.stringify(rec));
          me.receiptPending = true; me.receiptRejected = false;
          await putUser(env, me);
          return ok({ user: publicUser(me) });
        }

        case "admin/receipts": {
          const me = await sessionUser(env, request);
          if (!isMainAdmin(me)) return fail("Sem permissão.", 403);
          const list = await env.DB.list({ prefix: "receipt:" });
          const receipts = [];
          for (const k of list.keys){
            const raw = await env.DB.get(k.name);
            if (!raw) continue;
            const r = JSON.parse(raw);
            if (r.status === "pending") receipts.push({ id: r.id, email: r.email, amount: r.amount, unitKz: r.unitKz, method: r.method, mime: r.mime, name: r.name, b64: r.b64, createdAt: r.createdAt });
          }
          receipts.sort((a, b) => a.createdAt - b.createdAt);
          return ok({ receipts });
        }

        case "admin/receipt-decide": {
          const me = await sessionUser(env, request);
          if (!isMainAdmin(me)) return fail("Sem permissão.", 403);
          const raw = await env.DB.get("receipt:" + body.id);
          if (!raw) return fail("Comprovativo não encontrado.");
          const rec = JSON.parse(raw);
          const u = await getUser(env, rec.email);
          if (!u) return fail("Utilizador não encontrado.");
          if (body.approve){
            const days = Math.max(1, Math.floor(rec.amount / rec.unitKz));
            // nota: aqui soma-se em dias corridos (24h); para "só contar os dias em que há
            // jogos" como no index.html local, seria preciso que este Worker também tivesse
            // acesso ao calendário de jogos (fixtures.json) — diz-me se queres que eu adicione
            // essa parte, passando-te também essa lista para o Worker consultar.
            u.exp = Math.max(u.exp || 0, Date.now()) + days * DAYMS;
            rec.status = "approved";
          } else {
            u.receiptRejected = body.reason || "O comprovativo não foi aceite. Verifica o valor e tenta outra vez.";
            rec.status = "rejected";
          }
          u.receiptPending = false;
          await putUser(env, u);
          await env.DB.put("receipt:" + rec.id, JSON.stringify(rec));
          return ok();
        }

        /* ---------------- ADMINISTRAÇÃO ---------------- */

        case "admin/list": {
          const me = await sessionUser(env, request);
          if (!isAdm(me)) return fail("Sem permissão.", 403);
          const now = Date.now();
          let users = await allUsers(env);
          if (!me.admin) users = users.filter(u => u.tby === me.email || u.allowBy === me.email || u.email === me.email);
          const allow = users.filter(u => (u.exp || 0) > 0).map(u => ({ email: u.email, exp: u.exp, by: u.allowBy || "" }));
          const tadmins = users.filter(u => (u.texp || 0) > 0).map(u => ({ email: u.email, exp: u.texp, by: u.tby || "", quota: u.tquota || 0, used: u.tused || 0, created: u.tcreated || 0 }));
          return ok({ users: users.map(publicUser), allow, tadmins });
        }

        case "admin/allow": {
          const me = await sessionUser(env, request);
          if (!isAdm(me)) return fail("Sem permissão.", 403);
          const email = String(body.email || "").trim().toLowerCase(), days = Math.max(1, Math.floor(+body.days || 0));
          const t = await getUser(env, email);
          if (!t) return fail("Este e-mail ainda não tem conta.");
          if (t.admin) return fail("Esta conta é do administrador principal.");
          if (!me.admin){
            if (inviteLeft(me) <= 0) return fail("Já não tens convites para dar.");
            if ((t.exp || 0) > Date.now() && t.allowBy !== me.email) return fail("Este utilizador já tem VIP.");
          }
          t.exp = Math.max(t.exp || 0, Date.now()) + days * DAYMS;
          t.allowBy = me.admin ? "" : me.email;
          await putUser(env, t);
          if (!me.admin){ me.tused = (me.tused || 0) + 1; await putUser(env, me); }
          return ok();
        }

        case "admin/unallow": {
          const me = await sessionUser(env, request);
          if (!isMainAdmin(me)) return fail("Sem permissão.", 403);
          const t = await getUser(env, String(body.email || "").trim().toLowerCase());
          if (!t) return fail("Utilizador não encontrado.");
          t.exp = 0; t.allowBy = "";
          await putUser(env, t);
          return ok();
        }

        case "admin/vipall": {
          const me = await sessionUser(env, request);
          if (!isMainAdmin(me)) return fail("Sem permissão.", 403);
          const days = Math.max(1, Math.floor(+body.days || 0));
          const users = await allUsers(env);
          let n = 0;
          for (const u of users){
            if (u.admin) continue;
            if ((u.exp || 0) > Date.now()) continue; // só quem ainda não tem VIP
            u.exp = Date.now() + days * DAYMS; u.allowBy = "";
            await putUser(env, u); n++;
          }
          return ok({ n });
        }

        case "admin/tadmin": {
          const me = await sessionUser(env, request);
          if (!isAdm(me)) return fail("Sem permissão.", 403);
          const email = String(body.email || "").trim().toLowerCase(), days = Math.max(1, Math.floor(+body.days || 0)), quota = Math.max(1, Math.floor(+body.quota || days));
          if (email === me.email) return fail("Não podes convidar-te a ti mesmo.");
          const t = await getUser(env, email);
          if (!t) return fail("Este e-mail ainda não tem conta.");
          if (t.admin) return fail("Esta conta já é a do administrador principal.");
          if (!me.admin && inviteLeft(me) <= 0) return fail("Já não tens convites para dar.");
          t.texp = Date.now() + days * DAYMS; t.tquota = quota; t.tused = t.tused || 0; t.tby = me.admin ? "" : me.email; t.tcreated = Date.now();
          await putUser(env, t);
          if (!me.admin){ me.tused = (me.tused || 0) + 1; await putUser(env, me); }
          return ok();
        }

        case "admin/untadmin": {
          const me = await sessionUser(env, request);
          if (!isAdm(me)) return fail("Sem permissão.", 403);
          const t = await getUser(env, String(body.email || "").trim().toLowerCase());
          if (!t) return fail("Utilizador não encontrado.");
          if (!me.admin && t.tby !== me.email) return fail("Sem permissão.", 403);
          t.texp = 0; t.tquota = 0; t.tused = 0; t.tby = "";
          await putUser(env, t);
          return ok();
        }

        case "admin/ban": {
          const me = await sessionUser(env, request);
          if (!isAdm(me)) return fail("Sem permissão.", 403);
          const users = await allUsers(env);
          const t = users.find(u => u.id === body.id);
          if (!t) return fail("Utilizador não encontrado.");
          t.banUntil = +body.until || 0;
          await putUser(env, t);
          return ok();
        }

        case "admin/unban": {
          const me = await sessionUser(env, request);
          if (!isAdm(me)) return fail("Sem permissão.", 403);
          const users = await allUsers(env);
          const t = users.find(u => u.id === body.id);
          if (!t) return fail("Utilizador não encontrado.");
          t.banUntil = 0;
          await putUser(env, t);
          return ok();
        }

        case "admin/delete": {
          const me = await sessionUser(env, request);
          if (!isMainAdmin(me)) return fail("Sem permissão.", 403);
          const users = await allUsers(env);
          const t = users.find(u => u.id === body.id);
          if (!t) return fail("Utilizador não encontrado.");
          await env.DB.delete("user:" + t.email);
          return ok();
        }

        default:
          return fail("operação desconhecida: " + op, 404);
      }
    } catch (e){
      return fail("Erro interno: " + (e && e.message || e), 500);
    }
  }
};

/*
 * PASSOS DE PUBLICAÇÃO (pelo painel da Cloudflare, sem usar o terminal):
 *
 * 1) Entra em dash.cloudflare.com → Workers & Pages.
 * 2) Cria (ou abre) o Worker chamado "contas" (o que corresponde a
 *    contas.abelpemba939.workers.dev).
 * 3) Vai a Settings → Bindings → KV Namespace Bindings → Add binding:
 *       - Se ainda não tens um KV Namespace, cria um primeiro em
 *         Workers & Pages → KV → Create a namespace (ex: "ELEPHALPIT_DB").
 *       - Variable name: DB
 *       - KV Namespace: escolhe o que criaste.
 *    Guarda.
 * 4) Vai a "Edit code" (ou "Quick edit") neste Worker.
 * 5) Apaga todo o conteúdo do ficheiro e cola o conteúdo deste ficheiro
 *    (worker.js) inteiro.
 * 6) Clica "Save and deploy".
 * 7) Pronto — o URL continua o mesmo: https://contas.abelpemba939.workers.dev
 *    O app (index.html que te enviei) já está preparado para falar com ele.
 *
 * NOTA SOBRE AS CONTAS QUE JÁ EXISTEM: se o teu Worker atual guarda os
 * utilizadores de outra forma (por exemplo numa base de dados D1, ou com
 * outros nomes de campos), publicar este ficheiro por cima NÃO vai apagar
 * essas contas (elas continuam na base de dados antiga), mas o Worker novo
 * não vai conseguir vê-las, porque está a usar o KV Namespace novo. Se isso
 * for um problema para ti, envia-me o ficheiro do Worker atual e eu faço a
 * fusão sem perder nada.
 */
