const TERMINAL=new Set(['FAILED','COMPLETE']);
export function planHeartbeatRecovery(state={}){
if(state.pending)return {action:'NONE',reason:'EXEC_IN_FLIGHT'};
if(String(state.phase||'').includes('IN_FLIGHT'))return {action:'NONE',reason:'PHASE_IN_FLIGHT'};
if(Object.values(state.rounds||{}).some(r=>r&&r.send_state==='IN_FLIGHT'))return {action:'NONE',reason:'SUPERVISOR_IN_FLIGHT'};
if(state.phase==='NEEDS_HUMAN')return {action:'NONE',reason:'NEEDS_HUMAN'};
if(state.phase==='CANCELLED')return {action:'NONE',reason:'CANCELLED'};
if(state.stop_type==='CIRCUIT_BREAKER_OPEN')return {action:'NONE',reason:'CIRCUIT_BREAKER_OPEN'};
if(state.phase==='FAILED')return {action:'CONTINUE_CHILD',reason:'RECOVERABLE_TERMINAL'};
if(state.phase==='COMPLETE'&&/^(RELOAD|AUTO_CONTINUE)/i.test(String(state.stop_reason||'')))return {action:'CONTINUE_CHILD',reason:'AUTO_CONTINUE_COMPLETE'};
if(TERMINAL.has(state.phase))return {action:'NONE',reason:'TERMINAL_NO_AUTO_CONTINUE'};
return {action:'RESUME_EXISTING',reason:'SAFE_NONTERMINAL'};
}
