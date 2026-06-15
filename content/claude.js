// content/claude.js - Jury.ai v12
chrome.runtime.onMessage.addListener((msg,_,r)=>{
  if(msg.type==='CHECK_LOGIN') r({loggedIn:!!document.querySelector('.ProseMirror[contenteditable],div[contenteditable]')});
  if(msg.type==='CHECK_LIMIT'){const b=document.body?.innerText??'';r({hasLimit:b.includes('at capacity')||b.includes('temporarily unavailable')});}
});
