import {runIterativeLocalWorker} from "./local-worker-iterative-runner.mjs";

function assertNoPendingAction(actions){
 const pending=actions.find(x=>x?.pending===true);
 if(pending)throw new Error("AMBIGUOUS_ACTION_IN_FLIGHT: "+String(pending.request_id||pending.action||"unknown"));
}

export async function runLocalWorkerResume({mission,actions=[],repair,maxRounds=3,plan,execute,onBeforeExecute=()=>{},onProgress=()=>{}}){
 if(!repair||!["RETRY_PLANNER","EXECUTE_TYPED_ACTIONS"].includes(repair.mode))throw new Error("invalid local worker repair");
 assertNoPendingAction(actions);
 const guidedMission=mission+(repair.guidance?("\nSupervisor guidance: "+repair.guidance):"");
 if(repair.mode==="EXECUTE_TYPED_ACTIONS"){
  const items=repair.next_actions||[];
  for(let i=0;i<items.length;i++){
   const item=items[i];
   const requestId="REPAIR-"+String(actions.length+1).padStart(3,"0");
   if(actions.some(x=>x?.request_id===requestId))throw new Error("duplicate repair action identity: "+requestId);
   const record={request_id:requestId,action:item.action,args:item.args,repair:true,pending:true};
   actions.push(record);
   await onBeforeExecute({repair:true,item,requestId,actions});
   await onProgress({repair:true,item,requestId,pending:true,actions});
   const result=await execute(item.action,item.args,requestId);
   if(!result||!["PASS","BLOCKED","FAIL"].includes(result.status))throw new Error("invalid repair action result status");
   record.result=result;
   record.executor_request_id=typeof result.request_id==="string"&&result.request_id?result.request_id:null;
   delete record.pending;
   await onProgress({repair:true,item,requestId,result,pending:false,actions});
   if(result.status==="FAIL")throw new Error("supervisor repair typed action failed");
   if(result.status==="BLOCKED")break;
  }
 }
 return runIterativeLocalWorker({mission:guidedMission,actions,maxRounds,plan,execute,onBeforeExecute,onProgress});
}
