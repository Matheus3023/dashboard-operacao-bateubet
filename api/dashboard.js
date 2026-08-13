/**
 * Proxy do painel operacional Bateu Bet.
 *
 * Existe por um motivo só: o token do webhook n8n é dado financeiro do cliente
 * e NÃO pode aparecer no código-fonte da página. O navegador chama
 * /api/dashboard, esta função injeta o token (variável de ambiente, só no
 * servidor) e devolve a resposta do n8n como veio.
 *
 * Variável de ambiente obrigatória no projeto Vercel:
 *   N8N_DASHBOARD_TOKEN
 *
 * CommonJS de propósito: sem package.json, o runtime Node da Vercel trata
 * api/*.js como CJS. `fetch` é global no Node 18+.
 */

const UPSTREAM = 'https://n8n.srv1865704.hstgr.cloud/webhook/dashboard-operacao';

/* Orçamento TOTAL desta função, tentativas somadas. A função tem maxDuration de
   60s (vercel.json): abortar em 52s garante que quem responde é este código,
   com JSON explicando o que houve, e não a plataforma com uma página de 504.
   Período longo ainda não cacheado chega a levar 45s no n8n — daí a folga. */
const UPSTREAM_TIMEOUT_MS = 52000;
/* Uma segunda tentativa só faz sentido se sobrar tempo pra ela terminar. */
const RETRY_MIN_SOBRA_MS = 20000;
const MAX_RANGE_DIAS = 366;
const TZ = 'America/Sao_Paulo';

// Escopos aceitos no modo tendência. Mesmo default do n8n, repetido aqui só
// pra resposta ficar previsível caso o front esqueça de mandar o parâmetro.
const ESCOPOS = ['costa_lobao', 'geral'];
const ESCOPO_PADRAO = 'costa_lobao';

function hojeSP() {
  // en-CA devolve YYYY-MM-DD, que é exatamente o formato do contrato
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());
}

function dataValida(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function diasEntre(de, ate) {
  const a = Date.parse(de + 'T00:00:00Z');
  const b = Date.parse(ate + 'T00:00:00Z');
  return Math.round((b - a) / 86400000);
}

/** Espelha a validação que o n8n já faz, pra devolver erro claro sem gastar 10s. */
function validarPeriodo(de, ate) {
  if (de == null && ate == null) return null;
  if (de == null || ate == null) return 'Informe de e ate juntos.';
  if (!dataValida(de) || !dataValida(ate)) return 'Datas devem estar no formato YYYY-MM-DD.';
  const hoje = hojeSP();
  if (ate > hoje) return 'A data final não pode estar no futuro.';
  if (de > ate) return 'A data inicial não pode ser depois da final.';
  if (diasEntre(de, ate) > MAX_RANGE_DIAS) return 'Período máximo de ' + MAX_RANGE_DIAS + ' dias.';
  return null;
}

module.exports = async function handler(req, res) {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');

  if (req.method === 'OPTIONS') {
    res.setHeader('Allow', 'GET, OPTIONS');
    return res.status(204).end();
  }
  if (req.method !== 'GET') {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const token = process.env.N8N_DASHBOARD_TOKEN;
  if (!token) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(500).json({
      error: 'missing_env',
      detail: 'N8N_DASHBOARD_TOKEN não está definida no projeto Vercel.'
    });
  }

  const q = req.query || {};
  const de = typeof q.de === 'string' && q.de ? q.de : null;
  const ate = typeof q.ate === 'string' && q.ate ? q.ate : null;

  /* Modo tendência: mesmo webhook, contrato de resposta diferente
     ({ expert_name, escopo, dias[] } em vez de totais/experts). São os últimos
     dias FECHADOS de um expert, no máximo 7, nunca incluindo hoje.
     Quando `tendencia` vem preenchido, `de`/`ate` são ignorados de propósito:
     recorte de período e histórico fixo de dias fechados são dois modos
     distintos e o n8n não combina os dois. */
  const tendencia = typeof q.tendencia === 'string' && q.tendencia.trim()
    ? q.tendencia.trim()
    : null;

  /* Modo safra: terceiro contrato de resposta ({ escopo, meses[] }). É a turma
     por MÊS DE CADASTRO — quem entrou naquele mês e o que fez desde então —,
     então, como no modo tendência, `de`/`ate` não se aplicam e são ignorados.
     O valor do parâmetro não importa (só a presença), igual ao n8n faz. */
  const safra = !tendencia && typeof q.safra === 'string' && q.safra.trim()
    ? '1'
    : null;

  let escopo = ESCOPO_PADRAO;
  if (tendencia || safra) {
    const escopoBruto = typeof q.escopo === 'string' ? q.escopo.trim().toLowerCase() : '';
    escopo = escopoBruto || ESCOPO_PADRAO;
    if (!ESCOPOS.includes(escopo)) {
      res.setHeader('Cache-Control', 'no-store');
      return res.status(400).json({
        error: 'parametro_invalido',
        detail: 'escopo deve ser ' + ESCOPOS.join(' ou ') + '.'
      });
    }
  } else {
    const erro = validarPeriodo(de, ate);
    if (erro) {
      res.setHeader('Cache-Control', 'no-store');
      return res.status(400).json({ error: 'periodo_invalido', detail: erro });
    }
  }

  const url = new URL(UPSTREAM);
  url.searchParams.set('token', token);
  if (tendencia) {
    url.searchParams.set('tendencia', tendencia);
    url.searchParams.set('escopo', escopo);
  } else if (safra) {
    url.searchParams.set('safra', safra);
    url.searchParams.set('escopo', escopo);
  } else if (de && ate) {
    url.searchParams.set('de', de);
    url.searchParams.set('ate', ate);
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_MS);

  try {
    /* Uma tentativa extra existe por um motivo concreto: quando a Meta estrangula
       o token (rate limit), a execução do n8n morre no meio e o webhook devolve
       200 com CORPO VAZIO. É transitório — a chamada seguinte costuma passar, e
       quase sempre já cai no cache que a primeira tentativa deixou gravado.
       Sem isto, o painel mostra "Falha ao atualizar" por um soluço de segundos. */
    const comecou = Date.now();
    let r = null;
    let texto = '';
    for (let tentativa = 0; tentativa < 2; tentativa++) {
      if (tentativa > 0) {
        const sobra = UPSTREAM_TIMEOUT_MS - (Date.now() - comecou);
        /* Repetir sem tempo de terminar só troca "erro em 8s" por "504 em 52s",
           que é pior: o painel demora mais pra saber que precisa tentar de novo. */
        if (sobra < RETRY_MIN_SOBRA_MS) break;
        await new Promise((ok) => setTimeout(ok, 1500));
      }
      r = await fetch(url.toString(), {
        signal: ctrl.signal,
        headers: { accept: 'application/json' }
      });
      texto = await r.text();
      if (r.ok && texto && texto.trim()) break;
      // 4xx que não é 429 é erro de parâmetro nosso: repetir não muda nada.
      if (!r.ok && r.status >= 400 && r.status < 500 && r.status !== 429) break;
    }

    if (!r.ok) {
      res.setHeader('Cache-Control', 'no-store');
      // 401 aqui é token errado do NOSSO lado, não do cliente: vira 502.
      const status = r.status === 401 || r.status === 403 ? 502 : 502;
      return res.status(status).json({
        error: 'upstream_error',
        upstream_status: r.status,
        detail: r.status === 401
          ? 'O n8n recusou o token do servidor. Conferir N8N_DASHBOARD_TOKEN.'
          : texto.slice(0, 300)
      });
    }

    /* O n8n às vezes devolve 200 com corpo VAZIO (workflow que falhou no meio,
       limite da API do Meta, execução cancelada). Não é erro de rede e não é
       JSON quebrado: é ausência de dado. Merece mensagem própria, senão vira
       caça ao fantasma na próxima vez. */
    if (!texto || !texto.trim()) {
      res.setHeader('Cache-Control', 'no-store');
      return res.status(502).json({
        error: 'upstream_vazio',
        /* No modo tendência o corpo vazio tem uma causa muito mais provável:
           nome de expert que o n8n não reconhece (expert existente responde
           JSON com `dias`, mesmo que a lista venha vazia). Apontar isso aqui
           poupa o próximo debug. */
        detail: tendencia
          ? 'O n8n respondeu sem dados para tendencia="' + tendencia + '". ' +
            'Quase sempre é nome de expert que ele não reconhece: o nome tem que ' +
            'ser igual ao expert_name do payload principal.'
          : 'O n8n respondeu sem dados. Costuma ser execução do workflow que falhou ' +
            'ou limite da API do Meta. Conferir as execuções do workflow no n8n.'
      });
    }

    let dados;
    try {
      dados = JSON.parse(texto);
    } catch (e) {
      res.setHeader('Cache-Control', 'no-store');
      return res.status(502).json({
        error: 'upstream_invalid_json',
        detail: 'O n8n respondeu algo que não é JSON.',
        trecho: texto.slice(0, 200)
      });
    }

    /* Tendência tem contrato próprio: valida os campos dela e sai antes da
       checagem de totais/experts, que aqui nunca vão existir.
       `dias: []` é resposta legítima (expert novo, histórico ainda
       acumulando), então array vazio passa: só a AUSÊNCIA do array é erro. */
    if (tendencia) {
      /* Duas formas de resposta, uma por rota:
         - tendencia=<nome>  → { expert_name, escopo, dias[] }  (um expert)
         - tendencia=*       → { escopo, lote:true, experts[] }  (todos de uma
           vez, é o que alimenta a sparkline de cada linha do comparativo sem
           disparar uma chamada por expert). */
      const emLote = tendencia === '*';
      const formaOk = emLote
        ? (dados && typeof dados.escopo === 'string' && Array.isArray(dados.experts))
        : (dados && typeof dados.expert_name === 'string' &&
           typeof dados.escopo === 'string' && Array.isArray(dados.dias));
      if (!formaOk) {
        res.setHeader('Cache-Control', 'no-store');
        return res.status(502).json({
          error: 'upstream_incompleto',
          detail: emLote
            ? 'A resposta do n8n veio sem os campos escopo/experts.'
            : 'A resposta do n8n veio sem os campos expert_name/escopo/dias.'
        });
      }
      /* Só entra dia fechado, e o dia fecha uma vez por dia: 30 min de cache na
         borda não atrasa nada e derruba quase toda chamada ao n8n, já que o
         painel pede a tendência de vários experts em sequência. O
         stale-while-revalidate de 1h segura a página de pé mesmo com o n8n
         fora do ar. */
      res.setHeader(
        'Cache-Control',
        'public, max-age=0, s-maxage=1800, stale-while-revalidate=3600'
      );
      return res.status(200).json(dados);
    }

    /* Safra também tem contrato próprio ({ escopo, meses[] }) e sai antes da
       checagem de totais/experts. `meses: []` é resposta legítima: o workflow
       da safra preenche um mês por rodada, então logo depois de subir ainda
       não há nada gravado. Só a ausência do array é erro. */
    if (safra) {
      if (!dados || typeof dados.escopo !== 'string' || !Array.isArray(dados.meses)) {
        res.setHeader('Cache-Control', 'no-store');
        return res.status(502).json({
          error: 'upstream_incompleto',
          detail: 'A resposta do n8n veio sem os campos escopo/meses.'
        });
      }
      /* A safra é recalculada em rodízio (um mês a cada 15 min), então o número
         não muda de minuto em minuto: 10 min de cache na borda economiza n8n
         sem atrasar nada perceptível. */
      res.setHeader(
        'Cache-Control',
        'public, max-age=0, s-maxage=600, stale-while-revalidate=1800'
      );
      return res.status(200).json(dados);
    }

    if (!dados || !dados.totais || !Array.isArray(dados.experts)) {
      res.setHeader('Cache-Control', 'no-store');
      return res.status(502).json({
        error: 'upstream_incompleto',
        detail: 'A resposta do n8n veio sem os blocos totais/experts.'
      });
    }

    // Dado do dia muda o tempo todo: cache curto na borda só pra não bater
    // 10 segundos de n8n a cada aba aberta. Período fechado não muda mais.
    const isHoje = !dados || !dados.periodo || dados.periodo.is_hoje !== false;
    res.setHeader(
      'Cache-Control',
      isHoje
        ? 'public, max-age=0, s-maxage=45, stale-while-revalidate=120'
        : 'public, max-age=0, s-maxage=600, stale-while-revalidate=1800'
    );
    return res.status(200).json(dados);
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store');
    const abortou = e && (e.name === 'AbortError' || e.name === 'TimeoutError');
    return res.status(abortou ? 504 : 502).json({
      error: abortou ? 'upstream_timeout' : 'upstream_unreachable',
      detail: abortou
        ? 'O n8n não respondeu em ' + Math.round(UPSTREAM_TIMEOUT_MS / 1000) + 's.'
        : String((e && e.message) || e).slice(0, 200)
    });
  } finally {
    clearTimeout(timer);
  }
};
