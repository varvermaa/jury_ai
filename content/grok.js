// content/grok.js - Jury.ai v12
chrome.runtime.onMessage.addListener((msg,_,r)=>{
  if(msg.type==='CHECK_LOGIN') r({loggedIn:!!document.querySelector('div[contenteditable],textarea')});
  // FIX: added missing CHECK_LIMIT handler (was absent, causing background to hang on rate-limit check)
  if(msg.type==='CHECK_LIMIT'){
    const b=document.body?.innerText??'';
    r({hasLimit:b.includes('rate limit')||b.includes('Too many requests')||b.includes('temporarily unavailable')});
  }
});
