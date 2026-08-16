/**
 * Porta do recorte COSTA E LOBÃO.
 *
 * O painel inteiro já vive atrás do Basic Auth do time; esta senha separa,
 * DENTRO do painel, o número da dupla do número que todo mundo vê. Por isso o
 * corte é feito no SERVIDOR e não na tela — esconder a aba no navegador não
 * esconderia nada, o bloco viria no mesmo JSON e apareceria no DevTools.
 *
 * SEM COOKIE, DE PROPÓSITO (decisão do operador, 16/08): a senha tem que ser
 * pedida SEMPRE que a página carrega. Cookie — mesmo o de sessão — sobrevive
 * ao F5, e sobreviver ao F5 é exatamente o que não pode acontecer aqui.
 * Então o servidor devolve o token no CORPO da resposta e a tela guarda ele
 * só na memória do JavaScript: F5 apaga, e a porta fecha de novo sozinha.
 *
 * Contrato:
 *   POST /api/cl-auth   body { senha }  -> 200 { ok:true, token, expira_em }
 *                                       -> 401 { ok:false }
 *   GET  /api/cl-auth   header x-cl-token -> { ok: true|false }  (diagnóstico)
 *
 * O token é assinado, não é a senha: `<expira>.<hmac>`, e a chave do HMAC é a
 * própria senha do servidor. Trocar PAINEL_CL_SENHA invalida todo token vivo.
 *
 * Variável de ambiente obrigatória no projeto Vercel:
 *   PAINEL_CL_SENHA
 */

const crypto = require('crypto');

const HEADER = 'x-cl-token';
/* Teto de vida do token. Na prática quem manda é o F5 (o token só existe na
   memória da página), isto aqui é o limite de quem deixa a aba aberta o dia
   inteiro. */
const VALIDADE_MS = 8 * 60 * 60 * 1000;

function assinar(expiraEm, segredo) {
  return crypto.createHmac('sha256', segredo).update(String(expiraEm)).digest('hex');
}

/** true só se o token for nosso, íntegro e ainda dentro da validade. */
function tokenValido(req, segredo) {
  if (!segredo) return false;
  var bruto = req.headers && (req.headers[HEADER] || req.headers[HEADER.toUpperCase()]);
  if (Array.isArray(bruto)) bruto = bruto[0];
  if (!bruto || typeof bruto !== 'string') return false;
  const corte = bruto.indexOf('.');
  if (corte < 1) return false;
  const expiraEm = Number(bruto.slice(0, corte));
  const assinatura = bruto.slice(corte + 1);
  if (!expiraEm || Date.now() > expiraEm) return false;
  const esperada = assinar(expiraEm, segredo);
  /* comprimentos diferentes fazem timingSafeEqual LANÇAR, e um throw aqui
     viraria 500 no lugar de "não autenticado" */
  if (assinatura.length !== esperada.length) return false;
  return crypto.timingSafeEqual(Buffer.from(assinatura), Buffer.from(esperada));
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
  res.setHeader('Cache-Control', 'private, no-store');

  const segredo = process.env.PAINEL_CL_SENHA;
  if (!segredo) {
    return res.status(500).json({
      error: 'missing_env',
      detail: 'PAINEL_CL_SENHA não está definida no projeto Vercel.'
    });
  }

  if (req.method === 'GET') {
    return res.status(200).json({ ok: tokenValido(req, segredo) });
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
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
  return res.status(200).json({
    ok: true,
    token: expiraEm + '.' + assinar(expiraEm, segredo),
    expira_em: expiraEm
  });
};

module.exports.tokenValido = tokenValido;
module.exports.HEADER = HEADER;
