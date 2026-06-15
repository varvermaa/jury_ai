// cdp.js - Jury.ai - Chrome DevTools Protocol (debugger) helpers
// Low-level tab control primitives shared by the orchestrator, strategies and detect.
const delay=ms=>new Promise(r=>setTimeout(r,ms));

function cdpCmd(tabId,method,params={}){
  return new Promise((res,rej)=>{
    chrome.debugger.sendCommand({tabId},method,params,r=>{
      if(chrome.runtime.lastError)rej(new Error(chrome.runtime.lastError.message));
      else res(r||{});
    });
  });
}

function evalTab(tabId,expr,await_=false){
  return new Promise(res=>{
    chrome.debugger.sendCommand({tabId},'Runtime.evaluate',{expression:expr,returnByValue:true,awaitPromise:await_},
      r=>res(chrome.runtime.lastError||r?.exceptionDetails?null:r?.result?.value??null));
  });
}

// Bug #5: treat already-attached as success
function attachDbg(tabId){
  return new Promise((res,rej)=>{
    chrome.debugger.attach({tabId},'1.3',()=>{
      const e=chrome.runtime.lastError?.message||'';
      if(e&&!e.includes('already')){rej(new Error(e));return;}
      chrome.debugger.sendCommand({tabId},'Page.enable',{},()=>
        chrome.debugger.sendCommand({tabId},'Runtime.enable',{},res));
    });
  });
}

function tabReady(tabId){
  return new Promise(res=>{
    chrome.tabs.get(tabId,t=>{
      if(t?.status==='complete'){res();return;}
      const fn=(id,info)=>{if(id===tabId&&info.status==='complete'){chrome.tabs.onUpdated.removeListener(fn);res();}};
      chrome.tabs.onUpdated.addListener(fn);
      setTimeout(res,15000);
    });
  });
}

// Bug #26: wait for renderer
async function waitRenderer(tabId,timeout=15000){
  const t0=Date.now();
  while(Date.now()-t0<timeout){
    try{const r=await cdpCmd(tabId,'Runtime.evaluate',{expression:'1+1',returnByValue:true});if(r?.result?.value===2)return;}catch{}
    await delay(400);
  }
}
