/**
 * PORTÃO DE ACESSO DO PAINEL.
 *
 * O painel mostra verba, depósito, net PL e comissão de afiliado da operação
 * inteira da Bateu — dado financeiro do cliente. Até 13/08/2026 ele estava
 * público em painel-bateubet.vercel.app: qualquer pessoa com o link via tudo.
 * Este middleware fecha isso.
 *
 * Autenticação HTTP Basic, de propósito:
 *   · vale pra TUDO — o index.html, os assets e o /api/dashboard — porque roda
 *     na borda, antes do CDN servir arquivo estático. Uma tela de login em JS
 *     não protegeria o /api, que é de onde o dado realmente sai.
 *   · o navegador guarda a credencial e reenvia sozinho, então o auto-refresh
 *     de 5 min e os fetch do painel continuam funcionando sem gambiarra.
 *   · não exige plano pago da Vercel (Password Protection é recurso de Pro).
 *
 * Variáveis de ambiente do projeto na Vercel:
 *   PAINEL_SENHA    (obrigatória)
 *   PAINEL_USUARIO  (opcional, padrão "bateu")
 *
 * FALHA FECHADO: sem PAINEL_SENHA configurada o painel responde 503 em vez de
 * abrir. Num portão de acesso, "esqueci de configurar" não pode significar
 * "entra quem quiser".
 */

export const config = {
  /* tudo, menos as rotas internas da própria Vercel */
  matcher: '/((?!_vercel/).*)'
};

const REALM = 'Painel Bateu Bet';

/* comparação de tempo constante: com == , o tempo de resposta vaza quantos
   caracteres do início bateram, e isso é o suficiente pra adivinhar a senha
   caractere a caractere. */
function igual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let dif = 0;
  for (let i = 0; i < a.length; i++) dif |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return dif === 0;
}

function pedirSenha() {
  return new Response('Acesso restrito.', {
    status: 401,
    headers: {
      'WWW-Authenticate': 'Basic realm="' + REALM + '", charset="UTF-8"',
      'Content-Type': 'text/plain; charset=utf-8',
      /* nenhuma resposta deste painel pode ficar em cache compartilhado da
         borda — inclusive a de erro, que senão seria servida a quem já
         autenticou. */
      'Cache-Control': 'no-store'
    }
  });
}

export default function middleware(request) {
  const senha = process.env.PAINEL_SENHA;
  const usuario = process.env.PAINEL_USUARIO || 'bateu';

  if (!senha) {
    return new Response(
      'Painel sem senha configurada. Defina PAINEL_SENHA nas variáveis de ambiente do projeto na Vercel.',
      { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } }
    );
  }

  const cabecalho = request.headers.get('authorization') || '';
  if (!cabecalho.startsWith('Basic ')) return pedirSenha();

  let decodificado;
  try {
    decodificado = atob(cabecalho.slice(6));
  } catch (e) {
    /* base64 quebrado: trata como credencial errada, não como erro do servidor */
    return pedirSenha();
  }

  /* a senha pode conter ":", o usuário não — por isso o split é no PRIMEIRO */
  const corte = decodificado.indexOf(':');
  if (corte < 0) return pedirSenha();

  const u = decodificado.slice(0, corte);
  const s = decodificado.slice(corte + 1);

  /* as duas comparações sempre rodam: sair mais cedo quando o usuário erra
     entregaria, pelo tempo, se o usuário existe. */
  const okUsuario = igual(u, usuario);
  const okSenha = igual(s, senha);
  if (!(okUsuario && okSenha)) return pedirSenha();

  /* autenticado: segue pro arquivo estático ou pra função de API */
  return undefined;
}
