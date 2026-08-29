export async function runIterativeLocalWorker({mission,actions=[],maxRounds=3,plan,execute,consult,target=null,onProgress=()=>{}}){
 if(!mission||typeof plan!=="function"||typeof execute!=="function")throw new Error("iterative local worker arguments invalid");
 if(!Number.isInteger(maxRounds)||maxRounds<1||maxRounds>10)throw new Error("invalid planner round budget");
 for(let round=1;round<=maxRounds;round++){
 const decision=await plan({mission,evidence:actions,round,maxRounds});
 if(!decision||!["COMPLETE","REQUEST_ACTIONS","REQUEST_CONSULTATION"].includes(decision.type))throw new Error("invalid planner decision");
 if(decision.type==="COMPLETE")return {status:"DONE",summary:decision.summary,rounds:round,actions};
 if(decision.type==="REQUEST_CONSULTATION"){
  if(typeof consult!=="function")throw new Error("planner requested consultation but no consultation callback is configured");
  const consultationIndex=actions.filter(x=>x?.type==="CONSULTATION").length+1;
  const requestId="C-R"+String(round).padStart(2,"0")+"-"+String(consultationIndex).padStart(2,"0");
  const result=await consult(decision.prompt,requestId,target);
  if(!result||!["RESPONSE_RECEIVED","BLOCKED","DELIVERY_UNKNOWN"].includes(result.status))throw new Error("consultation callback returned invalid status");
  actions.push({type:"CONSULTATION",prompt:decision.prompt,request_id:requestId,result,planner_round:round});
  await onProgress({round,consultation:{prompt:decision.prompt,requestId},result,actions});
  if(result.status==="DELIVERY_UNKNOWN")break;
  continue;
 }
 for(let i=0;i<decision.actions.length;i++){
 const item=decision.actions[i];
 const requestId="R"+String(round).padStart(2,"0")+"-"+String(i+1).padStart(2,"0")+"-"+String(actions.length+1).padStart(3,"0");
 const result=await execute(item.action,item.args,requestId);
 if(!result||!["PASS","BLOCKED","FAIL"].includes(result.status))throw new Error("local typed action unexpected: "+item.action);
 if(result.status==="FAIL")throw new Error("local typed action failed: "+item.action);
 actions.push({action:item.action,args:item.args,result,planner_round:round});
 await onProgress({round,item,result,actions});
 if(result.status!=="PASS")break;
 }
 }
 throw new Error("local planner round budget exhausted without COMPLETE");
}
