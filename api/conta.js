/**
 * Detalhe de UMA conta de anúncio — o que abre quando alguém clica numa linha
 * do breakdown "Investimento conta a conta".
 *
 * A pergunta que esta rota responde é uma só, e é sempre a mesma:
 * "dá pra escalar esta conta ou não?". O painel principal responde QUANTO cada
 * conta gastou; isso não decide nada sozinho. Quem decide é o conjunto
 * orçamento × entrega × frequência × custo por FTD, campanha a campanha — e
 * esse dado nunca esteve na tela, era garimpo no Gerenciador.
 *
 * Fala DIRETO com a Graph API, não com o n8n, de propósito:
 *   · o pipeline do n8n é agregado por expert e roda em cache de 2 min; o
 *     detalhe é sob demanda, de uma conta só, e não pode entrar naquele bolo;
 *   · orçamento e estratégia de lance (daily_budget, bid_strategy) NÃO existem
 *     no endpoint de insights — moram nas edges /campaigns e /adsets. O n8n só
 *     busca insights, então o dado que decide escala nem passa por lá;
 *   · se esta rota quebrar, o painel inteiro continua de pé.
 *
 * Variável de ambiente obrigatória no projeto Vercel:
 *   META_ACCESS_TOKEN   (mesmo token de sistema que o n8n usa)
 *
 * CommonJS de propósito: sem package.json, o runtime Node da Vercel trata
 * api/*.js como CJS. `fetch` é global no Node 18+.
 */

const GRAPH = 'https://graph.facebook.com/v21.0/';

/* 25s: são 4 chamadas à Graph em paralelo, cada uma normalmente abaixo de 2s.
   Passar disso é Meta estrangulando o token, e aí é melhor dizer isso do que
   deixar a função morrer no limite da plataforma. */
const TIMEOUT_MS = 25000;
const MAX_RANGE_DIAS = 366;
const TZ = 'America/Sao_Paulo';

/* Piso de gasto pra um veredito valer. Abaixo disso a campanha não tem amostra
   pra afirmar nada: 1 FTD a mais ou a menos vira 50% de diferença no CPA, e
   painel que grita com ruído perde a confiança de quem lê. */
const GASTO_MIN_VEREDITO = 300;

/* Entrega: quanto do orçamento a campanha realmente queimou. Abaixo de 85% ela
   NÃO está limitada por verba — está limitada por lance ou por leilão, e subir
   orçamento não muda uma linha do resultado. É o erro mais caro do dia a dia:
   sobe verba, o gasto não sobe, e o gestor acha que escalou. */
const ENTREGA_LIMITADA = 0.85;

/* Frequência de saturação. Abaixo de 2 o público ainda é novo pra campanha;
   acima de 3 escalar é pagar mais caro pra falar com quem já viu. */
const FREQ_FOLGA = 2.0;
const FREQ_SATURADA = 3.0;

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

/* Quanto do dia de hoje já passou em Brasília, de 0 a 1.
   Existe por causa do erro mais fácil de cometer nesta tela: às 11h da manhã
   NENHUMA campanha entregou o orçamento do dia — faltam 12 horas. Contando o
   dia corrente como dia inteiro, o painel acusaria "limitada por lance" em
   toda campanha da conta, todo dia, até de madrugada. A capacidade do dia
   corrente é o orçamento × fração já decorrida.
   Aproximação consciente: a Meta não gasta linear ao longo do dia (puxa mais
   em horário de pico). Serve pra separar "travada" de "andando", não pra
   fechar caixa. */
function fracaoDoDiaSP() {
  const p = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(new Date());
  const h = Number(p.find((x) => x.type === 'hour').value);
  const m = Number(p.find((x) => x.type === 'minute').value);
  return Math.min(1, Math.max(0, (h * 60 + m) / 1440));
}

/* Abaixo disso o dia mal começou: qualquer leitura de entrega é ruído
   (uma campanha que gastou R$ 50 às 2h da manhã apareceria em 300%). */
const FRACAO_MIN_DIA = 0.25;

function num(v) {
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

/* A Graph devolve orçamento em CENTAVOS, como string ("507000" = R$ 5.070,00),
   enquanto spend vem em reais ("2233.91"). Misturar os dois é o bug clássico
   dessa API — o painel mostraria 0,4% de entrega e ninguém entenderia. */
function centavos(v) {
  const n = num(v);
  return n == null ? null : n / 100;
}

/* ── AÇÕES ────────────────────────────────────────────────────────────────
   Cada conta mede o resultado num evento diferente (a Institucional usa
   Compra no site como FTD; outras usam Lead ou Cadastro completo). Em vez de
   fixar um, procuramos na ordem que faz sentido de negócio e devolvemos qual
   foi encontrado — a tela mostra o nome junto do número, senão vira "23 do
   quê?".
   ────────────────────────────────────────────────────────────────────────── */
const ESCADA_RESULTADO = [
  ['offsite_conversion.fb_pixel_purchase', 'FTD'],
  ['omni_purchase', 'FTD'],
  ['purchase', 'FTD'],
  ['offsite_conversion.fb_pixel_lead', 'Lead'],
  ['lead', 'Lead'],
  ['onsite_conversion.messaging_conversation_started_7d', 'Conversa']
];
const ACOES_CADASTRO = [
  'offsite_conversion.fb_pixel_complete_registration',
  'omni_complete_registration',
  'complete_registration'
];

function mapaAcoes(lista) {
  const m = Object.create(null);
  (Array.isArray(lista) ? lista : []).forEach((a) => {
    if (a && typeof a.action_type === 'string') {
      const v = num(a.value);
      if (v != null) m[a.action_type] = v;
    }
  });
  return m;
}

function acharResultado(acoes) {
  for (const [tipo, rotulo] of ESCADA_RESULTADO) {
    if (acoes[tipo] > 0) return { valor: acoes[tipo], rotulo: rotulo, tipo: tipo };
  }
  return { valor: 0, rotulo: null, tipo: null };
}

function acharCadastros(acoes) {
  for (const tipo of ACOES_CADASTRO) {
    if (acoes[tipo] > 0) return acoes[tipo];
  }
  return null;
}

/* ── GRAPH ────────────────────────────────────────────────────────────────── */

/* Teto de páginas. Uma conta madura passa de 200 campanhas históricas e a
   Graph pagina em cima do `limit` que ela quiser, não do que a gente pede —
   sem seguir o cursor, campanha antiga que gastou no período aparece na
   tabela SEM orçamento (a entidade ficou na página que não veio) e a coluna
   de entrega, que é a que decide, nasce vazia. O teto existe só pra uma conta
   gigante não segurar a função até o timeout. */
const MAX_PAGINAS = 8;

async function graph(caminho, params, token, signal) {
  const url = new URL(GRAPH + caminho);
  Object.keys(params).forEach((k) => url.searchParams.set(k, params[k]));
  url.searchParams.set('access_token', token);

  let proxima = url.toString();
  const tudo = [];

  for (let pagina = 0; pagina < MAX_PAGINAS && proxima; pagina++) {
    const r = await fetch(proxima, { signal, headers: { accept: 'application/json' } });
    const texto = await r.text();
    let j = null;
    try { j = JSON.parse(texto); } catch (e) { /* tratado abaixo */ }

    if (!r.ok || (j && j.error)) {
      const err = new Error((j && j.error && j.error.message) || ('HTTP ' + r.status));
      err.meta = (j && j.error) || null;
      err.status = r.status;
      throw err;
    }
    if (j && Array.isArray(j.data)) tudo.push(...j.data);
    proxima = (j && j.paging && j.paging.next) || null;
  }
  return tudo;
}

/* ── MONTAGEM ─────────────────────────────────────────────────────────────
   Entidade (orçamento, estratégia, status) e insight (gasto, resultado) vêm de
   endpoints diferentes e precisam ser casados por id. Campanha que existe mas
   não gastou no período fica de fora: a tela é sobre onde a verba está indo,
   não um inventário da conta.
   ────────────────────────────────────────────────────────────────────────── */

function indexar(lista, chave) {
  const m = Object.create(null);
  lista.forEach((x) => { if (x && x[chave]) m[x[chave]] = x; });
  return m;
}

function montarLinha(ent, ins, dias) {
  /* `dias` aqui é o dias-de-entrega (fracionado no dia corrente), não o número
     de dias do recorte. null = cedo demais pra medir entrega. */
  const acoes = mapaAcoes(ins && ins.actions);
  const res = acharResultado(acoes);
  const gasto = num(ins && ins.spend) || 0;

  /* Orçamento diário: CBO carrega no nível da campanha, ABO carrega nos
     conjuntos. Quem chama passa `orcDia` já resolvido quando a campanha vem
     sem orçamento próprio — sem isso, toda campanha ABO apareceria como
     "sem orçamento" e a coluna de entrega ficaria vazia justo nas contas que
     mais precisam dela. */
  const orcDia = ent && ent.__orc_dia != null
    ? ent.__orc_dia
    : centavos(ent && ent.daily_budget);
  const orcVida = centavos(ent && ent.lifetime_budget);

  /* Capacidade do período = orçamento diário × dias do recorte, com o dia
     corrente entrando PELA FRAÇÃO já decorrida (ver fracaoDoDiaSP). É
     aproximação consciente: campanha que só ligou no meio do período aparece
     entregando menos do que entregou. Por isso a entrega só vira veredito com
     gasto relevante, e o texto sempre diz "no período". */
  const capacidade = (orcDia != null && dias != null)
    ? orcDia * dias
    : (orcVida != null ? orcVida : null);
  const entrega = (capacidade && capacidade > 0) ? gasto / capacidade : null;

  return {
    id: (ent && ent.id) || (ins && (ins.campaign_id || ins.adset_id)) || null,
    nome: (ent && ent.name) || (ins && (ins.campaign_name || ins.adset_name)) || '—',
    status: (ent && ent.effective_status) || null,
    estrategia: (ent && ent.bid_strategy) || null,
    lance: centavos(ent && ent.bid_amount),
    orcamento_dia: orcDia,
    orcamento_vida: orcVida,
    gasto: gasto,
    entrega: entrega,
    impressoes: num(ins && ins.impressions),
    cliques: num(ins && ins.clicks),
    ctr: num(ins && ins.ctr),
    cpm: num(ins && ins.cpm),
    frequencia: num(ins && ins.frequency),
    resultado: res.valor,
    resultado_rotulo: res.rotulo,
    custo_por_resultado: res.valor > 0 ? gasto / res.valor : null,
    cadastros: acharCadastros(acoes),
    campaign_id: (ins && ins.campaign_id) || (ent && ent.campaign_id) || null
  };
}

/* ── VEREDITO ─────────────────────────────────────────────────────────────
   O painel não pode devolver só uma tabela: quem abre está com a mão no botão
   de orçamento e precisa da frase. São quatro estados, nesta ordem de
   prioridade — o gargalo de entrega vem ANTES do custo de propósito, porque
   com entrega travada o custo não responde a mexida nenhuma de verba.
   `alvo` é o CPA que o gestor definiu na tela (localStorage). Sem alvo o
   veredito não fala de custo: painel não inventa meta que o negócio não deu.
   ────────────────────────────────────────────────────────────────────────── */
function vereditoLinha(l, alvo) {
  if (l.gasto < GASTO_MIN_VEREDITO) {
    return { tom: 'neutro', acao: 'Sem amostra',
      txt: 'Gasto baixo demais no período pra afirmar qualquer coisa.' };
  }
  if (l.resultado === 0) {
    return { tom: 'ruim', acao: 'Não escalar',
      txt: 'Queimou R$ ' + l.gasto.toFixed(2).replace('.', ',') +
        ' sem nenhum resultado no período.' };
  }
  if (l.entrega != null && l.entrega < ENTREGA_LIMITADA) {
    return { tom: 'atencao', acao: 'Destravar antes',
      txt: 'Entregou só ' + Math.round(l.entrega * 100) + '% do orçamento. ' +
        (l.estrategia === 'LOWEST_COST_WITH_BID_CAP'
          ? 'O teto de lance é o gargalo — subir verba não muda o gasto.'
          : 'Está limitada por leilão, não por verba.') };
  }
  if (l.frequencia != null && l.frequencia >= FREQ_SATURADA) {
    return { tom: 'atencao', acao: 'Público cansado',
      txt: 'Frequência em ' + l.frequencia.toFixed(1) + '×. Escalar aqui sobe o custo — ' +
        'renove criativo ou abra público antes.' };
  }
  if (alvo != null && l.custo_por_resultado != null && l.custo_por_resultado > alvo) {
    return { tom: 'ruim', acao: 'Não escalar',
      txt: 'Custo por resultado acima do alvo de ' + alvo.toFixed(0) + '.' };
  }
  const folga = l.frequencia != null && l.frequencia < FREQ_FOLGA;
  return { tom: 'bom', acao: 'Pode escalar',
    txt: 'Entrega cheia' + (folga ? ' e público longe de saturar' : '') +
      (alvo != null ? ', custo dentro do alvo' : '') + '.' };
}

/* Veredito da CONTA: não é a soma dos vereditos, é a leitura do dinheiro
   parado. "Tem R$ 4.150/dia de orçamento que ninguém está conseguindo gastar"
   é a informação que muda a decisão do dia. */
function vereditoConta(campanhas, alvo) {
  const ativas = campanhas.filter((c) => c.gasto > 0);
  const gasto = ativas.reduce((s, c) => s + c.gasto, 0);
  const capacidade = ativas.reduce((s, c) => s + (c.orcamento_dia || 0), 0);
  const resultado = ativas.reduce((s, c) => s + (c.resultado || 0), 0);
  const ociosas = ativas.filter((c) => c.entrega != null && c.entrega < ENTREGA_LIMITADA);

  return {
    gasto: gasto,
    orcamento_dia: capacidade || null,
    resultado: resultado,
    custo_por_resultado: resultado > 0 ? gasto / resultado : null,
    campanhas_ativas: ativas.length,
    campanhas_limitadas: ociosas.length,
    pode_escalar: ativas.filter((c) => vereditoLinha(c, alvo).tom === 'bom').length
  };
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

  const token = process.env.META_ACCESS_TOKEN;
  if (!token) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(500).json({
      error: 'missing_env',
      detail: 'META_ACCESS_TOKEN não está definida no projeto Vercel.'
    });
  }

  const q = req.query || {};

  /* Só dígitos. O id entra na URL da Graph, e id livre vindo do navegador é
     porta aberta pra chamar outra edge da API com o nosso token. */
  const conta = typeof q.conta_id === 'string' ? q.conta_id.trim() : '';
  if (!/^\d{5,20}$/.test(conta)) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(400).json({
      error: 'conta_invalida',
      detail: 'conta_id deve ser o id numérico da conta de anúncio.'
    });
  }

  const hoje = hojeSP();
  let de = typeof q.de === 'string' && q.de ? q.de : null;
  let ate = typeof q.ate === 'string' && q.ate ? q.ate : null;

  /* Sem período o recorte é HOJE, igual ao painel: quem clica na linha está
     olhando o número de hoje e espera o detalhe do mesmo dia. */
  if (de == null && ate == null) { de = hoje; ate = hoje; }

  if (!dataValida(de) || !dataValida(ate)) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(400).json({ error: 'periodo_invalido', detail: 'Datas devem estar no formato YYYY-MM-DD.' });
  }
  if (de > ate) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(400).json({ error: 'periodo_invalido', detail: 'A data inicial não pode ser depois da final.' });
  }
  if (ate > hoje) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(400).json({ error: 'periodo_invalido', detail: 'A data final não pode estar no futuro.' });
  }
  if (diasEntre(de, ate) > MAX_RANGE_DIAS) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(400).json({ error: 'periodo_invalido', detail: 'Período máximo de ' + MAX_RANGE_DIAS + ' dias.' });
  }

  const dias = diasEntre(de, ate) + 1;

  /* Dias que valem PRA MEDIR ENTREGA — não é a mesma coisa que dias do
     recorte. O dia corrente entra pela fração já vivida; de madrugada ele não
     entra de jeito nenhum (diasEntrega = null zera a coluna em vez de mentir).
     Sem isso, "hoje" acusaria toda campanha da conta como travada às 9h. */
  const ehHoje = ate >= hoje;
  const fracHoje = ehHoje ? fracaoDoDiaSP() : 1;
  const cedoDemais = ehHoje && fracHoje < FRACAO_MIN_DIA;
  const diasEntrega = (dias === 1 && cedoDemais) ? null : ((dias - 1) + fracHoje);

  const alvo = num(q.alvo);
  const act = 'act_' + conta;
  const janela = JSON.stringify({ since: de, until: ate });

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);

  try {
    /* Quatro chamadas em paralelo. Sequencial seria ~4× mais lento e a pessoa
       está esperando um modal abrir — não é uma tela de fundo. */
    const [campEnt, campIns, setEnt, setIns] = await Promise.all([
      graph(act + '/campaigns', {
        fields: 'id,name,status,effective_status,daily_budget,lifetime_budget,bid_strategy,bid_amount',
        limit: '300'
      }, token, ctrl.signal),
      graph(act + '/insights', {
        level: 'campaign',
        fields: 'campaign_id,campaign_name,spend,impressions,clicks,ctr,cpm,frequency,actions',
        time_range: janela,
        limit: '300'
      }, token, ctrl.signal),
      graph(act + '/adsets', {
        fields: 'id,name,campaign_id,effective_status,daily_budget,lifetime_budget,bid_strategy,bid_amount',
        limit: '500'
      }, token, ctrl.signal),
      graph(act + '/insights', {
        level: 'adset',
        fields: 'adset_id,adset_name,campaign_id,spend,impressions,clicks,ctr,cpm,frequency,actions',
        time_range: janela,
        limit: '500'
      }, token, ctrl.signal)
    ]);

    const porCamp = indexar(campEnt, 'id');
    const porSet = indexar(setEnt, 'id');

    /* ABO: a campanha vem sem daily_budget e o orçamento real é a soma dos
       conjuntos ATIVOS. Fazer isso antes de montar as linhas, senão a coluna
       de entrega nasce vazia em toda campanha ABO. */
    const somaSets = Object.create(null);
    setEnt.forEach((s) => {
      if (!s || !s.campaign_id) return;
      if (s.effective_status !== 'ACTIVE') return;
      const v = centavos(s.daily_budget);
      if (v == null) return;
      somaSets[s.campaign_id] = (somaSets[s.campaign_id] || 0) + v;
    });
    Object.keys(porCamp).forEach((id) => {
      const c = porCamp[id];
      c.__orc_dia = centavos(c.daily_budget);
      if (c.__orc_dia == null && somaSets[id] != null) c.__orc_dia = somaSets[id];
    });

    const conjuntos = setIns
      .map((i) => montarLinha(porSet[i.adset_id], i, diasEntrega))
      .filter((l) => l.gasto > 0)
      .sort((a, b) => b.gasto - a.gasto);

    const campanhas = campIns
      .map((i) => montarLinha(porCamp[i.campaign_id], i, diasEntrega))
      .filter((l) => l.gasto > 0)
      .sort((a, b) => b.gasto - a.gasto);

    campanhas.forEach((c) => {
      c.veredito = vereditoLinha(c, alvo);
      c.conjuntos = conjuntos.filter((s) => s.campaign_id === c.id);
    });

    /* Dado de hoje muda o tempo todo, mas o modal costuma ser aberto e fechado
       várias vezes seguidas na mesma leitura: 60s de borda derruba a repetição
       sem atrasar decisão nenhuma. Período fechado não muda mais. */
    const ehHoje = ate >= hoje;
    res.setHeader(
      'Cache-Control',
      ehHoje
        ? 'public, max-age=0, s-maxage=60, stale-while-revalidate=300'
        : 'public, max-age=0, s-maxage=900, stale-while-revalidate=3600'
    );

    return res.status(200).json({
      conta_id: conta,
      periodo: {
        de: de, ate: ate, dias: dias, is_hoje: ehHoje,
        /* o front precisa dos dois pra escrever a nota honesta: quantos dias o
           recorte tem e quantos valeram pra medir entrega (o dia corrente
           entra pela metade que já passou) */
        dias_entrega: diasEntrega,
        fracao_dia: ehHoje ? fracHoje : 1
      },
      resumo: vereditoConta(campanhas, alvo),
      campanhas: campanhas
    });
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store');
    const abortou = e && (e.name === 'AbortError' || e.name === 'TimeoutError');
    if (abortou) {
      return res.status(504).json({
        error: 'meta_timeout',
        detail: 'A Meta não respondeu em ' + Math.round(TIMEOUT_MS / 1000) + 's.'
      });
    }
    /* Código 17 e 613 da Graph são limite de chamada. Vale dizer o nome, senão
       o próximo debug começa procurando bug onde só tem fila. */
    const cod = e && e.meta && e.meta.code;
    return res.status(502).json({
      error: 'meta_error',
      detail: (cod === 17 || cod === 613)
        ? 'A Meta está limitando as chamadas do token agora. Tente de novo em alguns minutos.'
        : String((e && e.message) || e).slice(0, 240)
    });
  } finally {
    clearTimeout(timer);
  }
};
