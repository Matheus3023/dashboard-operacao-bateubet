/**
 * Postback de investimento pro CRM da Bateu (app Lovable em gamifydeposit.com.br).
 *
 * O CRM quer saber UMA coisa do tráfego: quem está rodando e quanto gastou.
 * Esta função busca o payload de HOJE no mesmo webhook n8n que alimenta o
 * painel, recorta só nome + valor investido (escopo geral = todas as contas
 * de anúncio da operação) e faz POST no hook público do CRM:
 *
 *   POST https://gamifydeposit.com.br/api/public/hooks/traffic-spend
 *   apikey: <chave pública do projeto Lovable>
 *
 * Nada além de nome e valor sai daqui de propósito: FTD, depósito, comissão e
 * afins são dado financeiro do cliente e o CRM não precisa deles.
 *
 * Disparo: cron da Vercel (vercel.json) + chamada manual GET pra testar.
 * Se CRON_SECRET existir no projeto, o disparo exige o Bearer que a própria
 * Vercel manda no cron — chamada de fora sem o segredo leva 401.
 *
 * Variáveis de ambiente:
 *   N8N_DASHBOARD_TOKEN  (obrigatória, a mesma do painel)
 *   GAMIFY_APIKEY        (opcional: sobrepõe a chave pública embutida abaixo)
 *   CRON_SECRET          (opcional: tranca o disparo)
 */

const UPSTREAM = 'https://n8n.srv1865704.hstgr.cloud/webhook/dashboard-operacao';
const HOOK_URL = 'https://gamifydeposit.com.br/api/public/hooks/traffic-spend';

/* Chave PÚBLICA (anon) do projeto Lovable do CRM — é a mesma que viaja no
   bundle do front deles, então não é segredo; a env só existe pra trocar sem
   deploy se o projeto for recriado. */
const GAMIFY_APIKEY_PADRAO =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlmdWlmanFrZm5lcWl2bHZhbmpqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM2MjQwMzgsImV4cCI6MjA5OTIwMDAzOH0.FnPDu95bzmHncUP9Lh0iUP91WXboeqn_VHg1-D0Xcdk';

/* Bem menor que o do painel: aqui ninguém está olhando uma tela esperando.
   Se o n8n estiver lento, o cron seguinte tenta de novo. */
const UPSTREAM_TIMEOUT_MS = 50000;
const HOOK_TIMEOUT_MS = 8000;

function numeroOuZero(v) {
  const n = Number(v);
  /* Duas casas: o n8n soma float e mandaria 2854.3100000000004 pro CRM. */
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

/**
 * Monta o corpo a partir do payload do painel e entrega no hook do CRM.
 * Devolve um resumo do que houve; joga erro só se nem chegou a enviar.
 * É usada pelo handler abaixo (cron) e pelo /api/dashboard (tempo real).
 */
async function entregar(dados) {
  const lista = dados && dados.geral && Array.isArray(dados.geral.experts)
    ? dados.geral.experts
    : null;
  if (!lista) {
    return { enviado: false, motivo: 'payload sem geral.experts' };
  }

  const experts = lista.map((e) => ({
    nome: String(e.expert_name || '').trim() || 'sem nome',
    valor_investido: numeroOuZero(e.investimento_total)
  }));

  const corpo = {
    origem: 'dashboard-operacao-bateubet',
    data: dados.periodo && dados.periodo.de ? dados.periodo.de : null,
    total_investido: numeroOuZero(
      experts.reduce((s, e) => s + e.valor_investido, 0)
    ),
    experts
  };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), HOOK_TIMEOUT_MS);
  try {
    const r = await fetch(HOOK_URL, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'content-type': 'application/json',
        apikey: process.env.GAMIFY_APIKEY || GAMIFY_APIKEY_PADRAO
      },
      body: JSON.stringify(corpo)
    });
    const resposta = await r.text();
    return {
      enviado: r.ok,
      hook_status: r.status,
      hook_resposta: resposta.slice(0, 300),
      experts_enviados: experts.length,
      total_investido: corpo.total_investido
    };
  } finally {
    clearTimeout(timer);
  }
}

/* TEMPO REAL, do jeito que dá sem cron de minuto (plano Hobby): o
   /api/dashboard chama isto a cada busca do dia corrente. A trava de 4 min é
   por INSTÂNCIA da função (variável de módulo sobrevive enquanto a instância
   está quente) — instância nova manda na primeira chamada, o que só adianta o
   relógio, nunca atrasa. Erro aqui morre aqui: o CRM fora do ar não pode
   derrubar o painel. */
const INTERVALO_MIN_MS = 4 * 60 * 1000;
let ultimaEntrega = 0;

async function entregarComTrava(dados) {
  const agora = Date.now();
  if (agora - ultimaEntrega < INTERVALO_MIN_MS) return { pulado: true };
  ultimaEntrega = agora;
  try {
    return await entregar(dados);
  } catch (e) {
    return { enviado: false, motivo: String((e && e.message) || e).slice(0, 200) };
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  /* Tranca opcional: o cron da Vercel manda `Authorization: Bearer CRON_SECRET`
     sozinho quando a env existe. Sem a env, o endpoint fica aberto — o que ele
     vaza (nome + gasto) já está no painel, e o destino do POST é fixo. */
  const segredo = process.env.CRON_SECRET;
  if (segredo) {
    const auth = req.headers['authorization'] || '';
    if (auth !== 'Bearer ' + segredo) {
      return res.status(401).json({ error: 'nao_autorizado' });
    }
  }

  const token = process.env.N8N_DASHBOARD_TOKEN;
  if (!token) {
    return res.status(500).json({
      error: 'missing_env',
      detail: 'N8N_DASHBOARD_TOKEN não está definida no projeto Vercel.'
    });
  }

  // 1. Busca o dado de HOJE (sem de/ate o n8n devolve o dia corrente).
  const url = new URL(UPSTREAM);
  url.searchParams.set('token', token);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_MS);

  let dados;
  try {
    const r = await fetch(url.toString(), {
      signal: ctrl.signal,
      headers: { accept: 'application/json' }
    });
    const texto = await r.text();
    if (!r.ok || !texto || !texto.trim()) {
      return res.status(502).json({
        error: 'upstream_error',
        upstream_status: r.status,
        detail: 'O n8n não devolveu dados. O cron seguinte tenta de novo.'
      });
    }
    dados = JSON.parse(texto);
  } catch (e) {
    const abortou = e && (e.name === 'AbortError' || e.name === 'TimeoutError');
    return res.status(abortou ? 504 : 502).json({
      error: abortou ? 'upstream_timeout' : 'upstream_unreachable',
      detail: String((e && e.message) || e).slice(0, 200)
    });
  } finally {
    clearTimeout(timer);
  }

  /* 2. Recorte (escopo GERAL, todas as contas — a raiz `experts` é só o
     recorte Costa e Lobão e ficaria devendo gente) + entrega no hook.
     O hook devolvendo erro NÃO é falha nossa de infra: o corpo foi montado e
     enviado. Devolve 200 com o espelho do que houve, pra log do cron contar
     a história inteira sem precisar abrir o Lovable. */
  try {
    const resultado = await entregar(dados);
    if (!resultado.enviado && resultado.motivo === 'payload sem geral.experts') {
      return res.status(502).json({
        error: 'upstream_incompleto',
        detail: 'A resposta do n8n veio sem geral.experts.'
      });
    }
    return res.status(200).json(resultado);
  } catch (e) {
    const abortou = e && (e.name === 'AbortError' || e.name === 'TimeoutError');
    return res.status(abortou ? 504 : 502).json({
      error: abortou ? 'hook_timeout' : 'hook_unreachable',
      detail: String((e && e.message) || e).slice(0, 200)
    });
  }
};

module.exports.entregar = entregar;
module.exports.entregarComTrava = entregarComTrava;
