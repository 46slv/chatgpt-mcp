// A trusted launch profile binds the operator. Browser fields never select roles,
// authority, workspaces, providers, or an execution mechanism.
import {MISSION_COMMAND_PROTOCOL,MISSION_REQUEST_PROTOCOL} from './devexec-mission-controller.mjs';
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,80}$/;
export function createMissionConsoleService({controller,bindingId,acceptanceRefs,protectedConstraints,requestedAuthority='READ_ONLY',notifyRunnable=()=>{},now=()=>new Date()}={}) {
  if(!controller||!/^sha256:[a-f0-9]{64}$/.test(bindingId)||!Array.isArray(acceptanceRefs)||!acceptanceRefs.length||!Array.isArray(protectedConstraints)||!['READ_ONLY','BOUNDED_WRITE'].includes(requestedAuthority))throw new Error('Explicit trusted Mission launch profile required');
  const source={type:'operator',adapter:'native-mission-console',binding_id:bindingId};
  function admittedTime(missionId,eventId){
    let after=0;
    for(;;){
      const page=controller.listEvents(missionId,{after,limit:256});
      const admitted=page.events.find(event=>event.event_id===eventId);
      if(admitted)return admitted.event.occurred_at;
      if(!page.events.length)return null;
      if(page.next_cursor<=after)throw new Error('Mission Event cursor did not advance');
      after=page.next_cursor;
    }
  }
  function common(requestId,missionId=null){
    if(typeof requestId!=='string'||!ID.test(requestId))throw new Error('Exact request ID required');
    const eventId=`console-${requestId}`;
    let occurredAt=null;
    if(missionId!==null)occurredAt=admittedTime(missionId,eventId);
    else{
      const page=controller.listMissions({limit:1024});
      for(const mission of page.missions){
        if(mission.request_id!==requestId)continue;
        occurredAt=admittedTime(mission.mission_id,eventId);
        if(occurredAt!==null)break;
      }
      if(occurredAt===null&&page.truncated)throw new Error('Mission replay lookup exceeds the public Mission list bound');
    }
    // Reuse only the canonical Event timestamp, never a cached request or receipt.
    // F03 still validates current authority and compares the entire supplied payload.
    return {schema_version:1,event_id:eventId,request_id:requestId,idempotency_key:eventId,occurred_at:occurredAt??now().toISOString(),source,correlation_id:eventId};
  }
  return Object.freeze({
    list:()=>controller.listMissions().missions,
    inspect:missionId=>controller.inspect(missionId),
    submit:({goal,request_id})=>{
      if(typeof goal!=='string'||!goal.trim()||goal.length>4096)throw new Error('Bounded Mission goal required');
      return controller.submit({...common(request_id),protocol:MISSION_REQUEST_PROTOCOL,actor:{binding_id:bindingId,axis:'DETERMINISTIC',role:'OPERATOR_INGRESS'},intent:requestedAuthority==='READ_ONLY'?'CONSULTATION':'TASK',requested_authority:requestedAuthority,goal:{goal_id:`goal-${request_id}`,summary:goal,acceptance_refs:[...acceptanceRefs],protected_constraints:[...protectedConstraints]}});
    },
    control:async({mission_id,action,expected_revision,request_id})=>{
      if(!['START','RESUME','PAUSE','CANCEL'].includes(action))throw new Error('Console action forbidden');
      const data={reason:`Operator requested ${action.toLowerCase()}`};if(action==='CANCEL')data.evidence_refs=[`console:${request_id}`];
      const receipt=controller.control({...common(request_id,mission_id),protocol:MISSION_COMMAND_PROTOCOL,actor:{binding_id:bindingId,axis:'MISSION_GOVERNANCE',role:'MISSION_GOVERNOR'},mission_id,action,expected_revision,data});
      // Notification is not an execution claim. A durable scheduler independently
      // reconciles RUNNING Missions and owns dispatch; duplicate receipts never wake.
      if(receipt.status==='APPLIED'&&['START','RESUME'].includes(action))await notifyRunnable({missionId:mission_id,receipt});
      return receipt;
    },
  });
}
