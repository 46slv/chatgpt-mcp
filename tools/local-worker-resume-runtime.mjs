import {runIterativeLocalWorker} from "./local-worker-iterative-runner.mjs";
export async function runLocalWorkerResume({mission,actions=[],repair,maxRounds=3,plan,execute,onBeforeExecute=()=>{},onProgress=()=>{}}){
 if(!repair||!["RETRY_PLANNER","EXECUTE_TYPED_ACTIONS"].includes(repair.mode))throw new Error("invalid local worker repair");
 const guidedMission=mission+(repair.guidance?("\nSupervisor guidance: "+repair.guidance):"");
 if(repair.mode==="EXECUTE_TYPED_ACTIONS"){
  const items=repair.next_actions||[];
  for(let i=0;i<items.length;i++){
   const item=items[i];
   const requestId="REPAIR-"+String(actions.length+1).padStart(3,"0");
   if(actions.some(x=>x?.request_id===requestId))throw new Error("duplicate repair action identity: "+requestId);
   await onBeforeExecute({repair:true,item,requestId,actions});
   const result=await execute(item.action,item.args,requestId);
   if(!result||!["PASS","BLOCKED","FAIL"].includes(result.status))throw new Error("invalid repair action result status");
   actions.push({request_id:requestId,action:item.action,args:item.args,result,repair:true});
   await onProgress({repair:true,item,requestId,result,actions});
   if(result.status==="FAIL")throw new Error("supervisor repair typed action failed");
   if(result.status==="BLOCKED")break;
  }
 }
 return runIterativeLocalWorker({mission:guidedMission,actions,maxRounds,plan,execute,onBeforeExecute,onProgress});
}
