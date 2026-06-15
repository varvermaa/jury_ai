// providers.js - Jury.ai - declarative provider registry (single source of truth)
// Adding a new LLM = add one entry here (+ optional content script). Every legacy
// map (ARENA, URLS, INPUT_SEL, SEND_SEL, COPY_SEL, RATE_TEXT, GEMINI_IN) is derived
// from this registry, so the rest of the code keeps working unchanged.

// Shared block-detection vocab (same for every site)
const CAPTCHA_TEXT=['verify you are human','are you a robot','complete the captcha','checking your browser','needs to review the security'];
const LOGIN_TEXT=['log in','sign in','sign up','log in to continue','continue with google','continue with apple','create account'];

const PROVIDERS={
  chatgpt:{
    id:'chatgpt', url:'https://chatgpt.com/', roles:['arena','judge'],
    input:['#prompt-textarea','div[contenteditable][data-id]','div[contenteditable]','textarea'],
    send:['button[data-testid="send-button"]','button[aria-label*="Send" i]','button[type="submit"]'],
    capture:{
      copy:'button[aria-label*="Copy" i],button[data-testid*="copy" i]',
      dom:['[data-message-author-role="assistant"] .markdown','[data-message-author-role="assistant"]','.markdown'],
    },
    rateText:["you've reached the limit","upgrade to chatgpt plus","you've hit the","usage cap","limit reached"],
  },
  claude:{
    id:'claude', url:'https://claude.ai/', roles:['arena','judge'],
    input:['.ProseMirror[contenteditable]','div[contenteditable][data-placeholder]','div[contenteditable]'],
    send:['button[aria-label*="Send" i]','button[type="submit"]'],
    capture:{
      copy:'button[aria-label*="Copy" i]',
      dom:['[data-testid="assistant-message"]','.assistant-message','[class*="AssistantMessage"]'],
    },
    rateText:['at capacity','temporarily unavailable','message limit','reached the maximum length','you are out of'],
  },
  grok:{
    id:'grok', url:'https://grok.com/', roles:['arena','judge'],
    input:['div[contenteditable][focused]','div[contenteditable][node]','div[contenteditable]','textarea'],
    send:['button[type="submit"]','button[aria-label*="Send" i]'],
    capture:{
      copy:'button[aria-label*="Copy" i],button[title*="Copy" i]',
      dom:['.message-bubble','[class*="message-bubble"]','[class*="prose"]'],
    },
    rateText:['rate limit','too many requests','temporarily unavailable','you have reached'],
  },
  gemini:{
    id:'gemini', url:'https://gemini.google.com/app', roles:['arena','judge'],
    input:['rich-textarea p','rich-textarea div[contenteditable]','div.ql-editor','div[contenteditable="true"][data-placeholder]','div[contenteditable="true"]'],
    send:['button[data-testid*="send" i]','button[aria-label*="Send" i]','button[aria-label*="submit" i]'],
    capture:{
      dom:['message-content .markdown','model-response .markdown','.response-container .markdown','message-content','model-response','.response-container-content','[data-response-index]','.model-response-text'],
    },
    rateText:['you have reached your limit','try again later','rate limit'],
  },
};

// ── Registry helpers ────────────────────────────────────────────────────────────
const providersWithRole=role=>Object.values(PROVIDERS).filter(p=>p.roles.includes(role)).map(p=>p.id);
const providerCfg=id=>PROVIDERS[id]||null;

// ── Derived legacy views (keep existing background.js code working unchanged) ─────
const ARENA=providersWithRole('arena');                 // ['chatgpt','claude','grok']
const JUDGE='gemini';
const URLS=Object.fromEntries(Object.values(PROVIDERS).map(p=>[p.id,p.url]));
const INPUT_SEL=Object.fromEntries(Object.values(PROVIDERS).map(p=>[p.id,p.input]));
const SEND_SEL=Object.fromEntries(Object.values(PROVIDERS).filter(p=>p.send).map(p=>[p.id,p.send]));
const COPY_SEL=Object.fromEntries(Object.values(PROVIDERS).filter(p=>p.capture?.copy).map(p=>[p.id,p.capture.copy]));
const RATE_TEXT=Object.fromEntries(Object.values(PROVIDERS).map(p=>[p.id,p.rateText||[]]));
const GEMINI_IN=PROVIDERS.gemini.input.join(',');
