import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import {spawn} from "node:child_process";
const a=process.argv.slice(2),id=a[0]; if(!id) throw Error("run-id required");
const b=process.env.LOCALAPPDATA||path.join(os.homedir(),"AppData","Local"),d=process.env.DEV_EXEC_STATE_DIR||path.join(b,"ChatGPTMCPProbe","dev-exec-state");
const s=JSON.parse(fs.readFileSync(path.join(d,id+".json"),"utf8")); if(s.pending) throw Error("ambiguous pending execution");
if(["COMPLETE","FAILED","NEEDS_HUMAN","CANCELLED"].includes(s.phase)) throw Error("terminal run");
const t=s.target?.target_id; if(!t) throw Error("target required");
const r=process.env.DEV_EXEC_RUNNER_PATH||path.join(process.cwd(),"tools","dev-exec-loop.mjs");
const c=spawn(process.execPath,[r],{stdio:"inherit",env:{...process.env,DEV_EXEC_RUN_ID:id,DEV_EXEC_TARGET_ALIAS:t}}); c.on("exit",x=>process.exit(Number.isInteger(x)?x:1));
