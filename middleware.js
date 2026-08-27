/**
 * PORTÃO DE ACESSO DO PAINEL — login Google, domínio bateubet.com (26/08).
 *
 * Sucede o Basic Auth (ver git log, commit fdc6b1a): mesma ideia — proteger
 * TUDO, na BORDA, antes de qualquer arquivo estático ou rota de API sair —
 * autenticação diferente. Roda em runtime de Edge (Web Crypto, não o
 * `crypto` do Node — por isso o HMAC usa SubtleCrypto e não
 * `crypto.createHmac` como em api/cl-auth.js e api/auth/callback.js, que
 * rodam em função Node comum).
 *
 * O cookie de sessão é escrito pelo callback (api/auth/callback.js), sempre
 * com a MESMA fórmula de assinatura implementada de novo aqui embaixo —
 * mudou uma, muda as duas.
 *
 * FALHA FECHADA: sem PAINEL_SESSAO_SEGREDO configurada, ninguém entra — nem
 * um cookie legítimo teria como validar a assinatura.
 *
 * Variável de ambiente obrigatória no projeto Vercel:
 *   PAINEL_SESSAO_SEGREDO
 */

export const config = {
  /* tudo, menos: rotas internas da Vercel, o próprio fluxo de login
     (/api/auth/*), a tela de login em si, o cron de push-spend (roda
     servidor-a-servidor, sem sessão de navegador nenhuma) e os arquivos de
     imagem/ícone que a TELA DE LOGIN também precisa carregar -- sem essa
     última exceção o painel logado carrega os ícones, mas a tela de login
     (que roda ANTES de qualquer sessão existir) ficaria sem logo. */
  matcher: '/((?!_vercel/|api/auth/|api/push-spend|login\\.html|.*\\.(?:svg|png|jpg|jpeg|ico|webp)$).*)'
};

const COOKIE = 'bateu_sessao';
const DOMINIO_PERMITIDO = 'bateubet.com';

/* comparação em tempo constante: com ===, o tempo de resposta vaza quantos
   caracteres do início bateram, e isso é o suficiente pra adivinhar a
   assinatura pedaço por pedaço. Mesma lógica do igual() do Basic Auth antigo. */
function igual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let dif = 0;
  for (let i = 0; i < a.length; i++) dif |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return dif === 0;
}

function paraHex(buffer) {
  return Array.from(new Uint8Array(buffer)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function assinar(dado, segredo) {
  const chave = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(segredo),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const assinatura = await crypto.subtle.sign('HMAC', chave, new TextEncoder().encode(dado));
  return paraHex(assinatura);
}

function lerCookie(request, nome) {
  const cru = request.headers.get('cookie') || '';
  const partes = cru.split(';').map((p) => p.trim());
  for (const p of partes) {
    const i = p.indexOf('=');
    if (i > 0 && p.slice(0, i) === nome) return decodeURIComponent(p.slice(i + 1));
  }
  return null;
}

function paraLogin(request) {
  const destino = new URL(request.url);
  const url = new URL('/login.html', destino);
  /* só o caminho, nunca a URL inteira -- host errado (proxy, preview antigo)
     não deve virar redirect pra fora do painel na volta do login. */
  url.searchParams.set('voltar', destino.pathname + destino.search);
  return Response.redirect(url, 302);
}

export default async function middleware(request) {
  const segredo = process.env.PAINEL_SESSAO_SEGREDO;
  if (!segredo) {
    return new Response(
      'Painel sem PAINEL_SESSAO_SEGREDO configurada nas variáveis de ambiente da Vercel.',
      { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } }
    );
  }

  const cookie = lerCookie(request, COOKIE);
  if (!cookie) return paraLogin(request);

  /* email~expiraEm~assinatura~nome — o nome (4º pedaço, opcional) é só
     exibição pro /api/auth/me; a assinatura nunca cobre ele, então ele pode
     crescer sem invalidar sessão nenhuma. */
  const partes = cookie.split('~');
  if (partes.length < 3) return paraLogin(request);
  const [email, expiraStr, assinatura] = partes;
  const expiraEm = Number(expiraStr);
  if (!email || !expiraEm || Date.now() > expiraEm) return paraLogin(request);
  if (!email.toLowerCase().endsWith('@' + DOMINIO_PERMITIDO)) return paraLogin(request);

  const esperada = await assinar(email + '~' + expiraStr, segredo);
  if (!igual(assinatura, esperada)) return paraLogin(request);

  /* passou: sem retorno nenhum, a requisição segue pro destino original */
}
