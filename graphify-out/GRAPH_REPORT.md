# Graph Report - dashboard-operacao-bateubet  (2026-08-27)

## Corpus Check
- 15 files · ~125,084 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 120 nodes · 150 edges · 17 communities (12 shown, 5 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 2 edges (avg confidence: 0.85)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `aeb322d2`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- index.html · Painel Operação ao vivo
- coorte.js
- conta.js
- vercel.json
- dashboard.js
- me.js
- touch.js
- cl-auth.js
- montarLinha
- push-spend.js
- CLAUDE.md
- middleware.js
- callback.js
- start.js
- tapPorUtm
- vereditoLinha

## God Nodes (most connected - your core abstractions)
1. `index.html · Painel Operação ao vivo` - 21 edges
2. `README · Painel Operação Bateu Bet` - 13 edges
3. `montarLinha()` - 6 edges
4. `num()` - 5 edges
5. `tapPorUtm()` - 5 edges
6. `middleware()` - 5 edges
7. `logo-bateubet.svg (wordmark oficial)` - 5 edges
8. `vereditoLinha()` - 4 edges
9. `validarPeriodo()` - 4 edges
10. `functions` - 4 edges

## Surprising Connections (you probably didn't know these)
- `index.html · Painel Operação ao vivo` --references--> `apple-touch-icon.png (ícone iOS 180x180)`  [EXTRACTED]
  index.html → apple-touch-icon.png
- `index.html · Painel Operação ao vivo` --references--> `fundo-marca.jpg (textura de fundo do body)`  [EXTRACTED]
  index.html → fundo-marca.jpg
- `index.html · Painel Operação ao vivo` --references--> `marca-b.png (B recortado, usado no loading)`  [EXTRACTED]
  index.html → marca-b.png
- `index.html · Painel Operação ao vivo` --references--> `og-image.jpg (card social 1200x630)`  [EXTRACTED]
  index.html → og-image.jpg
- `README · Painel Operação Bateu Bet` --references--> `og-image.jpg (card social 1200x630)`  [EXTRACTED]
  README.md → og-image.jpg

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Dois escopos (Costa e Lobão / Geral) compartilhando o mesmo filtro de período** — index_escopo_cl, index_escopo_geral, index_range_filter [EXTRACTED 0.90]
- **Token do n8n nunca exposto ao navegador (proxy serverless)** — readme_painel_operacao_bateu_bet, index_painel_operacao_ao_vivo, api_dashboard_proxy, index_token_nunca_navegador [EXTRACTED 0.90]
- **Identidade visual B da Bateu Bet em múltiplos formatos** — icon_svg_favicon, favicon_32x32_icone, favicon_16x16_icone, apple_touch_icon_icone, icon_512_appicon, marca_b_icone, logo_bateubet_wordmark [INFERRED 0.85]

## Communities (17 total, 5 thin omitted)

### Community 0 - "index.html · Painel Operação ao vivo"
Cohesion: 0.13
Nodes (22): api/dashboard.js (proxy serverless Vercel), apple-touch-icon.png (ícone iOS 180x180), fundo-marca.jpg (textura de fundo do body), icon-512.png (ícone de app 512x512), icon.svg (favicon vetorial), Auto-refresh de 5 minutos condicionado a periodo.is_hoje, div#dashboard-root (raiz de injeção de dados), Handoff designer → web-designer (entrega do layout estático) (+14 more)

### Community 2 - "conta.js"
Cohesion: 0.13
Nodes (6): ACOES_CADASTRO, BTAG_POR_CONTA, CAMPOS_FUNIL, ESCADA_RESULTADO, montarSafra(), safraDaCampanha()

### Community 3 - "vercel.json"
Cohesion: 0.18
Nodes (10): maxDuration, maxDuration, maxDuration, crons, functions, api/conta.js, api/dashboard.js, api/push-spend.js (+2 more)

### Community 4 - "dashboard.js"
Cohesion: 0.43
Nodes (5): dataValida(), diasEntre(), ESCOPOS, hojeSP(), validarPeriodo()

### Community 7 - "cl-auth.js"
Cohesion: 0.50
Nodes (3): assinar(), crypto, tokenValido()

### Community 8 - "montarLinha"
Cohesion: 0.47
Nodes (6): acharCadastros(), acharResultado(), centavos(), mapaAcoes(), montarLinha(), num()

### Community 9 - "push-spend.js"
Cohesion: 0.83
Nodes (3): entregar(), entregarComTrava(), numeroOuZero()

### Community 10 - "CLAUDE.md"
Cohesion: 0.20
Nodes (9): ✅ Coorte de FTD migrada pra tabela pré-calculada (26/08), graphify, Identidade visual: migração pra Estratégia de Marca (26/08), Login Google (26/08), QA de preview com login Google (26/08), Redesign de BI (26/08, em andamento por fase), ✅ RESOLVIDO: apagão de dados da TAP (26/08), Safra do Google (26/08) (+1 more)

### Community 11 - "middleware.js"
Cohesion: 0.43
Nodes (7): assinar(), config, igual(), lerCookie(), middleware(), paraHex(), paraLogin()

### Community 15 - "tapPorUtm"
Cohesion: 0.40
Nodes (6): casarFunil(), funilZero(), maisUmDia(), normUtm(), somarFunil(), tapPorUtm()

### Community 16 - "vereditoLinha"
Cohesion: 0.67
Nodes (4): ehDestravarBarato(), moeda(), vereditoConta(), vereditoLinha()

## Knowledge Gaps
- **31 isolated node(s):** `crypto`, `crypto`, `crypto`, `crypto`, `crypto` (+26 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **5 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **What connects `crypto`, `crypto`, `crypto` to the rest of the system?**
  _31 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `index.html · Painel Operação ao vivo` be split into smaller, more focused modules?**
  _Cohesion score 0.13405797101449277 - nodes in this community are weakly interconnected._
- **Should `conta.js` be split into smaller, more focused modules?**
  _Cohesion score 0.13333333333333333 - nodes in this community are weakly interconnected._