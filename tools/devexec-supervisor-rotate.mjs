import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {loadRegistry,saveRegistry} from './target-registry.mjs';
import {loadRotationPlan} from './devexec-supervisor-rotation-runtime.mjs';
import {loadSupervisorCheckpoint} from './devexec-supervisor-context-runtime.mjs';
import {buildSupervisorRehydratePack} from './devexec-supervisor-context-governor.mjs';
import {executeSupervisorRotationBoundary} from './devexec-supervisor-rotation-controller.mjs';
const a=process.argv.slice(2); const mission=a[0]; const runId=a[1]; if(!mission||!runId)throw Error('usage: mission-id run-id');
const base=process.env.LOCALAPPDATA||path.join(os.homedir(),'AppData','Local'); const root=path.join(base,'ChatGPTMCPProbe');
const state=JSON.parse(fs.readFileSync(path.join(root,'dev-exec-state',runId+'.json'),'utf8'));
if(state.pending){console.log(JSON.stringify({executed:false,reason:'PENDING_EXECUTION'}));process.exit(4);}
const terminal=['COMPLETE','FAILED','NEEDS_HUMAN','CANCELLED'].includes(state.phase);
if(!terminal){console.log(JSON.stringify({executed:false,reason:'CURRENT_RUN_NOT_TERMINAL',phase:state.phase}));process.exit(0);}
const ctx=path.join(root,'supervisor-context'); const plan=loadRotationPlan(ctx,mission); const cp=loadSupervisorCheckpoint(ctx,mission);
const pack=buildSupervisorRehydratePack({checkpoint:cp,freshNotion:cp.notion_authority,freshGit:cp.git});
const cfg=JSON.parse(fs.readFileSync(path.join(os.homedir(),'.lmstudio','mcp.json'),'utf8')); const m=cfg.mcpServers?.['chatgpt-web-probe']; if(!m?.command)throw Error('chatgpt-web-probe unavailable');
const client=new Client({name:'devexec-supervisor-rotate',version:'0.1.0'}); const tr=new StdioClientTransport({command:m.command,args:m.args||[],env:{...process.env,...(m.env||{})}});
try{await client.connect(tr);const registry=loadRegistry();const current=registry.targets[plan.current_target_id];if(!current)throw Error('current target missing');
const result=await executeSupervisorRotationBoundary({plan,state_dir:ctx,registry,client,rehydrate_pack:pack,current_conversation_id:current.conversation_id,current_run_terminal:true,pending_execution:false,save_registry:r=>saveRegistry(r)});
console.log(JSON.stringify(result,null,2));console.log('DEVEXEC_SUPERVISOR_ROTATE_CLI_V0_PASS');}finally{try{await client.close();}catch{}}
