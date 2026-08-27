/**
 * Quem está logado agora — pro dashboard mostrar o nome e o botão de sair.
 * GET /api/auth/me -> { ok:true, email, nome } | { ok:false }
 *
 * Mesma verificação de assinatura do middleware.js (email~expiraEm), só que
 * em crypto do Node em vez de Web Crypto -- essa rota roda como função
 * Node comum, não Edge. Nunca 401: o front chama isso pra DECORAR a tela,
 * não pra decidir se mostra o painel (quem decide isso é o middleware).
 */

const crypto = require('crypto');

const SESSAO_COOKIE = 'bateu_sessao';

function assinar(dado, segredo) {
  return crypto.createHmac('sha256', segredo).update(dado).digest('hex');
}

function lerCookie(req, nome) {
  const cru = req.headers.cookie || '';
  const partes = cru.split(';').map((p) => p.trim());
  for (const p of partes) {
    const i = p.indexOf('=');
    if (i > 0 && p.slice(0, i) === nome) return decodeURIComponent(p.slice(i + 1));
  }
  return null;
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');

  const segredo = process.env.PAINEL_SESSAO_SEGREDO;
  const cookie = segredo && lerCookie(req, SESSAO_COOKIE);
  if (!cookie) return res.status(200).json({ ok: false });

  const partes = cookie.split('~');
  if (partes.length < 3) return res.status(200).json({ ok: false });
  const [email, expiraStr, assinatura, nomeCru] = partes;
  const expiraEm = Number(expiraStr);
  if (!email || !expiraEm || Date.now() > expiraEm) return res.status(200).json({ ok: false });

  const esperada = assinar(email + '~' + expiraStr, segredo);
  if (assinatura.length !== esperada.length ||
      !crypto.timingSafeEqual(Buffer.from(assinatura), Buffer.from(esperada))) {
    return res.status(200).json({ ok: false });
  }

  let nome = null;
  if (nomeCru) {
    try { nome = decodeURIComponent(nomeCru); } catch (e) { nome = null; }
  }

  return res.status(200).json({ ok: true, email, nome });
};
