// content/gemini.js - Jury.ai v12
chrome.runtime.onMessage.addListener((msg,_,r)=>{
  if(msg.type==='CHECK_LOGIN') r({loggedIn:!!document.querySelector('rich-textarea,div[contenteditable],.ql-editor,textarea')});
  if(msg.type==='CHECK_URL') r({url:location.href});
});
