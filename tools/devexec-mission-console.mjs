// Thin HTTP/UI adapter. The injected service owns authority and canonical state.
const ACTIONS = new Set(['START', 'RESUME', 'PAUSE', 'CANCEL']);
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_BODY = 32768;
const json = (res, status, body) => { res.writeHead(status, {'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'}); res.end(JSON.stringify(body)); };
function exact(value, keys) { if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join() !== [...keys].sort().join()) throw new Error('Unexpected request fields'); }
async function body(req) {
  if (req.headers['content-type']?.split(';')[0] !== 'application/json') throw new Error('JSON body required');
  let size=0; const chunks=[];
  for await (const chunk of req) {size+=chunk.length; if(size>MAX_BODY) throw new Error('Request body too large'); chunks.push(chunk);}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
function isOwnOrigin(req) {
  if (!req.headers.origin) return true; // Machine clients are locally bound by the parent server.
  return req.headers.origin === `http://${req.headers.host}`;
}

export const MISSION_PAGE = `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>EPHEMERA Missions</title>
<style>body{font:16px system-ui;margin:0;background:#111723;color:#e9eff8}main{max-width:1000px;margin:40px auto;padding:24px}a{color:#9ec7ff}header{display:flex;justify-content:space-between;align-items:center}section{padding:24px;background:#1a2332;border:1px solid #364258;border-radius:12px;margin-top:20px}textarea{display:block;width:95%;min-height:90px;background:#101724;color:inherit;padding:12px;border:1px solid #65748d;border-radius:6px}button{padding:10px 16px;margin:10px 8px 0 0;background:#b2d5ff;color:#102035;border:0;border-radius:6px;cursor:pointer}button:disabled{opacity:.4;cursor:default}.row{display:block;text-align:left;width:100%;background:#26354b;color:inherit}pre{white-space:pre-wrap;overflow-wrap:anywhere}#error{color:#ffb7af}small{color:#bac6d8}</style>
<main><header><h1>Missions</h1><a href="/">Console</a></header><p>目的を登録し、進行状況と検証結果を確認します。</p><section><label for="goal">新しいMissionの目的</label><textarea id="goal" maxlength="4096"></textarea><button id="submit">登録</button><small id="connection" role="status">接続中</small></section><p id="error" role="alert"></p><section><h2>Mission一覧</h2><div id="list"></div></section><section id="detail" hidden><h2 id="title"></h2><p id="status"></p><p id="identity"></p><div id="actions"></div><h3>検証・実行の記録</h3><pre id="evidence"></pre></section></main>
<script>
let selected=null,current=null,busy=false,detailKey=null,listKey=null,detailSequence=0;
const el=id=>document.getElementById(id);
async function api(url,options){const r=await fetch(url,options);const d=await r.json();if(!r.ok)throw Error(d.error||'Request failed');return d;}
function error(e){el('error').textContent=e.message;el('connection').textContent='接続または状態の確認が必要です';}
async function detail(){if(!selected)return;const missionId=selected,sequence=++detailSequence;const next=await api('/api/missions/'+encodeURIComponent(missionId));if(sequence!==detailSequence||selected!==missionId)return;if(next.mission_id!==missionId)throw Error('Mission identity mismatch');current=next;const key=JSON.stringify([current.mission_id,current.revision,current.deferred_commands,current.result_id,busy]);if(detailKey===key)return;detailKey=key;el('detail').hidden=false;el('title').textContent=current.goal?.summary||current.mission_id;el('status').textContent=current.status+' · Goal '+(current.goal?.status||'—');el('identity').textContent=current.mission_id+' · revision '+current.revision;el('evidence').textContent=JSON.stringify({active_episode:current.active_episode,episodes:current.episodes,goal:current.goal,result_id:current.result_id,deferred_commands:current.deferred_commands},null,2);el('actions').replaceChildren();for(const [action,label] of [['START','開始'],['RESUME','再開'],['PAUSE','一時停止'],['CANCEL','取消']]){const b=document.createElement('button');b.textContent=label;b.dataset.action=action;b.disabled=busy||!({START:['CREATED'],RESUME:['PAUSED'],PAUSE:['RUNNING'],CANCEL:['CREATED','RUNNING','PAUSED']}[action].includes(current.status));b.onclick=()=>control(action);el('actions').append(b);}}
async function load(){try{const d=await api('/api/missions');const key=JSON.stringify(d.missions.map(m=>[m.mission_id,m.revision,m.status,m.goal?.summary]));if(listKey!==key){listKey=key;el('list').replaceChildren();for(const m of d.missions){const b=document.createElement('button');b.className='row';b.textContent=(m.goal?.summary||m.mission_id)+' · '+m.status;b.onclick=async()=>{selected=m.mission_id;current=null;try{await detail()}catch(e){error(e)}};el('list').append(b);}}await detail();el('connection').textContent='接続済み';}catch(e){current=null;detailKey=null;listKey=null;el('actions').replaceChildren();error(e);}}
async function control(action){if(!current||busy||current.mission_id!==selected)return;const missionId=current.mission_id,revision=current.revision;busy=true;try{await api('/api/missions/'+encodeURIComponent(missionId)+'/control',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action,expected_revision:revision,request_id:crypto.randomUUID()})});el('error').textContent='';}catch(e){error(e)}finally{busy=false;await load();}}
el('submit').onclick=async()=>{if(busy)return;busy=true;el('submit').disabled=true;try{const r=await api('/api/missions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({goal:el('goal').value,request_id:crypto.randomUUID()})});selected=r.mission_id;el('goal').value='';el('error').textContent='';}catch(e){error(e)}finally{busy=false;el('submit').disabled=false;await load();}};
load();setInterval(()=>{if(!busy)load()},2000);
</script></html>`;

export function createMissionConsoleHandler({missionService}={}) {
  for(const name of ['list','inspect','submit','control']) if(typeof missionService?.[name]!=='function') throw new Error(`Mission service ${name} required`);
  return async function handle(req,res,url) {
    if(url.pathname!=='/missions'&&!url.pathname.startsWith('/api/missions')) return false;
    try {
      if(req.method==='POST'&&!isOwnOrigin(req)){json(res,403,{error:'Same-origin Mission mutation required'});return true;}
      if(req.method==='GET'&&url.pathname==='/missions'){res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','x-frame-options':'DENY','x-content-type-options':'nosniff'});res.end(MISSION_PAGE);return true;}
      if(url.pathname==='/api/missions'&&req.method==='GET'){json(res,200,{missions:await missionService.list()});return true;}
      if(url.pathname==='/api/missions'&&req.method==='POST'){
        const input=await body(req);exact(input,['goal','request_id']);
        if(typeof input.goal!=='string'||!input.goal.trim()||input.goal.length>4096||typeof input.request_id!=='string'||!ID.test(input.request_id))throw new Error('Valid goal and exact request ID required');
        json(res,200,await missionService.submit(input));return true;
      }
      const match=/^\/api\/missions\/([^/]+)(\/control)?$/.exec(url.pathname);
      if(match){const missionId=decodeURIComponent(match[1]);if(!ID.test(missionId))throw new Error('Exact Mission ID required');
        if(!match[2]&&req.method==='GET'){const result=await missionService.inspect(missionId);json(res,result?200:404,result||{error:'Mission not found'});return true;}
        if(match[2]&&req.method==='POST'){const input=await body(req);exact(input,['action','expected_revision','request_id']);if(!ACTIONS.has(input.action)||!Number.isSafeInteger(input.expected_revision)||input.expected_revision<1||typeof input.request_id!=='string'||!ID.test(input.request_id))throw new Error('Invalid Mission control');json(res,200,await missionService.control({mission_id:missionId,...input}));return true;}
      }
      json(res,404,{error:'Mission route not found'});
    } catch(error){json(res,error?.code==='STALE_MISSION_OBSERVATION'?409:400,{error:String(error?.message||error),code:error?.code||'MISSION_REQUEST_REJECTED'});}
    return true;
  };
}
