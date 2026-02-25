const fs = require('fs');
const vm = require('vm');

const path = require('path');
const base = path.resolve(__dirname, '..');
const quietConsole = { log:()=>{}, warn:()=>{}, error:()=>{} };
const ctx = { console: quietConsole, setTimeout, clearTimeout };
ctx.document = {
  onkeydown: null,
  addEventListener: ()=>{},
  getElementById: ()=>({ value:'', innerHTML:'', src:'', style:{}, setAttribute:()=>{} }),
  querySelector: ()=>null,
  querySelectorAll: ()=>[],
  body: { innerHTML:'' }
};
ctx.window = ctx;
vm.createContext(ctx);
ctx.fetch = fetch;

function load(file){ return fs.readFileSync(`${base}/${file}`,'utf8'); }
vm.runInContext(load('state.js'), ctx);
vm.runInContext(load('utils.js'), ctx);
vm.runInContext(load('data.js'), ctx);
vm.runInContext(load('experiment.js'), ctx);

const TARGET=1, REPEAT=2, FILLER=3, VIGILANCE=4;

function calcLags(seq, types){
  const out={target:[], vigilance:[]};
  const firstSeen=new Map();
  for(let i=0;i<seq.length;i++){
    const id=(seq[i]||'').split('/').pop();
    const t=types[i];
    if(t===TARGET || t===FILLER){
      if(!firstSeen.has(id)) firstSeen.set(id,i);
    } else if(t===REPEAT){
      const j=firstSeen.get(id);
      if(j!==undefined) out.target.push(i-j);
    } else if(t===VIGILANCE){
      const j=firstSeen.get(id);
      if(j!==undefined) out.vigilance.push(i-j);
    }
  }
  return out;
}

(async()=>{
  await ctx.ensureImagesLoaded();
  const participants = Array.from({length:50},(_,i)=>`p${i+1}`);
  const summary = {
    participants: participants.length,
    overlapViolations:0,
    targetLagViolations:0,
    vigilanceLagViolations:0,
    nullSlotViolations:0,
    sequenceBuildErrors:0,
    samples:[]
  };

  for(const p of participants){
    try{
      ctx.initializeParticipantLevels(p);
      const levels = ctx.manifestData.levels;
      const keys = Object.keys(levels);
      const seen = new Set();
      for(const k of keys){
        const level=levels[k];
        [...level.targets,...level.fillers].forEach(u=>{
          if(seen.has(u)) summary.overlapViolations++;
          seen.add(u);
        });
      }

      for(const k of keys){
        ctx.currentLevelKey = k;
        const built = ctx.buildLevelSequence(k);
        if(built.sequence.some(x=>!x)) summary.nullSlotViolations++;
        const lags = calcLags(built.sequence,built.types);
        const badT = lags.target.filter(x=>x<ctx.targetRepeatDelayMin || x>ctx.targetRepeatDelayMax).length;
        const badV = lags.vigilance.filter(x=>x<1 || x>ctx.vigilanceRepeatMaxGap).length;
        summary.targetLagViolations += badT;
        summary.vigilanceLagViolations += badV;
        if(summary.samples.length<5){
          summary.samples.push({participant:p,level:k,targetLagMin:Math.min(...lags.target),targetLagMax:Math.max(...lags.target),vigilanceLagMin:Math.min(...lags.vigilance),vigilanceLagMax:Math.max(...lags.vigilance),badT,badV});
        }
      }
    }catch(e){
      summary.sequenceBuildErrors++;
    }
  }

  fs.writeFileSync(`${base}/reports/step3_constraints.json`, JSON.stringify(summary,null,2));
  console.log(JSON.stringify(summary,null,2));
})();
