// detect.js - Jury.ai - block detection + desktop notifications
// Detects login walls, rate-limit popups, captchas, or missing input, and raises
// OS notifications. Reads selectors/phrases from the provider registry.

function blockMsg(reason){
  return {
    login_required:'Not logged in — sign in to this site, then retry.',
    rate_limited:'Rate-limited or usage cap reached.',
    captcha:'Human verification (captcha) is blocking the page.',
    no_input:'Input box not found — the page changed or a popup is blocking it.',
    no_capture:'Response could not be captured.',
  }[reason]||'A popup or block prevented a response.';
}

function notify(model,reason,detail){
  const map={login_required:'Login required',rate_limited:'Rate-limited',captcha:'Captcha / verification',
    no_input:"Can't ask — input not found",no_capture:'Response not captured',error:'Error'};
  const label=model.charAt(0).toUpperCase()+model.slice(1);
  try{log('warn',model,'notify',{reason,detail});}catch{}
  chrome.notifications.create('jury-'+model+'-'+Date.now(),{
    type:'basic',
    iconUrl:'icons/icon128.png',
    title:'Jury.ai — '+label+': '+(map[reason]||reason),
    message:detail||blockMsg(reason),
    priority:2,
  },()=>chrome.runtime.lastError);
}

// Inspect a tab for login walls, rate-limit popups, captchas, or missing input.
// Returns a reason string or null. Fails open (null) so we never false-alarm.
async function detectBlock(model,tabId){
  const cfg=providerCfg(model)||{};
  const inputSels=cfg.input||[];
  const rateText=cfg.rateText||[];
  const reason=await evalTab(tabId,`(function(){
    const body=((document.body&&document.body.innerText)||'').toLowerCase();
    const cap=${JSON.stringify(CAPTCHA_TEXT)};
    if(cap.some(t=>body.includes(t))||document.querySelector('iframe[src*="captcha" i],iframe[src*="challenges.cloudflare" i],div.cf-turnstile,#challenge-stage'))return 'captcha';
    const rate=${JSON.stringify(rateText)};
    if(rate.some(t=>t&&body.includes(t)))return 'rate_limited';
    const sels=${JSON.stringify(inputSels)};
    const hasInput=sels.some(s=>document.querySelector(s.trim()));
    if(!hasInput){
      const login=${JSON.stringify(LOGIN_TEXT)};
      if(login.some(t=>body.includes(t)))return 'login_required';
      return 'no_input';
    }
    return '';
  })()`);
  return reason||null;
}
