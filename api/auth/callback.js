/**
 * Volta do login Google. Troca o código por token, confere quem é a pessoa
 * e abre a sessão do painel — ou manda de volta pro login com um motivo.
 *
 * GET /api/auth/callback?code=...&state=...
 *
 * Verificação do id_token SEM biblioteca de JWT (este projeto não tem
 * package.json, é tudo função serverless pura): manda o id_token pro
 * endpoint tokeninfo do próprio Google, que confere assinatura e validade e
 * devolve os claims decodificados. É a forma suportada pelo Google pra quem
 * não quer carregar as chaves públicas e validar localmente — adequado aqui
 * porque o volume é baixo (login humano, não API de alto tráfego).
 *
 * FALHA FECHADA: e-mail fora de @bateubet.com nunca ganha cookie de sessão,
 * mesmo que o token do Google seja válido — o `hd` do início é só dica de
 * UI, quem tranca de verdade é esta checagem aqui.
 *
 * Variáveis de ambiente obrigatórias:
 *   GOOGLE_CLIENT_ID
 *   GOOGLE_CLIENT_SECRET
 *   PAINEL_SESSAO_SEGREDO
 */

const crypto = require('crypto');

const STATE_COOKIE = 'bateu_oauth_state';
const SESSAO_COOKIE = 'bateu_sessao';
const DOMINIO_PERMITIDO = 'bateubet.com';
/* SESSÃO DESLIZANTE (26/08, pedido do Costa): não é "loga uma vez e fica
   valendo o dia inteiro" -- é "fica valendo enquanto a aba estiver aberta e
   sendo usada". A validade aqui é só o ponto de partida; quem MANTÉM viva é
   o "toque" que o próprio painel dá a cada poucos minutos em
   api/auth/touch.js (mesmo segredo, mesma fórmula de assinatura -- mudou o
   número aqui, muda lá também). Sem toque (aba fechada, computador
   dormindo, tela de login parada), o cookie vence e o próximo acesso pede
   login de novo -- é isso que "tempo ocioso" quer dizer. */
const VALIDADE_SESSAO_S = 30 * 60; // 30min de ociosidade

function assinar(dado, segredo) {
  return crypto.createHmac('sha256', segredo).update(dado).digest('hex');
}

function lerCookie(req, nome) {
  const cru = req.headers.cookie || '';
  const partes = cru.split(';').map((p) => p.trim());
  for (const p of partes) {
    const i = p.indexOf('=');
    if (i > 0 && p.slice(0, i) === nome) return p.slice(i + 1);
  }
  return null;
}

function paraLogin(res, erro) {
  res.writeHead(302, { Location: '/login?erro=' + encodeURIComponent(erro) });
  res.end();
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const segredoSessao = process.env.PAINEL_SESSAO_SEGREDO;
  if (!clientId || !clientSecret || !segredoSessao) {
    return res.status(500).send(
      'Faltam variáveis de ambiente do login Google (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, PAINEL_SESSAO_SEGREDO).'
    );
  }

  const { code, state, error } = req.query;
  if (error) return paraLogin(res, error === 'access_denied' ? 'access_denied' : 'token_negado');
  if (!code || typeof state !== 'string') return paraLogin(res, 'state_invalido');

  const corte = state.indexOf('|');
  if (corte < 1) return paraLogin(res, 'state_invalido');
  const tokenState = state.slice(0, corte);
  let voltar = decodeURIComponent(state.slice(corte + 1) || '/');
  if (!voltar.startsWith('/') || voltar.startsWith('//')) voltar = '/';

  const stateCookie = lerCookie(req, STATE_COOKIE);
  if (!stateCookie || stateCookie !== tokenState) return paraLogin(res, 'state_invalido');

  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const redirectUri = 'https://' + host + '/api/auth/callback';

  let tokenJson;
  try {
    const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code'
      })
    });
    tokenJson = await tokenResp.json();
    if (!tokenResp.ok || !tokenJson.id_token) return paraLogin(res, 'token_negado');
  } catch (e) {
    return paraLogin(res, 'google_indisponivel');
  }

  /* confere a ASSINATURA e os claims do id_token no próprio Google -- nunca
     decodifica o JWT localmente sem verificar, isso seria confiar em dado
     que veio do navegador sem checar quem assinou. */
  let info;
  try {
    const r = await fetch(
      'https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(tokenJson.id_token)
    );
    info = await r.json();
    if (!r.ok || !info || info.aud !== clientId) return paraLogin(res, 'token_invalido');
  } catch (e) {
    return paraLogin(res, 'verificacao_falhou');
  }

  if (!info.email || info.email_verified !== 'true') return paraLogin(res, 'token_invalido');
  const email = String(info.email).toLowerCase();
  if (!email.endsWith('@' + DOMINIO_PERMITIDO)) return paraLogin(res, 'fora_do_dominio');

  const expiraEm = Date.now() + VALIDADE_SESSAO_S * 1000;
  const assinatura = assinar(email + '~' + expiraEm, segredoSessao);
  /* nome vem do Google (scope profile) só pra EXIBIR quem está logado — a
     assinatura acima nunca cobre este pedaço, então ele não é dado de
     segurança nenhum, é ok cair de novo pra '' se o Google não mandar. */
  const nome = info.name ? encodeURIComponent(String(info.name)) : '';
  const valorSessao = email + '~' + expiraEm + '~' + assinatura + (nome ? '~' + nome : '');

  res.setHeader('Set-Cookie', [
    `${SESSAO_COOKIE}=${encodeURIComponent(valorSessao)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${VALIDADE_SESSAO_S}`,
    `${STATE_COOKIE}=; Path=/; Max-Age=0`
  ]);
  res.writeHead(302, { Location: voltar });
  res.end();
};
