import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {loadRegistry,resolveTarget} from './target-registry.mjs';
function mcpConfigPath(){return path.join(os.homedir(),'.lmstudio','mcp.json');}
function loadServer(name){const cfg=JSON.parse(fs.readFileSync(mcpConfigPath(),'utf8')); const s=cfg.mcpServers?.[name]; if(!s?.command)throw new Error('MCP server unavailable: '+name); return s;}
function extract(result){if(result?.isError)throw new Error('chatgpt_reply MCP error'); const blocks=(result?.content||[]).filter(x=>x.type==='text').map(x=>x.text); if(blocks.length!==1)throw new Error('chatgpt_reply expected one text block'); const v=JSON.parse(blocks[0]); if(typeof v.error==='string'&&v.error.trim())throw new Error(v.error.trim()); if(typeof v.response!=='string'||!v.response.trim())throw new Error('chatgpt_reply empty response'); return v.response;}
export async function replyHeartbeatViaBridge(i={}){
 const root=path.resolve(i.project_root||'.'); const target=resolveTarget({explicitTarget:i.target_alias||null,cwd:root,registry:loadRegistry()}); const server=loadServer('chatgpt-web-probe');
 const client=new Client({name:'devexec-heartbeat',version:'0.1.0'}); const transport=new StdioClientTransport({command:server.command,args:server.args||[],env:{...process.env,...(server.env||{}),CHATGPT_MCP_CHAT_URL:target.chat_url,DEV_EXEC_TARGET_ID:target.target_id,DEV_EXEC_TARGET_SOURCE:target.source,CHATGPT_MCP_TRANSPORT_RUN_ID:'HEARTBEAT-'+Date.now()}});
 try{await client.connect(transport); const listed=await client.listTools(); if(!listed.tools.some(x=>x.name==='chatgpt_reply'))throw new Error('chatgpt_reply unavailable'); const result=await client.callTool({name:'chatgpt_reply',arguments:{prompt:i.prompt,timeout_minutes:30}},undefined,{timeout:35*60*1000,maxTotalTimeout:35*60*1000}); return {response:extract(result),target};}finally{try{await client.close();}catch{}}
}
