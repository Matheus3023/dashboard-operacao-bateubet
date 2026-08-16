/**
 * Porta do recorte COSTA E LOBÃO.
 *
 * O painel inteiro já vive atrás do Basic Auth do time, então esta senha não
 * existe pra barrar estranho: ela separa, DENTRO do painel, o número da dupla
 * do número que todo mundo vê. Por isso o corte é feito no SERVIDOR e não na
 * tela — esconder a aba no navegador não esconderia nada, o bloco viria no
 * mesmo JSON e apareceria inteiro no DevTools.
 *
 * Contrato:
 *   GET  /api/cl-auth   -> { ok: true|false }  (só diz se a sessão vale)
 *   POST /api/cl-auth   -> body { senha }      -> 200 { ok:true } + cookie
 *                                              -> 401 { ok:false }
 *   DELETE /api/cl-auth -> apaga a sessão (sair)
 *
 * O cookie é assinado, não é a senha: `<expira>.<hmac>`, HttpOnly, e a chave
 * do HMAC é a própria senha do servidor. Trocar PAINEL_CL_SENHA invalida
 * todas as sessões abertas de uma vez, que é o comportamento certo.
 *
 * SameSite=Lax, não Strict: com Strict, o painel aberto por link de fora
 * (WhatsApp, ClickUp) fazia a PRIMEIRA leitura sem mandar o cookie e o
 * recorte voltava trancado mesmo com sessão válida — bastava recarregar pra
 * destravar, o que é exatamente o tipo de fantasma que ninguém consegue
 * reportar direito. Lax mantém a proteção que importa aqui (POST de outro
 * site não vem com o cookie) e a porta abre de primeira.
 *
 * Variável de ambiente obrigatória no projeto Vercel:
 *   PAINEL_CL_SENHA
 */

const crypto = require('crypto');

const COOKIE = 'cl_ok';
const VALIDADE_MS = 12 * 60 * 60 * 1000; // 12h: um dia de trabalho, não mais

function assinar(expiraEm, segredo) {
  return crypto.createHmac('sha256', segredo).update(String(expiraEm)).digest('hex');
}

/** true só se o cookie for nosso, íntegro e ainda dentro da validade. */
function sessaoValida(req, segredo) {
  const bruto = req.headers && req.headers.cookie;
  if (!bruto || !segredo) return false;
  const par = bruto.split(';').map(s => s.trim()).find(s => s.indexOf(COOKIE + '=') === 0);
  if (!par) return false;
  const valor = par.slice(COOKIE.length + 1);
  const corte = valor.indexOf('.');
  if (corte < 1) return false;
  const expiraEm = Number(valor.slice(0, corte));
  const assinatura = valor.slice(corte + 1);
  if (!expiraEm || Date.now() > expiraEm) return false;
  const esperada = assinar(expiraEm, segredo);
  /* comprimentos diferentes fazem timingSafeEqual LANÇAR, e um throw aqui
     viraria 500 no lugar de "não autenticado" */
  if (assinatura.length !== esperada.length) return false;
  return crypto.timingSafeEqual(Buffer.from(assinatura), Buffer.from(esperada));
}

function cookieDeSessao(expiraEm, segredo) {
  return COOKIE + '=' + expiraEm + '.' + assinar(expiraEm, segredo) +
    '; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=' +
    Math.floor(VALIDADE_MS / 1000);
}

function cookieVazio() {
  return COOKIE + '=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0';
}

/** Comparação de senha em tempo constante, com hash pra igualar o tamanho. */
function senhaConfere(recebida, esperada) {
  if (typeof recebida !== 'string' || !recebida) return false;
  const a = crypto.createHash('sha256').update(recebida).digest();
  const b = crypto.createHash('sha256').update(esperada).digest();
  return crypto.timingSafeEqual(a, b);
}

module.exports = async function handler(req, res) {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  /* resposta de sessão NUNCA pode ficar na borda: ela depende do cookie de
     quem perguntou */
  res.setHeader('Cache-Control', 'no-store');

  const segredo = process.env.PAINEL_CL_SENHA;
  if (!segredo) {
    return res.status(500).json({
      error: 'missing_env',
      detail: 'PAINEL_CL_SENHA não está definida no projeto Vercel.'
    });
  }

  if (req.method === 'GET') {
    return res.status(200).json({ ok: sessaoValida(req, segredo) });
  }

  if (req.method === 'DELETE') {
    res.setHeader('Set-Cookie', cookieVazio());
    return res.status(200).json({ ok: false });
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST, DELETE');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  /* o body chega objeto quando o content-type é json e string quando não é */
  let corpo = req.body;
  if (typeof corpo === 'string') {
    try { corpo = JSON.parse(corpo); } catch (e) { corpo = {}; }
  }
  const senha = corpo && corpo.senha;

  if (!senhaConfere(senha, segredo)) {
    /* atraso curto e fixo: encarece a tentativa em série sem transformar erro
       de digitação em espera irritante */
    await new Promise(ok => setTimeout(ok, 600));
    return res.status(401).json({ ok: false, error: 'senha_incorreta' });
  }

  const expiraEm = Date.now() + VALIDADE_MS;
  res.setHeader('Set-Cookie', cookieDeSessao(expiraEm, segredo));
  return res.status(200).json({ ok: true, expira_em: expiraEm });
};

module.exports.sessaoValida = sessaoValida;
