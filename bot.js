"use strict";
/* ============================================================================
   STOCK SENTINEL — cloud engine (paper trading, simulated money only)

   Runs ONE tick per invocation on GitHub Actions (cron every 5 min). It learns
   and trades with your computer off. All money is pretend — nothing real is bought.

   Flow each run:
     load state.json -> (market open?) -> fetch Finnhub quotes -> update the
     strategy population's EMAs + shadow trades -> champion trades the real paper
     portfolio -> evolve every GEN_TICKS -> write state.json back.

   Needs Node 18+ (Actions runners have 20+). No dependencies (native fetch).
   Requires env FINNHUB_KEY (set as a GitHub repo secret).
   ============================================================================ */

const fs = require("fs");
const STATE = "state.json";

/* ---------------- settings ---------------- */
const START_CASH = 10000;
const WATCH = ["AAPL","MSFT","NVDA","AMZN","GOOGL","META","TSLA","AMD","NFLX","AVGO",
               "JPM","V","UNH","HD","COST","DIS","INTC","CRM","PLTR","SPY"];
const POP = 16, ELITE = 5;
const GEN_TICKS = 12;                 // evolve ~hourly (12 * 5min)
const F_MIN = 3, F_MAX = 9, S_MIN = 10, S_MAX = 30;   // EMA gene ranges (in 5-min ticks)
const HISTMAX = 64;                   // closes kept per symbol (warm-start + dashboard)
const MAX_TRADES = 120, MAX_LOG = 160, MAX_EQ = 600;

/* ---------------- helpers ---------------- */
const clamp = (v,a,b)=>Math.max(a,Math.min(b,v));
const randInt = (a,b)=>a+Math.floor(Math.random()*(b-a+1));
const emaStep = (p,v,per)=> p==null ? v : v*(2/(per+1)) + p*(1-2/(per+1));
const nowISO = ()=> new Date().toISOString();

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
  return j.c;                                 // "c" = current price
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
  if(c.count <= c.slow) return;               // warming
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
    warmFromHistory(state, state.rb, genome.fast, genome.slow);   // recalibrate real bot, keep cash/pos
    log(`Gen ${state.gen}: new champion EMA(${genome.fast}/${genome.slow}) · best paper ${(state.bestRet*100>=0?"+":"")+(state.bestRet*100).toFixed(2)}%`);
  }
  const eg = state.pop.slice(0,ELITE).map(c=>({fast:c.fast, slow:c.slow}));
  const next = [];
  for(const g of eg) next.push(makeCand(g.fast, g.slow));
  while(next.length < POP){
    const p = eg[randInt(0,eg.length-1)];
    let fast = clamp(p.fast + randInt(-1,1), F_MIN, F_MAX);
    let slow = clamp(p.slow + randInt(-3,3), Math.max(S_MIN, fast+2), S_MAX);
    next.push(makeCand(fast, slow));
  }
  state.pop = next;
  state.gen++;
  for(const c of state.pop) warmFromHistory(state, c, c.fast, c.slow);   // fresh + warm from history
}

/* ---------------- state io ---------------- */
function freshState(){
  const st = { cash:START_CASH, pos:null, trades:[], champ:null, gen:0, tick:0, bestRet:0,
               pop:[], rb:{ema:{}, count:0}, hist:{}, equity:[], log:[], updated:nowISO() };
  for(const s of WATCH) st.hist[s] = [];
  for(let i=0;i<POP;i++){ const f=randInt(F_MIN,F_MAX); const sl=clamp(randInt(f+2,S_MAX),S_MIN,S_MAX); st.pop.push(makeCand(f,sl)); }
  return st;
}
function loadState(){
  try{ const st = JSON.parse(fs.readFileSync(STATE,"utf8"));
    if(!st.pop || !st.pop.length) return freshState();
    for(const s of WATCH) if(!st.hist[s]) st.hist[s]=[];
    return st;
  }catch(e){ return freshState(); }
}
function saveState(st){ fs.writeFileSync(STATE, JSON.stringify(st)); }

/* ---------------- main (one tick) ---------------- */
async function main(){
  const key = process.env.FINNHUB_KEY;
  const state = loadState();
  const logs = [];
  const log = msg => { logs.push(msg); state.log.unshift({t:nowISO(), msg}); while(state.log.length>MAX_LOG) state.log.pop(); };

  if(!key){ log("No FINNHUB_KEY secret set — cannot fetch quotes"); state.updated=nowISO(); saveState(state); console.log(logs.join("\n")); return; }

  if(!marketOpen()){
    log("Market closed — waiting (no trades outside 9:30–16:00 ET weekdays)");
    state.updated = nowISO(); saveState(state); console.log(logs.join("\n")); return;
  }

  // fetch quotes; tolerate individual failures, bail only if the key is rejected
  let got = 0;
  for(const s of WATCH){
    try{
      const p = await fetchQuote(s, key);
      const h = state.hist[s]; h.push(p); while(h.length>HISTMAX) h.shift();
      got++;
    }catch(e){
      if(e.message==="badkey"){ log("Finnhub rejected the key — check the FINNHUB_KEY secret"); state.updated=nowISO(); saveState(state); console.log(logs.join("\n")); return; }
      if(e.message==="ratelimit"){ log("Hit Finnhub rate limit — skipping the rest of this tick"); break; }
      // badsymbol/network: skip this symbol this tick
    }
    await new Promise(r=>setTimeout(r,120));   // pace requests
  }
  if(got===0){ log("Could not fetch any quotes this tick — will retry next run"); state.updated=nowISO(); saveState(state); console.log(logs.join("\n")); return; }

  // population learns
  for(const c of state.pop) stepCand(state, c);
  state.tick++;

  // real paper portfolio follows the champion
  if(!state.champ && state.pop.length){ state.champ = {fast:state.pop[0].fast, slow:state.pop[0].slow}; warmFromHistory(state, state.rb, state.champ.fast, state.champ.slow); }
  if(state.champ){
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
  }
  while(state.trades.length > MAX_TRADES) state.trades.pop();

  // evolve
  if(state.tick % GEN_TICKS === 0 && histLen(state) > S_MAX) evolve(state, log);

  // record equity point
  const equity = state.cash + (state.pos ? state.pos.qty*priceOf(state,state.pos.sym) : 0);
  state.equity.unshift({t:nowISO(), v:Math.round(equity*100)/100});
  while(state.equity.length > MAX_EQ) state.equity.pop();

  state.updated = nowISO();
  saveState(state);
  console.log(`tick ${state.tick} | gen ${state.gen} | champ ${state.champ?`EMA(${state.champ.fast}/${state.champ.slow})`:"—"} | equity $${equity.toFixed(2)} | holding ${state.pos?state.pos.sym:"none"}`);
  if(logs.length) console.log(logs.join("\n"));
}

if(require.main === module){
  main().catch(e=>{ console.error("Run failed (state left intact):", e.message); process.exit(0); });
}
module.exports = { main };
