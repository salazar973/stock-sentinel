"use strict";
/* ============================================================================
   STOCK SENTINEL — cloud engine v2: live session runner (paper trading only)

   Instead of one tick per 5-min cron, this runs a LIVE SESSION on GitHub
   Actions: it connects to Finnhub's real-time websocket (50 symbols, free
   tier), makes a trading decision every TICK_MS, evolves the strategy swarm
   every GEN_TICKS, pushes state.json every SAVE_MS, and exits at market close
   (or at the session time limit — the cron immediately starts a fresh one).

   All money is simulated. Nothing real is ever bought or sold.

   Needs Node 22+ (native WebSocket). No dependencies.
   Requires env FINNHUB_KEY (GitHub repo secret).
   ============================================================================ */

const fs = require("fs");
const { execSync } = require("child_process");
const STATE = "state.json";

/* ---------------- settings (env-overridable for tests) ---------------- */
const START_CASH = 10000;
const WATCH = ["AAPL","MSFT","NVDA","AMZN","GOOGL","META","TSLA","AMD","NFLX","AVGO",
               "JPM","V","MA","UNH","HD","COST","PEP","KO","DIS","BA",
               "INTC","CRM","ORCL","QCOM","PLTR","COIN","SPY","QQQ","WMT","XOM",
               "CVX","PG","JNJ","LLY","MRK","BAC","WFC","GS","MS","T",
               "VZ","CSCO","ADBE","IBM","UBER","MU","F","GM","SOFI","DAL"]; // 50 = Finnhub ws free cap
const POP = 16, ELITE = 5;
const F_MIN = 3, F_MAX = 15, S_MIN = 10, S_MAX = 60;      // EMA genes, in ticks
const TICK_MS    = +process.env.TICK_MS    || 15000;      // decision every 15 s
const GEN_TICKS  = +process.env.GEN_TICKS  || 120;        // evolve every ~30 min
const SAVE_MS    = +process.env.SAVE_MS    || 300000;     // push state every 5 min
const MAX_RUN_MS = +process.env.MAX_RUN_MS || 5.5*3600*1000; // stay under the 6 h job cap
const SEED_MS    = +process.env.SEED_MS    || 1100;       // REST seed spacing (60/min cap)
const HISTMAX = 120, MAX_TRADES = 200, MAX_LOG = 200, MAX_EQ = 800;

/* ---------------- helpers ---------------- */
const clamp = (v,a,b)=>Math.max(a,Math.min(b,v));
const randInt = (a,b)=>a+Math.floor(Math.random()*(b-a+1));
const emaStep = (p,v,per)=> p==null ? v : v*(2/(per+1)) + p*(1-2/(per+1));
const nowISO = ()=> new Date().toISOString();
const sleep = ms => new Promise(r=>setTimeout(r,ms));

function marketOpen(){
  const et = new Intl.DateTimeFormat("en-US",{timeZone:"America/New_York",hour12:false,
    weekday:"short",hour:"numeric",minute:"numeric"})
    .formatToParts(new Date()).reduce((a,p)=>(a[p.type]=p.value,a),{});
  if(et.weekday==="Sat"||et.weekday==="Sun") return false;
  const mins = parseInt(et.hour)*60 + parseInt(et.minute);
  return mins >= 9*60+30 && mins < 16*60;    // 9:30–16:00 ET (ignores holidays)
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

/* ---------------- strategy population ---------------- */
function makeCand(fast, slow){ return {fast, slow, cash:START_CASH, pos:null, ema:{}, count:0}; }
function priceOf(state, sym){ const h = state.hist[sym]; return h && h.length ? h[h.length-1] : null; }
function histLen(state){ return (state.hist[WATCH[0]]||[]).length; }

function warmFromHistory(state, entity, fast, slow){
  entity.ema = {};
  for(const s of WATCH){
    const h = state.hist[s] || []; let f=null, sl=null;
    for(const p of h){ f=emaStep(f,p,fast); sl=emaStep(sl,p,slow); }
    entity.ema[s] = {f, s:sl};
  }
  entity.count = histLen(state);
}
function candEquity(state, c){ return c.cash + (c.pos ? c.pos.qty*priceOf(state,c.pos.sym) : 0); }

function stepCand(state, c){
  for(const s of WATCH){
    const p = priceOf(state,s); if(p==null) continue;
    const e = c.ema[s] || (c.ema[s]={f:null,s:null});
    e.f = emaStep(e.f,p,c.fast); e.s = emaStep(e.s,p,c.slow);
  }
  c.count++;
  if(c.count <= c.slow) return;
  if(c.pos){
    const e = c.ema[c.pos.sym];
    if(e && e.f <= e.s){ c.cash += c.pos.qty*priceOf(state,c.pos.sym); c.pos = null; }
  } else {
    let best=null, bm=0;
    for(const s of WATCH){ const e=c.ema[s]; if(e && e.f>e.s){ const m=(e.f-e.s)/e.s; if(m>bm){ bm=m; best=s; } } }
    if(best){ const p=priceOf(state,best); c.pos={sym:best, qty:c.cash/p, cost:c.cash}; c.cash=0; }
  }
}

function evolve(state, log){
  state.pop.sort((a,b)=>candEquity(state,b)-candEquity(state,a));
  const best = state.pop[0];
  const genome = {fast:best.fast, slow:best.slow};
  state.bestRet = candEquity(state,best)/START_CASH - 1;
  const changed = !state.champ || state.champ.fast!==genome.fast || state.champ.slow!==genome.slow;
  state.champ = genome;
  if(changed){
    warmFromHistory(state, state.rb, genome.fast, genome.slow);
    log(`Gen ${state.gen}: new champion EMA(${genome.fast}/${genome.slow}) · best paper ${(state.bestRet*100>=0?"+":"")+(state.bestRet*100).toFixed(2)}%`);
  }
  const eg = state.pop.slice(0,ELITE).map(c=>({fast:c.fast, slow:c.slow}));
  const next = [];
  for(const g of eg) next.push(makeCand(g.fast, g.slow));
  while(next.length < POP){
    const p = eg[randInt(0,eg.length-1)];
    let fast = clamp(p.fast + randInt(-2,2), F_MIN, F_MAX);
    let slow = clamp(p.slow + randInt(-5,5), Math.max(S_MIN, fast+4), S_MAX);
    next.push(makeCand(fast, slow));
  }
  state.pop = next;
  state.gen++;
  for(const c of state.pop) warmFromHistory(state, c, c.fast, c.slow);
}

/* ---------------- state io ---------------- */
function freshState(){
  const st = { cash:START_CASH, pos:null, trades:[], champ:null, gen:0, tick:0, bestRet:0,
               pop:[], rb:{ema:{}, count:0}, hist:{}, equity:[], log:[], updated:nowISO() };
  for(const s of WATCH) st.hist[s] = [];
  for(let i=0;i<POP;i++){ const f=randInt(F_MIN,F_MAX); const sl=clamp(randInt(f+4,S_MAX),S_MIN,S_MAX); st.pop.push(makeCand(f,sl)); }
  return st;
}
function loadState(){
  try{ const st = JSON.parse(fs.readFileSync(STATE,"utf8"));
    if(!st.pop || !st.pop.length) return freshState();
    for(const s of WATCH) if(!st.hist[s]) st.hist[s]=[];
    return st;
  }catch(e){ return freshState(); }
}
function saveState(st){
  // round numbers to 4dp to keep the committed file small
  fs.writeFileSync(STATE, JSON.stringify(st, (k,v)=> typeof v==="number" && isFinite(v) ? Math.round(v*10000)/10000 : v));
}
function gitPush(msg){
  try{
    execSync(`git add ${STATE} && git -c user.name=stock-sentinel-bot -c user.email=stock-sentinel-bot@users.noreply.github.com commit -m "${msg}" && git push`, {stdio:"ignore"});
  }catch(e){ /* nothing new to commit, or not in a repo (local test) — fine */ }
}

/* ---------------- one decision tick ---------------- */
function tickOnce(state, prices, log){
  // fold latest streamed prices into history
  for(const s of WATCH){
    const p = prices[s]; if(p==null || !isFinite(p)) continue;
    const h = state.hist[s]; h.push(p); while(h.length>HISTMAX) h.shift();
  }
  if(histLen(state)===0) return;

  for(const c of state.pop) stepCand(state, c);
  state.tick++;

  if(!state.champ && state.pop.length){ state.champ={fast:state.pop[0].fast, slow:state.pop[0].slow}; warmFromHistory(state, state.rb, state.champ.fast, state.champ.slow); }
  const g = state.champ;
  for(const s of WATCH){ const p=priceOf(state,s); if(p==null) continue; const e=state.rb.ema[s]||(state.rb.ema[s]={f:null,s:null}); e.f=emaStep(e.f,p,g.fast); e.s=emaStep(e.s,p,g.slow); }
  state.rb.count++;
  if(state.rb.count > g.slow){
    if(state.pos){
      const e = state.rb.ema[state.pos.sym];
      if(e && e.f <= e.s){
        const p = priceOf(state, state.pos.sym), net = state.pos.qty*p, pnl = net - state.pos.cost;
        state.trades.unshift({side:"SELL", sym:state.pos.sym, price:p, qty:state.pos.qty, t:nowISO(), pnl});
        log(`SELL ${state.pos.qty.toFixed(4)} ${state.pos.sym} @ $${p.toFixed(2)} -> ${pnl>=0?"+":""}$${pnl.toFixed(2)}`);
        state.cash += net; state.pos = null;
      }
    } else if(state.cash > 1){
      let best=null, bm=0;
      for(const s of WATCH){ const e=state.rb.ema[s]; if(e && e.f>e.s){ const m=(e.f-e.s)/e.s; if(m>bm){ bm=m; best=s; } } }
      if(best){ const p=priceOf(state,best); const qty=state.cash/p; state.pos={sym:best, qty, cost:state.cash};
        state.trades.unshift({side:"BUY", sym:best, price:p, qty, t:nowISO()});
        log(`BUY ${qty.toFixed(4)} ${best} @ $${p.toFixed(2)} · champion signal`); state.cash = 0; }
    }
  }
  while(state.trades.length > MAX_TRADES) state.trades.pop();

  if(state.tick % GEN_TICKS === 0 && histLen(state) > S_MAX) evolve(state, log);

  if(state.tick % 4 === 0){   // equity point every ~minute
    const eq = state.cash + (state.pos ? state.pos.qty*priceOf(state,state.pos.sym) : 0);
    state.equity.unshift({t:nowISO(), v:Math.round(eq*100)/100});
    while(state.equity.length > MAX_EQ) state.equity.pop();
  }
}

/* ---------------- live data: websocket + REST fallback ---------------- */
function connectWS(key, prices, log){
  return new Promise(resolve=>{
    let settled=false;
    const done = v => { if(!settled){ settled=true; resolve(v); } };
    let ws;
    try{ ws = new WebSocket("wss://ws.finnhub.io/?token="+encodeURIComponent(key)); }
    catch(e){ return done(null); }
    ws.addEventListener("open", ()=>{
      for(const s of WATCH) ws.send(JSON.stringify({type:"subscribe", symbol:s}));
      log(`Websocket connected — streaming live trades for ${WATCH.length} symbols`);
      done(ws);
    });
    ws.addEventListener("message", ev=>{
      try{ const m = JSON.parse(ev.data);
        if(m.type==="trade" && Array.isArray(m.data)) for(const t of m.data) prices[t.s]=t.p;
      }catch(e){}
    });
    ws.addEventListener("error", ()=>done(null));
    ws.addEventListener("close", ()=>done(null));
    setTimeout(()=>{ try{ if(!settled) ws.close(); }catch(e){} done(null); }, 20000);
  });
}
async function pollAll(prices, key, log){
  for(const s of WATCH){
    try{ prices[s] = await fetchQuote(s, key); }
    catch(e){ if(e.message==="ratelimit"){ log("REST rate limit — partial scan"); break; } }
    await sleep(SEED_MS);
  }
}

/* ---------------- main: one live session ---------------- */
async function main(){
  const key = process.env.FINNHUB_KEY;
  const state = loadState();
  const log = msg => { console.log(msg); state.log.unshift({t:nowISO(), msg}); while(state.log.length>MAX_LOG) state.log.pop(); };

  if(!key){ log("No FINNHUB_KEY secret set — cannot fetch quotes"); state.updated=nowISO(); saveState(state); return; }
  if(!marketOpen()){
    log("Market closed — waiting (sessions run 9:30–16:00 ET weekdays)");
    state.updated = nowISO(); saveState(state); return;
  }

  log(`Live session started — ${WATCH.length} symbols, decision every ${TICK_MS/1000}s, evolves every ${Math.round(GEN_TICKS*TICK_MS/60000)} min`);

  // seed every symbol with a REST quote so no one starts blank
  const prices = {};
  for(const s of WATCH){
    try{ prices[s] = await fetchQuote(s, key); }
    catch(e){ if(e.message==="badkey"){ log("Finnhub rejected the key — check the FINNHUB_KEY secret"); state.updated=nowISO(); saveState(state); return; }
              if(e.message==="ratelimit") break; }
    await sleep(SEED_MS);
  }

  const ws = await connectWS(key, prices, log);
  if(!ws) log("Websocket unavailable — falling back to REST polling (about one scan per minute)");

  const start = Date.now();
  let lastSave = Date.now(), lastPoll = Date.now();
  while(true){
    if(!marketOpen()){ log("Market closed — session complete"); break; }
    if(Date.now()-start > MAX_RUN_MS){ log("Session time limit — a fresh session takes over"); break; }
    await sleep(TICK_MS);
    if(!ws && Date.now()-lastPoll >= 60000){ lastPoll = Date.now(); await pollAll(prices, key, log); }
    tickOnce(state, prices, log);
    if(Date.now()-lastSave >= SAVE_MS){
      lastSave = Date.now(); state.updated = nowISO(); saveState(state); gitPush("state: live session update [skip ci]");
    }
  }

  try{ if(ws) ws.close(); }catch(e){}
  state.updated = nowISO(); saveState(state); gitPush("state: session close [skip ci]");
  const eq = state.cash + (state.pos ? state.pos.qty*priceOf(state,state.pos.sym) : 0);
  console.log(`session end | tick ${state.tick} | gen ${state.gen} | champ ${state.champ?`EMA(${state.champ.fast}/${state.champ.slow})`:"—"} | equity $${eq.toFixed(2)} | holding ${state.pos?state.pos.sym:"none"}`);
}

if(require.main === module){
  main().catch(e=>{ console.error("Run failed (state left intact):", e.message); process.exit(0); });
}
module.exports = { main };
