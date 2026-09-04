/* Teste isolado: nenhuma chamada é enviada à produção. Dados explicitamente fictícios. */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const names = ['TANOS', 'GP DADOS', 'TALYSON', 'DEKO', 'GREGORIO BIG'];
const experts = names.map((name, i) => ({ expert_name: name, investimento_total: 12480 - i * 1300, contas: [], criativos: [],
  grupo: { ativo: false }, direto: { ativo: true, valor_investido: 12480 - i * 1300, resultado: 2400, custo_por_resultado: 5 },
  tap: { cadastros: 244 + i * 20, ftd: 61 + i * 5, custo_por_ftd: 161, deposito: 24000, depositos: 200, valor_ftd: 3660, net_pl: 13200 - i * 400, net_dep: 19620 - i * 1560, volume: 172000 - i * 7000, comissao: 1200, pagamentos: 0 }
}));
experts[3].tap.net_pl = -3400;
const totals = { investimento_total: experts.reduce((s,e)=>s+e.investimento_total,0), investimento_grupo:0, investimento_direto:42120 };
for(const key of Object.keys(experts[0].tap)) totals[key] = experts.reduce((s,e)=>s+(e.tap[key]||0),0);
const dias = Array.from({length:7},(_,i)=>{const d=new Date(today+'T12:00:00Z');d.setUTCDate(d.getUTCDate()-7+i);return {data:d.toISOString().slice(0,10),investimento_total:1300+i*120,net_pl:2100+i*150,net_dep:2800+i*200,volume:14000+i*600,ftd:12+i,cadastros:90+i,deposito:5000, custo_por_ftd:100};});
const payload = (q) => {
  const old=q.get('de') && q.get('de')<today;
  const list=old ? experts.map((e,i)=>({...e,tap:{...e.tap,net_pl:e.tap.net_pl+(i%2===0?-1500:1500)}})) : experts;
  const sum={...totals,net_pl:list.reduce((s,e)=>s+e.tap.net_pl,0)};
  return {cl_bloqueado:true,atualizado_em:new Date().toISOString(),periodo:{de:q.get('de')||today,ate:q.get('ate')||today,is_hoje:!q.has('de')},geral:{totais:sum,experts:list},google:{investimento_total:2000,investimento_pendente:false,tap:sum,contas:[]}};
};
const safra = {escopo:'geral',meses:Array.from({length:3},(_,i)=>{
  const date=new Date(today+'T12:00:00Z');date.setUTCDate(1);date.setUTCMonth(date.getUTCMonth()-2+i);
  return {mes:date.toISOString().slice(0,7),experts:experts.map(e=>({expert_name:e.expert_name,...e.tap,ativos:30,churned:12,investimento:e.investimento_total,investimento_disponivel:true}))};
})};
async function run() {
  const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
  const browser = await chromium.launch({headless:true});
  const page = await browser.newPage({viewport:{width:1440,height:1050},reducedMotion:'reduce'});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  let failedTap=false, failedRequest=false;
  await page.route('**/*',async route=>{
    const url=new URL(route.request().url());
    if(url.hostname!=='bateu.test') return route.abort();
    if(url.pathname.startsWith('/api/')){
      if(failedRequest) return route.fulfill({status:503,contentType:'application/json',body:'{"error":"Teste de indisponibilidade"}'});
      let data;
      if(url.pathname==='/api/auth/me') data={ok:true,nome:'Prévia de teste',email:'teste@bateu.bet.br'};
      else if(url.pathname==='/api/cl-auth') return route.fulfill({status:403,contentType:'application/json',body:'{}'});
      else if(url.pathname==='/api/coorte') data={safras:[],ainda_nao_calculado:true};
      else if(url.searchParams.has('tendencia')) data={escopo:'geral',experts:experts.map(e=>({expert_name:e.expert_name,dias})),dias};
      else if(url.searchParams.has('safra')) data=safra;
      else data={...payload(url.searchParams),tap_indisponivel:failedTap};
      return route.fulfill({contentType:'application/json',body:JSON.stringify(data)});
    }
    const file=url.pathname==='/'?'index.html':url.pathname.slice(1);
    if(!['index.html','dashboard-ui.js','dashboard.css','logo-bateubet.svg','carregando-b.mp4','marca-b.png','fundo-marca.jpg','favicon.ico','icon.svg'].includes(file))return route.fulfill({status:404,body:''});
    const ext=path.extname(file);let body=fs.readFileSync(path.join(root,file));
    if(file==='index.html') body=body.toString().replace('<body>','<body><div style="position:fixed;bottom:0;left:0;right:0;z-index:99999;background:#ad1647;color:white;text-align:center;font:11px sans-serif;padding:5px">PRÉVIA DE TESTE · DADOS FICTÍCIOS</div>');
    await route.fulfill({contentType:({'.html':'text/html','.css':'text/css','.js':'text/javascript','.svg':'image/svg+xml','.mp4':'video/mp4'})[ext]||'application/octet-stream',body});
  });
  await page.goto('http://bateu.test/');
  await page.waitForSelector('#dashboard-root[data-state="pronto"]');
  await page.waitForSelector('#escopo-geral .desk-plot svg');
  assert.equal(await page.locator('#escopo-geral .desk-number').count(),4);
  assert.match(await page.locator('#escopo-geral .desk-number').first().innerText(),/49\.400/);
  assert.equal(await page.locator('.desk-ticker-group:not(.desk-ticker-copy) .desk-ticker-item').count(),5);
  assert.equal(await page.locator('#escopo-geral .tcard--off').count(),0);
  assert.equal(await page.locator('.desk-user-status').innerText(),'Google · conectado');
  assert.equal(await page.locator('.scopebar label[for="e-google"] .desk-channel-status').innerText(),'Dados recebidos');
  await page.waitForFunction(()=>document.querySelector('.desk-ticker-delta').textContent.includes('↑'));
  assert.ok((await page.locator('.desk-ticker').boundingBox()).height<=34);
  assert.equal(await page.locator('.desk-ticker-label').isVisible(),false);
  assert.equal(await page.locator('.desk-ticker-group:not(.desk-ticker-copy) .desk-ticker-value.is-negative').count(),1);
  assert.equal(await page.locator('.desk-ticker-group:not(.desk-ticker-copy) .desk-ticker-delta.is-negative').count(),2);
  await page.emulateMedia({reducedMotion:'no-preference'});
  assert.equal(await page.locator('.desk-ticker-track').evaluate(e=>getComputedStyle(e).animationName),'desk-market');
  await page.locator('.desk-ticker-pause').focus();
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('.desk-ticker-pause').getAttribute('aria-pressed'),'true');
  await page.keyboard.press('Enter');
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.screenshot({path:'/private/tmp/bateu-redesign-desktop.png'});
  await page.locator('.desk-nav button[data-view="v-experts"]').click();
  await page.locator('#escopo-geral .desk-search').fill('talyson');
  assert.equal(await page.locator('#escopo-geral .desk-expert-list .desk-table tbody tr').count(),1);
  await page.locator('#escopo-geral .desk-expert-open').click();
  await page.waitForSelector('.pnl:not([hidden])');
  await page.screenshot({path:'/private/tmp/bateu-redesign-expert.png'});
  await page.keyboard.press('Escape');
  await page.locator('#escopo-geral .desk-search').fill('gregorio');
  await page.locator('#escopo-geral .desk-expert-open').click();
  await page.waitForSelector('#pnl-gbd:not([hidden])');
  assert.equal(await page.locator('.desk-shortcut-week').isVisible(),true);
  await page.locator('.desk-shortcut-week').click();
  await page.screenshot({path:'/private/tmp/bateu-redesign-big.png'});
  assert.equal(await page.locator('#escopo-geral [data-gbd]').isVisible(),false);
  await page.keyboard.press('Escape');
  await page.locator('.desk-nav button[data-view="v-safra"]').click();
  assert.equal(await page.locator('#escopo-geral .view--safra').isVisible(),true);
  await page.waitForSelector('#escopo-geral .view--safra .mtz__grade');
  assert.ok(await page.locator('#escopo-geral .view--safra .mtz__c--parcial').count()>0);
  await page.screenshot({path:'/private/tmp/bateu-redesign-safra.png'});
  await page.locator('.desk-nav button[data-view="v-geral"]').click();
  assert.equal(await page.locator('#escopo-geral .desk-all-metrics .totals').isVisible(),true);
  assert.equal(await page.locator('#escopo-geral .metfil__btn').isVisible(),true);
  await page.locator('#escopo-geral .metfil__btn').click();
  assert.equal(await page.locator('#escopo-geral .metfil__pop').isVisible(),true);
  await page.keyboard.press('Escape');
  await page.locator('.scopebar label[for="e-google"]').click();
  assert.equal(await page.locator('#escopo-google .desk-number').count(),4);
  await page.locator('.scopebar label[for="e-kwai"]').click();
  assert.match(await page.locator('.desk-title').innerText(),/Kwai/);
  await page.locator('.scopebar label[for="e-geral"]').click();
  await page.locator('.desk-period-button').click();
  assert.equal(await page.locator('#r-custom').isChecked(),true);
  assert.equal(await page.locator('#range-de').isVisible(),true);
  await page.keyboard.press('Escape');
  await page.locator('label[for="r-ontem"]').click();
  await page.waitForSelector('#dashboard-root[data-state="pronto"]');
  for(const width of [390,768,1280,1920]){
    await page.setViewportSize({width,height:1000});
    const size=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth}));
    assert.ok(size.scroll<=size.width+1,'Overflow horizontal em '+width+': '+size.scroll);
    await page.screenshot({path:'/private/tmp/bateu-redesign-'+width+'.png'});
  }
  failedTap=true;
  await page.reload();await page.waitForSelector('#dashboard-root[data-state="pronto"]');
  assert.equal(await page.locator('#escopo-geral .desk-number').nth(1).innerText(),'—');
  assert.equal(await page.locator('.desk-ticker-group:not(.desk-ticker-copy) .desk-ticker-value').first().innerText(),'—');
  assert.notEqual(await page.locator('#escopo-geral .desk-number').first().innerText(),'—');
  failedRequest=true;
  await page.reload();await page.waitForSelector('#erro-banner:not([hidden])');
  assert.equal(await page.locator('#escopo-geral .desk-number').first().innerText(),'—');
  assert.deepEqual(errors,[]);
  console.log('OK: dados, gráfico, experts, painel, safra, métricas, canais, período, erro de rede, falha TAP e 4 larguras.');
  await browser.close();
}
module.exports={payload,experts,dias,today,safra};
if(require.main===module)run().catch(e=>{console.error(e);process.exit(1)});
