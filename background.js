// background.js - Jury.ai v12 - thin orchestrator + message router
// Shared modules (registry, cdp helpers, block-detection, logging) are pulled in
// here; this file owns session state, the message router, and the run pipeline.
importScripts('logger.js','providers.js','cdp.js','detect.js','strategies.js','jury.js');

let session=null,tab2model={},model2tab={};
const WATCHDOG_MS=300000; // hard per-model deadline → mark failed, keep the run going

// Race a promise against a hard deadline so one stuck tab can't hang the whole run.
function withTimeout(promise,ms,label){
  return Promise.race([promise,new Promise((_,rej)=>setTimeout(()=>rej(new Error(label+' watchdog timeout')),ms))]);
}
// Retry a step; errors flagged .nonRetriable (blocks) bypass retries.
async function withRetry(fn,{attempts=2,backoff=2000}={}){
  let lastErr;
  for(let i=0;i<attempts;i++){
    try{return await fn(i);}
    catch(e){lastErr=e;if(e&&e.nonRetriable)throw e;if(i<attempts-1)await delay(backoff*(i+1));}
  }
  throw lastErr;
}

// Bug #6: dual write
async function saveState(o){await chrome.storage.session.set(o).catch(()=>{});await chrome.storage.local.set(o).catch(()=>{});}
async function loadState(k){try{return await chrome.storage.session.get(k);}catch{return chrome.storage.local.get(k);}}

chrome.runtime.onMessage.addListener((msg,_,res)=>{
  if(msg.type==='GET_STATE'){loadState(['session']).then(r=>res(r?.session||null));return true;}
  if(msg.type==='SEND_PROMPT'){
    // settings carried from popup so the (popup-less) background can auto-judge
    session={sessionId:msg.sessionId,prompt:msg.prompt,responses:{},settings:msg.settings||{},verdict:null,raw:'',judging:false};
    saveState({session});
    sendAll(msg.prompt).catch(console.error);
    res({ok:true});return true;
  }
  if(msg.type==='RUN_JUDGE'){
    // Manual trigger reuses the same background-owned path so the verdict is persisted.
    startJury(true);
    res({ok:true});return true;
  }
  if(msg.type==='CLEAR_SESSION'){
    Object.keys(tab2model).forEach(id=>chrome.debugger.detach({tabId:+id},()=>chrome.runtime.lastError));
    tab2model={};model2tab={};session=null;saveState({session:null});res({ok:true});return true;
  }
  if(msg.type==='GET_LOGS'){res(getLogs());return true;}
  if(msg.type==='CLEAR_LOGS'){clearLogs();res({ok:true});return true;}
  if(msg.type==='DIAGNOSE'){diagnose(msg.models).then(res).catch(e=>res({error:e.message}));return true;}
});

// Dry-run health check: per provider, open the tab and report which selectors
// currently match (input/send/capture) + any block — WITHOUT sending a prompt.
// Catches UI drift before a real run. Detaches/closes tabs it had to open.
async function firstMatch(tabId,sels){
  return await evalTab(tabId,`(function(){const ss=${JSON.stringify(sels||[])};for(const s of ss){try{if(document.querySelector(s.trim()))return s.trim();}catch(e){}}return null;})()`);
}
async function diagnose(models){
  const targets=(models&&models.length?models:Object.keys(PROVIDERS));
  const report=[];
  for(const m of targets){
    const cfg=providerCfg(m)||{};
    const row={model:m,opened:false};
    let tabId=model2tab[m];
    try{
      if(!tabId){
        const found=await chrome.tabs.query({url:URLS[m]+'*'});
        if(found.length){tabId=found[0].id;}
        else{const t=await chrome.tabs.create({url:URLS[m],active:false});tabId=t.id;row.opened=true;await tabReady(tabId);}
      }
      await attachDbg(tabId).catch(()=>{});
      await waitRenderer(tabId,8000);
      row.block=await detectBlock(m,tabId);
      row.input=await firstMatch(tabId,cfg.input);
      row.send=await firstMatch(tabId,cfg.send);
      row.capture_copy=cfg.capture&&cfg.capture.copy?await firstMatch(tabId,[cfg.capture.copy]):null;
      row.capture_dom=await firstMatch(tabId,(cfg.capture&&cfg.capture.dom)||[]);
      row.ok=!row.block&&!!row.input;
      log('info',m,'diagnose',row);
    }catch(e){row.error=e.message;row.ok=false;}
    finally{if(row.opened&&tabId){chrome.debugger.detach({tabId},()=>chrome.runtime.lastError);chrome.tabs.remove(tabId,()=>chrome.runtime.lastError);}}
    report.push(row);
  }
  return {report};
}

async function sendAll(prompt){
  ARENA.forEach(m=>updateResp(m,{status:'waiting',text:''}));
  const allM=[...new Set([...ARENA,JUDGE])]; // dedupe: Gemini may be both arena + judge
  const tabs=await Promise.all(allM.map(m=>getOrCreate(m)));
  try{const gid=await chrome.tabs.group({tabIds:tabs.map(t=>t.id)});await chrome.tabGroups.update(gid,{title:'Jury.ai',color:'yellow'});}catch{}
  for(let i=0;i<allM.length;i++){model2tab[allM[i]]=tabs[i].id;tab2model[tabs[i].id]=allM[i];}
  for(const[,id] of Object.entries(model2tab)) await attachDbg(id).catch(e=>console.warn(e.message));
  await delay(5000); // Bug #22: Grok React mount
  await Promise.all(ARENA.map(m=>processModel(m,model2tab[m],prompt)));
}

// Per-model state machine wrapped in a watchdog. One stuck/blocked model can't
// hang the run; the orchestrator proceeds on whatever subset reaches 'done'.
async function processModel(model,tabId,prompt){
  try{
    await withTimeout(runModelPipeline(model,tabId,prompt),WATCHDOG_MS,model);
  }catch(e){
    log('error',model,'pipeline.fail',{error:e.message});
    // Don't clobber a terminal block status already set by the pipeline.
    const cur=session&&session.responses[model]&&session.responses[model].status;
    if(!['done','login_required','rate_limited'].includes(cur)){
      const reason=e&&e.reason?e.reason:/watchdog|capture/i.test(e.message)?'no_capture':'error';
      updateResp(model,{status:'error',text:'',error:e.message});
      notify(model,reason,reason==='error'?e.message:undefined);
    }
  }
  checkDone();
}

// inject → send → done → capture, with block-detection gates and per-step retry.
async function runModelPipeline(model,tabId,prompt){
  await tabReady(tabId);
  await waitRenderer(tabId);
  await delay(1500);
  await chrome.tabs.update(tabId,{active:true});
  await delay(600);
  // Pre-injection block detection (login wall / rate-limit / captcha) — non-retriable.
  const block=await detectBlock(model,tabId);
  if(block){
    const status=block==='rate_limited'?'rate_limited':block==='login_required'?'login_required':'error';
    updateResp(model,{status,text:'',error:blockMsg(block)});
    notify(model,block);
    return;
  }
  await withRetry(async()=>{
    updateResp(model,{status:'injecting'});
    // Gemini keeps its proven custom paste/read path even when answering as an arena model.
    if(model==='gemini'){
      await geminiPaste(tabId,prompt);
      updateResp(model,{status:'waiting_response'});
      const txt=await readGemini(tabId);
      if(!txt){
        const post=await detectBlock(model,tabId);
        if(post){
          const status=post==='rate_limited'?'rate_limited':post==='login_required'?'login_required':'error';
          updateResp(model,{status,text:'',error:blockMsg(post)});
          notify(model,post);
          const err=new Error('blocked: '+post);err.nonRetriable=true;throw err;
        }
        throw new Error('capture failed');
      }
      updateResp(model,{status:'done',text:txt});
      return;
    }
    await runInject(tabId,model,prompt);
    updateResp(model,{status:'waiting_response'});
    await runSend(tabId,model);
    await runDone(tabId,model);
    const cap=await runCapture(tabId,model,prompt);
    if(!cap){
      // A popup may have appeared mid-generation — re-check before retrying.
      const post=await detectBlock(model,tabId);
      if(post){
        const status=post==='rate_limited'?'rate_limited':post==='login_required'?'login_required':'error';
        updateResp(model,{status,text:'',error:blockMsg(post)});
        notify(model,post);
        const err=new Error('blocked: '+post);err.nonRetriable=true;throw err;
      }
      throw new Error('capture failed');
    }
    updateResp(model,{status:'done',text:cap.text});
  },{attempts:2,backoff:2500});
}

// ── Gemini judge ──────────────────────────────────────────────────────────────
async function findGeminiTab(){
  const found=await chrome.tabs.query({url:'https://gemini.google.com/*'});
  if(found.length)return found[0].id;
  const t=await chrome.tabs.create({url:URLS.gemini,active:false});
  await tabReady(t.id);return t.id;
}

async function geminiPaste(tabId,text){
  await chrome.tabs.update(tabId,{active:true});await delay(800);
  // Use CDP Input.insertText — avoids clipboard permission issues in service workers
  const sels=GEMINI_IN.split(',');
  // Focus and clear input
  const found=await evalTab(tabId,`(function(){
    const ss=${JSON.stringify(sels)};
    for(const s of ss){const el=document.querySelector(s.trim());if(el){el.focus();document.execCommand('selectAll');document.execCommand('delete');return s.trim();}}
    return null;
  })()`);
  if(!found){console.warn('[Jury.ai] Gemini input not found');return;}
  await delay(300);
  // Insert text in chunks via CDP to avoid length limits
  const enc=new TextEncoder();let rem=text;
  while(rem.length>0){
    let chunk=rem;
    while(enc.encode(chunk).length>480)chunk=chunk.slice(0,chunk.length-1);
    rem=rem.slice(chunk.length);
    await cdpCmd(tabId,'Input.insertText',{text:chunk});
    await delay(80);
  }
  // Fire input event so Gemini's React picks up the text
  await evalTab(tabId,`(function(){
    const ss=${JSON.stringify(sels)};
    for(const s of ss){const el=document.querySelector(s.trim());if(el){el.dispatchEvent(new InputEvent('input',{bubbles:true,composed:true}));break;}}
  })()`);
  await delay(500);
  // Click send — covers current Gemini UI (data-testid, aria-label, and tooltip patterns)
  const t0=Date.now();
  while(Date.now()-t0<5000){
    const ok=await evalTab(tabId,`(function(){
      const b=document.querySelector('button[data-testid*="send" i],button[aria-label*="Send" i],button[aria-label*="submit" i]')
        ||Array.from(document.querySelectorAll('button')).find(x=>
          x.querySelector('mat-icon')?.textContent?.trim()==='send'||
          (x.getAttribute('aria-label')||'').toLowerCase().includes('send'));
      if(b&&!b.disabled){b.click();return true;}return false;
    })()`);
    if(ok)break;await delay(300);
  }
}

// Bug #18: poll send re-enabled + 2s; Bug #9: length>100 — updated selectors for current Gemini UI
async function readGemini(tabId,timeout=90000){
  await delay(3000);const t0=Date.now();
  while(Date.now()-t0<timeout){
    // Send button re-enabled = generation done
    const ready=await evalTab(tabId,`(function(){
      const b=document.querySelector('button[data-testid*="send" i],button[aria-label*="Send" i],button[aria-label*="submit" i]')
        ||Array.from(document.querySelectorAll('button')).find(x=>x.querySelector('mat-icon')?.textContent?.trim()==='send');
      return b?!b.disabled:false;
    })()`);
    if(ready){
      await delay(1500);
      // Try all known Gemini response container selectors
      const txt=await evalTab(tabId,`(function(){
        const sel=[
          'message-content .markdown',
          'model-response .markdown',
          '.response-container .markdown',
          'message-content',
          'model-response',
          '.response-container-content',
          '[data-response-index]',
          '.model-response-text'
        ];
        for(const s of sel){
          const bs=document.querySelectorAll(s);
          if(bs.length){const l=bs[bs.length-1];const t=l.innerText?.trim();if(t&&t.length>50)return t;}
        }
        return '';
      })()`);
      if(txt&&txt.length>100)return txt;
    }
    await delay(600);
  }
  return null;
}

// Single-judge runJudge() has been replaced by the jury panel in jury.js (runJury).
// Gemini is still driven by geminiPaste/readGemini below — reused as the primary juror.

async function getOrCreate(model){
  const url=URLS[model];
  const found=await chrome.tabs.query({url:url+'*'});
  return found.length?found[0]:chrome.tabs.create({url,active:false});
}

function updateResp(model,data){
  if(session){session.responses[model]={...session.responses[model],...data};saveState({session});}
  chrome.runtime.sendMessage({type:'RESPONSE_UPDATE',model,data}).catch(()=>{});
}

function checkDone(){
  if(!session)return;
  const term=s=>['done','error','login_required','rate_limited'].includes(s);
  if(ARENA.every(m=>term(session.responses[m]?.status))){
    chrome.runtime.sendMessage({type:'ALL_DONE'}).catch(()=>{});
    maybeAutoJudge();
  }
}

// ── Background-owned judging ─────────────────────────────────────────────────────
// The popup closes the moment we focus an LLM tab, so judging is orchestrated here
// (the service worker survives). The verdict is persisted into session state, and
// broadcast for any popup that happens to be open. On reopen the popup reads it back.
let juryRunning=false;
function maybeAutoJudge(){
  if(!session||juryRunning||session.verdict)return;
  if(session.settings&&session.settings.autoJudge===false)return; // default on
  if(!ARENA.some(m=>session.responses[m]?.status==='done'))return; // nothing to judge
  startJury(false);
}
async function startJury(force){
  if(!session||juryRunning)return;
  if(!force&&session.verdict)return;
  const responses={};
  ARENA.forEach(m=>{if(session.responses[m]?.status==='done')responses[m]=session.responses[m].text||'';});
  if(!Object.keys(responses).length){chrome.runtime.sendMessage({type:'JUDGE_ERROR',error:'No responses to judge'}).catch(()=>{});return;}
  juryRunning=true;
  session.judging=true;session.verdict=null;saveState({session});
  chrome.runtime.sendMessage({type:'JUDGE_STARTED'}).catch(()=>{});
  try{
    const panel=!(session.settings&&session.settings.juryPanel===false); // default on
    const {verdict,raw}=await runJury(responses,session.prompt,{panel});
    session.verdict=verdict;session.raw=raw;session.judging=false;saveState({session});
    chrome.runtime.sendMessage({type:'JUDGE_DONE',verdict,raw}).catch(()=>{});
  }catch(e){
    session.judging=false;saveState({session});
    log('error','jury','run.fail',{error:e.message});
    chrome.runtime.sendMessage({type:'JUDGE_ERROR',error:e.message}).catch(()=>{});
  }finally{juryRunning=false;}
}

// Bug #21: cleanup debugger
chrome.debugger.onDetach.addListener(src=>{const m=tab2model[src.tabId];if(m){delete model2tab[m];delete tab2model[src.tabId];}});
