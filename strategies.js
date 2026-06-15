// strategies.js - Jury.ai - ordered fallback chains for each pipeline step
// Each pipeline step (inject, send, capture, done) is an ordered list of strategies
// tried until one succeeds. Every attempt is logged so we can see which won/failed,
// which makes the run survive a single selector/UI drift on any site.
// Primitives reused from cdp.js (cdpCmd, evalTab, delay) and providers.js (registry).

// ── shared helpers ───────────────────────────────────────────────────────────────
function escTpl(s){return s.replace(/\\/g,'\\\\').replace(/`/g,'\\`').replace(/\$/g,'\\$');}
function inputSelsFor(model){return (providerCfg(model)||{}).input||[];}
function sendSelsFor(model){return (providerCfg(model)||{}).send||[];}
function captureCfg(model){return (providerCfg(model)||{}).capture||{};}

const USER_BUBBLE='[data-message-author-role="user"],.user-message,[data-testid="human-message"],[class*="UserMessage"]';
const STOP_SEL='button[aria-label*="Stop" i],button[data-testid*="stop" i],button[aria-label*="generating" i],button svg rect[width="10"],button svg rect[width="11"]';

// Focus first matching input + selectAll/delete to clear it. Returns matched selector or null.
async function focusClear(tabId,sels){
  return await evalTab(tabId,`(function(){
    const ss=${JSON.stringify(sels)};
    for(const s of ss){const el=document.querySelector(s.trim());if(el){el.focus();document.execCommand('selectAll');document.execCommand('delete');return s.trim();}}
    return null;
  })()`);
}

// Current text content of first matching input (used to verify inject/send worked).
async function inputText(tabId,sels){
  return (await evalTab(tabId,`(function(){
    const ss=${JSON.stringify(sels)};
    for(const s of ss){const el=document.querySelector(s.trim());if(el)return (el.value||el.innerText||'').trim();}
    return '';
  })()`))||'';
}

async function fireInput(tabId,sels){
  await evalTab(tabId,`(function(){const ss=${JSON.stringify(sels)};for(const s of ss){const el=document.querySelector(s.trim());if(el){el.dispatchEvent(new InputEvent('input',{bubbles:true,composed:true}));break;}}})()`);
}

// chunk a string to <=480 UTF-8 bytes and run fn(chunk) sequentially
async function eachChunk(text,fn){
  const enc=new TextEncoder();let rem=text;
  while(rem.length>0){
    let chunk=rem;
    while(enc.encode(chunk).length>480)chunk=chunk.slice(0,chunk.length-1);
    rem=rem.slice(chunk.length);
    await fn(chunk);
    await delay(80);
  }
}

// DOM innerText of the last assistant message (excludes user bubbles). '' if none.
async function scrapeText(tabId,sels){
  return (await evalTab(tabId,`(function(){
    const ss=${JSON.stringify(sels)};
    for(const s of ss){
      const ns=Array.from(document.querySelectorAll(s)).filter(n=>!n.closest('${USER_BUBBLE}'));
      if(ns.length){const t=(ns[ns.length-1].innerText||'').trim();if(t)return t;}
    }
    return '';
  })()`))||'';
}

function cleanCapture(text){
  return text.replace(/^(ChatGPT|Claude|Grok|Gemini) said:\s*/i,'').replace(/\s*(ChatGPT|Claude|Grok|Gemini)$/i,'').trim();
}

// ── INJECT chain ─────────────────────────────────────────────────────────────────
async function injectCDP(tabId,sel,text){await eachChunk(text,c=>cdpCmd(tabId,'Input.insertText',{text:c}));}
async function injectExec(tabId,sel,text){
  await eachChunk(text,async c=>{const esc=escTpl(c);
    await evalTab(tabId,`(function(){const el=document.querySelector(${JSON.stringify(sel)});if(el){el.focus();document.execCommand('insertText',false,\`${esc}\`);}})()`);});
}
async function injectPaste(tabId,sel,text){
  await eachChunk(text,async c=>{const esc=escTpl(c);
    await evalTab(tabId,`(function(){const el=document.querySelector(${JSON.stringify(sel)});if(!el)return;el.focus();const dt=new DataTransfer();dt.setData('text/plain',\`${esc}\`);dt.setData('text/html','');el.dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true}));})()`);});
}
const INJECT_STRATEGIES=[
  {name:'cdp-insertText',fn:injectCDP},
  {name:'execCommand',fn:injectExec},
  {name:'paste-event',fn:injectPaste},
];

// Try inject strategies until the input box reflects the typed text.
async function runInject(tabId,model,text){
  const sels=inputSelsFor(model);
  const sel=await focusClear(tabId,sels);
  if(!sel){log('warn',model,'inject.no_input',{});const e=new Error(`${model}: input not found`);e.reason='no_input';throw e;}
  await delay(200);
  const need=Math.min(8,text.length);
  for(const s of INJECT_STRATEGIES){
    try{
      await focusClear(tabId,sels);
      await s.fn(tabId,sel,text);
      await fireInput(tabId,sels);
      await delay(250);
      const got=await inputText(tabId,sels);
      if(got&&got.length>=need){log('info',model,'inject.ok',{strategy:s.name,len:got.length});return s.name;}
      log('warn',model,'inject.empty',{strategy:s.name});
    }catch(e){log('warn',model,'inject.err',{strategy:s.name,error:e.message});}
  }
  throw new Error(`${model}: all inject strategies failed`);
}

// ── SEND chain ───────────────────────────────────────────────────────────────────
async function sendClick(tabId,model){
  const sels=sendSelsFor(model);
  return await evalTab(tabId,`(function(){const ss=${JSON.stringify(sels)};for(const s of ss){const b=document.querySelector(s);if(b&&!b.disabled){b.click();return true;}}return false;})()`);
}
async function sendEnter(tabId,model){
  const sels=inputSelsFor(model);
  return await evalTab(tabId,`(function(){const ss=${JSON.stringify(sels)};for(const s of ss){const el=document.querySelector(s.trim());if(el){el.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',keyCode:13,which:13,bubbles:true,cancelable:true}));return true;}}return false;})()`);
}
async function sendCmdEnter(tabId,model){
  const sels=inputSelsFor(model);
  return await evalTab(tabId,`(function(){const ss=${JSON.stringify(sels)};for(const s of ss){const el=document.querySelector(s.trim());if(el){el.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',keyCode:13,which:13,metaKey:true,ctrlKey:true,bubbles:true,cancelable:true}));return true;}}return false;})()`);
}
const SEND_STRATEGIES=[
  {name:'click',fn:sendClick},
  {name:'enter',fn:sendEnter},
  {name:'cmd-enter',fn:sendCmdEnter},
];

// Try send strategies until the input clears (= submission accepted).
async function runSend(tabId,model){
  const sels=inputSelsFor(model);
  for(const s of SEND_STRATEGIES){
    try{
      const fired=await s.fn(tabId,model);
      if(!fired)continue;
      const t0=Date.now();
      while(Date.now()-t0<2500){
        const left=await inputText(tabId,sels);
        if(!left||left.length<3){log('info',model,'send.ok',{strategy:s.name});return s.name;}
        await delay(300);
      }
      log('warn',model,'send.no_clear',{strategy:s.name});
    }catch(e){log('warn',model,'send.err',{strategy:s.name,error:e.message});}
  }
  log('warn',model,'send.all_failed',{});
  return null;
}

// ── DONE chain ───────────────────────────────────────────────────────────────────
// Stop button appears then disappears = generation finished.
async function doneStopGone(tabId,model,timeout){
  const t0=Date.now();let appeared=false;
  while(!appeared&&Date.now()-t0<60000){
    if(await evalTab(tabId,`!!document.querySelector('${STOP_SEL}')`))appeared=true;else await delay(400);
  }
  if(!appeared)return false; // never saw a stop button — defer to next strategy
  while(Date.now()-t0<timeout){
    if(!(await evalTab(tabId,`!!document.querySelector('${STOP_SEL}')`))){log('info',model,'done.stop_gone',{});return true;}
    await delay(500);
  }
  return false;
}
// Send button re-enabled = generation finished.
async function doneSendReenabled(tabId,model,timeout){
  const sels=sendSelsFor(model);const t0=Date.now();
  while(Date.now()-t0<timeout){
    const ready=await evalTab(tabId,`(function(){const ss=${JSON.stringify(sels)};for(const s of ss){const b=document.querySelector(s);if(b)return !b.disabled;}return false;})()`);
    if(ready){log('info',model,'done.send_reenabled',{});return true;}
    await delay(600);
  }
  return false;
}
// Output text unchanged across N polls = generation finished (last-resort signal).
async function doneOutputStable(tabId,model,timeout){
  const sels=captureCfg(model).dom||[];let last='';let stable=0;const t0=Date.now();
  while(Date.now()-t0<timeout){
    const cur=await scrapeText(tabId,sels);
    if(cur&&cur===last){if(++stable>=3){log('info',model,'done.output_stable',{len:cur.length});return true;}}
    else stable=0;
    last=cur;await delay(1200);
  }
  return false;
}
async function runDone(tabId,model,timeout=120000){
  if(await doneStopGone(tabId,model,timeout))return 'stop-gone';
  if(await doneSendReenabled(tabId,model,Math.min(timeout,90000)))return 'send-reenabled';
  if(await doneOutputStable(tabId,model,Math.min(timeout,90000)))return 'output-stable';
  log('warn',model,'done.timeout',{});
  return null;
}

// ── CAPTURE chain ────────────────────────────────────────────────────────────────
async function revealCopy(tabId){
  await evalTab(tabId,`(function(){const bs=document.querySelectorAll('button[aria-label*="Copy" i],button[data-testid*="copy" i]');for(const b of bs){const p=b.parentElement;if(p){p.dispatchEvent(new MouseEvent('mouseover',{bubbles:true}));p.dispatchEvent(new MouseEvent('mouseenter',{bubbles:true}));}}})()`);
  await delay(300);
}
async function scrollLast(tabId){
  await evalTab(tabId,`(function(){const ms=document.querySelectorAll('[data-testid="assistant-message"],.assistant-message,[class*="AssistantMessage"]');const l=ms[ms.length-1];if(l)l.scrollIntoView({behavior:'smooth',block:'end'});})()`);
  await delay(800);
}

// Strategy 1: copy button → clipboard read (most faithful — preserves markdown).
async function captureCopy(tabId,model,origPrompt){
  const sel=captureCfg(model).copy;
  if(!sel)return null;
  await revealCopy(tabId);
  const clicked=await evalTab(tabId,`(function(){
    let bs;
    if(${model==='grok'}){
      bs=Array.from(document.querySelectorAll('button')).filter(b=>{const h=b.innerHTML;return h.includes('M8 4')||h.includes('M16 4h2a2 2 0 0 1 2 2v14')||h.includes('clipboard')||(b.getAttribute('aria-label')||'').toLowerCase().includes('copy');});
    }else{bs=Array.from(document.querySelectorAll(${JSON.stringify(sel)}));}
    bs=bs.filter(b=>!b.closest('${USER_BUBBLE}'));
    if(!bs.length)return false;
    const last=bs[bs.length-1];if(!last.getBoundingClientRect().width)return false;
    last.click();return true;
  })()`);
  if(!clicked)return null;
  await delay(700);
  const text=await evalTab(tabId,`(async()=>{try{return await navigator.clipboard.readText();}catch{return '';}})()`,true);
  if(!text||text===origPrompt||text.trim().length<20)return null;
  return cleanCapture(text);
}
// Strategy 2: innerText scrape of last assistant message (survives copy-button drift).
async function captureDOM(tabId,model){
  const t=await scrapeText(tabId,captureCfg(model).dom||[]);
  if(!t||t.trim().length<20)return null;
  return cleanCapture(t);
}
// Strategy 3: outerHTML of last assistant message, tags stripped (last-resort).
async function captureHTML(tabId,model){
  const sels=captureCfg(model).dom||[];
  const html=await evalTab(tabId,`(function(){
    const ss=${JSON.stringify(sels)};
    for(const s of ss){const ns=Array.from(document.querySelectorAll(s)).filter(n=>!n.closest('${USER_BUBBLE}'));if(ns.length)return ns[ns.length-1].outerHTML;}
    return '';
  })()`);
  if(!html)return null;
  const text=html.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();
  if(text.length<20)return null;
  return cleanCapture(text);
}
const CAPTURE_STRATEGIES=[
  {name:'copy-button',fn:captureCopy},
  {name:'dom-scrape',fn:captureDOM},
  {name:'cdp-outerhtml',fn:captureHTML},
];

// Try capture strategies, retrying a few times while the response settles.
// Returns {text,strategy} or null.
async function runCapture(tabId,model,origPrompt){
  for(let attempt=0;attempt<12;attempt++){
    await delay(attempt===0?2500:4000);
    try{await chrome.tabs.update(tabId,{active:true});}catch{}
    await delay(300);
    await revealCopy(tabId);
    if(model==='claude')await scrollLast(tabId);
    for(const s of CAPTURE_STRATEGIES){
      try{
        const text=await s.fn(tabId,model,origPrompt);
        if(text){log('info',model,'capture.ok',{strategy:s.name,len:text.length,attempt});return {text,strategy:s.name};}
      }catch(e){log('warn',model,'capture.err',{strategy:s.name,error:e.message});}
    }
    log('warn',model,'capture.retry',{attempt});
  }
  return null;
}
