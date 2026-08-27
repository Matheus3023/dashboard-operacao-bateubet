/**
 * Início do login Google.
 *
 * GET /api/auth/start[?voltar=/algum/caminho]
 *   -> 302 pro consent screen do Google, com hd=bateubet.com (dica de UI —
 *      quem de fato barra fora do domínio é o callback, conferindo o e-mail
 *      do token; hd sozinho é so cosmético e não pode ser a única trava).
 *
 * `state` carrega dois pedaços separados por "|": um token aleatório (contra
 * CSRF — comparado com o cookie no callback) e o caminho de volta (pra onde
 * a pessoa ia antes do middleware desviar pro login). Nada sensível nisso:
 * é só uma URL do próprio painel.
 *
 * Variável de ambiente obrigatória:
 *   GOOGLE_CLIENT_ID
 */

const crypto = require('crypto');

const STATE_COOKIE = 'bateu_oauth_state';

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    return res.status(500).send('GOOGLE_CLIENT_ID não configurada nas variáveis de ambiente da Vercel.');
  }

  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const redirectUri = 'https://' + host + '/api/auth/callback';

  const token = crypto.randomBytes(16).toString('hex');

  /* só aceita caminho relativo do próprio painel -- nunca uma URL externa
     (open redirect é a classe de bug clássica desse parâmetro). */
  let voltar = typeof req.query.voltar === 'string' ? req.query.voltar : '/';
  if (!voltar.startsWith('/') || voltar.startsWith('//')) voltar = '/';

  const state = token + '|' + encodeURIComponent(voltar);

  res.setHeader('Set-Cookie',
    `${STATE_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`);

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    hd: 'bateubet.com',
    prompt: 'select_account',
    state
  });

  res.writeHead(302, { Location: 'https://accounts.google.com/o/oauth2/v2/auth?' + params.toString() });
  res.end();
};
