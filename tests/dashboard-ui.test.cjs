const { test } = require('node:test');
const assert = require('node:assert/strict');
const { totalsOf, aggregateHistory, tickerValue, investmentRange } = require('../dashboard-ui.js');

test('safra começa no investimento positivo registrado, sem inferir início ausente', () => {
  const months = [
    { mes: '2026-03', experts: [{ expert_name: 'A', investimento: 0, investimento_disponivel: true }] },
    { mes: '2026-05', experts: [{ expert_name: 'A', investimento: 100, investimento_disponivel: true }] },
    { mes: '2026-06', experts: [{ expert_name: 'B', investimento: 200, investimento_disponivel: true }] }
  ];
  assert.equal(investmentRange(months, ['A']).start, '2026-05');
  assert.equal(investmentRange(months, ['B']).start, '2026-06');
  assert.equal(investmentRange(months, ['A','B']).start, '2026-05');
  assert.equal(investmentRange(months, ['A','Novo']).start, null);
});

test('ticker separa saldo positivo de queda e negativo de recuperação', () => {
  assert.deepEqual(tickerValue(100, 150), { value: 100, balance: 'positive', delta: -50 });
  assert.deepEqual(tickerValue(-100, -150), { value: -100, balance: 'negative', delta: 50 });
  assert.deepEqual(tickerValue(0, 0), { value: 0, balance: 'neutral', delta: 0 });
});
test('ticker não inventa dados nem comparação com base ausente', () => {
  assert.deepEqual(tickerValue(null, 100), { value: null, balance: 'unknown', delta: null });
  assert.deepEqual(tickerValue(100, undefined), { value: 100, balance: 'positive', delta: null });
});

test('preserva totais oficiais e o GGR bruto sem descontar comissão', () => {
  const t = totalsOf({ totais: { investimento_total: 100, net_pl: -20, net_dep: 0, volume: 900, comissao: 10 } });
  assert.equal(t.net_pl, -20); assert.equal(t.net_dep, 0); assert.equal(t.volume, 900);
});
test('não transforma campo ausente em zero', () => {
  assert.equal(totalsOf({ totais: { investimento_total: null }, experts: [] }).investimento_total, null);
  assert.equal(totalsOf({ experts: [{ tap: { net_dep: 10 } }, { tap: {} }] }).net_dep, null);
});
test('soma apenas campos completos e respeita escopo, datas e ausência', () => {
  const experts = [{ expert_name: 'A' }, { expert_name: 'B' }];
  const cache = {
    'geral|A': { estado: 'ok', dias: [{ data: '2026-09-01', investimento_total: 10, net_pl: -5, net_dep: 2 }, { data: '2026-09-03', investimento_total: 100 }] },
    'geral|B': { estado: 'ok', dias: [{ data: '2026-09-01', investimento_total: 20, net_pl: 5 }] },
    'cl|A': { estado: 'ok', dias: [{ data: '2026-09-01', investimento_total: 1000 }] }
  };
  const series = aggregateHistory(experts, cache, 'geral', '2026-09-03');
  assert.equal(series.length, 1); assert.equal(series[0].investimento_total, 30);
  assert.equal(series[0].net_pl, 0); assert.equal(series[0].net_dep, null);
  assert.equal(series[0].volume, null);
});
test('expert novo sem histórico não gera total subestimado', () => {
  const series = aggregateHistory([{ expert_name: 'A' }, { expert_name: 'Novo' }], {
    'geral|A': { estado: 'ok', dias: [{ data: '2026-09-01', investimento_total: 12 }] }
  }, 'geral', '2026-09-03');
  assert.equal(series[0].investimento_total, null);
});
