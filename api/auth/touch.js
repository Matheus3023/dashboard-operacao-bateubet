/**
 * "Toque" de sessão viva — é isto que transforma a sessão de 30min em
 * "enquanto a aba ficar aberta e sendo usada". O painel chama esta rota a
 * cada poucos minutos (ver ligarUsuario()/renovarSessao() em index.html);
 * cada chamada bem-sucedida empurra a validade mais 30min pra frente. Sem
 * chamada nova antes do prazo vencer (aba fechada, computador dormindo,
 * rede caída), o cookie antigo simplesmente vence e o middleware manda pro
 * login no próximo acesso — é a definição de "tempo ocioso" aqui.
 *
 * GET /api/auth/touch -> { ok:true } | { ok:false } (nunca escreve cookie
 * novo no caso false: sessão que já venceu ou nunca existiu não ressuscita).
 *
 * Mesma fórmula de assinatura de api/auth/callback.js e middleware.js —
 * mudou uma, muda as três.
 */

const crypto = require('crypto');

const SESSAO_COOKIE = 'bateu_sessao';
const VALIDADE_SESSAO_S = 30 * 60; // 30min -- TEM que bater com callback.js

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

  /* renova a partir de AGORA -- sessão deslizante, não fixa */
  const novaExpira = Date.now() + VALIDADE_SESSAO_S * 1000;
  const novaAssinatura = assinar(email + '~' + novaExpira, segredo);
  const novoValor = email + '~' + novaExpira + '~' + novaAssinatura + (nomeCru ? '~' + nomeCru : '');

  res.setHeader('Set-Cookie',
    `${SESSAO_COOKIE}=${encodeURIComponent(novoValor)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${VALIDADE_SESSAO_S}`);
  return res.status(200).json({ ok: true });
};
