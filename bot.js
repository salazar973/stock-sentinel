"use strict";
/* ============================================================================
   STOCK SENTINEL — cloud engine v3: event-driven live trader (paper only)

   Reacts to every streamed trade in real time (milliseconds), not on a clock:
     - Finnhub websocket streams live trades for 50 symbols (free tier cap).
     - EMAs are TIME-BASED (tau in seconds) so irregular trade arrivals are
       handled correctly: k = 1 - exp(-dt/tau).
     - EXITS are checked on every incoming trade of the held symbol
       (crossover down OR stop-loss). ENTRIES are scanned every 500 ms.
     - Every strategy has a 4-gene genome: fast tau, slow tau, stop-loss %,
       minimum momentum to enter. A population of 16 forward-tests live;
       every GEN_MS the winners breed and the champion trades the portfolio.
     - Every fill pays COST_BPS (spread/slippage stand-in) so high-frequency
       churn cannot fake its P/L. All money is simulated.

   Needs Node 22+ (native WebSocket). No dependencies.
   Requires env FINNHUB_KEY (GitHub repo secret).
   ============================================================================ */

const fs = require("fs");
const { execSync } = require("child_process");
const STATE = "state.json";
const NUM = (name, def) => (process.env[name] != null && isFinite(+process.env[name])) ? +process.env[name] : def;

/* ---------------- settings ---------------- */
const START_CASH = 10000;
const WATCH = ["AAPL","MSFT","NVDA","AMZN","GOOGL","META","TSLA","AMD","NFLX","AVGO",
               "JPM","V","MA","UNH","HD","COST","PEP","KO","DIS","BA",
               "INTC","CRM","ORCL","QCOM","PLTR","COIN","SPY","QQQ","WMT","XOM",
               "CVX","PG","JNJ","LLY","MRK","BAC","WFC","GS","MS","T",
               "VZ","CSCO","ADBE","IBM","UBER","MU","F","GM","SOFI","DAL"]; // 50 = ws free cap
const POP = 16, ELITE = 5;
const COST_BPS   = NUM("COST_BPS", 3);          // per-side cost: fee + spread/slippage stand-in
const GEN_MS     = NUM("GEN_MS", 30*60*1000);   // evolve every 30 min
const SCAN_MS    = NUM("SCAN_MS", 500);         // entry scan cadence
const SAMPLE_MS  = NUM("SAMPLE_MS", 15000);     // dashboard price sampling
const SAVE_MS    = NUM("SAVE_MS", 5*60*1000);   // push state cadence
const MAX_RUN_MS = NUM("MAX_RUN_MS", 5.5*3600*1000);
const SEED_MS    = NUM("SEED_MS", 1100);        // REST seed spacing (60/min cap)
const WARM_MS    = process.env.WARM_MS ? +process.env.WARM_MS : null; // test override
/* genome ranges */
const FT_MIN = NUM("FT_MIN", 5),   FT_MAX = NUM("FT_MAX", 120);   // fast tau, seconds
const ST_MIN = NUM("ST_MIN", 20),  ST_MAX = NUM("ST_MAX", 900);   // slow tau, seconds
const STOP_MIN = 0.002, STOP_MAX = 0.02;                          // stop-loss 0.2%–2%
const MOM_MIN = 0.0002, MOM_MAX = 0.002;                          // entry momentum 2–20 bps
const HISTMAX = 120, MAX_TRADES = 300, MAX_LOG = 200, MAX_EQ = 800;

/* ---------------- helpers ---------------- */
const clamp = (v,a,b)=>Math.max(a,Math.min(b,v));
const rand = (a,b)=>a+Math.random()*(b-a);
const mut = (v,a,b)=>clamp(v*Math.exp((Math.random()-0.5)*0.5), a, b);
const nowISO = ()=> new Date().toISOString();
const sleep = ms => new Promise(r=>setTimeout(r,ms));
const cost = ()=> COST_BPS/10000;

function marketOpen(){
  const et = new Intl.DateTimeFormat("en-US",{timeZone:"America/New_York",hour12:false,
    weekday:"short",hour:"numeric",minute:"numeric"})
    .formatToParts(new Date()).reduce((a,p)=>(a[p.type]=p.value,a),{});
  if(et.weekday==="Sat"||et.weekday==="Sun") return false;
  const mins = parseInt(et.hour)*60 + parseInt(et.minute);
  return mins >= 9*60+30 && mins < 16*60;
}

async function fetchQuote(sym, key){
  const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(sym)}&token=${encodeURIComponent(key)}`;
  const r = await fetch(url);
  if(r.status===401 || r.status===403) throw new Error("badkey");
  if(r.status===429) throw new Error("ratelimit");
  const j = await r.json();
  if(!j.c || !isFinite(j.c)) throw new Error("badsymbol");
  return j.c;
}

/* ---------------- time-based EMA ---------------- */
function emaUpd(e, p, t, tau){
  if(e.v==null){ e.v=p; e.t=t; return; }
  const dt = Math.max(0, (t - e.t)/1000);
  const k = 1 - Math.exp(-dt/tau);
  e.v += k*(p - e.v); e.t = t;
}

/* ---------------- entities (candidates + the real bot) ---------------- */
const last = {};              // sym -> latest price
let sessionStart = 0;

function newGenes(){
  const ft = rand(FT_MIN, FT_MAX);
  return { ft, st: rand(Math.max(ST_MIN, ft*3), ST_MAX), stop: rand(STOP_MIN, STOP_MAX), mom: rand(MOM_MIN, MOM_MAX) };
}
function childGenes(p){
  const ft = mut(p.ft, FT_MIN, FT_MAX);
  return { ft, st: clamp(mut(p.st, ST_MIN, ST_MAX), Math.max(ST_MIN, ft*3), ST_MAX),
           stop: mut(p.stop, STOP_MIN, STOP_MAX), mom: mut(p.mom, MOM_MIN, MOM_MAX) };
}
function makeEntity(genes, bornAt){
  const ema = {};
  for(const s of WATCH) ema[s] = { f:{v:last[s]??null, t:bornAt}, s:{v:last[s]??null, t:bornAt} };
  return { ...genes, cash:START_CASH, pos:null, ema, bornAt };
}
const ready = (e, t)=> t - e.bornAt >= (WARM_MS ?? e.st*1500);
const equityOf = e => e.cash + (e.pos ? e.pos.qty*(last[e.pos.sym]||0) : 0);

function entityUpdate(e, sym, p, t){
  const m = e.ema[sym]; if(!m) return;
  emaUpd(m.f, p, t, e.ft); emaUpd(m.s, p, t, e.st);
}
function entityExit(e, sym, p, t, onSell){
  if(!e.pos || e.pos.sym!==sym || !ready(e,t)) return;
  const m = e.ema[sym];
  const stopped = p <= e.pos.entry*(1 - e.stop);
  const crossed = m.f.v!=null && m.s.v!=null && m.f.v <= m.s.v;
  if(stopped || crossed){
    const net = e.pos.qty*p*(1-cost());
    const pnl = net - e.pos.cost;
    if(onSell) onSell(sym, p, e.pos.qty, pnl, stopped?"stop-loss":"momentum flip");
    e.cash += net; e.pos = null;
  }
}
function entityEnter(e, t, onBuy){
  if(e.pos || e.cash <= 1 || !ready(e,t)) return;
  let best=null, bm=e.mom;                 // must beat the genome's entry threshold
  for(const s of WATCH){
    const m=e.ema[s]; if(m.f.v==null || m.s.v==null || !m.s.v) continue;
    const g=(m.f.v-m.s.v)/m.s.v;
    if(g>bm){ bm=g; best=s; }
  }
  if(best && last[best]){
    const p=last[best], spend=e.cash, qty=spend*(1-cost())/p;
    if(onBuy) onBuy(best, p, qty);
    e.pos = { sym:best, qty, cost:spend, entry:p }; e.cash = 0;
  }
}

/* ---------------- state io ---------------- */
function freshState(){
  return { v:3, cash:START_CASH, pos:null, trades:[], champ:null, gen:0, bestRet:0, warm:false,
           pop:[], rb:null, hist:Object.fromEntries(WATCH.map(s=>[s,[]])), equity:[], log:[], updated:nowISO() };
}
function loadState(){
  try{
    const st = JSON.parse(fs.readFileSync(STATE,"utf8"));
    if(st.v!==3) { const f=freshState(); f.cash=st.cash??START_CASH; f.trades=st.trades||[]; f.equity=st.equity||[]; f.log=st.log||[]; return f; } // migrate v1/v2: keep money history
    for(const s of WATCH) if(!st.hist[s]) st.hist[s]=[];
    return st;
  }catch(e){ return freshState(); }
}
function saveState(st){
  fs.writeFileSync(STATE, JSON.stringify(st,(k,v)=> typeof v==="number"&&isFinite(v) ? Math.round(v*10000)/10000 : v));
}
function gitPush(msg){
  try{ execSync(`git add ${STATE} && git -c user.name=stock-sentinel-bot -c user.email=stock-sentinel-bot@users.noreply.github.com commit -m "${msg}" && git push`, {stdio:"ignore"}); }
  catch(e){ /* nothing to commit / local test — fine */ }
}

/* ---------------- main: one live session ---------------- */
async function main(){
  const key = process.env.FINNHUB_KEY;
  const state = loadState();
  const log = msg => { console.log(msg); state.log.unshift({t:nowISO(), msg}); while(state.log.length>MAX_LOG) state.log.pop(); };

  if(!key){ log("No FINNHUB_KEY secret set — cannot fetch quotes"); state.updated=nowISO(); saveState(state); return; }
  if(!marketOpen()){ log("Market closed — waiting (sessions run 9:30–16:00 ET weekdays)"); state.updated=nowISO(); saveState(state); return; }

  sessionStart = Date.now();
  log(`Live session v3 — ${WATCH.length} symbols, event-driven (exits on every trade, entries every ${SCAN_MS} ms), ${COST_BPS} bps cost per side`);

  // seed prices via REST so every symbol starts with a value
  for(const s of WATCH){
    try{ last[s] = await fetchQuote(s, key); }
    catch(e){ if(e.message==="badkey"){ log("Finnhub rejected the key — check the FINNHUB_KEY secret"); state.updated=nowISO(); saveState(state); return; }
              if(e.message==="ratelimit") break; }
    await sleep(SEED_MS);
  }

  // population + real bot follow the champion genome
  const t0 = Date.now();
  let pop = state.pop.length===POP && state.pop[0].ft
    ? state.pop.map(c=>makeEntity({ft:c.ft, st:c.st, stop:c.stop, mom:c.mom}, t0))
    : Array.from({length:POP}, ()=>makeEntity(newGenes(), t0));
  let champ = state.champ && state.champ.ft ? state.champ : {ft:pop[0].ft, st:pop[0].st, stop:pop[0].stop, mom:pop[0].mom};
  let rb = makeEntity(champ, t0);          // real bot's market view
  rb.cash = state.cash; rb.pos = state.pos;  // …but the real portfolio

  const sellLog = (sym,p,qty,pnl,why)=> { state.trades.unshift({side:"SELL",sym,price:p,qty,t:nowISO(),pnl});
    log(`SELL ${qty.toFixed(4)} ${sym} @ $${p.toFixed(2)} · ${why} -> ${pnl>=0?"+":""}$${pnl.toFixed(2)}`); };
  const buyLog  = (sym,p,qty)=> { state.trades.unshift({side:"BUY",sym,price:p,qty,t:nowISO()});
    log(`BUY ${qty.toFixed(4)} ${sym} @ $${p.toFixed(2)} · champion signal`); };

  /* --- event handler: every streamed trade, in the millisecond it arrives --- */
  function onTrade(sym, p, t){
    last[sym] = p;
    for(const c of pop){ entityUpdate(c,sym,p,t); entityExit(c,sym,p,t,null); }
    entityUpdate(rb,sym,p,t); entityExit(rb,sym,p,t,sellLog);
    while(state.trades.length>MAX_TRADES) state.trades.pop();
  }

  /* --- websocket --- */
  const ws = await new Promise(resolve=>{
    let settled=false; const done=v=>{ if(!settled){settled=true; resolve(v);} };
    let sock; try{ sock = new WebSocket("wss://ws.finnhub.io/?token="+encodeURIComponent(key)); }catch(e){ return done(null); }
    sock.addEventListener("open", ()=>{ for(const s of WATCH) sock.send(JSON.stringify({type:"subscribe",symbol:s}));
      log("Websocket connected — reacting to every trade in real time"); done(sock); });
    sock.addEventListener("message", ev=>{ try{ const m=JSON.parse(ev.data);
      if(m.type==="trade" && Array.isArray(m.data)) for(const tr of m.data) onTrade(tr.s, tr.p, tr.t||Date.now());
    }catch(e){} });
    sock.addEventListener("error", ()=>done(null));
    sock.addEventListener("close", ()=>done(null));
    setTimeout(()=>{ try{ if(!settled) sock.close(); }catch(e){} done(null); }, 20000);
  });
  if(!ws) log("Websocket unavailable — REST fallback (one scan per minute; far less lively)");

  /* --- entry scanner (twice a second) --- */
  const scanIv = setInterval(()=>{ const t=Date.now();
    for(const c of pop) entityEnter(c,t,null);
    entityEnter(rb,t,buyLog);
  }, SCAN_MS);

  /* --- evolution --- */
  function evolve(){
    pop.sort((a,b)=>equityOf(b)-equityOf(a));
    const best = pop[0];
    state.bestRet = equityOf(best)/START_CASH - 1;
    const g = {ft:best.ft, st:best.st, stop:best.stop, mom:best.mom};
    const changed = !champ || Math.abs(champ.ft-g.ft)>0.01 || Math.abs(champ.st-g.st)>0.01;
    champ = g; state.champ = g; state.gen++;
    if(changed){
      const keepCash=rb.cash, keepPos=rb.pos;
      rb = makeEntity(g, Date.now()); rb.cash=keepCash; rb.pos=keepPos;
      log(`Gen ${state.gen}: new champion τ ${g.ft.toFixed(0)}s/${g.st.toFixed(0)}s · stop ${(g.stop*100).toFixed(2)}% · best paper ${(state.bestRet*100>=0?"+":"")+(state.bestRet*100).toFixed(2)}%`);
    }
    const t=Date.now();
    const elite = pop.slice(0,ELITE).map(c=>({ft:c.ft,st:c.st,stop:c.stop,mom:c.mom}));
    pop = elite.map(e=>makeEntity(e,t));
    while(pop.length<POP) pop.push(makeEntity(childGenes(elite[Math.floor(Math.random()*elite.length)]), t));
  }

  /* --- main timers loop --- */
  let lastSave=Date.now(), lastGen=Date.now(), lastSample=Date.now(), lastPoll=Date.now(), lastEq=Date.now();
  while(true){
    if(!marketOpen()){ log("Market closed — session complete"); break; }
    if(Date.now()-sessionStart > MAX_RUN_MS){ log("Session time limit — a fresh session takes over"); break; }
    await sleep(Math.min(SCAN_MS, 1000));
    const now = Date.now();
    if(!ws && now-lastPoll>=60000){ lastPoll=now;
      for(const s of WATCH){ try{ onTrade(s, await fetchQuote(s,key), Date.now()); }catch(e){ if(e.message==="ratelimit") break; } await sleep(SEED_MS); } }
    if(now-lastSample>=SAMPLE_MS){ lastSample=now;
      for(const s of WATCH){ if(last[s]!=null){ const h=state.hist[s]; h.push(last[s]); while(h.length>HISTMAX) h.shift(); } } }
    if(now-lastEq>=60000){ lastEq=now;
      state.equity.unshift({t:nowISO(), v:Math.round(equityOf(rb)*100)/100}); while(state.equity.length>MAX_EQ) state.equity.pop(); }
    if(now-lastGen>=GEN_MS){ lastGen=now; evolve(); }
    if(now-lastSave>=SAVE_MS){ lastSave=now; snapshot(); saveState(state); gitPush("state: live update [skip ci]"); }
  }

  function snapshot(){
    state.cash = rb.cash; state.pos = rb.pos; state.champ = champ;
    state.warm = ready(rb, Date.now());
    state.rb = { ema: rb.ema };   // champion's live market view, for the dashboard board
    state.pop = pop.map(c=>({ft:c.ft, st:c.st, stop:c.stop, mom:c.mom, cash:c.cash, pos:c.pos ? {sym:c.pos.sym, qty:c.pos.qty} : null}));
    state.updated = nowISO();
  }

  clearInterval(scanIv);
  try{ if(ws) ws.close(); }catch(e){}
  snapshot(); saveState(state); gitPush("state: session close [skip ci]");
  console.log(`session end | gen ${state.gen} | champ τ ${champ.ft.toFixed(0)}s/${champ.st.toFixed(0)}s | equity $${equityOf(rb).toFixed(2)} | holding ${rb.pos?rb.pos.sym:"none"}`);
}

if(require.main === module){
  main().catch(e=>{ console.error("Run failed (state left intact):", e.message); process.exit(0); });
}
module.exports = { main };
