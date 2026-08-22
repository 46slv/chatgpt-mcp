function assertNoPendingAction(actions){
 const pending=actions.find(x=>x?.pending===true);
 if(pending)throw new Error("AMBIGUOUS_ACTION_IN_FLIGHT: "+String(pending.request_id||pending.action||"unknown"));
}

export async function runIterativeLocalWorker({mission,actions=[],maxRounds=3,plan,execute,onBeforeExecute=()=>{},onProgress=()=>{}}){
 if(!mission||typeof plan!=="function"||typeof execute!=="function")throw new Error("iterative local worker arguments invalid");
 if(!Number.isInteger(maxRounds)||maxRounds<1||maxRounds>10)throw new Error("invalid planner round budget");
 assertNoPendingAction(actions);
 for(let round=1;round<=maxRounds;round++){
 const decision=await plan({mission,evidence:actions,round,maxRounds});
 if(!decision||!["COMPLETE","REQUEST_ACTIONS"].includes(decision.type))throw new Error("invalid planner decision");
 if(decision.type==="COMPLETE")return {status:"DONE",summary:decision.summary,rounds:round,actions};
 for(let i=0;i<decision.actions.length;i++){
 const item=decision.actions[i];
 const requestId="R"+String(round).padStart(2,"0")+"-"+String(i+1).padStart(2,"0")+"-"+String(actions.length+1).padStart(3,"0");
 if(actions.some(x=>x?.request_id===requestId))throw new Error("duplicate local action identity: "+requestId);
 const record={request_id:requestId,action:item.action,args:item.args,planner_round:round,pending:true};
 actions.push(record);
 await onBeforeExecute({round,item,requestId,actions});
 await onProgress({round,item,requestId,pending:true,actions});
 const result=await execute(item.action,item.args,requestId);
 if(!result||!["PASS","BLOCKED","FAIL"].includes(result.status))throw new Error("local typed action unexpected: "+item.action);
 record.result=result;
 record.executor_request_id=typeof result.request_id==="string"&&result.request_id?result.request_id:null;
 delete record.pending;
 await onProgress({round,item,requestId,result,pending:false,actions});
 if(result.status==="FAIL")throw new Error("local typed action failed: "+item.action);
 if(result.status!=="PASS")break;
 }
 }
 throw new Error("local planner round budget exhausted without COMPLETE");
}
