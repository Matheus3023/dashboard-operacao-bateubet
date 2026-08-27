## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).

## Login Google (26/08)

O painel inteiro (páginas + `/api/*`, exceto `/api/push-spend` que é cron)
vive atrás de `middleware.js` (Edge) — só entra quem loga com conta Google
`@bateubet.com`. Substituiu o Basic Auth antigo (removido em 13/08,
`PAINEL_USUARIO`/`PAINEL_SENHA` inertes desde então).

- Projeto Google Cloud **separado** do `bateubet-ads-api` (que alimenta o
  Google Ads MCP) — de propósito, pra nunca mexer na tela de consentimento
  OAuth de quem já está em produção pro Ads. Projeto: `painel-bateubet-login`,
  tipo de público **Interno** (só contas do Workspace conseguem nem ver a
  tela de consentimento — trava mais forte que o `hd=` do request).
- Fluxo: `login.html` (tela) → `/api/auth/start` (redireciona pro Google) →
  `/api/auth/callback` (troca code por token, confere e-mail via
  `tokeninfo`, assina cookie `bateu_sessao` com HMAC) → `/api/auth/logout`
  (apaga o cookie).
- **Sessão DESLIZANTE, não fixa** (26/08, ajuste do Costa): cookie nasce com
  30min de validade. `index.html` chama `/api/auth/touch` a cada 5min
  (`renovarSessao()`) e cada chamada empurra o vencimento mais 30min pra
  frente — na prática dura "enquanto a aba ficar aberta e em uso". Sem
  toque (aba fechada, computador dormiu, rede caiu), o cookie vence sozinho
  e o próximo acesso cai no login. `HttpOnly`+`Secure`+`SameSite=Lax`.
  Chave do HMAC é `PAINEL_SESSAO_SEGREDO` — trocar essa env invalida toda
  sessão viva de uma vez (mesmo mecanismo do `PAINEL_CL_SENHA`). A fórmula
  de assinatura está DUPLICADA em três arquivos (middleware.js, api/auth/
  callback.js, api/auth/touch.js) — mudou uma, muda as três.
- `userbox` no topbar (`#userbox`) mostra o nome do Google (scope `profile`,
  guardado no cookie depois do `~` da assinatura, NUNCA assinado — é só
  exibição) + link "Sair". Vem de `/api/auth/me`, chamado uma vez no boot
  (`ligarUsuario()`); nunca decide se mostra o painel, só decora.
- Env vars obrigatórias na Vercel: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
  `PAINEL_SESSAO_SEGREDO`.

## Identidade visual: migração pra Estratégia de Marca (26/08)

O painel usava hex extraídos do CSS de `bateu.bet.br` (produto, ameixa
`#3B0038`/`#570433` + magenta `#E20266`). O documento formal de Estratégia de
Marca do cliente (`bateubet-estrategia-de-marca.pdf`) documenta que produto e
comunicação falam idiomas visuais diferentes hoje, e define a identidade de
**comunicação** (vinho `#4A0E2E→#0A0308` + magenta `#D81B60`/`#C2185B` +
dourado `#E8B23D`/`#D4AF37`) como a oficial pra qualquer entregável novo.
Costa confirmou migrar o painel pra essa (perguntado explicitamente antes,
por ser mudança de token usado em milhares de linhas).

- `:root` (index.html) trocado: `--bg/--surface/--surface-2/--surface-3/
  --surface-sunk/--acao/--acao-2/--acao-3/--gold/--gold-2` + todos os hex e
  rgba() fixos que dependiam deles (véu do body, topbar, badge dourado).
  **Intocado de propósito**: `--good/--warn/--bad` (são função, não marca) e
  `--grupo`/`--direto` (cor categórica de canal, documentado no próprio CSS).
- `fundo-marca.jpg` e `login-fundo.jpg` regenerados via Magnific na nova
  paleta (mesma composição/direção de foto, só recolorido: halo magenta no
  topo → vinho → quase preto, fio dourado fino).
- `login.html`: texto reduzido (Costa pediu "diminuir as informações da tela
  de acesso") — tirou parágrafo de domínio e rodapé separados, uma linha só
  ("Só com conta Google **@bateubet.com**").
- Typography (Avenir Next/Helvetica Neue da estratégia) NÃO aplicada ainda —
  o painel usa system font stack; entra se/quando o Costa pedir.

## Redesign de BI (26/08, em andamento por fase)

Pedido do Costa: elevar o painel a "BI moderno" (inspiração Stripe/Linear/
Power BI) sem trocar stack, sem inventar filtro pra conceito que não existe
no dado (nada de "Responsável"/"Status" genérico), sem fabricar número.
Antes de tocar em qualquer coisa, mapeei o que já existia — o painel já era
maduro (skeleton, estado vazio tratado, popover de filtro com select-all/
limpar, sparkline de CPA, textos narrativos automáticos por faixa) — então o
trabalho é ADITIVO, não reconstrução.

- **Fase 1 (feito, testado)**: botão "Limpar filtros" no topbar — só aparece
  quando período ≠ Hoje ou ordenação ≠ padrão (`filtrosForaDoPadrao()`).
  Clicar reidrata os dois e aciona os mesmos botões "Selecionar todos/todas"
  de cada popover com recorte ativo (`data-filtrando`) — não duplica estado.
- **Fase 2 (feito, testado em produção com dado real, 27/08)**: comparação
  com período anterior nos tiles-herói de "Totais da operação" (Investimento,
  Cadastros, FTD, Depósito, Net Dep, Net PL). Período anterior = mesmo nº de
  dias imediatamente antes do período em tela (regra única pra todo preset,
  `periodoAnteriorDe()`). Busca extra, encadeada DEPOIS do `carregar()`
  principal ter sucesso (`buscarPeriodoAnterior`) — nunca bloqueia, nunca
  aparece em `#erro-banner`, pulada em "Datas" (custom) pra não dobrar uma
  consulta de 30-40s sem pedido. Polaridade por métrica: investido é neutro
  (cinza, gastar mais não é bom/ruim), os outros 5 são "subiu = bom" — nunca
  verde/vermelho decorativo.
  **✅ BUG achado na QA visual e corrigido (27/08)**: `variacao()` dividia
  pelo valor cru de "antes" pra achar o percentual. Pra Net Dep/Net PL, que
  são legitimamente negativos boa parte do tempo (ex.: Net Dep de hoje é
  -R$53.441,56), isso dava dois problemas em produção — período anterior
  <= 0 fazia o selo de comparação sumir da tela em silêncio (guarda
  `antes <= 0` descartava a conta inteira), e se a guarda fosse só
  afrouxada uma melhora de net dep (-50k → -30k) apareceria pintada de
  vermelho como se tivesse piorado (dividir por base negativa inverte o
  sinal). Corrigido: direção (subiu/desceu/estável) vem sempre do diff cru
  (`depois - antes`), que não inverte perto do zero; só a magnitude do
  percentual usa `|antes|` como base. Pra métrica sempre positiva
  (investimento/cadastros/ftd/depósito/CPA/giro/retenção) o resultado é
  idêntico ao de antes, zero mudança de comportamento aí.
- **Esconder expert inativo >15 dias (feito, no ar em produção)**: campo
  novo `dias_sem_investimento` (por expert, em `experts[]`/`geral.experts[]`)
  calculado no n8n (`Dashboard Operação - Refresh Cache`, node **"Calcular
  Ultimo Investimento"**, lendo a tabela `dashboard_historico` INTEIRA, sem o
  teto de 7 dias do motor de tendência — de propósito ISOLADO dele, ver nota
  abaixo). `null` = sem histórico suficiente pra afirmar nada, front NUNCA
  trata como ativo nem inativo. `index.html`: `estaInativo()`/
  `pintarExperts()` escondem por padrão quem passou de 15 dias, com botão
  "Ver todos os experts" que aparece só quando existe alguém escondido
  (`estado.mostrarInativos`). Não apaga nada — o expert continua existindo
  em safra/comparativo/histórico, só o card de "Por expert" filtra.
  **Armadilha real corrigida**: a 1ª tentativa referenciava o node novo via
  `$('Calcular Ultimo Investimento')` dentro de `Montar JSON final` sem uma
  aresta real no grafo — com `executionOrder: v1` isso quebra
  ("node hasn't been executed"). Corrigido religando o node como 3ª entrada
  de `Merge Todos` (append, `numberInputs: 3`) com um marcador `_inatividade:
  true`, filtrado no começo de `Montar JSON final` antes de virar expert.
  Testado com `execute_workflow` (manual) antes de confiar: 51 experts (11
  CL + 40 Geral), nenhum passou de 15 dias ainda (histórico só existe desde
  ~07/08), nenhum campo existente mudou de valor.
  **Por que não reaproveitei o motor de tendência de 7 dias**: ele alimenta
  `analisarTendencia()`/recomendação de orçamento no painel de cada expert
  (divide a série ao meio pra julgar "subindo/descendo") — alargar a janela
  dele mudaria a sensibilidade dessa régua já calibrada sem eu ter validado
  a regra, o que é proibido.
- **Correção: sobrou roxo/ameixa antigo em 6 pontos** (achado pelo Costa em
  produção, 26/08) — a migração de paleta original só trocou as CSS
  variables + os hardcodes que eu tinha achado por grep na hora; ficaram de
  fora componentes com cor própria hardcoded: `<meta name="theme-color">`,
  `.tabs` (barra fixa Visão geral/Por expert/Safra), `.cldlg` (diálogo de
  senha do recorte Costa e Lobão, tinha `#3D0038`/`#2B0027` chapados),
  `.cmp__th.is-ord` (destaque de coluna ordenada no comparativo mobile),
  véu do `#boot` (loading) e `.pnl__fundo` (fundo escurecido do painel de
  análise do expert — provavelmente o mais visível dos seis). **Lição**: ao
  trocar paleta de novo no futuro, procurar por `rgba\([0-9]+,\s*0,\s*[0-9]+`
  (assinatura do R,G,B com G=0 da família ameixa antiga) além das variáveis
  CSS — cor hardcoded em componente isolado não aparece só olhando `:root`.
  `og-image.jpg` (card de compartilhamento social) ainda está na paleta
  antiga — baixa prioridade (só aparece em preview de link, não no uso do
  painel), pendente de regeneração.
- Ordenação por coluna clicável no comparativo: JÁ EXISTIA (`data-ord`/
  `alternarOrdem`) — engano meu no diagnóstico anterior, não precisou de
  trabalho.
- **✅ BUG achado pelo Costa em produção e corrigido (27/08)**: tile "Ticket
  médio do depósito" (totais Meta E Google) dizia "sem depósito" / "nenhum
  depósito no período" mesmo quando `deposito` (o R$ bruto) era > 0 — bastava
  faltar só a CONTAGEM (`t.depositos`, o `deposit_count` da TAP que entrou no
  payload em 20/08/v14). O código já sabia que isso podia acontecer (comentário
  próprio dizia "sem depósito em vez de imprimir uma divisão por zero"), mas o
  texto de fallback mentia: lia como "não teve depósito nenhum" quando na
  verdade só faltava o dado pra tirar a média. Corrigido em `pintarTotais()` e
  `pintarGoogle()`: agora distingue os dois casos — sem contagem MAS com
  dinheiro caído mostra "—" + o valor bruto ("R$X em depósito, sem contagem no
  período"); só fala "sem depósito"/"nenhum depósito no período" quando o R$
  também é zero. Não achei reproduzir ao vivo (testei Meta e Google em Hoje/
  Ontem/7d/Mês/Mês ant./Datas em dia pré-v14 — todos com contagem presente);
  o fix cobre a causa raiz documentada mesmo sem ter pego o payload exato que
  o Costa viu (pode ter sido Costa e Lobão, que pede senha, ou um instante de
  cache específico). Se reaparecer, o texto novo já diferencia os dois casos
  em vez de esconder que teve dinheiro entrando.
- **Gráfico de evolução: feito, testado, e REMOVIDO a pedido do Costa
  (26/08, mesmo dia)** — "ficou uma merda". Testei em 3 larguras (1512/820/
  390px) sem achar defeito visual reproduzível; hipótese não confirmada é
  que o estranhamento veio do combo com o apagão de TAP (ver seção própria
  abaixo) deixando a tela toda zerada exceto o gráfico. Removido por completo
  (HTML dos 2 escopos, CSS `.grf*`, JS `pintarGraficoEvolucao`/
  `graficoLinha`, a chamada dentro de `buscarLoteTendencia`) — sem vestígio
  no código. Não reintroduzir sem pedido explícito.
- **Fase 6 (não iniciada)**: exportação CSV do comparativo, responsivo/
  estados no resto do painel.

## ✅ RESOLVIDO: apagão de dados da TAP (26/08)

Cadastros/FTD/depósito/net dep/volume/comissão foram pra ZERO na operação
inteira (os dois escopos) por ~1h30 — não era bug do painel nem dos ajustes
no n8n feitos nesse mesmo dia (confirmado por timestamp: já estava zerado às
20:20, antes de qualquer edição). Causa raiz real: toda chamada de `TAP
Insights`/`TAP Insights Geral` (workflow "Refresh Cache") voltava
`{"errCode":3,"message":"Access to this label is not allowed"}` —
`tap_api_key` desatualizada no node "Credenciais". Como esses nodes têm
`onError: continueRegularOutput`, o erro ficava silencioso: a execução
aparecia "success" no n8n, só que com tudo zerado.

**Onde achar/trocar a chave**: TAP (Smartico) → menu **Label** → aba
**Settings** (`https://drive-3.smartico.ai/12330#/af2_operators_op/1`) →
campo "API Key to access Media reports, Balance API and Affiliates data".
Host da API: `https://boapi3.smartico.ai`. A chave trocou em algum momento
sem avisar o n8n — não tem como prever quando vai trocar de novo, só
monitorar (a resposta `errCode:3` com HTTP 200 é o sintoma).

**Corrigido em 3 workflows** (cada um tem sua PRÓPRIA cópia do node
"Credenciais", chave duplicada, sem credencial compartilhada do n8n):
"Dashboard Operação - Refresh Cache", "Dashboard Operação - Webhook API",
"Dashboard Operação - Safra". ("Safra Histórico API" não chama a TAP, só lê
snapshot já salvo — não precisou.)

**Pegadinha que quase me enganou**: `update_workflow` só grava o RASCUNHO.
`execute_workflow` (manual) já confirmou a chave nova funcionando na hora,
mas o **gatilho agendado de produção continuou batendo na chave velha** nas
2 execuções seguintes — só resolveu de verdade depois de `publish_workflow`
explícito nos 3 workflows. Ver [[n8n-segredos-credenciais-estado]] (mesma
lição documentada lá em 13/08, reincidiu). Regra fixa: sempre que
`update_workflow` mexer num node que o schedule/webhook de produção usa,
`publish_workflow` na sequência — nunca confiar que "rodou manual" prova que
a produção também vai rodar.

Validado ponta a ponta: execução agendada trazendo dado real (cadastros 487,
FTD 291, depósito R$236.568,16 no escopo Geral) + `/api/dashboard` com o
mesmo número + painel em produção mostrando certo depois de um reload.

## Safra do Google (26/08)

O n8n (`Dashboard Operação - Safra`) já soma o btag do Google (543779) desde
13/08 (`add('google', 'GOOGLE', ['543779'])` em "Montar Linhas Safra") — só
não estava ligado na tela. Ligado agora: `SAFRA_ESCOPO_API.google = 'google'`
+ `pintarSafraGoogle()` (mesmo motor de `pintarSafraFiltro`, sem filtro de
expert por ser 1 conta só, sem filtro de mês, sempre carteira inteira),
disparado por `carregarSafra('google')` dentro de `pintarGoogle()`. Seção
nova no escopo Google, logo depois de "Contas de anúncio".
**Pegadinha real, testada e corrigida em preview**: `api/dashboard.js` tinha
um segundo allowlist (`const ESCOPOS`) que só aceitava `costa_lobao`/`geral`
nos modos `tendencia`/`safra` — `?safra=1&escopo=google` voltava 400 mesmo
com o front certo. `google` entrou nessa lista. Testado com dado real
(matriz Out/25→hoje, TOTAL batendo com a única linha).

## QA de preview com login Google (26/08)

Cada `vercel deploy --yes` gera uma URL nova (hash aleatório) e o Google só
aceita fazer OAuth pras URLs cadastradas no client (`painel-bateubet-login`,
tela "Clientes" do Google Auth Platform) — login em URL de preview nova
sempre cai em `redirect_uri_mismatch`. Solução: `painel-bateubet-preview.
vercel.app` é um ALIAS ESTÁVEL (`vercel alias set <deploy-url>
painel-bateubet-preview.vercel.app`), com sua origem + `/api/auth/callback`
já cadastrados no client OAuth uma vez. Pra testar um preview novo com login
de verdade: `vercel deploy --yes` e depois `vercel alias set <url do deploy>
painel-bateubet-preview.vercel.app` — não precisa mexer no Google Cloud de
novo.

## ✅ Coorte de FTD migrada pra tabela pré-calculada (26/08)

O card "GGR gerado por safra de FTD" do painel do expert (Coorte) travava em
branco às vezes ("cade a porra a safra") porque `api/coorte.js` calculava tudo
AO VIVO a cada abertura de painel — Graph API + TAP, retry com backoff, 11+
chamadas por expert, sem estado de loading no front. Uma leitura lenta virava
painel travado pra sempre.

**Arquitetura nova (mesmo padrão da Safra/Histórico):**
- Workflow n8n `Dashboard Operação - Coorte` (id `eURadR19TlocBv1C`, a cada 15
  min): recalcula em RODÍZIO — uma execução = um (expert, granularidade)
  inteiro, não um mês por vez feito Safra, porque a matriz safra×idade
  precisa de todos os períodos juntos pra nascer. Porta fiel de toda a lógica
  do antigo `api/coorte.js` (BTAGS, CONTAS_META, montar(), estimarFator(),
  calcularPayback()) pros nodes Code do n8n. Grava em `dashboard_coorte`
  (tabela nova, id `EnGxXmnKDuexfHx8`), upsert por (expert_name, gran, mes).
- Workflow n8n `Dashboard Operação - Coorte API` (id `ppr4xci8UtmEgpBK`,
  webhook `GET /webhook/dashboard-coorte`, token estático via query `token`):
  só LÊ a tabela, reconstrói o mesmo contrato JSON de sempre. Nunca chama
  Graph API nem TAP.
- `api/coorte.js` (Vercel) virou um proxy fino: valida escopo/sessão C&L
  (isso continua no servidor, o n8n não sabe quem está logado) e repassa pro
  webhook acima. Responde em milissegundos.
- Env var nova: `N8N_COORTE_TOKEN` (Vercel, Production) — token do webhook
  Coorte API, mesmo padrão do `N8N_DASHBOARD_TOKEN` que `api/dashboard.js` já
  usa (mas é OUTRO token, outro webhook).

**Armadilha nova (Code node do n8n não faz HTTP):** o sandbox do Code node
desta instância barra `fetch`/`axios`/qualquer chamada de rede — só o node
HTTP Request pode chamar TAP/Graph API. Isso forçou a arquitetura em vários
nodes (Expandir Janelas → Buscar Janela TAP → Montar Matriz Coorte, e em
paralelo Expandir Contas → Buscar Insights Conta → Montar Investimento,
sincronizados por um Merge antes de Finalizar Safras) em vez de um Code node
só fazendo tudo como a rota antiga fazia em Node puro.

**Armadilha de URL do n8n:** a "Production URL" que a ferramenta MCP do n8n
relata para um webhook de path customizado inclui um prefixo de webhookId
(`/webhook/{uuid}/dashboard-coorte`) que **não é a URL real** desta instância
— o caminho de verdade é `/webhook/dashboard-coorte`, sem UUID (confirmado
comparando com `api/dashboard.js`, que já funcionava em produção com essa
forma). Testar a URL com UUID dá 404 "not registered" mesmo com o workflow
ativo — quase virou um susto de "produção inteira caiu" por engano.

**Cobertura no rodízio:** 25 experts × 2 granularidades (mês/semana) = 50
combinações; uma por execução a cada 15 min. Expert nunca calculado aparece
com `safras: []` e `ainda_nao_calculado: true` até a vez dele chegar — o
front trata isso como "sem dado ainda", não como erro. Rodei algumas
execuções manuais em 26/08 pra adiantar a semeadura; o resto enche sozinho.

## Workflow deste projeto (instrução do Costa, 26/08)

- Toda mensagem do Costa referente a este projeto: antes de responder ou editar, rodar `graphify query "<pergunta derivada da mensagem>"` pra entender o estado atual do projeto pelo grafo. Depois de qualquer edição de código, rodar `graphify update .` (o hook post-commit já cobre o momento do commit, mas atualize também fora dele quando editar sem commitar na hora).
- Na hora de fazer commit: sempre rodar `graphify update .` (garantindo que o hook post-commit não falhe silenciosamente) e revisar/atualizar este CLAUDE.md se algo relevante sobre arquitetura, decisão de projeto ou regra de negócio mudou - não deixar o CLAUDE.md desatualizado em relação ao código.
