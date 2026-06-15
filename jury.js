// jury.js - Jury.ai - research-backed independent jury (replaces single judge)
// Instead of one "supreme judge", an independent panel of available judge-role
// providers each score the arena responses, and we aggregate by majority vote.
// Bias mitigations from LLM-as-a-judge research:
//   • position bias  → responses anonymised as A/B/C, order randomised per judge
//   • verbosity bias → Pass-1 compresses each answer to its core (normalises length)
//   • self-preference→ a judge never scores/votes its own arena response
//   • independent panel, NOT debate (debate amplifies bias)
// Degrades gracefully to whatever judges are reachable, down to quorum 1.
// Absorbs the old prompts.js (now identity-blind). Drives Gemini via the proven
// geminiPaste/readGemini path, and any other judge via the generic strategy chain.

const PENALISE=['sycophancy','padding','disclaimers','hallucination','hedging','irrelevance'];
const REWARD=['clarity','specific_facts','actionable','faithfulness','completeness','conciseness'];
const CRITERIA=PENALISE.concat(REWARD);

// ── anonymisation ────────────────────────────────────────────────────────────────
function shuffle(a){const r=a.slice();for(let i=r.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));const t=r[i];r[i]=r[j];r[j]=t;}return r;}
function respText(v){return typeof v==='object'&&v?(v.text||''):(v||'');}

// Randomise candidate order and label A/B/C… so judges can't tell who is who.
function anonymize(responses){
  const order=shuffle(Object.keys(responses));
  const letters=order.map((_,i)=>String.fromCharCode(65+i));
  const letterToModel={};
  order.forEach((m,i)=>{letterToModel[letters[i]]=m;});
  const blocks=order.map((m,i)=>`=== Response ${letters[i]} ===\n${respText(responses[m])}`).join('\n\n');
  return {order,letters,letterToModel,blocks};
}

// ── identity-blind prompts (Pass 1 compress, Pass 2 score) ────────────────────────
function buildCompressPrompt(originalPrompt,anon){
  const L=anon.letters.join(', ');
  return `You are a neutral judge. The user asked:\n"${originalPrompt}"\n\nHere are ${anon.letters.length} AI responses, labelled ${L}:\n\n${anon.blocks}\n\nFor each response (${L}), compress their answer to its single core message in 1-2 sentences.\nReturn ONLY:\n${anon.letters.map(x=>`${x}_CORE: <core message>`).join('\n')}`;
}
function buildScorePrompt(anon){
  const L=anon.letters;
  const tmpl='{"sycophancy":"no","padding":"no","disclaimers":"no","hallucination":"no","hedging":"no","irrelevance":"no","clarity":"yes","specific_facts":"yes","actionable":"yes","faithfulness":"yes","completeness":"yes","conciseness":"yes"}';
  const scoresObj=L.map(x=>`"${x}":${tmpl}`).join(',');
  return `Using the compressed summaries (${L.map(x=>x+'_CORE').join(', ')}), evaluate each response YES/NO only. No explanations.\n\nPENALISE (YES=bad): sycophancy, padding, disclaimers, hallucination, hedging, irrelevance\nREWARD (YES=good): clarity, specific_facts, actionable, faithfulness, completeness, conciseness\n\nReturn ONLY raw JSON:\n{"scores":{${scoresObj}},"winner":"${L[0]}","synthesis":"2-3 sentence ideal answer"}`;
}

// ── verdict parsing (letter-keyed) ────────────────────────────────────────────────
function parseLetterVerdict(raw,letters){
  try{
    const ms=[...raw.matchAll(/\{[\s\S]*\}/g)];
    let js=null;
    for(let i=ms.length-1;i>=0;i--){const c=ms[i][0];if(c.includes('"scores"')||letters.some(L=>c.includes('"'+L+'"')||c.includes('"'+L.toLowerCase()+'"'))){js=c;break;}}
    if(!js)return null;
    js=js.replace(/"([A-Za-z_]+)":/g,(_,k)=>`"${k.toLowerCase()}":`);
    return JSON.parse(js);
  }catch(e){log('warn','jury','parse.fail',{error:e.message});return null;}
}
function normLetterVerdict(o,letters){
  if(!o)return null;
  const src=o.scores||{};const scores={};
  letters.forEach(L=>{scores[L]=src[L]??src[L.toLowerCase()]??{};});
  return {scores,winner:(o.winner||'').toString().toUpperCase().trim(),synthesis:o.synthesis||''};
}
// Map a judge's letter verdict back to model ids, dropping its own response (self-guard).
function judgeToModelVerdict(lv,anon,judgeModel){
  const scores={};
  anon.letters.forEach(L=>{const m=anon.letterToModel[L];if(m!==judgeModel)scores[m]=lv.scores[L]||{};});
  const wm=anon.letterToModel[lv.winner];
  return {scores,winner:(wm&&wm!==judgeModel)?wm:'',synthesis:lv.synthesis};
}

// ── aggregation (majority vote per criterion + winner vote, minority-veto ties) ────
function modelScore(cell){let s=0;PENALISE.forEach(c=>{if((''+(cell[c]||'')).toLowerCase()!=='yes')s++;});REWARD.forEach(c=>{if((''+(cell[c]||'')).toLowerCase()==='yes')s++;});return s;}

function aggregateVerdicts(perJudge,arenaModels){
  const scores={},conf={};
  let confSum=0,confCells=0;
  arenaModels.forEach(m=>{
    scores[m]={};conf[m]={};
    CRITERIA.forEach(c=>{
      let yes=0,tot=0;
      perJudge.forEach(j=>{const cell=j.verdict.scores[m];if(cell&&typeof cell[c]!=='undefined'){tot++;if((''+cell[c]).toLowerCase()==='yes')yes++;}});
      const decision=(tot>0&&yes*2>tot)?'yes':'no';
      scores[m][c]=decision;
      // criterion confidence = share of scoring judges that agreed with the decision
      const agreeing=decision==='yes'?yes:(tot-yes);
      const cc=tot>0?agreeing/tot:0;
      conf[m][c]=Math.round(cc*100)/100;
      if(tot>0){confSum+=cc;confCells++;}
    });
  });
  // winner = plurality of judge votes; tie → minority-veto via aggregate score; still tie → none
  const votes={};
  perJudge.forEach(j=>{if(j.verdict.winner)votes[j.verdict.winner]=(votes[j.verdict.winner]||0)+1;});
  let winner='',max=-1,tie=false;
  Object.keys(votes).forEach(m=>{const v=votes[m];if(v>max){max=v;winner=m;tie=false;}else if(v===max)tie=true;});
  if(tie||!winner){
    let best='',bs=-1,bt=false;
    arenaModels.forEach(m=>{const s=modelScore(scores[m]);if(s>bs){bs=s;best=m;bt=false;}else if(s===bs)bt=true;});
    winner=bt?'':best;
  }
  const wj=perJudge.find(j=>j.verdict.winner===winner);
  const synthesis=(wj||perJudge[0]).verdict.synthesis||'';
  const totalVotes=Object.keys(votes).reduce((a,m)=>a+votes[m],0)||perJudge.length;
  // winnerAgreement = how many judges backed the winner; criterionAgreement = mean
  // per-criterion consensus (captures disagreement the winner vote alone hides).
  const agreement=(winner&&votes[winner])?Math.round((votes[winner]/totalVotes)*100)/100:0;
  const criterionAgreement=confCells?Math.round((confSum/confCells)*100)/100:0;
  return {scores,winner,synthesis,conf,jury:{judges:perJudge.map(j=>j.judge),count:perJudge.length,votes,agreement,criterionAgreement}};
}

// ── judge driving ─────────────────────────────────────────────────────────────────
// Gemini keeps its proven custom paste/read path; any other judge uses the generic
// strategy chain (inject → send → done → capture) so adding a judge is registry-only.
async function driveJudge(model,tabId,text){
  if(model==='gemini'){await geminiPaste(tabId,text);return await readGemini(tabId);}
  await runInject(tabId,model,text);
  await runSend(tabId,model);
  await runDone(tabId,model);
  const cap=await runCapture(tabId,model,text);
  return cap?cap.text:null;
}

// Pick the judge panel: reuse already-open, reachable judge-role tabs (arena models
// that just answered + any open judge), and ensure Gemini as the primary judge.
async function selectJudges(opts){
  opts=opts||{};
  const wantPanel=opts.panel!==false;
  const judges=[];
  if(wantPanel){
    for(const m of providersWithRole('judge')){
      if(m==='gemini')continue;
      const tabId=model2tab[m];
      if(!tabId)continue;
      const block=await detectBlock(m,tabId);
      if(block){log('warn',m,'judge.skip_unreachable',{block});continue;}
      judges.push({model:m,tabId,detach:false});
    }
  }
  let gid=model2tab['gemini'],detach=false;
  if(!gid){gid=await findGeminiTab();await attachDbg(gid).catch(()=>{});await waitRenderer(gid);detach=true;}
  judges.push({model:'gemini',tabId:gid,detach});
  log('info','jury','panel.selected',{judges:judges.map(j=>j.model)});
  return judges;
}

// ── orchestration ─────────────────────────────────────────────────────────────────
async function runJury(responses,originalPrompt,opts){
  const arenaModels=Object.keys(responses||{}).filter(m=>respText(responses[m]).trim().length);
  if(!arenaModels.length)throw new Error('No responses to judge');
  const judges=await selectJudges(opts);
  if(!judges.length)throw new Error('No judges reachable');

  const perJudge=[];
  for(let i=0;i<judges.length;i++){
    const J=judges[i];
    try{
      const block=await detectBlock(J.model,J.tabId);
      if(block){notify(J.model,block);log('warn',J.model,'judge.blocked',{block});continue;}
      const anon=anonymize(pickResponses(responses,arenaModels));
      chrome.runtime.sendMessage({type:'JUDGE_PROGRESS',step:1,judge:J.model,judgeIndex:i,judgeCount:judges.length}).catch(()=>{});
      const core=await driveJudge(J.model,J.tabId,buildCompressPrompt(originalPrompt,anon));
      if(!core){const b=await detectBlock(J.model,J.tabId);if(b)notify(J.model,b);log('warn',J.model,'judge.pass1_fail',{});continue;}
      chrome.runtime.sendMessage({type:'JUDGE_PROGRESS',step:2,judge:J.model,judgeIndex:i,judgeCount:judges.length}).catch(()=>{});
      const raw=await driveJudge(J.model,J.tabId,buildScorePrompt(anon));
      if(!raw){const b=await detectBlock(J.model,J.tabId);if(b)notify(J.model,b);log('warn',J.model,'judge.pass2_fail',{});continue;}
      const lv=normLetterVerdict(parseLetterVerdict(raw,anon.letters),anon.letters);
      if(!lv){log('warn',J.model,'judge.parse_fail',{});continue;}
      perJudge.push({judge:J.model,verdict:judgeToModelVerdict(lv,anon,J.model),raw});
      log('info',J.model,'judge.ok',{winner:judgeToModelVerdict(lv,anon,J.model).winner});
    }catch(e){log('warn',J.model,'judge.err',{error:e.message});}
    finally{if(J.detach)chrome.debugger.detach({tabId:J.tabId},()=>chrome.runtime.lastError);}
  }
  if(!perJudge.length)throw new Error('All judges failed');
  const verdict=aggregateVerdicts(perJudge,arenaModels);
  log('info','jury','verdict',{winner:verdict.winner,count:verdict.jury.count,agreement:verdict.jury.agreement});
  return {verdict,raw:perJudge.map(j=>`[${j.judge}] winner=${j.verdict.winner}\n${j.raw}`).join('\n\n---\n\n')};
}

function pickResponses(responses,models){const o={};models.forEach(m=>{o[m]=responses[m];});return o;}
