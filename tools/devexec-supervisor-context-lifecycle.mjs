import {inspectSupervisorContext,buildSupervisorCheckpoint,buildSupervisorRehydratePack} from './devexec-supervisor-context-governor.mjs';
import {persistSupervisorCheckpoint,appendSupervisorContextEvent} from './devexec-supervisor-context-runtime.mjs';
export function applySupervisorContextLifecycle(input={}){
const decision=inspectSupervisorContext(input.context||{});
if(decision.decision==='CONTINUE')return {decision,checkpoint:null,checkpoint_file:null,rehydrate_pack:null};
if(decision.rotation_allowed===false&&decision.decision==='ROTATE')throw new Error('rotation forbidden');
const checkpoint=buildSupervisorCheckpoint(input.checkpoint||{});
const checkpoint_file=persistSupervisorCheckpoint(input.state_dir,checkpoint);
appendSupervisorContextEvent(input.state_dir,checkpoint.mission_id,{decision:decision.decision,reason:decision.reason,run_id:checkpoint.run_id});
let rehydrate_pack=null;
if(decision.decision==='ROTATE'){if(!input.freshNotion||!input.freshGit)throw new Error('rotation requires fresh authority');rehydrate_pack=buildSupervisorRehydratePack({checkpoint,freshNotion:input.freshNotion,freshGit:input.freshGit,latestOpsSync:input.latestOpsSync||null});}
return {decision,checkpoint,checkpoint_file,rehydrate_pack};
}
