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
- **Abas em rota de hash** (`#geral` e `#experts`), para o refresh não jogar a
  pessoa de volta na primeira aba.
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
