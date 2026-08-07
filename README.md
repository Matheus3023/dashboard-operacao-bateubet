# Painel Operação Bateu Bet

Painel interno de acompanhamento em tempo real da operação de tráfego pago
(Meta Ads) somada ao funil TAP, por expert. Cliente Bateu Bet, agência TechAds.

**Página privada.** Sem indexação (`noindex, nofollow` no HTML e `X-Robots-Tag`
no header). O link não deve circular fora do time.

## Como funciona

- `index.html` estático, sem build, sem framework, sem dependência externa.
  Todo o CSS e o JS moram no próprio arquivo.
- `api/dashboard.js` é uma função serverless na Vercel que serve de proxy para o
  webhook do n8n. **O token nunca vai para o navegador**: ele fica na variável de
  ambiente `N8N_DASHBOARD_TOKEN` e é injetado do lado do servidor.
- A página chama `/api/dashboard?de=YYYY-MM-DD&ate=YYYY-MM-DD` (parâmetros
  opcionais, sem eles a API devolve o dia corrente).

## Variável de ambiente (obrigatória)

| Nome | Onde | Valor |
| --- | --- | --- |
| `N8N_DASHBOARD_TOKEN` | Vercel, todos os ambientes | token do webhook do n8n |

Sem ela a função devolve `500 missing_env`.

Para rodar local com a Vercel CLI:

```bash
echo "N8N_DASHBOARD_TOKEN=o_token_aqui" > .env.local   # não versionar
vercel dev
```

## Comportamento

- **Auto-refresh de 5 minutos**, só quando a API responde `periodo.is_hoje`.
  Em período fechado o timer é desligado (dado do passado não muda).
- **Filtro de período**: hoje, ontem, 7 dias, 30 dias e intervalo livre. A
  escolha fica no `localStorage`. As datas são calculadas no fuso de Brasília,
  não no fuso do aparelho de quem abre.
- **Dois escopos** no topo, cada um com as mesmas duas sub-abas:
  - **Costa e Lobão**, os 7 experts de sempre (`totais` + `experts[]`);
  - **Geral**, as 24 entidades da BM inteira (`geral.totais` + `geral.experts[]`).
    Entidade com mais de uma conta de anúncio abre o breakdown conta a conta
    (`geral.experts[].contas[]`), com linha de total fechando a soma.
- **Abas em rota de hash**, agora em dois níveis: `#cl/visao`, `#cl/detalhe`,
  `#geral/visao` e `#geral/detalhe`. Os hashes antigos (`#geral` e `#experts`,
  sem barra) continuam abrindo o escopo Costa e Lobão.
- **Verba zerada é estado previsto, não erro.** Entidade sem investimento no
  período aparece com o chip cinza "Sem verba" (nunca "R$ 0,00" verde), fica
  fora das contas de melhor e pior custo por FTD e o escopo Geral avisa quantas
  estão nessa situação. Hoje isso vale para a maioria das entidades, por causa
  da liberação de permissão da Meta ainda em andamento.
- **A palavra "hoje" na tela** só é escrita quando o período devolvido termina
  no dia corrente em Brasília. O auto-refresh continua olhando `periodo.is_hoje`
  da API: na virada da meia-noite o n8n ainda responde do cache de 2 minutos, e
  o painel prefere pausar a palavra a carimbar dado de ontem como sendo de hoje.
- **Faixas de custo por FTD** (`FAIXA_BOA` e `FAIXA_ALTA` no início do script):
  provisórias em R$ 120 e R$ 200 até o cliente passar a meta oficial. Trocar
  nesses dois lugares muda a cor dos chips, o veredito e o texto do rodapé.

## Estrutura

```
index.html            página inteira (layout, estilo e camada de dados)
api/dashboard.js      proxy serverless que esconde o token
logo-bateubet.svg     logo oficial da marca
icon.svg / favicon.*  ícones gerados a partir do símbolo da logo
og-image.jpg          card 1200x630 para o preview no WhatsApp
vercel.json           headers de privacidade e limite de tempo da função
```
