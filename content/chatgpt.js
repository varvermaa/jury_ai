// content/chatgpt.js - Jury.ai v12
chrome.runtime.onMessage.addListener((msg,_,r)=>{
  if(msg.type==='CHECK_LOGIN') r({loggedIn:!!document.querySelector('#prompt-textarea,div[contenteditable][data-id],textarea')});
  if(msg.type==='CHECK_LIMIT'){const b=document.body?.innerText??'';r({hasLimit:b.includes("You've reached the limit")||b.includes("Upgrade to ChatGPT Plus")||!!document.querySelector('[data-testid="upsell-modal"]')});}
});
