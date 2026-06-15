// popup.js - Jury.ai v12
const AM=['chatgpt','claude','grok','gemini'];
const MM={chatgpt:{label:'ChatGPT',icon:'🤖'},claude:{label:'Claude',icon:'🔶'},grok:{label:'Grok',icon:'G'},gemini:{label:'Gemini',icon:'✦'}};
const CR=[
  {key:'sycophancy',label:'Sycophancy',p:true},{key:'padding',label:'Padding',p:true},
  {key:'disclaimers',label:'Disclaimers',p:true},{key:'hallucination',label:'Hallucination',p:true},
  {key:'hedging',label:'Hedging',p:true},{key:'irrelevance',label:'Irrelevance',p:true},
  {key:'clarity',label:'Clarity',p:false},{key:'specific_facts',label:'Specific Facts',p:false},
  {key:'actionable',label:'Actionable',p:false},{key:'faithfulness',label:'Faithfulness',p:false},
  {key:'completeness',label:'Completeness',p:false},{key:'conciseness',label:'Conciseness',p:false},
];
let state={prompt:'',responses:{},sessionId:null},settings={autoJudge:true,showSynthesis:true,juryPanel:true};
const $=id=>document.getElementById(id);

function loadSettings(){
  try{const r=localStorage.getItem('jurySettings');if(r)settings={...settings,...JSON.parse(r)};}catch{}
  $('auto-judge').checked=settings.autoJudge;$('show-synthesis').checked=settings.showSynthesis;
  if($('jury-panel'))$('jury-panel').checked=settings.juryPanel;
}

// FIX: all event listeners moved inside DOMContentLoaded so DOM elements exist
document.addEventListener('DOMContentLoaded',async()=>{

  // Settings panel toggles — were previously top-level (null ref crash before DOM ready)
  $('settings-btn').addEventListener('click',()=>$('settings-panel').classList.toggle('open'));
  $('settings-save').addEventListener('click',()=>{
    settings.autoJudge=$('auto-judge').checked;settings.showSynthesis=$('show-synthesis').checked;
    settings.juryPanel=$('jury-panel').checked;
    try{localStorage.setItem('jurySettings',JSON.stringify(settings));}catch{}
    $('settings-panel').classList.remove('open');
  });

  $('diagnose-btn').addEventListener('click',runDiagnose);
  $('debug-btn').addEventListener('click',toggleDebug);
  $('clear-logs-btn').addEventListener('click',()=>{chrome.runtime.sendMessage({type:'CLEAR_LOGS'});$('debug-log').innerHTML='';});

  $('prompt-input').addEventListener('input',()=>{
    $('char-count').textContent=$('prompt-input').value.length;
    updateSendBtn();
  });

  $('send-btn').addEventListener('click',()=>{
    const prompt=$('prompt-input').value.trim();if(!prompt)return;
    const sessionId=Date.now().toString(36);state={prompt,responses:{},sessionId};
    renderCards();AM.forEach(id=>setStatus(id,'waiting',''));
    $('verdict-panel').classList.add('hidden');$('action-bar').classList.remove('hidden');
    $('judge-btn').disabled=true;$('judge-progress').classList.add('hidden');
    $('jury-stats')?.classList.add('hidden');
    chrome.runtime.sendMessage({type:'SEND_PROMPT',prompt,sessionId,settings});
  });

  $('clear-btn').addEventListener('click',()=>{
    chrome.runtime.sendMessage({type:'CLEAR_SESSION'});
    state={prompt:'',responses:{},sessionId:null};$('prompt-input').value='';$('char-count').textContent='0';
    updateSendBtn();renderCards();$('action-bar').classList.add('hidden');
    $('judge-progress').classList.add('hidden');$('verdict-panel').classList.add('hidden');
  });

  $('judge-btn').addEventListener('click',runJudge);

  renderCards();
  loadSettings();

  const saved=await chrome.runtime.sendMessage({type:'GET_STATE'});
  if(saved?.prompt){
    state={...state,...saved};$('prompt-input').value=saved.prompt;$('char-count').textContent=saved.prompt.length;
    updateSendBtn();updateCards();$('action-bar').classList.remove('hidden');
    const term=s=>['done','error','login_required','rate_limited'].includes(s);
    if(AM.every(id=>term(state.responses[id]?.status))&&AM.some(id=>state.responses[id]?.status==='done'))
      $('judge-btn').disabled=false;
    // Background owns judging now — reflect its persisted result/progress on reopen.
    if(saved.verdict)renderVerdict(saved.verdict);
    else if(saved.judging)showJudgeStartUI();
  }

  chrome.runtime.onMessage.addListener(handleMsg);
});

function renderCards(){
  $('cards-grid').innerHTML='';
  AM.forEach(id=>{
    const m=MM[id];
    $('cards-grid').innerHTML+=`<div class="model-card" id="card-${id}">
      <div class="card-header">
        <div class="card-title"><span class="card-icon">${m.icon}</span><span>${m.label}</span></div>
        <div style="display:flex;align-items:center;gap:5px">
          <span class="status-text" id="st-${id}">idle</span>
          <span class="status-dot idle" id="dot-${id}"></span>
        </div>
      </div>
      <div class="card-body empty" id="body-${id}">Waiting...</div>
    </div>`;
  });
}

function updateCards(){AM.forEach(id=>{const r=state.responses[id];if(r)setStatus(id,r.status||'idle',r.text||r.error||'');});}

function setStatus(id,status,text){
  const card=$('card-'+id),dot=$('dot-'+id),st=$('st-'+id),body=$('body-'+id);if(!card)return;
  card.classList.remove('receiving','done','errored','winner');dot.className='status-dot';
  const map={idle:['idle','Idle'],waiting:['waiting','Waiting...'],injecting:['waiting','Injecting...'],
    waiting_response:['receiving','Receiving...'],done:['done','Done'],error:['error','Error'],
    login_required:['error','Login needed'],rate_limited:['error','Rate limited']};
  const[cls,lbl]=map[status]||['idle',status];dot.classList.add(cls);st.textContent=lbl;
  if(status==='done')card.classList.add('done');
  if(status==='waiting_response')card.classList.add('receiving');
  if(['error','login_required','rate_limited'].includes(status))card.classList.add('errored');
  if(text?.length>0){body.classList.remove('empty');body.textContent=text.slice(0,400);}
}

function updateSendBtn(){$('send-btn').disabled=!$('prompt-input').value.trim();}

function showJudgeStartUI(){
  $('judge-btn').disabled=true;$('judge-progress').classList.remove('hidden');
  document.querySelectorAll('.step-dot').forEach(d=>d.className='step-dot');
  document.querySelectorAll('.judge-step').forEach(s=>s.classList.remove('done'));
  $('step-1').querySelector('.step-dot').classList.add('active');
}
// Judging is orchestrated in the background (popup may be closed when responses land);
// the popup only requests it and reflects progress/results pushed back or restored.
function runJudge(){showJudgeStartUI();chrome.runtime.sendMessage({type:'RUN_JUDGE'});}

// ── Diagnose dry-run + debug log panel ───────────────────────────────────────────
async function runDiagnose(){
  const box=$('diag-results');box.classList.remove('hidden');box.textContent='Running diagnostics…';
  try{
    const r=await chrome.runtime.sendMessage({type:'DIAGNOSE'});
    if(!r||r.error){box.textContent='Diagnose failed: '+((r&&r.error)||'no response');return;}
    box.innerHTML=r.report.map(row=>{
      const mark=row.ok?'&#9989;':'&#10060;';
      const bits=[];
      if(row.block)bits.push('<span class="diag-bad">block: '+row.block+'</span>');
      bits.push('input '+(row.input?'&#10003;':'<span class="diag-bad">&#10007;</span>'));
      bits.push('send '+(row.send?'&#10003;':'<span class="diag-bad">&#10007;</span>'));
      bits.push('capture '+((row.capture_copy||row.capture_dom)?'&#10003;':'<span class="diag-bad">&#10007;</span>'));
      if(row.error)bits.push('<span class="diag-bad">err: '+row.error+'</span>');
      return '<div class="diag-row">'+mark+' <b>'+row.model+'</b> — '+bits.join(', ')+'</div>';
    }).join('');
  }catch(e){box.textContent='Diagnose failed: '+e.message;}
}

async function toggleDebug(){
  const p=$('debug-panel');p.classList.toggle('hidden');
  if(p.classList.contains('hidden'))return;
  const logs=await chrome.runtime.sendMessage({type:'GET_LOGS'})||[];
  $('debug-log').innerHTML=logs.slice(-200).reverse().map(e=>{
    const ts=new Date(e.t).toLocaleTimeString();
    const data=e.data?(' '+JSON.stringify(e.data)):'';
    return '<div class="log-line log-'+e.level+'"><span class="log-t">'+ts+'</span> <b>'+(e.model||'')+'</b> '+e.event+data+'</div>';
  }).join('')||'<div class="log-line">No logs yet.</div>';
}

function handleMsg(msg){
  if(msg.type==='RESPONSE_UPDATE'){
    state.responses[msg.model]={...state.responses[msg.model],...msg.data};
    setStatus(msg.model,msg.data.status,msg.data.text||msg.data.error||'');
    checkAuto();
  }
  if(msg.type==='ALL_DONE')checkAuto();
  if(msg.type==='JUDGE_STARTED')showJudgeStartUI();
  if(msg.type==='JUDGE_PROGRESS'){
    if(msg.step===1)$('step-1').querySelector('.step-dot').classList.add('active');
    if(msg.step===2){
      const d=$('step-1').querySelector('.step-dot');d.classList.remove('active');d.classList.add('done');
      $('step-1').classList.add('done');$('step-2').querySelector('.step-dot').classList.add('active');
    }
  }
  if(msg.type==='JUDGE_DONE'){
    const d=$('step-2').querySelector('.step-dot');d.classList.remove('active');d.classList.add('done');$('step-2').classList.add('done');
    setTimeout(()=>{$('judge-progress').classList.add('hidden');if(msg.verdict)renderVerdict(msg.verdict);},500);
  }
  if(msg.type==='JUDGE_ERROR'){$('judge-progress').classList.add('hidden');$('judge-btn').disabled=false;alert('Judge error: '+msg.error);}
}

// Background triggers the jury (it survives the popup closing); here we just enable
// the manual button once responses are terminal. No popup-side auto-trigger to avoid
// double-running when the popup happens to stay open.
function checkAuto(){
  const term=s=>['done','error','login_required','rate_limited'].includes(s);
  const anyDone=AM.some(id=>state.responses[id]?.status==='done');
  const allDone=AM.every(id=>term(state.responses[id]?.status));
  if(allDone&&anyDone)$('judge-btn').disabled=false;
}

function renderVerdict(v){
  $('verdict-panel').classList.remove('hidden');
  const scores=v.scores??v;const winner=(v.winner||'').toLowerCase();const conf=v.conf||null;
  AM.forEach(id=>$('card-'+id)?.classList.remove('winner'));
  if(winner&&MM[winner])$('card-'+winner)?.classList.add('winner');
  $('winner-chip').textContent=winner?((MM[winner]?.label??winner)+' wins'):'No consensus';
  // Jury stats: judge count, winner consensus, mean criteria consensus, vote split
  const js=$('jury-stats');
  if(v.jury){
    const j=v.jury;
    const wa=Math.round((j.agreement||0)*100);
    const ca=Math.round((j.criterionAgreement||0)*100);
    const votes=j.votes?Object.keys(j.votes).map(m=>`${MM[m]?.label??m} ${j.votes[m]}`).join(' · '):'';
    js.classList.remove('hidden');
    js.innerHTML=`<span class="jstat"><b>${j.count}</b> judge${j.count===1?'':'s'}: ${j.judges.map(x=>MM[x]?.label??x).join(', ')}</span>`
      +`<span class="jstat">Winner consensus <b>${wa}%</b></span>`
      +`<span class="jstat">Criteria consensus <b>${ca}%</b></span>`
      +(votes?`<span class="jstat">Votes: ${votes}</span>`:'');
  }else js.classList.add('hidden');
  const row=$('scores-row');row.innerHTML='';
  AM.forEach(id=>{
    const c=scores[id]??scores[id.charAt(0).toUpperCase()+id.slice(1)]??{};
    let s=0;
    for(const k of['sycophancy','padding','disclaimers','hallucination','hedging','irrelevance'])if((c[k]||'').toLowerCase()!=='yes')s++;
    for(const k of['clarity','specific_facts','actionable','faithfulness','completeness','conciseness'])if((c[k]||'').toLowerCase()==='yes')s++;
    row.innerHTML+=`<div class="score-card${id===winner?' winner-card':''}"><div class="score-model">${MM[id].icon} ${MM[id].label}</div><div class="score-num">${s}</div><div class="score-max">/ 12</div></div>`;
  });
  if(settings.showSynthesis&&v.synthesis){$('synthesis-box').classList.remove('hidden');$('synthesis-text').textContent=v.synthesis;}
  else $('synthesis-box').classList.add('hidden');
  let html='<table><thead><tr><th>Criterion</th>'+AM.map(id=>`<th>${MM[id].label}</th>`).join('')+'</tr></thead><tbody>';
  for(const c of CR){
    html+=`<tr><td class="crit-label">${c.label}</td>`;
    for(const id of AM){
      const cr=scores[id]??scores[id.charAt(0).toUpperCase()+id.slice(1)]??{};
      const isYes=(cr[c.key]||'').toLowerCase()==='yes';
      const good=c.p?!isYes:isYes;
      const cc=conf&&conf[id]&&typeof conf[id][c.key]!=='undefined'?conf[id][c.key]:null;
      const dissent=cc!==null&&cc<1;
      const title=cc!==null?` title="${Math.round(cc*100)}% of judges agreed"`:'';
      html+=`<td class="${good?'crit-yes':'crit-no'}${dissent?' crit-dissent':''}"${title}>${good?'&#10003;':'&#10007;'}${dissent?'<sup class="crit-conf">'+Math.round(cc*100)+'%</sup>':''}</td>`;
    }
    html+='</tr>';
  }
  html+='</tbody></table>';$('criteria-table-wrap').innerHTML=html;
}
