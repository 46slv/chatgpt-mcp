const ALLOWED=new Set(["git_branch_current","git_status_short","git_diff_name_only","path_exists","read_file","file_sha256","write_text_file"]);
function exactKeys(value,expected){if(!value||typeof value!=="object"||Array.isArray(value))return false;const a=Object.keys(value).sort();const b=[...expected].sort();return a.length===b.length&&a.every((x,i)=>x===b[i]);}
function validAction(item,allowWrite=false){
 if(!exactKeys(item,["action","args"])||!ALLOWED.has(item.action)||!item.args||typeof item.args!=="object"||Array.isArray(item.args))return false;
 if(["git_branch_current","git_status_short","git_diff_name_only"].includes(item.action))return exactKeys(item.args,[]);
 if(item.action==="path_exists")return exactKeys(item.args,["path"])&&typeof item.args.path==="string";
 if(item.action==="file_sha256")return exactKeys(item.args,["path"])&&typeof item.args.path==="string"&&item.args.path.length>0;
 if(item.action==="read_file"){const k=Object.keys(item.args).sort().join(",");return (k==="path"||k==="max_bytes,path")&&typeof item.args.path==="string"&&(!("max_bytes" in item.args)||(Number.isInteger(item.args.max_bytes)&&item.args.max_bytes>=1&&item.args.max_bytes<=262144));}
 if(item.action==="write_text_file"){if(!allowWrite)return false;if(!exactKeys(item.args,["path","content","expected_sha256"]))return false;if(typeof item.args.path!=="string"||!item.args.path.length||typeof item.args.content!=="string")return false;if(Buffer.byteLength(item.args.content,"utf8")>262144)return false;return item.args.expected_sha256==="MISSING"||(typeof item.args.expected_sha256==="string"&&/^[A-Fa-f0-9]{64}$/.test(item.args.expected_sha256));}
 return false;
}
export function parsePlannerDecision(value,{allowWrite=false,allowConsultation=false}={}){
 if(!value||typeof value!=="object"||Array.isArray(value))throw new Error("planner decision must be object");
 if(value.type==="COMPLETE"){if(!exactKeys(value,["type","summary"]))throw new Error("planner COMPLETE schema mismatch");if(typeof value.summary!=="string"||!value.summary.trim()||value.summary.length>4000)throw new Error("planner COMPLETE summary invalid");return {type:"COMPLETE",summary:value.summary};}
 if(value.type==="REQUEST_ACTIONS"){if(!exactKeys(value,["type","actions"])||!Array.isArray(value.actions)||value.actions.length<1||value.actions.length>5)throw new Error("planner REQUEST_ACTIONS schema mismatch");for(const item of value.actions)if(!validAction(item,allowWrite))throw new Error("planner requested invalid action: "+JSON.stringify(item));return {type:"REQUEST_ACTIONS",actions:value.actions};}
 if(value.type==="REQUEST_CONSULTATION"){if(!allowConsultation)throw new Error("planner REQUEST_CONSULTATION is disabled");if(!exactKeys(value,["type","prompt"])||typeof value.prompt!=="string"||!value.prompt.trim()||value.prompt.length>12000)throw new Error("planner REQUEST_CONSULTATION schema mismatch");return {type:"REQUEST_CONSULTATION",prompt:value.prompt};}
 throw new Error("planner decision type invalid");
}
export function normalizePlannerText(text){
 let t=String(text||"").trim();
 if(!t.startsWith("{")||!t.endsWith("}"))return t;
 t=t.replace(/([{,]\s*)(type|summary|actions|action|args|path|content|expected_sha256|prompt)(\s*:)/g,(m,a,b,c)=>a+'"'+b+'"'+c);
 t=t.replace(/:\s*(COMPLETE|REQUEST_ACTIONS|REQUEST_CONSULTATION)(\s*[,}])/g,(m,a,b)=>':"'+a+'"'+b);
 t=t.replace(/("summary"\s*:\s*)([A-Za-z0-9_.-]+)(\s*[,}])/g,(m,a,b,c)=>a+'"'+b+'"'+c);
 t=t.replace(/("action"\s*:\s*)(git_branch_current|git_status_short|git_diff_name_only|path_exists|read_file|file_sha256|write_text_file)(\s*[,}])/g,(m,a,b,c)=>a+'"'+b+'"'+c);
 t=t.replace(/("path"\s*:\s*)([A-Za-z0-9_./\\:-]+)(\s*[,}])/g,(m,a,b,c)=>a+'"'+b.replace(/\\/g,"\\\\")+'"'+c);
 return t;
}
export function parsePlannerText(text,options={}){text=String(text).replace(/("expected_sha256"\s*:\s*)""/g,'$1"MISSING"');
 const normalized=normalizePlannerText(text);
 let value;
 try{value=JSON.parse(normalized);}catch{throw new Error("planner did not return strict or safely-normalized JSON: "+normalized.slice(0,1000));}
 return parsePlannerDecision(value,options);
}
export function buildPlannerPrompt({mission,evidence=[],round=1,maxRounds=3,allowWrite=false,consultationEnabled=false}){
 const compact=evidence.slice(-10).map(x=>{const text=String(x.result?.stdout?.text||x.result?.response_evidence||"");return {type:x.type||"ACTION",action:x.action||null,args:x.args||null,status:x.result?.status||x.status||null,stdout:text.length>1000?text.slice(0,500)+"...[TRUNCATED]..."+text.slice(-500):text};});
 const writeCapability=allowWrite?" write_text_file args {path:string,content:string,expected_sha256:string}; expected_sha256 is MISSING for create or exact current SHA-256 for replace.":"";
 const consultation=consultationEnabled?"You may request one bounded ordinary-text consultation with ChatGPT using exactly {\"type\":\"REQUEST_CONSULTATION\",\"prompt\":\"...\"}. The runner fixes target, tool, and request id; do not provide them. Never include secrets, credentials, personal data, files, permissions, accounts, billing, destructive, out-of-scope, or unknown requests.":"REQUEST_CONSULTATION is unavailable.";
 return ["You are a bounded local planning worker with NO direct tool or shell authority.","The deterministic runner may execute only these read-only Local Executor actions:","git_branch_current args {}; git_status_short args {}; git_diff_name_only args {};","path_exists args {path:string}; read_file args {path:string,max_bytes?:integer}; file_sha256 args {path:string}."+writeCapability,consultation,"Mission: "+mission,"Planning round: "+round+" of "+maxRounds,"Evidence so far: "+JSON.stringify(compact),"Return exactly one JSON object and nothing else.","If the mission is proven complete: {\"type\":\"COMPLETE\",\"summary\":\"...\"}","Otherwise request 1 to 5 useful actions: {\"type\":\"REQUEST_ACTIONS\",\"actions\":[{\"action\":\"...\",\"args\":{}}]} or the consultation object above.","Do not request any action outside the listed set. Do not claim COMPLETE unless evidence proves the mission."].join("\n");
}
