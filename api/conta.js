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
 * ── O FUNIL REAL, CAMPANHA A CAMPANHA (15/08) ────────────────────────────
 * O Gerenciador conta o que o PIXEL viu; a casa conta o que o jogador fez.
 * Os dois discordam sempre, e é o segundo que paga. Esta rota agora puxa
 * também o relatório da TAP agrupado por `utm_campaign` e casa linha a linha
 * com a campanha do Meta — daí saem cadastro, FTD de verdade, depósito, net
 * dep e o CUSTO REAL por FTD (verba do Meta ÷ FTD da casa). É esse número que
 * decide escala, não o CPA do pixel.
 *
 * Variáveis de ambiente obrigatórias no projeto Vercel:
 *   META_ACCESS_TOKEN   (mesmo token de sistema que o n8n usa)
 *   TAP_API_KEY         (mesma chave do BO da afiliação que o n8n guarda)
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

/* ── FUNIL DA CASA (TAP / Smartico) ───────────────────────────────────────
   O relatório `af2_media_report_op` com `group_by=utm_campaign` devolve, por
   valor de UTM, o funil inteiro: visita, cadastro, FTD, depósito, net dep e
   comissão. É o mesmo endpoint que o n8n usa pro funil do expert — a
   diferença é que aqui ele vem QUEBRADO por campanha, e é isso que permite
   dizer "esta campanha custa R$ 183 por FTD de verdade e aquela R$ 426".

   Três armadilhas medidas na API, todas silenciosas:

   1. DATA INVÁLIDA NÃO DÁ ERRO — devolve o relatório da vida inteira, do
      operador inteiro (22 mil cadastros). O período aqui já vem validado pelo
      handler; se um dia alguém afrouxar aquela validação, esta rota passa a
      mentir sem avisar.
   2. `date_to` é EXCLUSIVO (é o que o n8n faz: `date_ate_exclusive`). Passar
      o último dia do recorte perde o dia inteiro.
   3. ESTOURO DE CHAMADA VEM COM HTTP 200, corpo `{"errCode":3}`. Por isso
      toda resposta é conferida como array antes de somar — e conta com 5
      btags (a compartilhada do Gabriel) vai em lote de 3.
   ────────────────────────────────────────────────────────────────────────── */

const TAP_URL = 'https://boapi3.smartico.ai/api/af2_media_report_op';
const TAP_LOTE = 3;

/* Conta de anúncio → btag(s) do BO. A FONTE DE VERDADE é o nó `Montar
   entidades Geral` / `Montar experts` dos workflows do painel; esta cópia
   existe porque o payload do n8n não carrega btag e esta rota não passa por
   ele. Conta fora do mapa não fica quebrada: ela cai no padrão de nome
   ("CA - NOME - 12345", o mesmo que o n8n usa pra descobrir conta nova
   sozinho) e, se nem isso, a janela abre sem o bloco de funil.

   A 989562184047728 é COMPARTILHADA (Ederson, Deko, Charles, QZL) e por isso
   tem 5 btags: o casamento é por UTM da campanha, então juntar os relatórios
   dos 5 não mistura nada — cada campanha só aparece no btag dela. */
const BTAG_POR_CONTA = {
  '897476669429623':   ['537615'],   /* COSTA E LOBAO   */
  '1997624391048176':  ['539199'],   /* PEDRO FOOTBALL  */
  '1517002369929477':  ['505716'],   /* FELIPE BORGES   */
  '965568832979022':   ['505716'],   /* FELIPE BORGES 2 */
  '1350047622999139':  ['543714'],   /* PR TIPSTER      */
  '1608680367486969':  ['545056'],   /* LEO FREITAS     */
  '1504234301191468':  ['505209'],   /* CAIO TIPS       */
  '809590885250558':   ['532538'],   /* ZECA            */
  '1538558644947601':  ['543378'],   /* NATHAN ROSENO   */
  '2020228565251138':  ['508799'],   /* SHELGUIMA       */
  '3602839156558626':  ['542954'],   /* DIEGO LUGO      */
  '1318099683822304':  ['544076'],   /* JOTA PE         */
  '1677889643448352':  ['544076'],   /* JOTA PE         */
  '3432194193613959':  ['544076'],   /* JOTA PE         */
  '27620008490951770': ['544076'],   /* JOTA PE         */
  '1375513147862272':  ['537874'],   /* INSTITUCIONAL   */
  '4369472913294852':  ['537874'],
  '566433646393570':   ['537874'],
  '4491460707782665':  ['537874'],   /* CA 04           */
  '1007454048772455':  ['537874'],
  '1364418892488854':  ['537874'],
  '1689900502296830':  ['537874'],
  '3841440682664482':  ['537874'],
  '1662336521647121':  ['537874'],
  '2474915826342866':  ['537874'],
  '1344546561194352':  ['537680'],   /* REINAN TIPS     */
  '2124508238097600':  ['548109'],   /* ICARO           */
  '1047677338184825':  ['548110'],   /* GIOVANNI ROLETA */
  '1362893448699965':  ['548058'],   /* HENRIQUE 500K   */
  '1036518365963855':  ['548592'],   /* GEGE ROLETA     */
  '1044864454792358':  ['547573'],   /* TALYSON         */
  '1690283185195699':  ['544991'],   /* TANOS           */
  '1018864441147274':  ['544991'],   /* TANOS roleta    */
  '1970560716829162':  ['541420', '474243'],  /* DEKO roleta */
  '898597209986158':   ['546470'],   /* GREGORIO BIG    */
  '989562184047728':   ['541420', '474243', '538384', '546473', '542346']
};

/* Mesmo padrão do n8n: conta nova da BM nasce com o btag no próprio nome. */
const PADRAO_NOME_BTAG = /^CA\s*-\s*[^[\]]+?\s*-\s*(?:ID\s*)?(\d{4,})\s*$/i;

function btagsDaConta(id, nomeConta) {
  if (BTAG_POR_CONTA[id]) return BTAG_POR_CONTA[id];
  const m = PADRAO_NOME_BTAG.exec(String(nomeConta || '').trim());
  return m ? [m[1]] : [];
}

function maisUmDia(iso) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/* Chave de casamento entre a UTM da TAP e o nome da campanha no Meta.
   Três coisas separam as duas pontas e todas apareceram no dado real:
   · a MESMA campanha chega em duas linhas, uma decodificada e outra ainda
     form-encoded (`FB+-+AQ+-+12.08...`, `%2C` no lugar da vírgula) — sem
     juntar as duas, a visita fica partida ao meio;
   · o nome carrega ESPAÇO DUPLO ("12.08  - AQUISICAO") que o HTML engole na
     tela, então o que se vê nunca bate caractere a caractere;
   · maiúscula/minúscula varia.
   O `+` só vira espaço quando a string não tem nenhum espaço de verdade —
   senão um nome de campanha com "+" literal seria mutilado. */
function normUtm(s) {
  let t = String(s == null ? '' : s);
  if (t.indexOf('+') >= 0 && !/\s/.test(t)) t = t.replace(/\+/g, ' ');
  if (t.indexOf('%') >= 0) { try { t = decodeURIComponent(t); } catch (e) { /* fica como veio */ } }
  return t.replace(/\s+/g, ' ').trim().toLowerCase();
}

const CAMPOS_FUNIL = [
  ['visitas', 'visit_count'],
  ['cadastros', 'registration_count'],
  ['ftd', 'ftd_count'],
  ['valor_ftd', 'ftd_total'],
  ['depositos', 'deposit_count'],
  ['deposito', 'deposit_total'],
  ['net_dep', 'net_deposits'],
  ['net_pl', 'net_pl'],
  ['comissao', 'commissions_total'],
  ['volume', 'volume']
];

function funilZero() {
  const f = Object.create(null);
  CAMPOS_FUNIL.forEach((c) => { f[c[0]] = 0; });
  return f;
}

function somarFunil(dest, linha) {
  CAMPOS_FUNIL.forEach((c) => { dest[c[0]] += num(linha[c[1]]) || 0; });
  return dest;
}

/* Devolve { linhas: {utmNormalizada: funil}, erro: null } ou { erro: '...' }.
   Nunca lança: funil é enriquecimento — se a TAP cair, a janela continua
   respondendo o que o Gerenciador diz. */
async function tapPorUtm(btags, de, ate, signal) {
  if (!btags.length) return { linhas: null, erro: 'sem_btag' };
  const chave = process.env.TAP_API_KEY;
  if (!chave) return { linhas: null, erro: 'sem_chave' };

  const ateExclusivo = maisUmDia(ate);
  const linhas = Object.create(null);
  let leu = 0;

  for (let i = 0; i < btags.length; i += TAP_LOTE) {
    const lote = btags.slice(i, i + TAP_LOTE);
    const respostas = await Promise.all(lote.map(async (btag) => {
      const url = new URL(TAP_URL);
      url.searchParams.set('date_from', de);
      url.searchParams.set('date_to', ateExclusivo);
      url.searchParams.set('affiliate_id', btag);
      url.searchParams.set('group_by', 'utm_campaign');
      const r = await fetch(url.toString(), {
        signal,
        headers: { accept: 'application/json', authorization: chave }
      });
      const j = await r.json().catch(() => null);
      /* HTTP 200 com errCode é o jeito da TAP dizer "chega de chamada". Ler
         isso como resposta vazia é o bug que já zerou funil de expert. */
      if (!j || !Array.isArray(j.data)) return null;
      return j.data;
    }));

    respostas.forEach((data) => {
      if (!data) return;
      leu++;
      data.forEach((r) => {
        const k = normUtm(r && r.utm_campaign);
        if (!linhas[k]) linhas[k] = funilZero();
        somarFunil(linhas[k], r);
      });
    });
  }

  if (!leu) return { linhas: null, erro: 'tap_indisponivel' };
  return { linhas: linhas, erro: null };
}

/* Casa cada linha da TAP com UMA campanha do Meta. Exato primeiro; depois
   prefixo, que é o que pega as variantes que a Meta cria sozinha (" — Cópia",
   " 001"). Prefixo mais longo ganha, senão uma campanha nova cujo nome começa
   igual ao de outra roubaria o funil da irmã.
   O que sobra é tão informativo quanto o que casa, e por isso volta separado:
   · `sem_utm`   — visita que chegou sem utm_campaign nenhuma (link fora do Meta);
   · `macro_crua`— chegou com `{{campaign.name}}` literal: a macro não foi
                   substituída, e esse tráfego está órfão de campanha;
   · `outras`    — UTM de campanha que não está mais rodando (o jogador voltou
                   por um link antigo). Não é erro: é depósito de safra velha. */
function casarFunil(campanhas, linhas) {
  const porChave = [];
  campanhas.forEach((c) => {
    const k = normUtm(c.nome);
    if (k) porChave.push({ chave: k, camp: c });
  });
  porChave.sort((a, b) => b.chave.length - a.chave.length);

  const naoAtribuido = { sem_utm: funilZero(), macro_crua: funilZero(), outras: funilZero() };
  const total = funilZero();

  Object.keys(linhas).forEach((k) => {
    const f = linhas[k];
    let dono = null;
    for (let i = 0; i < porChave.length; i++) {
      if (k === porChave[i].chave || k.indexOf(porChave[i].chave) === 0) { dono = porChave[i].camp; break; }
    }
    if (dono) {
      if (!dono.funil) { dono.funil = funilZero(); dono.funil.utms = []; }
      CAMPOS_FUNIL.forEach((c) => { dono.funil[c[0]] += f[c[0]]; });
      CAMPOS_FUNIL.forEach((c) => { total[c[0]] += f[c[0]]; });
      dono.funil.utms.push(k);
      return;
    }
    const balde = k === '' ? 'sem_utm' : (k.indexOf('{{') === 0 ? 'macro_crua' : 'outras');
    CAMPOS_FUNIL.forEach((c) => { naoAtribuido[balde][c[0]] += f[c[0]]; });
  });

  campanhas.forEach((c) => {
    if (!c.funil) return;
    c.funil.custo_por_ftd = c.funil.ftd > 0 ? c.gasto / c.funil.ftd : null;
    c.funil.custo_por_cadastro = c.funil.cadastros > 0 ? c.gasto / c.funil.cadastros : null;
    c.funil.conversao = c.funil.cadastros > 0 ? (c.funil.ftd / c.funil.cadastros) * 100 : null;
    c.funil.ticket_ftd = c.funil.ftd > 0 ? c.funil.valor_ftd / c.funil.ftd : null;
  });

  return { total: total, nao_atribuido: naoAtribuido };
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

/* Leitura de UM nó (não de uma coleção): a Graph devolve o objeto direto, sem
   `data`, então não dá pra reaproveitar graph() acima. Nunca lança — serve só
   pra descobrir o btag pelo nome da conta, e nome faltando não pode derrubar
   a janela inteira. */
async function graphUm(caminho, params, token, signal) {
  try {
    const url = new URL(GRAPH + caminho);
    Object.keys(params).forEach((k) => url.searchParams.set(k, params[k]));
    url.searchParams.set('access_token', token);
    const r = await fetch(url.toString(), { signal, headers: { accept: 'application/json' } });
    const j = await r.json().catch(() => null);
    return j && !j.error ? j : null;
  } catch (e) { return null; }
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
    /* capacidade = o que ela PODERIA ter gasto no recorte; ociosa = o que
       sobrou. Com custo real bom, essa sobra é a conta mais importante da
       tela: é FTD barato que deixou de ser comprado. */
    capacidade: capacidade,
    verba_ociosa: (capacidade != null && capacidade > gasto) ? capacidade - gasto : 0,
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
   Quem abre esta janela está com a mão no botão de orçamento. A tabela sozinha
   não decide nada — a frase decide.

   A REGRA MUDOU EM 15/08, e a razão vale mais que a regra: entrega travada
   NÃO é problema, é sintoma. Se o custo real está bom, entrega baixa é a
   melhor notícia da tela — é FTD barato que ficou na mesa por falta de lance,
   e a ação é DESTRAVAR pra comprar mais. Se o custo real está ruim, entrega
   travada é o que está segurando o prejuízo, e destravar é acelerar no
   sentido errado. A mesma barra vermelha, dois vereditos opostos.

   Antes o painel lia só a entrega e mandava "destravar antes" numa campanha
   que entregava FTD a R$ 179 com alvo de R$ 300 — leitura que fazia o gestor
   duvidar do painel, com razão.

   Então o cruzamento é CUSTO REAL × ENTREGA, nesta ordem:
     custo bom  + entrega cheia   → escala por orçamento
     custo bom  + entrega travada → DESTRAVA (e a sobra vira FTD estimado)
     custo ruim + entrega travada → não destrava; arruma criativo/oferta antes
     custo ruim + entrega cheia   → não escala
   `alvo` é o CPA que o gestor definiu na tela (localStorage). Sem alvo o
   painel não fala de custo: não inventa meta que o negócio não deu.
   ────────────────────────────────────────────────────────────────────────── */
function moeda(v) {
  return 'R$ ' + (Math.round(v * 100) / 100).toFixed(2).replace('.', ',')
    .replace(/\B(?=(\d{3})+(?!\d)(?=,))/g, '.');
}
function vereditoLinha(l, alvo) {
  /* Campanha ligada que não gastou um real é informação, não ruído: ou o
     conjunto está sem entrega, ou ficou sem público, ou o lance não paga o
     leilão. Antes ela nem aparecia na tabela. */
  if (l.gasto === 0) {
    return { tom: 'neutro', acao: 'Não gastou',
      txt: 'Está ativa e não gastou nada no período — confira entrega do ' +
        'conjunto, público e lance.' };
  }
  if (l.gasto < GASTO_MIN_VEREDITO) {
    return { tom: 'neutro', acao: 'Sem amostra',
      txt: 'Gasto baixo demais no período pra afirmar qualquer coisa.' };
  }
  /* Quando a casa respondeu, é ELA que manda: o pixel pode contar 6 compras
     que a TAP não reconhece como FTD. Zero FTD com verba relevante é o
     veredito mais caro da tela, e o pixel não tem direito de suavizá-lo. */
  if (l.funil && l.funil.ftd === 0) {
    return { tom: 'ruim', acao: 'Não escalar',
      txt: 'Queimou R$ ' + l.gasto.toFixed(2).replace('.', ',') +
        ' e a casa não registrou nenhum FTD no período' +
        (l.resultado > 0 ? ' (o pixel conta ' + l.resultado + ').' : '.') };
  }
  if (!l.funil && l.resultado === 0) {
    return { tom: 'ruim', acao: 'Não escalar',
      txt: 'Queimou R$ ' + l.gasto.toFixed(2).replace('.', ',') +
        ' sem nenhum resultado no período.' };
  }
  /* Custo que vale é o REAL (verba ÷ FTD da casa). O do pixel entra só quando
     não existe funil pra esta campanha — e aí a frase diz de onde veio. */
  const real = !!(l.funil && l.funil.custo_por_ftd != null);
  const custo = real ? l.funil.custo_por_ftd : l.custo_por_resultado;
  const travada = l.entrega != null && l.entrega < ENTREGA_LIMITADA;
  const pctEntrega = travada ? Math.round(l.entrega * 100) + '%' : null;
  const porQue = l.estrategia === 'LOWEST_COST_WITH_BID_CAP'
    ? 'o teto de lance é o gargalo'
    : 'está limitada por leilão, não por verba';
  const rotuloCusto = real
    ? 'FTD real a ' + moeda(custo)
    : 'CPA de pixel de ' + moeda(custo);

  /* Quanto a sobra viraria, no custo que ESTA campanha já pratica. É a conta
     que transforma "entregou 41%" em decisão: não é um alerta, é uma fila de
     FTD esperando lance. */
  const sobra = l.verba_ociosa || 0;
  const ftdNaMesa = (custo != null && custo > 0 && sobra > 0) ? Math.floor(sobra / custo) : 0;

  const custoBom = alvo != null && custo != null && custo <= alvo;
  const custoRuim = alvo != null && custo != null && custo > alvo;

  if (custoRuim) {
    return travada
      ? { tom: 'atencao', acao: 'Não destravar',
          txt: 'Entregou ' + pctEntrega + ' e o ' + rotuloCusto + ' já está acima do alvo de ' +
            moeda(alvo) + '. A trava está segurando prejuízo — destravar aqui compra ' +
            'FTD caro. Mexa em criativo, público ou oferta primeiro.' }
      : { tom: 'ruim', acao: 'Não escalar',
          txt: rotuloCusto + ', acima do alvo de ' + moeda(alvo) +
            (real ? ' (' + l.funil.ftd + ' FTD na casa).' : '.') };
  }

  if (travada) {
    /* Custo bom e entrega travada: o melhor negócio da tela. */
    if (custoBom) {
      return { tom: 'bom', acao: 'Destrave e escale',
        txt: rotuloCusto + ', dentro do alvo de ' + moeda(alvo) + ' — e mesmo assim entregou só ' +
          pctEntrega + ' do orçamento: ' + porQue + '. Sobraram ' + moeda(sobra) +
          (ftdNaMesa > 0 ? ', que nesse custo dariam ~' + ftdNaMesa + ' FTD' : '') +
          '. Suba o lance (ou tire o teto) antes de mexer no orçamento — verba nova aqui não vira gasto.' };
    }
    return { tom: 'atencao', acao: 'Destravar antes',
      txt: 'Entregou só ' + pctEntrega + ' do orçamento: ' + porQue +
        '. Subir verba não muda o gasto' +
        (alvo == null ? ' — e sem CPA alvo o painel não julga se vale a pena destravar.' : '.') };
  }

  if (l.frequencia != null && l.frequencia >= FREQ_SATURADA) {
    return { tom: 'atencao', acao: 'Público cansado',
      txt: 'Frequência em ' + l.frequencia.toFixed(1) + '×. Escalar aqui sobe o custo — ' +
        'renove criativo ou abra público antes.' };
  }

  const folga = l.frequencia != null && l.frequencia < FREQ_FOLGA;
  return { tom: 'bom', acao: 'Pode escalar',
    txt: 'Entrega cheia' + (folga ? ', público longe de saturar' : '') +
      (custoBom ? ' e ' + rotuloCusto + ' dentro do alvo' : '') +
      '. Aqui o orçamento é o limite: pode subir.' };
}

/* Veredito da CONTA: não é a soma dos vereditos, é a leitura do dinheiro
   parado. "Tem R$ 4.150/dia de orçamento que ninguém está conseguindo gastar"
   é a informação que muda a decisão do dia. */
function vereditoConta(campanhas, alvo, funilTotal) {
  const comGasto = campanhas.filter((c) => c.gasto > 0);
  /* "Ativa" passou a ser o STATUS, não "gastou alguma coisa". A conta dizia
     "4 campanhas ativas" contando uma pausada que tinha gasto no começo do
     período — e a frase do gargalo saía com denominador errado. */
  const ativas = campanhas.filter((c) => c.status === 'ACTIVE');
  const gasto = comGasto.reduce((s, c) => s + c.gasto, 0);
  const capacidade = ativas.reduce((s, c) => s + (c.orcamento_dia || 0), 0);
  const resultado = comGasto.reduce((s, c) => s + (c.resultado || 0), 0);
  const ociosas = comGasto.filter((c) => c.entrega != null && c.entrega < ENTREGA_LIMITADA);

  const f = funilTotal || null;
  const gastoAtribuido = campanhas.reduce((s, c) => s + (c.funil ? c.gasto : 0), 0);
  return {
    gasto: gasto,
    orcamento_dia: capacidade || null,
    resultado: resultado,
    custo_por_resultado: resultado > 0 ? gasto / resultado : null,
    campanhas_ativas: ativas.length,
    campanhas_com_gasto: comGasto.length,
    campanhas_paradas: ativas.filter((c) => c.gasto === 0).length,
    campanhas_limitadas: ociosas.length,
    pode_escalar: comGasto.filter((c) => vereditoLinha(c, alvo).tom === 'bom').length,
    /* As travadas que estão BARATAS: é aqui que mora o dinheiro fácil da
       conta, e a frase do topo tem que começar por elas. */
    destravar_barato: comGasto.filter((c) => vereditoLinha(c, alvo).acao === 'Destrave e escale').length,
    verba_ociosa: ociosas.reduce((s, c) => s + (c.verba_ociosa || 0), 0),
    verba_ociosa_barata: comGasto.reduce((s, c) =>
      s + (vereditoLinha(c, alvo).acao === 'Destrave e escale' ? (c.verba_ociosa || 0) : 0), 0),
    /* Funil só das campanhas que casaram por UTM — e o custo real divide a
       verba DESSAS campanhas, não a da conta inteira. Misturar o gasto de uma
       campanha sem UTM no numerador barateia o FTD de graça. */
    funil: f ? {
      cadastros: f.cadastros, ftd: f.ftd, valor_ftd: f.valor_ftd,
      deposito: f.deposito, net_dep: f.net_dep, comissao: f.comissao,
      visitas: f.visitas,
      gasto_atribuido: gastoAtribuido,
      custo_por_ftd: f.ftd > 0 ? gastoAtribuido / f.ftd : null,
      custo_por_cadastro: f.cadastros > 0 ? gastoAtribuido / f.cadastros : null,
      conversao: f.cadastros > 0 ? (f.ftd / f.cadastros) * 100 : null
    } : null
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

  /* A TAP sai JUNTO com a Graph quando a conta está no mapa — que é o caso de
     todas as 36 hoje. Só quem depende do nome da conta pra descobrir o btag
     precisa esperar a Graph responder primeiro. */
  const btagsMapa = BTAG_POR_CONTA[conta] || null;
  const tapCedo = btagsMapa
    ? tapPorUtm(btagsMapa, de, ate, ctrl.signal).catch(() => ({ linhas: null, erro: 'tap_falhou' }))
    : null;

  try {
    /* Cinco chamadas em paralelo (quatro na Graph + o nome da conta, que é o
       que descobre o btag de conta nova sem mexer no mapa). Sequencial seria
       vezes mais lento e a pessoa está esperando um modal abrir. */
    const [campEnt, campIns, setEnt, setIns, contaEnt] = await Promise.all([
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
      }, token, ctrl.signal),
      graphUm(act, { fields: 'name' }, token, ctrl.signal)
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
      .filter((l) => l.gasto > 0);

    /* Campanha ATIVA que não gastou nada no período também entra. Antes ela
       simplesmente não existia na tela — e "ligada há três dias sem gastar um
       real" é justamente o que ninguém percebe olhando só quem gastou. */
    const jaTem = Object.create(null);
    campanhas.forEach((c) => { if (c.id) jaTem[c.id] = true; });
    campEnt.forEach((e) => {
      if (!e || e.effective_status !== 'ACTIVE' || jaTem[e.id]) return;
      campanhas.push(montarLinha(e, null, diasEntrega));
    });

    campanhas.sort((a, b) => b.gasto - a.gasto);

    /* O funil da casa entra ANTES do veredito: é o custo real por FTD que
       decide escala, e o veredito lê `c.funil`. */
    const btags = btagsMapa || btagsDaConta(conta, contaEnt && contaEnt.name);
    const tap = await (tapCedo ||
      tapPorUtm(btags, de, ate, ctrl.signal).catch(() => ({ linhas: null, erro: 'tap_falhou' })));
    const casamento = tap.linhas ? casarFunil(campanhas, tap.linhas) : null;

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
      resumo: vereditoConta(campanhas, alvo, casamento && casamento.total),
      /* De onde veio (ou por que não veio) o funil. A tela precisa saber a
         diferença entre "zero FTD" e "não consegui perguntar" — são leituras
         opostas e o painel não pode desenhar as duas do mesmo jeito. */
      funil_fonte: {
        ok: !!casamento,
        btags: btags,
        motivo: tap.erro || null,
        nao_atribuido: casamento ? casamento.nao_atribuido : null
      },
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
