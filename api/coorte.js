/**
 * COORTE DE FTD — GGR mês a mês, por safra de primeiro depósito.
 *
 * A pergunta: "a turma que depositou pela primeira vez em junho gerou quanto em
 * junho, em julho, em agosto? E quantos daqueles jogadores ainda estavam vivos
 * em cada um desses meses?"
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
 * devolve o net_pl de CADA JOGADOR DENTRO DO PERÍODO pedido. Um mês por
 * chamada, e o GGR mensal cai pronto.
 *
 * E a safra sai do próprio relatório: no mês em que o jogador tem
 * `ftd_count > 0`, ele nasce. Isso dispensa `af2_regs_op` por completo — e
 * ainda é MAIS completo que ele, porque pega quem se cadastrou antes da janela
 * varrida e só foi depositar depois (conferido: 818 contra 816 numa safra).
 *
 * ─── DEFINIÇÕES (a regra de negócio, escrita onde ela é aplicada) ───────────
 *   safra      mês do PRIMEIRO depósito. O jogador entra numa safra e fica
 *              nela pra sempre — depósito novo NÃO cria safra nova.
 *   M0,M1,M2   idade da safra em meses de calendário, não em dias:
 *              M0 é o próprio mês do FTD, M1 o seguinte. FTD em 31/05 com
 *              atividade em 01/06 é M1, mesmo com um dia de diferença.
 *   GGR        `net_pl` do mês (na TAP, net_pl = pl = netwin quando não há
 *              bônus). NÃO é acumulado: cada célula é só aquele mês.
 *   ativos     jogadores DISTINTOS da safra com atividade no mês (apostou ou
 *              moveu GGR). Cai com o tempo — é a retenção da turma.
 *   jogadores  tamanho da safra: quantos fizeram FTD naquele mês.
 *
 * ─── TRÊS ESTADOS DE CÉLULA, que não podem se confundir ─────────────────────
 *   fechado   mês que já acabou. Valor definitivo.
 *   parcial   mês corrente. O valor ainda sobe — vem com `parcial: true`.
 *   futuro    mês que nem começou. NÃO VEM NO JSON. Zero seria mentira: uma
 *             safra que não gerou nada e uma que ainda não teve tempo de
 *             gerar são coisas diferentes, e a tela precisa distinguir.
 *
 * Variável de ambiente obrigatória no projeto Vercel:
 *   TAP_API_KEY          (mesma chave do BO da afiliação que o n8n usa)
 *   PAINEL_CL_SENHA      (só pro escopo costa_lobao; ver api/cl-auth.js)
 */

const TAP_URL = 'https://boapi3.smartico.ai/api/af2_media_report_op';

/* Primeiro mês com operação que vale a pena olhar — o mesmo SAFRA_DESDE do
   workflow do n8n, pra que as duas leituras falem do mesmo pedaço de história. */
const DESDE = '2025-10';

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

/* ── Uma leitura da TAP: um btag, um mês ────────────────────────────────────
   Devolve a lista de jogadores com o que cada um moveu DENTRO do mês. */
async function lerMes(btag, ym, chave, ateQuando) {
  const url = new URL(TAP_URL);
  url.searchParams.set('date_from', ym + '-01');
  url.searchParams.set('date_to', limiteDoMes(ym));
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
         "mês sem movimento" é o bug que já zerou funil de expert no painel —
         por isso a resposta só vale se `data` for array de verdade. */
      if (corpo && Array.isArray(corpo.data)) return corpo.data;
    } catch (e) {
      /* rede/timeout: cai no backoff abaixo */
    }
    await new Promise(ok => setTimeout(ok, BACKOFF_BASE_MS * Math.pow(2, tentativa)));
  }
  return null;   /* leitura FALHA — não é o mesmo que mês vazio */
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

/* ── O cálculo ──────────────────────────────────────────────────────────────
   Duas passadas sobre a mesma leitura:
     1ª  descobre em que mês cada jogador fez o FTD  -> a safra dele
     2ª  joga o GGR de cada mês na célula [safra][idade]
   A segunda passada precisa do mapa completo da primeira: um jogador aparece no
   relatório de agosto, mas a safra dele pode ter nascido em outubro. */
function montar(leituras, meses, hoje) {
  const safraDoJogador = {};
  for (const { ym, linhas } of leituras) {
    for (const r of linhas) {
      const rid = r.registration_id ? String(r.registration_id) : '';
      if (!rid || !(Number(r.ftd_count) || 0)) continue;
      /* o primeiro depósito é o PRIMEIRO: se o jogador aparecer com ftd_count
         em dois meses (correção retroativa da casa), vale o mais antigo */
      if (!safraDoJogador[rid] || ym < safraDoJogador[rid]) safraDoJogador[rid] = ym;
    }
  }

  const tamanho = {};                 /* safra -> quantos fizeram FTD nela */
  for (const rid in safraDoJogador) {
    const s = safraDoJogador[rid];
    tamanho[s] = (tamanho[s] || 0) + 1;
  }

  const celulas = {};                 /* "safra|idade" -> { ggr, ativos } */
  for (const { ym, linhas } of leituras) {
    for (const r of linhas) {
      const rid = r.registration_id ? String(r.registration_id) : '';
      const safra = safraDoJogador[rid];
      if (!safra) continue;           /* jogador que nunca depositou: sem safra */
      const idade = ordinal(ym) - ordinal(safra);
      if (idade < 0) continue;        /* atividade ANTES do FTD não é da safra */

      const ggr = Number(r.net_pl) || 0;
      const ops = Number(r.operations) || 0;
      const k = safra + '|' + idade;
      if (!celulas[k]) celulas[k] = { ggr: 0, ativos: 0 };
      celulas[k].ggr += ggr;
      /* ATIVO É JOGADOR DISTINTO, não transação: a TAP já entrega uma linha por
         jogador dentro do mês, então basta não contar quem ficou parado. */
      if (ops > 0 || ggr !== 0) celulas[k].ativos += 1;
    }
  }

  const ordHoje = ordinal(hoje);
  const safras = Object.keys(tamanho).sort().map(function (mes) {
    const idadeMax = ordHoje - ordinal(mes);
    const linha = { mes: mes, jogadores: tamanho[mes], celulas: [] };
    for (let i = 0; i <= idadeMax; i++) {
      /* MÊS FUTURO NÃO ENTRA — o laço já para na idade de hoje. Célula que
         existe e está zerada é GGR zero de verdade: a turma teve o mês e não
         gerou nada. As duas coisas não podem virar a mesma coisa na tela. */
      const c = celulas[mes + '|' + i] || { ggr: 0, ativos: 0 };
      const mesRef = deOrdinal(ordinal(mes) + i);
      linha.celulas.push({
        idade: i,
        mes_ref: mesRef,
        ggr: Math.round(c.ggr * 100) / 100,
        ativos: c.ativos,
        parcial: mesRef === hoje    /* mês corrente: o número ainda sobe */
      });
    }
    return linha;
  });

  return { safras: safras, meses_lidos: meses.length };
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

  const hoje = mesCorrente();
  const meses = [];
  for (let o = ordinal(DESDE); o <= ordinal(hoje); o++) meses.push(deOrdinal(o));

  const ateQuando = Date.now() + ORCAMENTO_MS;
  const pedidos = [];
  for (const btag of btags) {
    for (const ym of meses) {
      pedidos.push({ btag: btag, ym: ym });
    }
  }

  const respostas = await comLimite(
    pedidos.map(p => () => lerMes(p.btag, p.ym, chave, ateQuando)),
    CONCORRENCIA
  );

  /* Leitura que falhou não pode virar zero na matriz: um mês que a TAP recusou
     apareceria como "a safra não gerou nada", que é o oposto de "não sei". Se
     faltar qualquer mês, a resposta inteira é um erro honesto. */
  const falhas = [];
  const leituras = [];
  respostas.forEach(function (linhas, i) {
    if (linhas === null) { falhas.push(pedidos[i].ym); return; }
    leituras.push({ ym: pedidos[i].ym, linhas: linhas });
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

  const dados = montar(leituras, meses, hoje);

  /* A matriz muda devagar: mês fechado não muda mais, e o mês corrente só anda
     conforme o dia passa. Meia hora de borda tira o peso das 11+ chamadas de
     TAP de cima de cada abertura de painel; o stale-while-revalidate garante
     que ninguém espera pela revalidação. */
  res.setHeader('Cache-Control',
    'public, max-age=0, s-maxage=1800, stale-while-revalidate=86400');
  return res.status(200).json({
    escopo: escopo,
    expert: expert,
    btags: btags,
    desde: DESDE,
    hoje: hoje,
    metrica: 'net_pl',
    safras: dados.safras
  });
};
