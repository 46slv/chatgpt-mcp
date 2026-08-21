import os from 'node:os';
import {buildStopAlert,shouldNotifyStop} from './devexec-stop-alert.mjs';
import {enqueueStopAlert} from './devexec-stop-alert-queue.mjs';
export function queueTerminalStopAlert(i={}){
 const s=i.state||{},r=i.recovery||{};
 let t=null;
 if(r.reason==='CIRCUIT_BREAKER_OPEN')t='CIRCUIT_BREAKER_OPEN';
 else if(s.stop_type==='HUMAN_ACTION_REQUIRED_BLOCKED')t='HUMAN_ACTION_REQUIRED_BLOCKED';
 else if(s.phase==='FAILED')t='NON_RECOVERABLE_FAIL';
 else if(s.phase==='NEEDS_HUMAN')t='NEEDS_HUMAN';
 if(!t||!shouldNotifyStop({stop_type:t}))return {queued:false,reason:'NOT_HUMAN_NOTIFIABLE'};
 const a=buildStopAlert({mission_id:i.mission_id||i.run_id,run_id:i.run_id,machine:i.machine||process.env.COMPUTERNAME||os.hostname(),project_root:i.project_root,stop_type:t,reason:String(s.stop_reason||r.reason||t),last_checkpoint:{step:s.step??null,phase:s.phase??null},requested_human_action:String(s.requested_human_action||'Inspect terminal stop and resume when safe.'),git:i.git||{}});
 return {...enqueueStopAlert({dir:i.queue_dir,alert:a}),alert:a};
}
