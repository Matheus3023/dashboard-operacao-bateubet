/**
 * COORTE DE FTD — GGR e net dep por safra de primeiro depósito, mês a mês ou
 * semana a semana, com o investimento em ads da safra e a projeção de payback.
 *
 * ─── 26/08: MIGRADO PARA TABELA PRÉ-CALCULADA ───────────────────────────────
 * Esta rota fazia o cálculo AO VIVO a cada abertura de painel (Graph API +
 * TAP, retry com backoff, 11+ chamadas por expert) — lento, e sem estado de
 * loading no front, uma leitura que demorasse virava um painel travado pra
 * sempre ("cade a porra a safra", 26/08). Virou o mesmo padrão da Safra:
 * um workflow no n8n (`Dashboard Operação - Coorte`) recalcula em rodízio
 * (1 expert+granularidade por execução, a cada 15 min) e grava em
 * `dashboard_coorte`. Esta rota agora só LÊ — nunca chama Graph API nem TAP
 * diretamente, e por isso responde em milissegundos.
 *
 * Toda a lógica de negócio (o que é uma safra, M0/M1/M2, payback, fator de
 * decaimento) mora agora no workflow do n8n — ela é a fonte de verdade.
 * As definições completas estão comentadas lá; aqui só o contrato de leitura.
 *
 * O corte do escopo Costa e Lobão continua sendo feito AQUI, no servidor —
 * o n8n não sabe (nem precisa saber) quem está logado.
 *
 * Variáveis de ambiente obrigatórias no projeto Vercel:
 *   N8N_COORTE_TOKEN     token estático da Coorte API (mesmo padrão do N8N_DASHBOARD_TOKEN
 *                        que api/dashboard.js já usa, mas é OUTRO token — o webhook é outro)
 *   PAINEL_CL_SENHA      só pro escopo costa_lobao; ver api/cl-auth.js
 */

/* Mesmo host do resto do painel (ver UPSTREAM em api/dashboard.js) — caminho
   fixo, sem prefixo de webhookId: é assim que o n8n resolve path customizado
   nesta instância (confirmado testando ao vivo em 26/08). */
const UPSTREAM = 'https://n8n.srv1865704.hstgr.cloud/webhook/dashboard-coorte';

/* Expert → escopo(s) que podem vê-lo. Mesma régua de autorização que a rota
   antiga já tinha: o corte é feito aqui, não no n8n. Um expert que não está
   nem em COSTA_LOBAO nem em GERAL_TAMBEM simplesmente é liberado pro geral
   (comportamento padrão de sempre — a lista serve só pra saber quando o
   escopo costa_lobao PRECISA da senha). */
const ESCOPOS = { costa_lobao: true, geral: true, google: true };

/* A porta do recorte Costa e Lobão mora em api/cl-auth.js. Se o arquivo sumir,
   o recorte fica FECHADO — o lado seguro do erro. */
let tokenCl = null;
try { tokenCl = require('./cl-auth').tokenValido; } catch (e) { tokenCl = null; }
function temSessaoCl(req) {
  const segredo = process.env.PAINEL_CL_SENHA;
  if (!segredo) return true;
  if (!tokenCl) return false;
  return tokenCl(req, segredo);
}

module.exports = async function handler(req, res) {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');

  if (req.method === 'OPTIONS') {
    res.setHeader('Allow', 'GET, OPTIONS');
    return res.status(204).end();
  }
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET, OPTIONS');
    res.setHeader('Cache-Control', 'no-store');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const token = process.env.N8N_COORTE_TOKEN;
  if (!token) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(500).json({
      error: 'missing_env',
      detail: 'N8N_COORTE_TOKEN não está definida no projeto Vercel.'
    });
  }

  const q = (req.query || {});
  const escopo = String(q.escopo || 'costa_lobao').toLowerCase();
  const expert = String(q.expert || '').trim();
  const gran = String(q.gran || 'mes').toLowerCase() === 'semana' ? 'semana' : 'mes';

  if (!ESCOPOS[escopo]) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(400).json({ error: 'escopo_invalido' });
  }
  if (escopo === 'costa_lobao' && !temSessaoCl(req)) {
    res.setHeader('Cache-Control', 'private, no-store');
    return res.status(403).json({ error: 'nao_autorizado' });
  }
  if (!expert) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(400).json({ error: 'expert_obrigatorio' });
  }

  const url = new URL(UPSTREAM);
  url.searchParams.set('escopo', escopo);
  url.searchParams.set('expert', expert);
  url.searchParams.set('gran', gran);
  url.searchParams.set('token', token);

  let corpo;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    let r;
    try {
      r = await fetch(url.toString(), { signal: ctrl.signal, headers: { accept: 'application/json' } });
    } finally {
      clearTimeout(timer);
    }
    corpo = await r.json();
  } catch (e) {
    /* n8n fora do ar ou lento — resposta rápida e honesta, sem travar o
       painel esperando (o problema exato que esta migração resolveu). */
    res.setHeader('Cache-Control', 'no-store');
    return res.status(502).json({
      error: 'n8n_indisponivel',
      detail: 'A Coorte API do n8n não respondeu a tempo. Tentar de novo em alguns segundos costuma resolver.'
    });
  }

  if (!corpo || !Array.isArray(corpo.safras)) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(502).json({ error: 'resposta_invalida_n8n' });
  }

  /* A matriz muda devagar (o workflow do n8n só refaz este expert+gran a
     cada rodízio de ~15 min na melhor das hipóteses, e cada expert leva
     bem mais que isso pra dar a volta completa) — meia hora de borda tira
     o peso de cima do n8n sem ninguém notar dado velho. */
  res.setHeader('Cache-Control',
    'public, max-age=0, s-maxage=1800, stale-while-revalidate=86400');
  return res.status(200).json(corpo);
};
