/* Camada de apresentação. Os contratos, filtros e cálculos existentes continuam no index. */
(function (global) {
  'use strict';
  var api, panels = {}, blocks = {};
  var ticker, previous = null, previousFor = null, tickerSignature = '', loadStatus = '';
  var metrics = [
    { key: 'investimento_total', label: 'Investimento', note: 'Mídia no período', color: '#e9e4e6', dash: '6 4' },
    { key: 'net_pl', label: 'GGR', note: 'Net PL bruto · antes da comissão', color: '#ef8aaf', dash: '3 3' },
    { key: 'net_dep', label: 'Net Dep', note: 'Depósitos menos saques', color: '#f0246b', dash: '' },
    { key: 'volume', label: 'Volume', note: 'Volume apostado', color: '#c9ae85', dash: '10 4' }
  ];
  var num = function (v) { return typeof v === 'number' && Number.isFinite(v); };
  var brl = function (v) { return num(v) ? v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }) : '—'; };
  var count = function (v) { return num(v) ? v.toLocaleString('pt-BR') : '—'; };
  var moneyShort = function (v) { return 'R$ ' + (Math.abs(v) >= 1000 ? (v / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + ' mil' : Math.round(v).toLocaleString('pt-BR')); };
  var $ = function (s, root) { return (root || document).querySelector(s); };
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function button(text, cls, action) {
    var b = el('button', cls, text); b.type = 'button';
    b.addEventListener('click', action); return b;
  }
  function sumComplete(rows, getter) {
    if (!rows.length) return null;
    var vals = rows.map(getter);
    return vals.every(num) ? vals.reduce(function (a, b) { return a + b; }, 0) : null;
  }
  function totalsOf(block) {
    var t = block.totais || {}, experts = block.experts || [];
    var out = {};
    metrics.concat([{ key: 'cadastros' }, { key: 'ftd' }]).forEach(function (m) {
      out[m.key] = num(t[m.key]) ? t[m.key] : sumComplete(experts, function (e) {
        return m.key === 'investimento_total' ? e[m.key] : (e.tap || {})[m.key];
      });
    });
    return out;
  }
  /* Uma ausência não vira zero. Só somamos uma série quando todos os experts
     selecionados têm aquele campo naquele dia; os demais pontos ficam em branco. */
  function aggregateHistory(experts, cache, scope, today) {
    var dates = new Set();
    var maps = experts.map(function (e) {
      var entry = cache[scope + '|' + e.expert_name];
      var map = {};
      if (entry && entry.estado === 'ok') (entry.dias || []).forEach(function (d) {
        if (/^\d{4}-\d{2}-\d{2}$/.test(d.data) && d.data < today) { dates.add(d.data); map[d.data] = d; }
      });
      return map;
    });
    return Array.from(dates).sort().slice(-7).map(function (date) {
      var row = { data: date };
      metrics.forEach(function (m) {
        row[m.key] = sumComplete(maps, function (map) { return map[date] && map[date][m.key]; });
      });
      return row;
    });
  }
  function fold(node, title, cls) {
    if (!node) return;
    var box = el('section', 'desk-information ' + (cls || ''));
    box.appendChild(el('h3', '', title));
    node.before(box); box.appendChild(node);
    return box;
  }
  function tickerValue(current, before) {
    return { value: num(current) ? current : null,
      balance: !num(current) ? 'unknown' : current > 0 ? 'positive' : current < 0 ? 'negative' : 'neutral',
      delta: num(current) && num(before) ? current - before : null };
  }
  function initTicker() {
    var bar = el('section', 'desk-ticker'); bar.setAttribute('aria-label', 'GGR dos experts no período selecionado');
    var label = el('div', 'desk-ticker-label');
    label.append(el('strong', '', 'EXPERTS'), el('span', '', 'GGR / NET PL'));
    var viewport = el('div', 'desk-ticker-viewport');
    var track = el('div', 'desk-ticker-track'); viewport.appendChild(track);
    var pause = button('Pausar', 'desk-ticker-pause', function () {
      var paused = bar.classList.toggle('is-paused');
      pause.textContent = paused ? 'Retomar' : 'Pausar'; pause.setAttribute('aria-pressed', String(paused));
    });
    pause.setAttribute('aria-label', 'Pausar rolagem dos experts'); pause.setAttribute('aria-pressed', 'false');
    pause.addEventListener('click', function () { pause.setAttribute('aria-label', bar.classList.contains('is-paused') ? 'Retomar rolagem dos experts' : 'Pausar rolagem dos experts'); });
    bar.append(label, viewport, pause); $('.topbar').before(bar);
    ticker = { bar: bar, track: track, label: label, pause: pause };
  }
  function setPrevious(data) { previous = data; previousFor = api.state.dados; renderTicker(); }
  function setStatus(mode) { loadStatus = mode; renderTicker(); renderConnections(); }
  function renderConnections() {
    var d = api.state.dados;
    ['geral', 'google'].forEach(function (scope) {
      var label = $('.scopebar label[for="e-' + scope + '"]');
      if (!label) return;
      var status = $('.desk-channel-status', label);
      if (!status) { status = el('span', 'desk-channel-status'); label.appendChild(status); }
      var block = d && d[scope];
      var readable = block && (scope === 'google' ? !block.investimento_pendente && num(block.investimento_total) : num((block.totais || {}).investimento_total));
      var loading = api.state.carregando;
      var error = loadStatus === 'erro';
      status.textContent = loading ? 'Atualizando' : error ? (d ? 'Leitura anterior' : 'Indisponível') : readable ? 'Dados recebidos' : 'API pendente';
      status.dataset.state = !loading && !error && readable ? 'ok' : 'pending';
      status.title = 'Estado da última leitura do dashboard; não representa conexão em tempo real com a plataforma.';
    });
  }
  function renderTicker() {
    if (!ticker || !api) return;
    var scope = $('input[name="escopo"]:checked').id.slice(2), d = api.state.dados;
    var block = d && (scope === 'cl' ? d : d[scope]);
    var base = previousFor === d && previous && !previous.tap_indisponivel ? (scope === 'cl' ? previous : previous[scope]) : null;
    var before = new Map(((base || {}).experts || []).map(function (e) { return [e.expert_name, (e.tap || {}).net_pl]; }));
    var rows = ((block || {}).experts || []).map(function (e) {
      return { name: e.expert_name, metric: tickerValue(d.tap_indisponivel ? null : (e.tap || {}).net_pl, before.get(e.expert_name)) };
    });
    var status = api.state.carregando ? 'Atualizando período…' : loadStatus === 'erro' ? 'Falha na atualização · leitura anterior' : '';
    var signature = JSON.stringify([scope, rows, status, d && d.periodo]);
    if (signature === tickerSignature) return;
    tickerSignature = signature;
    ticker.track.replaceChildren();
    var group = el('div', 'desk-ticker-group');
    if (status) group.appendChild(el('span', 'desk-ticker-message', status));
    rows.forEach(function (row) {
      var m = row.metric;
      var item = button('', 'desk-ticker-item', function () { api.openExpert(row.name, scope, item); });
      var value = el('strong', 'desk-ticker-value is-' + m.balance, brl(m.value));
      var balance = { positive: 'positivo', negative: 'negativo', neutral: 'zerado', unknown: 'sem leitura' }[m.balance];
      var deltaText = m.delta === null ? balance + ' · sem comparação' : (m.delta > 0 ? '↑ ' : m.delta < 0 ? '↓ ' : '→ ') + brl(Math.abs(m.delta)) + ' vs. anterior';
      var delta = el('span', 'desk-ticker-delta' + (m.delta === null ? '' : m.delta > 0 ? ' is-positive' : m.delta < 0 ? ' is-negative' : ''), deltaText);
      delta.textContent = m.delta === null ? '·' : m.delta > 0 ? '↑' : m.delta < 0 ? '↓' : '→';
      delta.setAttribute('aria-label', deltaText);
      item.setAttribute('aria-label', row.name + ' · GGR ' + brl(m.value) + ' · ' + deltaText + '. Abrir análise');
      item.append(el('span', 'desk-ticker-name', row.name), el('span', 'desk-ticker-key', 'GGR'), value, delta);
      item.title = row.name + ' · GGR = Net PL bruto: ' + brl(m.value) + '. Saldo ' + balance + '. ' + deltaText + '. Clique para abrir a análise.';
      group.appendChild(item);
    });
    if (!rows.length && !status) group.appendChild(el('span', 'desk-ticker-message', !d ? 'Aguardando dados dos experts' : scope === 'google' ? 'Google Ads · sem detalhamento de GGR por expert nesta integração' : 'Sem experts disponíveis neste canal'));
    ticker.track.appendChild(group);
    ticker.bar.classList.toggle('has-items', rows.length > 0);
    ticker.pause.hidden = !rows.length;
    if (rows.length) {
      var copy = group.cloneNode(true); copy.setAttribute('aria-hidden', 'true'); copy.inert = true;
      copy.classList.add('desk-ticker-copy'); ticker.track.appendChild(copy);
      ticker.track.style.setProperty('--ticker-duration', Math.max(65, rows.length * 9) + 's');
    }
    var per = (d || {}).periodo || {};
    ticker.bar.title = 'GGR dos experts · ' + (per.de || '—') + ' a ' + (per.ate || '—') + '. Cor = saldo; seta = variação contra o período anterior.';
  }
  function setUser(data) {
    if (!data || !data.ok) return;
    var box = $('#userbox'), name = $('#userbox-nome'); if (!box || !name || $('.desk-user-avatar', box)) return;
    var avatar = el('span', 'desk-user-avatar', name.textContent.trim().split(/\s+/).slice(0, 2).map(function (s) { return s[0]; }).join('').toUpperCase());
    avatar.setAttribute('aria-hidden', 'true');
    var identity = el('div', 'desk-user-identity'); name.before(identity); identity.append(name, el('span', 'desk-user-status', 'Google · conectado'));
    box.prepend(avatar);
  }
  function initShell() {
    document.documentElement.classList.add('desk-ready');
    var root = $('#dashboard-root');
    var side = el('aside', 'desk-side');
    var logo = el('img', 'desk-logo'); logo.src = 'logo-bateubet.svg'; logo.alt = 'BateuBet';
    side.appendChild(logo); side.appendChild(el('span', 'desk-kicker', 'OPERAÇÃO'));
    var nav = el('nav', 'desk-nav'); nav.setAttribute('aria-label', 'Seções da operação');
    [['v-geral', 'Visão geral', '↗'], ['v-experts', 'Por expert', '◎'], ['v-safra', 'Safras', '▦'], ['v-metas', 'Metas', '◈']].forEach(function (item) {
      var b = button('', '', function () { $('#' + item[0]).click(); });
      var icon = el('span', 'desk-nav-icon', item[2]); icon.setAttribute('aria-hidden', 'true');
      b.append(icon, el('span', '', item[1])); b.dataset.view = item[0]; nav.appendChild(b);
    });
    side.appendChild(nav);
    side.appendChild(el('div', 'desk-side-foot', 'PAINEL INTERNO\nDados da operação Bateu'));
    root.insertBefore(side, $('.topbar'));
    var heading = el('div', 'desk-heading');
    var mobileLogo = logo.cloneNode(); mobileLogo.className = 'desk-mobile-logo'; heading.appendChild(mobileLogo);
    heading.append(el('div', 'desk-kicker', 'DESEMPENHO DA OPERAÇÃO'), el('h2', 'desk-title', 'Visão geral'));
    $('.topbar__in').prepend(heading);
    initTicker();
    var periodButton = button('', 'desk-period-button', function () { $('#r-custom').click(); $('#range-de').focus(); });
    periodButton.append(el('span', '', 'Período'), el('strong', 'desk-period-selection', 'Selecionar datas'), el('span', '', '⌄'));
    $('#range-filter').prepend(periodButton);
    $('label[for="r-custom"]').textContent = 'Personalizado';
    $('.scopebar label[for="e-geral"] .scopebar__nome').textContent = 'Meta Ads';
    $('.scopebar label[for="e-google"] .scopebar__nome').textContent = 'Google Ads';
    ['kwai', 'tiktok', 'taboola'].forEach(function (name) {
      var l = $('.scopebar label[for="e-' + name + '"]');
      l.classList.add('desk-soon'); l.appendChild(el('span', 'desk-soon-label', 'Em breve'));
    });
    document.querySelectorAll('.scopebar label').forEach(function (label) {
      label.tabIndex = 0; label.setAttribute('role', 'button');
      label.addEventListener('keydown', function (event) {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); $('#' + label.htmlFor).click(); }
      });
    });
    /* Mantém os rádios e suas proteções originais. O botão acessível só os aciona. */
    document.addEventListener('change', function (event) {
      if (event.target.matches('input[name="view"],input[name="escopo"]')) syncShell();
    });
    window.addEventListener('hashchange', syncShell);
    window.addEventListener('resize', fitScores);
    document.addEventListener('change', function () {
      /* Ordenação global conserva o significado também na comparação nova. */
      setTimeout(function () { ['cl', 'geral'].forEach(drawExperts); }, 0);
    });
    syncShell();
  }
  function syncShell() {
    var scope = $('input[name="escopo"]:checked').id;
    var view = $('input[name="view"]:checked').id;
    var names = { 'v-geral': 'Visão geral', 'v-experts': 'Por expert', 'v-safra': 'Safras', 'v-metas': 'Metas' };
    $('.desk-title').textContent = scope === 'e-google' ? 'Google Ads' : ['e-kwai', 'e-tiktok', 'e-taboola'].includes(scope) ? scope.slice(2).replace(/^./, function (c) { return c.toUpperCase(); }) : names[view];
    document.querySelectorAll('.desk-nav button').forEach(function (b) {
      var allowed = scope === 'e-cl' || (scope === 'e-geral' && b.dataset.view !== 'v-metas');
      b.disabled = !allowed;
      b.setAttribute('aria-current', allowed && b.dataset.view === view ? 'page' : 'false');
      b.title = !allowed ? 'Esta seção está disponível no escopo Meta' : '';
    });
    document.querySelectorAll('.scopebar label').forEach(function (label) { label.setAttribute('aria-pressed', String(label.htmlFor === scope || scope === 'e-cl' && label.htmlFor === 'e-geral')); });
    requestAnimationFrame(fitScores);
    renderTicker(); renderConnections();
    var per = (api.state.dados || {}).periodo;
    if (per) $('.desk-period-selection').textContent = per.de.split('-').reverse().join('/') + (per.ate !== per.de ? ' — ' + per.ate.split('-').reverse().join('/') : '');
  }
  function fitScores() {
    document.querySelectorAll('.desk-number').forEach(function (value) {
      if (!value.clientWidth) return;
      value.style.fontSize = '';
      var size = parseFloat(getComputedStyle(value).fontSize);
      while (value.scrollWidth > value.clientWidth && size > 16) { size -= 1; value.style.fontSize = size + 'px'; }
    });
  }
  function createPanel(scope, root) {
    var view = $('.view--geral', root) || root;
    var section = el('section', 'desk-overview'); section.setAttribute('aria-label', 'Resumo financeiro');
    var period = el('p', 'desk-period', 'Aguardando dados do período');
    var score = el('div', 'desk-score'), values = {};
    metrics.forEach(function (m) {
      var tile = el('div', 'desk-score-item');
      var value = el('strong', 'desk-number', '—');
      tile.append(el('span', 'desk-label', m.label), value, el('span', 'desk-muted', m.note));
      tile.title = m.note; score.appendChild(tile); values[m.key] = value;
    });
    var lower = el('div', 'desk-financial');
    var chart = el('section', 'desk-chart'); chart.appendChild(el('h3', '', 'Evolução financeira'));
    chart.appendChild(el('p', 'desk-muted', scope === 'google' ? 'Histórico diário não disponível nesta integração' : 'Últimos 7 dias fechados · mesmo recorte de experts'));
    var controls = el('div', 'desk-series'), visible = new Set(['investimento_total', 'net_pl', 'net_dep']);
    metrics.forEach(function (m) {
      var b = button(m.label, 'desk-series-button', function () {
        if (visible.has(m.key)) visible.delete(m.key); else visible.add(m.key);
        b.setAttribute('aria-pressed', String(visible.has(m.key))); drawChart(scope);
      });
      b.style.setProperty('--series-color', m.color); b.setAttribute('aria-pressed', String(visible.has(m.key))); controls.appendChild(b);
    });
    var graph = el('div', 'desk-plot');
    var note = el('p', 'desk-chart-note', 'Aguardando histórico real.'); note.setAttribute('role', 'status');
    chart.append(controls, graph, note);
    var retry = button('Tentar histórico novamente', 'desk-retry', function () { api.retryHistory(panels[scope].sourceScope || scope); });
    retry.hidden = true; chart.appendChild(retry);
    var funnel = el('section', 'desk-funnel'); funnel.appendChild(el('h3', '', 'Aquisição no período'));
    var fvalues = {};
    ['Cadastros', 'FTD', 'Conversão cadastro → FTD'].forEach(function (label, i) {
      var row = el('div', 'desk-funnel-row'), val = el('strong', 'desk-funnel-value', '—'), bar = el('div', 'desk-bar');
      row.append(el('span', 'desk-muted', label), val, bar); funnel.appendChild(row); fvalues[i] = { val: val, bar: bar };
    });
    lower.append(chart, funnel); section.append(period, score, lower); view.prepend(section);
    /* Todos os indicadores ficam abertos; o filtro de métricas continua opcional. */
    var totals = $('.totals', view);
    if (totals) {
      var header = totals.previousElementSibling;
      var details = fold(totals, 'Todos os indicadores · aquisição, retorno e comissões', 'desk-all-metrics');
      if (header && header.classList.contains('section-head')) details.insertBefore(header, totals);
    }
    fold($('.placar', view), 'Diagnóstico da operação · CPA, destaques e alertas');
    panels[scope] = { root: root, period: period, values: values, graph: graph, note: note, retry: retry, visible: visible, funnel: fvalues };
    if (scope !== 'google') createExpertList(scope, root);
  }
  function createExpertList(scope, root) {
    var view = $('.view--experts', root); if (!view) return;
    var section = el('section', 'desk-expert-list');
    var head = el('div', 'desk-list-head'); head.appendChild(el('h3', '', 'Desempenho por expert'));
    var input = el('input', 'desk-search'); input.type = 'search'; input.placeholder = 'Buscar expert'; input.setAttribute('aria-label', 'Buscar na comparação de experts');
    head.appendChild(input);
    var wrap = el('div', 'desk-table-wrap'), table = el('table', 'desk-table');
    var thead = el('thead'), row = el('tr');
    ['Expert', 'Investimento', 'GGR', 'Net Dep', 'Volume', 'FTD', 'CPA'].forEach(function (text) { var th = el('th', '', text); th.scope = 'col'; row.appendChild(th); });
    thead.appendChild(row); var body = el('tbody'); table.append(thead, body); wrap.appendChild(table);
    section.append(head, wrap, el('p', 'desk-muted', 'Selecione o expert para abrir a análise, as contas e as safras. Os cards completos continuam abaixo.'));
    view.prepend(section);
    panels[scope].expertBody = body;
    panels[scope].search = input;
    input.addEventListener('input', function () { drawExperts(scope); });
  }
  function drawExperts(scope) {
    var p = panels[scope], block = blocks[scope]; if (!p || !p.expertBody || !block) return;
    var query = p.search.value.trim().toLocaleLowerCase('pt-BR');
    var list = (block.experts || []).filter(function (e) { return e.expert_name.toLocaleLowerCase('pt-BR').includes(query); });
    p.expertBody.replaceChildren();
    api.orderExperts(list, api.state.ordenar.metrica, api.state.ordenar.dir).forEach(function (e) {
      var tr = el('tr'), name = el('td'), tap = e.tap || {};
      var b = button(e.expert_name + ' ↗', 'desk-expert-open', function () { api.openExpert(e.expert_name, scope, b); });
      name.appendChild(b); tr.appendChild(name);
      var failed = api.state.dados && api.state.dados.tap_indisponivel;
      [brl(e.investimento_total), brl(failed ? null : tap.net_pl), brl(failed ? null : tap.net_dep), brl(failed ? null : tap.volume), count(failed ? null : tap.ftd), brl(!failed && num(e.investimento_total) && tap.ftd > 0 ? e.investimento_total / tap.ftd : null)].forEach(function (value) { tr.appendChild(el('td', '', value)); });
      p.expertBody.appendChild(tr);
    });
    if (!list.length) { var tr = el('tr'), td = el('td', 'desk-empty', 'Nenhum expert encontrado neste recorte.'); td.colSpan = 7; tr.appendChild(td); p.expertBody.appendChild(tr); }
  }
  function renderScope(scope, block) {
    var p = panels[scope]; if (!p || !block) return;
    blocks[scope] = block;
    var t = totalsOf(block), failed = api.state.dados && api.state.dados.tap_indisponivel;
    metrics.forEach(function (m) { p.values[m.key].textContent = brl(failed && m.key !== 'investimento_total' ? null : t[m.key]); });
    var per = block.periodo || {};
    var date = function (s) { return s ? s.slice(8) + '/' + s.slice(5, 7) + '/' + s.slice(0, 4) : '—'; };
    p.period.textContent = date(per.de) + (per.ate !== per.de ? ' a ' + date(per.ate) : '') + ' · ' + (scope === 'cl' ? 'Costa e Lobão' : scope === 'google' ? 'Google Ads' : 'Meta Ads') + (failed ? ' · Dados TAP indisponíveis' : '');
    var cad = failed ? null : t.cadastros, ftd = failed ? null : t.ftd;
    p.funnel[0].val.textContent = count(cad); p.funnel[1].val.textContent = count(ftd);
    p.funnel[2].val.textContent = cad > 0 && num(ftd) ? (ftd / cad * 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + '%' : '—';
    p.funnel[0].bar.style.width = cad > 0 ? '100%' : '0%';
    p.funnel[1].bar.style.width = cad > 0 && num(ftd) ? Math.min(100, ftd / cad * 100) + '%' : '0%';
    p.funnel[2].bar.hidden = true;
    drawExperts(scope); drawChart(scope); syncShell();
  }
  function renderGoogle(g, period) {
    if (!g) return;
    renderScope('google', { totais: Object.assign({}, g.tap || {}, { investimento_total: g.investimento_pendente ? null : g.investimento_total }), experts: [], periodo: period });
  }
  function renderExpert(expert, scope) {
    var p = panels.detail;
    if (!p) return;
    p.sourceScope = scope;
    renderScope('detail', { experts: [expert], periodo: (api.state.dados || {}).periodo });
    p.period.textContent += ' · ' + expert.expert_name;
    var week = $('.desk-shortcut-week'); if (week) week.hidden = expert.expert_name !== 'GREGORIO BIG';
  }
  function svgEl(tag, attrs) {
    var n = document.createElementNS('http://www.w3.org/2000/svg', tag);
    Object.keys(attrs || {}).forEach(function (key) { n.setAttribute(key, attrs[key]); }); return n;
  }
  function drawChart(scope) {
    var p = panels[scope]; if (!p) return;
    var block = blocks[scope]; p.graph.replaceChildren(); p.retry.hidden = true;
    var cache = api.state.tendencia || {}, sourceScope = p.sourceScope || scope;
    var rows = block && scope !== 'google' ? aggregateHistory(block.experts || [], cache, sourceScope, api.today()) : [];
    var serie = metrics.filter(function (m) { return p.visible.has(m.key); });
    var vals = rows.flatMap(function (d) { return serie.map(function (m) { return d[m.key]; }).filter(num); });
    var lote = (api.state.tendLote || {})[sourceScope];
    if (!vals.length) {
      var msg = !serie.length ? 'Selecione uma métrica acima.' : scope === 'google' ? 'O Google ainda não fornece uma série diária neste painel.' : lote && lote.estado === 'erro' ? 'Não foi possível carregar o histórico.' : lote && lote.estado === 'carregando' ? 'Carregando os dias fechados…' : 'Sem histórico completo para este recorte.';
      p.graph.appendChild(el('div', 'desk-empty', msg));
      p.note.textContent = 'Nenhum valor ausente é apresentado como zero.';
      p.retry.hidden = !(lote && lote.estado === 'erro'); return;
    }
    var svg = svgEl('svg', { viewBox: '0 0 800 290', role: 'img', 'aria-label': 'Evolução financeira em reais, por dia fechado. Consulte os pontos ou a tabela acessível.' });
    var low = Math.min(0, Math.min.apply(null, vals)), high = Math.max(0, Math.max.apply(null, vals));
    if (low === high) high = low + 1;
    var pad = (high - low) * 0.08; high += pad; if (low < 0) low -= pad;
    var x = function (i) { return rows.length === 1 ? 430 : 86 + i / (rows.length - 1) * 680; };
    var y = function (v) { return 230 - (v - low) / (high - low) * 208; };
    for (var i = 0; i <= 4; i++) {
      var value = low + (high - low) * i / 4, yy = y(value);
      svg.appendChild(svgEl('line', { x1: 86, x2: 774, y1: yy, y2: yy, stroke: '#ffffff12' }));
      var label = svgEl('text', { x: 74, y: yy + 4, 'text-anchor': 'end', fill: '#bfb3b9', 'font-size': 11 }); label.textContent = moneyShort(value); svg.appendChild(label);
    }
    rows.forEach(function (d, i) {
      var label = svgEl('text', { x: x(i), y: 262, 'text-anchor': 'middle', fill: '#bfb3b9', 'font-size': 12 }); label.textContent = d.data.slice(8) + '/' + d.data.slice(5, 7); svg.appendChild(label);
    });
    serie.forEach(function (m) {
      var path = '', open = false;
      rows.forEach(function (d, i) {
        if (!num(d[m.key])) { open = false; return; }
        path += (open ? ' L ' : ' M ') + x(i) + ' ' + y(d[m.key]); open = true;
      });
      svg.appendChild(svgEl('path', { d: path, fill: 'none', stroke: m.color, 'stroke-width': 2.5, 'stroke-dasharray': m.dash }));
      rows.forEach(function (d, i) {
        if (!num(d[m.key])) return;
        var dot = svgEl('circle', { cx: x(i), cy: y(d[m.key]), r: 4, fill: m.color, tabindex: 0, 'aria-label': d.data + ' · ' + m.label + ': ' + brl(d[m.key]) });
        var title = svgEl('title'); title.textContent = d.data + ' · ' + m.label + ': ' + brl(d[m.key]); dot.appendChild(title); svg.appendChild(dot);
      });
    });
    p.graph.appendChild(svg);
    var details = el('details', 'desk-chart-table'); details.appendChild(el('summary', '', 'Ver valores por dia'));
    var table = el('table', 'desk-table'), head = el('thead'), hr = el('tr'), body = el('tbody');
    ['Dia'].concat(serie.map(function (m) { return m.label; })).forEach(function (name) { var th = el('th', '', name); th.scope = 'col'; hr.appendChild(th); }); head.appendChild(hr);
    rows.forEach(function (d) { var tr = el('tr'); tr.appendChild(el('td', '', d.data)); serie.forEach(function (m) { tr.appendChild(el('td', '', brl(d[m.key]))); }); body.appendChild(tr); });
    table.append(head, body); details.appendChild(table); p.graph.appendChild(details);
    p.note.textContent = rows[0].data + ' a ' + rows[rows.length - 1].data + ' · Valores diários, não acumulados. Lacunas = cobertura incompleta. O período dos indicadores acima é independente.';
  }
  function refreshCharts() { Object.keys(panels).forEach(drawChart); }
  function init(context) {
    api = context; initShell();
    ['cl', 'geral', 'google'].forEach(function (scope) { var root = $('#escopo-' + scope); if (root) createPanel(scope, root); });
    var detail = $('#pnl .pnl__body');
    if (detail) createPanel('detail', detail);
    if (detail) {
      var shortcuts = el('nav', 'desk-expert-shortcuts'); shortcuts.setAttribute('aria-label', 'Seções da análise do expert');
      [['Resumo financeiro', '.desk-overview'], ['Semana a semana', '#pnl-gbd'], ['Safras e coortes', '#pnl-coorte-card']].forEach(function (item, i) {
        var b = button(item[0], i === 1 ? 'desk-shortcut-week' : '', function () {
          var target = $(item[1], detail); if (target && !target.hidden) target.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
        });
        if (i === 1) b.hidden = true;
        if (i !== 2 || $(item[1], detail)) shortcuts.appendChild(b);
      });
      detail.prepend(shortcuts);
    }
    /* Skeleton e erro do carregador original também abrangem o novo resumo. */
  }
  var exported = { init: init, renderScope: renderScope, renderGoogle: renderGoogle, renderExpert: renderExpert, refreshCharts: refreshCharts, aggregateHistory: aggregateHistory, totalsOf: totalsOf, tickerValue: tickerValue, setPrevious: setPrevious, setStatus: setStatus, setUser: setUser };
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
  else global.BateuUI = exported;
})(typeof window !== 'undefined' ? window : globalThis);
