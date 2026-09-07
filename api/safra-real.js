/**
 * SAFRA REAL — ROI por safra de FTD usando net_real = net_deposit − saldo em
 * carteira (o "padrão-ouro" do gestor, em vez de net_pl cru da TAP, que conta
 * como retorno dinheiro que ainda está parado na carteira do jogador).
 *
 * ─── 07/09/2026: PRIMEIRA VERSÃO, DADO ESTÁTICO ────────────────────────────
 * Ao contrário de /api/coorte (n8n recalcula em rodízio a cada poucos
 * minutos), esta rota lê um arquivo (`data/safra-real.json`) recalculado
 * MANUALMENTE por enquanto — o pipeline (TAP `af2_regs_op` paginado + join no
 * Databricks `player_summary`) ainda não está automatizado em n8n. Isso é
 * intencional (ver decisão do gestor, 07/09): a versão mensal (M0/M1/M2) do
 * mesmo cálculo tinha uma divergência de ~8% não resolvida contra o total
 * acumulado; a versão ACUMULADA por safra (sem quebrar em M0/M1/M2) bate
 * exata e foi validada, então essa é a que foi ao ar primeiro.
 *
 * Consequência prática: o dado pode ficar defasado até alguém rodar de novo
 * o pipeline manual e sobrescrever `data/safra-real.json` (e reimplantar).
 * `gerado_em` no payload existe pra isso ficar visível na tela, não escondido.
 *
 * Duas safras (SHELGUIMA, REINAN TIPS) não têm investimento: as contas de
 * anúncio delas ainda não estão habilitadas no Ads MCP (rollout gradual da
 * Meta) — `investido: null` nesses casos, front mostra "sem dado" em vez de
 * R$0 (que mentiria "gastou zero").
 */

const fs = require('fs');
const path = require('path');

let tokenCl = null;
try { tokenCl = require('./cl-auth').tokenValido; } catch (e) { tokenCl = null; }
function temSessaoCl(req) {
  const segredo = process.env.PAINEL_CL_SENHA;
  if (!segredo) return true;
  if (!tokenCl) return false;
  return tokenCl(req, segredo);
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

  const q = req.query || {};
  const escopo = String(q.escopo || 'costa_lobao').toLowerCase();
  const expert = String(q.expert || '').trim();

  if (escopo === 'costa_lobao' && !temSessaoCl(req)) {
    res.setHeader('Cache-Control', 'private, no-store');
    return res.status(403).json({ error: 'nao_autorizado' });
  }
  if (!expert) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(400).json({ error: 'expert_obrigatorio' });
  }

  let payload;
  try {
    const raw = fs.readFileSync(path.join(process.cwd(), 'data', 'safra-real.json'), 'utf8');
    payload = JSON.parse(raw);
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(500).json({ error: 'dado_indisponivel', detail: 'data/safra-real.json não encontrado ou inválido.' });
  }

  const dados = payload.experts && payload.experts[expert];
  if (!dados) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({
      expert, gerado_em: payload.gerado_em, ainda_nao_calculado: true, safras: []
    });
  }

  res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=1800, stale-while-revalidate=86400');
  return res.status(200).json({
    expert,
    gerado_em: payload.gerado_em,
    metodo: payload.metodo,
    safras: dados.safras,
    pool_investido: dados.pool_investido,
    pool_net_real: dados.pool_net_real,
    pool_roi: dados.pool_roi,
    pool_jogadores: dados.pool_jogadores
  });
};
