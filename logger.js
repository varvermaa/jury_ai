// logger.js - Jury.ai - structured logging + ring buffer
// Loaded first via importScripts so every other module can call log().
const LOG_KEY='jury_logs', LOG_MAX=500;
let _logBuf=[];

function log(level,model,event,data){
  const e={t:Date.now(),level,model:model||'',event,data:data??null};
  _logBuf.push(e);
  if(_logBuf.length>LOG_MAX)_logBuf=_logBuf.slice(-LOG_MAX);
  try{
    const fn=level==='error'?console.error:level==='warn'?console.warn:console.log;
    fn('[Jury.ai]',(model||'').padEnd?(model||''):model,event,data??'');
  }catch{}
  try{chrome.storage.local.set({[LOG_KEY]:_logBuf}).catch(()=>{});}catch{}
}
const logInfo=(model,event,data)=>log('info',model,event,data);
const logWarn=(model,event,data)=>log('warn',model,event,data);
const logErr=(model,event,data)=>log('error',model,event,data);

function getLogs(){return _logBuf.slice();}
function clearLogs(){_logBuf=[];try{chrome.storage.local.set({[LOG_KEY]:[]}).catch(()=>{});}catch{}}
