/**
 * COORTE DE FTD — GGR e net dep por safra de primeiro depósito, mês a mês ou
 * semana a semana, com o investimento em ads da safra e a projeção de payback.
 *
 * A pergunta: "a turma que depositou pela primeira vez em junho gerou quanto em
 * junho, em julho, em agosto? Quantos daqueles jogadores ainda estavam vivos em
 * cada período? E o que eu GASTEI pra trazer essa turma — já voltou?"
 *
 * ─── POR QUE ESTA ROTA EXISTE, SE JÁ EXISTE A SAFRA DO n8n ──────────────────
 * A safra do painel (workflow `Dashboard Operação - Safra`) responde outra
 * pergunta: ela agrupa por mês de CADASTRO e só sabe o ACUMULADO DE VIDA de
 * cada turma, porque `af2_regs_op` devolve o total de cada jogador desde que
 * ele entrou — não dá pra abrir por mês. Pra conseguir o mês a mês, aquele
 * workflow fotografa o acumulado uma vez por mês e subtrai foto de foto: um
 * dado que só PASSA a existir, mês após mês (a primeira foto é de 13/08/26).
 *
 * Esta rota não precisa de foto nenhuma, e é RETROATIVA desde o primeiro mês:
 *   af2_media_report_op + group_by=registration_id + date_from/date_to
 * devolve o net_pl e o net_deposits de CADA JOGADOR DENTRO DA JANELA pedida.
 * Uma janela por chamada, e o período a período cai pronto.
 *
 * E a safra sai do próprio relatório: na janela em que o jogador tem
 * `ftd_count > 0`, ele nasce. Isso dispensa `af2_regs_op` por completo — e
 * ainda é MAIS completo que ele, porque pega quem se cadastrou antes da janela
 * varrida e só foi depositar depois (conferido: 818 contra 816 numa safra).
 *
 * ─── DEFINIÇÕES (a regra de negócio, escrita onde ela é aplicada) ───────────
 *   safra      período do PRIMEIRO depósito. O jogador entra numa safra e fica
 *              nela pra sempre — depósito novo NÃO cria safra nova.
 *   M0,M1,M2   idade da safra em meses de calendário, não em dias:
 *              M0 é o próprio mês do FTD, M1 o seguinte. FTD em 31/05 com
 *              atividade em 01/06 é M1, mesmo com um dia de diferença.
 *   S0,S1,S2   idem em SEMANAS (segunda a domingo, fuso da operação), quando
 *              `gran=semana`. Só as últimas SEMANAS_JANELA semanas entram: a
 *              leitura semanal serve pra acompanhar safra RECENTE de perto, e
 *              varrer um ano inteiro semana a semana seriam 47+ chamadas de
 *              TAP por btag — não cabe no orçamento da função.
 *   GGR        `net_pl` do período (na TAP, net_pl = pl = netwin quando não há
 *              bônus). NÃO é acumulado: cada célula é só aquele período.
 *   net dep    `net_deposits` do período (depósitos − saques). Mesma regra.
 *   ativos     jogadores DISTINTOS da safra com atividade no período.
 *   jogadores  tamanho da safra: quantos fizeram FTD naquele período.
 *
 * ─── INVESTIMENTO E PAYBACK ─────────────────────────────────────────────────
 * O investimento da safra é o gasto de Meta Ads do expert NO PERÍODO da safra
 * (Graph API, insights com time_increment). Conta compartilhada é recortada
 * por match_terms no nome da campanha — o MESMO recorte do n8n, espelhado no
 * mapa CONTAS_META abaixo. É uma aproximação assumida: o gasto do mês trouxe
 * também gente que ainda não depositou, mas é a régua que o gestor pediu
 * ("investi 10k em abril — a turma de abril já devolveu isso?").
 *
 * O payback compara o investimento com o GGR ACUMULADO da safra:
 *   · já cruzou → em que idade cruzou;
 *   · ainda não → projeta os próximos períodos com o último período fechado
 *     como base e um fator de decaimento estimado da PRÓPRIA matriz (mediana
 *     das razões período-a-período entre células fechadas positivas). Se nem
 *     a soma infinita da geometria alcança, a resposta honesta é "não fecha
 *     no ritmo atual" — projeção otimista aqui seria mentira cara.
 *
 * ─── TRÊS ESTADOS DE CÉLULA, que não podem se confundir ─────────────────────
 *   fechado   período que já acabou. Valor definitivo.
 *   parcial   período corrente. O valor ainda sobe — vem com `parcial: true`.
 *   futuro    período que nem começou. NÃO VEM NO JSON. Zero seria mentira.
 *
 * Variáveis de ambiente obrigatórias no projeto Vercel:
 *   TAP_API_KEY          (mesma chave do BO da afiliação que o n8n usa)
 *   META_ACCESS_TOKEN    (mesmo token de sistema do n8n — investimento)
 *   PAINEL_CL_SENHA      (só pro escopo costa_lobao; ver api/cl-auth.js)
 */

const TAP_URL = 'https://boapi3.smartico.ai/api/af2_media_report_op';
const GRAPH = 'https://graph.facebook.com/v21.0/';

/* Primeiro mês com operação que vale a pena olhar — o mesmo SAFRA_DESDE do
   workflow do n8n, pra que as duas leituras falem do mesmo pedaço de história. */
const DESDE = '2025-10';

/* Janela da visão semanal: 16 semanas ≈ 4 meses de safras recentes, e 16
   chamadas de TAP por btag — mesma ordem de grandeza das 11 mensais. */
const SEMANAS_JANELA = 16;

/* A TAP derruba acima de ~5 chamadas simultâneas, e o jeito dela de reclamar é
   HTTP 200 com `errCode` no corpo (nunca um status de erro). 4 é o teto seguro
   medido em produção. */
const CONCORRENCIA = 3;
/* Quando a TAP satura, ela satura pra TODO MUNDO por alguns segundos — abrir
   dois painéis em sequência já é suficiente. Por isso o backoff aqui é
   exponencial e generoso (0,8s / 1,6s / 3,2s): tentar de novo rápido só
   engrossa a fila que causou o problema. Cabe no orçamento porque só as
   leituras que falharam repetem, não as 11. */
const TENTATIVAS = 4;
const BACKOFF_BASE_MS = 800;

/* maxDuration desta função é 60s (vercel.json). Abortar em 50 garante que quem
   responde é este código, com JSON explicando o que houve, e não a plataforma
   com uma página de 504. O pior caso medido (conta institucional, ~6.500
   jogadores por mês, 11 meses) fecha em 14s. */
const ORCAMENTO_MS = 50000;

/* Teto da projeção de payback: além disso a geometria já disse que não fecha
   em horizonte de decisão nenhum. */
const PROJECAO_MAX_PERIODOS = 36;

const TZ = 'America/Sao_Paulo';

/* ── Expert → btag(s) ───────────────────────────────────────────────────────
   ESTE MAPA É ESPELHO do nó `Montar Linhas Safra` do workflow
   `Dashboard Operação - Safra` no n8n. Nome de expert que não bater LETRA POR
   LETRA com o do painel faz a matriz vir vazia — o front casa por nome.

   UM MAPA SÓ, e não um por escopo, de propósito: o btag de um expert é o mesmo
   esteja ele no recorte da dupla ou na visão geral — quem muda de escopo pra
   escopo é QUEM PODE VER, não o número. Separar por escopo criava um jeito
   bobo de quebrar: expert que entra no recorte depois (o TALYSON entrou em
   15/08) aparecia no painel e devolvia 404 aqui, porque estava listado só de
   um lado. A autorização é feita separado, embaixo. */
const BTAGS = {
  'EDERSON': ['538384'],
  'GP DADOS': ['537822'],
  'DEKO': ['541420', '474243'],
  'CHARLES': ['546473'],
  'QZL': ['542346'],
  'TANOS': ['544991'],
  'GREGORIO BIG': ['546470'],
  'COSTA E LOBAO': ['537615'],
  'PEDRO FOOTBALL': ['539199'],
  'FELIPE BORGES': ['505716'],
  'PR TIPSTER': ['543714'],
  'LEO FREITAS': ['545056'],
  'CAIO TIPS': ['505209'],
  'ZECA': ['532538'],
  'NATHAN ROSENO': ['543378'],
  'SHELGUIMA': ['508799'],
  'DIEGO LUGO': ['542954'],
  'JOTA PE': ['544076'],
  'REINAN TIPS': ['537680'],
  'BATEU - TALYSON': ['547573'],
  'BATEU BET - HENRIQUE 500K': ['548058'],
  'BATEU BET - GIOVANNI ROLETA': ['548110'],
  'GOOGLE': ['543779'],
  /* a marca inteira: o painel chama de INSTITUCIONAL na visão geral e de CA04
     INSTITUCIONAL no recorte, mas o btag — e o funil — é o mesmo */
  'INSTITUCIONAL': ['537874'],
  'CA04 INSTITUCIONAL': ['537874']
};

/* ── Expert → conta(s) de anúncio do Meta ───────────────────────────────────
   ESPELHO dos nós `Montar experts` / `Montar entidades Geral` do workflow
   `Dashboard Operação - Webhook API` no n8n — MESMAS contas, MESMOS
   match_terms. `termos: null` = a conta é toda do expert; lista = conta
   compartilhada, só campanha com um dos termos no nome conta.

   Expert que não está aqui (GOOGLE, que anuncia no Google Ads) volta
   `investimento: null` — o front mostra "sem investimento rastreado" em vez
   de R$ 0, que significaria "anunciou e não gastou". */
const CONTAS_META = {
  'EDERSON': [{ conta: '989562184047728', termos: ['EDERSON'] }],
  'GP DADOS': [{ conta: '989562184047728', termos: ['GPDADOS', 'GP DADOS'] }],
  'DEKO': [{ conta: '989562184047728', termos: ['DEKO'] },
           { conta: '1970560716829162', termos: null }],
  'CHARLES': [{ conta: '989562184047728', termos: ['CHARLES'] }],
  'QZL': [{ conta: '989562184047728', termos: ['QZL'] }],
  'TANOS': [{ conta: '1690283185195699', termos: null },
            { conta: '1018864441147274', termos: null }],
  'GREGORIO BIG': [{ conta: '898597209986158', termos: null }],
  'COSTA E LOBAO': [{ conta: '897476669429623', termos: null }],
  'PEDRO FOOTBALL': [{ conta: '1997624391048176', termos: ['PEDRO'] }],
  'FELIPE BORGES': [{ conta: '1517002369929477', termos: null },
                    { conta: '965568832979022', termos: null }],
  'PR TIPSTER': [{ conta: '1350047622999139', termos: null }],
  'LEO FREITAS': [{ conta: '1608680367486969', termos: null }],
  'CAIO TIPS': [{ conta: '1504234301191468', termos: null }],
  'ZECA': [{ conta: '809590885250558', termos: null }],
  'NATHAN ROSENO': [{ conta: '1538558644947601', termos: null }],
  'SHELGUIMA': [{ conta: '2020228565251138', termos: null }],
  'DIEGO LUGO': [{ conta: '3602839156558626', termos: null }],
  'JOTA PE': [{ conta: '1318099683822304', termos: null },
              { conta: '1677889643448352', termos: null },
              { conta: '3432194193613959', termos: null },
              { conta: '27620008490951770', termos: null }],
  'REINAN TIPS': [{ conta: '1344546561194352', termos: null }],
  'BATEU - TALYSON': [{ conta: '1044864454792358', termos: null }],
  'BATEU BET - HENRIQUE 500K': [{ conta: '1362893448699965', termos: null }],
  'BATEU BET - GIOVANNI ROLETA': [{ conta: '1047677338184825', termos: null }],
  'INSTITUCIONAL': [
    { conta: '1375513147862272', termos: null },
    { conta: '4369472913294852', termos: null },
    { conta: '566433646393570', termos: null },
    { conta: '4491460707782665', termos: null },
    { conta: '1007454048772455', termos: null },
    { conta: '1364418892488854', termos: null },
    { conta: '1689900502296830', termos: null },
    { conta: '3841440682664482', termos: null },
    { conta: '1662336521647121', termos: null },
    { conta: '2474915826342866', termos: null }
  ],
  /* a linha CA04 do recorte mostra o funil da marca, mas o INVESTIMENTO dela
     é só o da conta CA04 — mesma régua do painel principal */
  'CA04 INSTITUCIONAL': [{ conta: '4491460707782665', termos: null }]
};

/* Escopos que o painel conhece. Aqui eles servem só pra decidir se a resposta
   precisa da senha do recorte — o número em si não depende de escopo. */
const ESCOPOS = { costa_lobao: true, geral: true, google: true };

/* A porta do recorte Costa e Lobão mora em api/cl-auth.js. Se o arquivo sumir,
   o recorte fica FECHADO — o lado seguro do erro. */
let tokenCl = null;
try { tokenCl = require('./cl-auth').tokenValido; } catch (e) { tokenCl = null; }
function temSessaoCl(req) {
  const segredo = process.env.PAINEL_CL_SENHA;
  /* sem senha configurada o recorte fica aberto como sempre foi */
  if (!segredo) return true;
  if (!tokenCl) return false;
  return tokenCl(req, segredo);
}

/* ── Aritmética de mês ──────────────────────────────────────────────────────
   Tudo aqui é "YYYY-MM" e número de meses desde o ano zero. Contar em meses de
   calendário, e não em dias, é a regra §15: virar o ano tem que ser +1 mês, não
   −11. */
function ordinal(ym) {
  return Number(ym.slice(0, 4)) * 12 + Number(ym.slice(5, 7)) - 1;
}
function deOrdinal(o) {
  return String(Math.floor(o / 12)).padStart(4, '0') + '-' +
         String((o % 12) + 1).padStart(2, '0');
}
function mesCorrente() {
  /* en-CA devolve YYYY-MM-DD; o fuso é o da operação, não o do servidor */
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit'
  }).format(new Date()).slice(0, 7);
}
/** Primeiro dia do mês seguinte — o `date_to` da TAP é EXCLUSIVO. */
function limiteDoMes(ym) {
  return deOrdinal(ordinal(ym) + 1) + '-01';
}

/* ── Aritmética de semana ───────────────────────────────────────────────────
   Semana é SEGUNDA A DOMINGO no fuso da operação, e o nome dela é a data da
   segunda ("2026-08-17"). Contas em dias-época UTC — a data já chega no fuso
   certo, então meia-noite UTC serve de régua sem risco de virada dupla. */
function hojeSP() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());
}
function diaEpoch(ymd) { return Math.floor(Date.parse(ymd + 'T00:00:00Z') / 86400000); }
function deDiaEpoch(n) { return new Date(n * 86400000).toISOString().slice(0, 10); }
/** Segunda-feira da semana que contém a data. Date.getUTCDay(): dom=0 … sáb=6. */
function segundaDe(ymd) {
  const d = diaEpoch(ymd);
  const dow = new Date(d * 86400000).getUTCDay();
  return deDiaEpoch(d - ((dow + 6) % 7));
}
function somaDias(ymd, n) { return deDiaEpoch(diaEpoch(ymd) + n); }

/* ── Uma leitura da TAP: um btag, uma janela [de, ateExcl) ──────────────────
   Devolve a lista de jogadores com o que cada um moveu DENTRO da janela. */
async function lerJanela(btag, de, ateExcl, chave, ateQuando) {
  const url = new URL(TAP_URL);
  url.searchParams.set('date_from', de);
  url.searchParams.set('date_to', ateExcl);
  url.searchParams.set('affiliate_id', btag);
  url.searchParams.set('group_by', 'registration_id');

  for (let tentativa = 0; tentativa < TENTATIVAS; tentativa++) {
    const sobra = ateQuando - Date.now();
    if (sobra <= 1500) break;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), Math.min(sobra, 20000));
      let corpo;
      try {
        const r = await fetch(url.toString(), {
          signal: ctrl.signal,
          headers: { accept: 'application/json', authorization: chave }
        });
        corpo = await r.json();
      } finally {
        clearTimeout(timer);
      }
      /* ESTOURO DE CHAMADA VEM COM HTTP 200 e `errCode` no corpo. Ler isso como
         "janela sem movimento" é o bug que já zerou funil de expert no painel —
         por isso a resposta só vale se `data` for array de verdade. */
      if (corpo && Array.isArray(corpo.data)) return corpo.data;
    } catch (e) {
      /* rede/timeout: cai no backoff abaixo */
    }
    await new Promise(ok => setTimeout(ok, BACKOFF_BASE_MS * Math.pow(2, tentativa)));
  }
  return null;   /* leitura FALHA — não é o mesmo que janela vazia */
}

/** Roda as tarefas com teto de simultâneas, preservando a ordem do resultado. */
async function comLimite(tarefas, limite) {
  const saida = new Array(tarefas.length);
  let proxima = 0;
  async function operario() {
    while (true) {
      const i = proxima++;
      if (i >= tarefas.length) return;
      saida[i] = await tarefas[i]();
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limite, tarefas.length) }, operario)
  );
  return saida;
}

/* ── Investimento Meta por período ──────────────────────────────────────────
   Uma chamada de insights por conta, com time_increment fazendo a Graph
   devolver os buckets prontos: 'monthly' pro mensal; 7 pro semanal — e como o
   `since` semanal é sempre uma segunda-feira, os buckets de 7 dias CAEM
   alinhados com as semanas da TAP, sem rebucketing aqui.
   Conta com match_terms pede level=campaign (o recorte é pelo nome); conta
   inteira pede level=account (uma linha por bucket, resposta mínima).
   Devolve { bucket → spend } ou null se QUALQUER conta falhar — investimento
   pela metade é pior que investimento ausente: um payback calculado sobre
   metade do gasto diria "pagou" antes da hora. */
async function buscarInvestimento(contas, gran, deYmd, ateYmd, token, ateQuando) {
  async function umaConta(cfg) {
    const compartilhada = Array.isArray(cfg.termos) && cfg.termos.length > 0;
    const params = new URLSearchParams();
    params.set('access_token', token);
    params.set('fields', compartilhada ? 'spend,campaign_name' : 'spend');
    params.set('level', compartilhada ? 'campaign' : 'account');
    params.set('time_range', JSON.stringify({ since: deYmd, until: ateYmd }));
    params.set('time_increment', gran === 'semana' ? '7' : 'monthly');
    params.set('limit', '500');

    const porBucket = {};
    let url = GRAPH + 'act_' + cfg.conta + '/insights?' + params.toString();
    /* paginação: conta compartilhada em nível de campanha pode passar de uma
       página; teto de 5 é folga (medido: 117 linhas numa página só) */
    for (let pagina = 0; pagina < 5 && url; pagina++) {
      const sobra = ateQuando - Date.now();
      if (sobra <= 1500) return null;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), Math.min(sobra, 15000));
      let corpo;
      try {
        const r = await fetch(url, { signal: ctrl.signal });
        corpo = await r.json();
      } catch (e) {
        return null;
      } finally {
        clearTimeout(timer);
      }
      if (!corpo || !Array.isArray(corpo.data)) return null;   /* erro da Graph */
      for (const linha of corpo.data) {
        if (compartilhada) {
          const nome = String(linha.campaign_name || '').toUpperCase();
          if (!cfg.termos.some(t => nome.includes(t))) continue;
        }
        const bucket = gran === 'semana'
          ? String(linha.date_start || '')
          : String(linha.date_start || '').slice(0, 7);
        porBucket[bucket] = (porBucket[bucket] || 0) + (Number(linha.spend) || 0);
      }
      url = corpo.paging && corpo.paging.next ? corpo.paging.next : null;
    }
    return porBucket;
  }

  const partes = await Promise.all(contas.map(umaConta));
  if (partes.some(p => p === null)) return null;
  const total = {};
  for (const p of partes) {
    for (const b in p) total[b] = (total[b] || 0) + p[b];
  }
  return total;
}

/* ── Payback ────────────────────────────────────────────────────────────────
   Régua: GGR acumulado da safra × investimento do período dela.
   `fator` é o decaimento período-a-período estimado da matriz inteira (mediana
   das razões entre células FECHADAS positivas consecutivas, idade ≥ 1) — a
   retenção da operação medida nela mesma, não um chute de benchmark. */
function estimarFator(safras) {
  const razoes = [];
  for (const s of safras) {
    const cs = s.celulas || [];
    for (let i = 1; i < cs.length; i++) {
      if (cs[i].parcial || cs[i - 1].parcial) continue;
      if (cs[i - 1].ggr > 0 && cs[i].ggr > 0) razoes.push(cs[i].ggr / cs[i - 1].ggr);
    }
  }
  if (!razoes.length) return 0.75;   /* sem história: decaimento típico da casa */
  razoes.sort((a, b) => a - b);
  const meio = Math.floor(razoes.length / 2);
  const mediana = razoes.length % 2 ? razoes[meio]
                                    : (razoes[meio - 1] + razoes[meio]) / 2;
  /* clamp: razão > 1 acontece (mês bom), mas projetar crescimento eterno é
     mentira; abaixo de 0,4 a projeção mata a safra rápido demais por causa de
     um mês ruim isolado */
  return Math.min(0.95, Math.max(0.4, mediana));
}

function calcularPayback(safra, investimento, fator, gran) {
  if (investimento == null || !(investimento > 0)) return null;

  /* "Pago" é estado do ACUMULADO DE HOJE, não evento histórico: uma safra que
     cruzou o investimento em julho e devolveu tudo num jogador sortudo em
     agosto NÃO está paga — o caixa dela não cobre o gasto. Só quando o total
     atual cobre é que a primeira travessia vira a resposta de "quando pagou". */
  const cs = safra.celulas || [];
  let acumulado = 0;
  for (const c of cs) acumulado += c.ggr;
  if (acumulado >= investimento) {
    let soma = 0;
    for (let i = 0; i < cs.length; i++) {
      soma += cs[i].ggr;
      if (soma >= investimento) {
        return { status: 'pago', idade: i, periodo: cs[i].mes_ref };
      }
    }
  }

  /* Base da projeção: o maior entre o último período FECHADO e o que o período
     corrente JÁ acumulou. Só o fechado subestima quando a safra está acelerando
     (jul/26 do TANOS: mês fechado R$ 883, corrente já em R$ 13 mil — projetar
     sobre 883 condenava a safra a "não fecha" com o dinheiro entrando); só o
     parcial superestimaria se o período recém-começou. O maior dos dois é um
     piso honesto: o parcial só cresce até fechar. */
  let fechado = null;
  let ultimo = null;
  for (let i = cs.length - 1; i >= 0; i--) {
    if (!cs[i].parcial) { fechado = cs[i].ggr; break; }
  }
  if (cs.length) ultimo = cs[cs.length - 1];
  const parcialAtual = ultimo && ultimo.parcial ? ultimo.ggr : null;
  let base = fechado;
  if (parcialAtual != null && (base == null || parcialAtual > base)) base = parcialAtual;
  if (base == null) base = 0;

  const falta = investimento - acumulado;
  if (!(base > 0)) {
    /* a turma não está gerando: não há de onde projetar retorno */
    return { status: 'sem_ritmo', falta: Math.round(falta * 100) / 100 };
  }

  let soma = 0;
  let v = base * fator;
  for (let n = 1; n <= PROJECAO_MAX_PERIODOS; n++) {
    soma += v;
    if (soma >= falta) {
      const ref = ultimo ? ultimo.mes_ref : safra.mes;
      const previsto = gran === 'semana'
        ? somaDias(ref, 7 * n)
        : deOrdinal(ordinal(ref) + n);
      return {
        status: 'projetado',
        periodos: n,
        periodo: previsto,
        fator: Math.round(fator * 100) / 100
      };
    }
    v *= fator;
  }
  return {
    status: 'nao_fecha',
    falta: Math.round(falta * 100) / 100,
    fator: Math.round(fator * 100) / 100
  };
}

/* ── O cálculo ──────────────────────────────────────────────────────────────
   Duas passadas sobre a mesma leitura:
     1ª  descobre em que período cada jogador fez o FTD  -> a safra dele
     2ª  joga o GGR/net dep de cada período na célula [safra][idade]
   A segunda passada precisa do mapa completo da primeira: um jogador aparece
   numa janela recente, mas a safra dele pode ter nascido meses antes.
   `periodos` chega ORDENADO; a idade é a distância de índices — vale igual pro
   mês (out, nov, …) e pra semana (segunda a segunda). */
function montar(leituras, periodos, indicePeriodo) {
  const safraDoJogador = {};
  for (const { chave, linhas } of leituras) {
    for (const r of linhas) {
      const rid = r.registration_id ? String(r.registration_id) : '';
      if (!rid || !(Number(r.ftd_count) || 0)) continue;
      /* o primeiro depósito é o PRIMEIRO: se o jogador aparecer com ftd_count
         em duas janelas (correção retroativa da casa), vale a mais antiga */
      if (!safraDoJogador[rid] || chave < safraDoJogador[rid]) safraDoJogador[rid] = chave;
    }
  }

  const tamanho = {};                 /* safra -> quantos fizeram FTD nela */
  for (const rid in safraDoJogador) {
    const s = safraDoJogador[rid];
    tamanho[s] = (tamanho[s] || 0) + 1;
  }

  const celulas = {};                 /* "safra|idade" -> { ggr, net_dep, ativos } */
  for (const { chave, linhas } of leituras) {
    for (const r of linhas) {
      const rid = r.registration_id ? String(r.registration_id) : '';
      const safra = safraDoJogador[rid];
      if (!safra) continue;           /* jogador que nunca depositou: sem safra */
      const idade = indicePeriodo[chave] - indicePeriodo[safra];
      if (idade < 0) continue;        /* atividade ANTES do FTD não é da safra */

      const ggr = Number(r.net_pl) || 0;
      const netDep = Number(r.net_deposits) || 0;
      const ops = Number(r.operations) || 0;
      const k = safra + '|' + idade;
      if (!celulas[k]) celulas[k] = { ggr: 0, net_dep: 0, ativos: 0 };
      celulas[k].ggr += ggr;
      celulas[k].net_dep += netDep;
      /* ATIVO É JOGADOR DISTINTO, não transação: a TAP já entrega uma linha por
         jogador dentro da janela, então basta não contar quem ficou parado. */
      if (ops > 0 || ggr !== 0 || netDep !== 0) celulas[k].ativos += 1;
    }
  }

  const ultimoIdx = periodos.length - 1;
  return Object.keys(tamanho).sort().map(function (chaveSafra) {
    const idadeMax = ultimoIdx - indicePeriodo[chaveSafra];
    const linha = { mes: chaveSafra, jogadores: tamanho[chaveSafra], celulas: [] };
    for (let i = 0; i <= idadeMax; i++) {
      /* PERÍODO FUTURO NÃO ENTRA — o laço já para na idade de hoje. Célula que
         existe e está zerada é GGR zero de verdade: a turma teve o período e
         não gerou nada. As duas coisas não podem virar a mesma coisa na tela. */
      const c = celulas[chaveSafra + '|' + i] || { ggr: 0, net_dep: 0, ativos: 0 };
      const ref = periodos[indicePeriodo[chaveSafra] + i];
      linha.celulas.push({
        idade: i,
        mes_ref: ref,
        ggr: Math.round(c.ggr * 100) / 100,
        net_dep: Math.round(c.net_dep * 100) / 100,
        ativos: c.ativos,
        parcial: indicePeriodo[chaveSafra] + i === ultimoIdx   /* período corrente */
      });
    }
    return linha;
  });
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

  const chave = process.env.TAP_API_KEY;
  if (!chave) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(500).json({
      error: 'missing_env',
      detail: 'TAP_API_KEY não está definida no projeto Vercel.'
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
  /* mesma porta do resto do painel: o corte é no SERVIDOR, porque esconder a
     aba no navegador não esconderia o JSON no DevTools */
  if (escopo === 'costa_lobao' && !temSessaoCl(req)) {
    res.setHeader('Cache-Control', 'private, no-store');
    return res.status(403).json({ error: 'nao_autorizado' });
  }
  const btags = BTAGS[expert];
  if (!btags) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(404).json({
      error: 'expert_desconhecido',
      detail: 'Sem btag mapeado para "' + expert + '". Conta nova que o painel ' +
              'descobriu sozinha na BM precisa ser somada ao mapa desta rota.'
    });
  }

  /* ── Janelas da varredura ─────────────────────────────────────────────────
     Mensal: todos os meses desde DESDE. Semanal: as últimas SEMANAS_JANELA
     semanas, segunda a segunda. `periodos` é a régua ordenada; a TAP recebe
     [de, ateExcl) por janela. */
  const hoje = hojeSP();
  const periodos = [];
  const janelas = [];   /* { chave, de, ateExcl } */
  if (gran === 'semana') {
    const segundaAtual = segundaDe(hoje);
    for (let i = SEMANAS_JANELA - 1; i >= 0; i--) {
      const seg = somaDias(segundaAtual, -7 * i);
      periodos.push(seg);
      janelas.push({ chave: seg, de: seg, ateExcl: somaDias(seg, 7) });
    }
  } else {
    const mesAtual = mesCorrente();
    for (let o = ordinal(DESDE); o <= ordinal(mesAtual); o++) {
      const ym = deOrdinal(o);
      periodos.push(ym);
      janelas.push({ chave: ym, de: ym + '-01', ateExcl: limiteDoMes(ym) });
    }
  }
  const indicePeriodo = {};
  periodos.forEach((p, i) => { indicePeriodo[p] = i; });

  const ateQuando = Date.now() + ORCAMENTO_MS;
  const pedidos = [];
  for (const btag of btags) {
    for (const j of janelas) pedidos.push({ btag: btag, janela: j });
  }

  /* Investimento sai em paralelo com a TAP: são serviços diferentes, um não
     rouba orçamento do outro. Falha de Meta NÃO derruba a matriz — o payback
     vira "sem investimento" e o resto da resposta segue inteiro. */
  const token = process.env.META_ACCESS_TOKEN;
  const contasMeta = CONTAS_META[expert] || null;
  const investimentoPromise = (token && contasMeta)
    ? buscarInvestimento(contasMeta, gran, janelas[0].de,
                         janelas[janelas.length - 1].ateExcl, token, ateQuando)
    : Promise.resolve(null);

  const [respostas, investimentoPorPeriodo] = await Promise.all([
    comLimite(
      pedidos.map(p => () => lerJanela(p.btag, p.janela.de, p.janela.ateExcl,
                                       chave, ateQuando)),
      CONCORRENCIA
    ),
    investimentoPromise
  ]);

  /* Leitura que falhou não pode virar zero na matriz: uma janela que a TAP
     recusou apareceria como "a safra não gerou nada", que é o oposto de "não
     sei". Se faltar qualquer janela, a resposta inteira é um erro honesto. */
  const falhas = [];
  const leituras = [];
  respostas.forEach(function (linhas, i) {
    if (linhas === null) { falhas.push(pedidos[i].janela.chave); return; }
    leituras.push({ chave: pedidos[i].janela.chave, linhas: linhas });
  });

  if (falhas.length) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(502).json({
      error: 'tap_indisponivel',
      detail: 'A TAP não respondeu ' + falhas.length + ' de ' + pedidos.length +
              ' leituras. Costuma ser limite de chamadas — tentar de novo em ' +
              'alguns segundos resolve.',
      meses_falhos: Array.from(new Set(falhas)).sort()
    });
  }

  const safras = montar(leituras, periodos, indicePeriodo);

  /* investimento e payback safra a safra — depois da matriz pronta porque o
     fator de decaimento é estimado dela inteira */
  const temInvestimento = investimentoPorPeriodo !== null;
  const fator = estimarFator(safras);
  for (const s of safras) {
    const inv = temInvestimento ? (investimentoPorPeriodo[s.mes] || 0) : null;
    s.investimento = inv == null ? null : Math.round(inv * 100) / 100;
    let ggrAcum = 0, depAcum = 0;
    for (const c of s.celulas) { ggrAcum += c.ggr; depAcum += c.net_dep; }
    s.retorno = {
      ggr: Math.round(ggrAcum * 100) / 100,
      net_dep: Math.round(depAcum * 100) / 100
    };
    s.payback = calcularPayback(s, s.investimento, fator, gran);
  }

  /* A matriz muda devagar: período fechado não muda mais, e o corrente só anda
     conforme o dia passa. Meia hora de borda tira o peso das chamadas de
     TAP+Meta de cima de cada abertura de painel; o stale-while-revalidate
     garante que ninguém espera pela revalidação. */
  res.setHeader('Cache-Control',
    'public, max-age=0, s-maxage=1800, stale-while-revalidate=86400');
  return res.status(200).json({
    escopo: escopo,
    expert: expert,
    btags: btags,
    gran: gran,
    desde: gran === 'semana' ? periodos[0] : DESDE,
    hoje: gran === 'semana' ? segundaDe(hoje) : mesCorrente(),
    metrica: 'net_pl',
    investimento_disponivel: temInvestimento,
    fator_decaimento: Math.round(fator * 100) / 100,
    safras: safras
  });
};
