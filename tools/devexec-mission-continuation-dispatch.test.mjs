import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {openMissionControl} from "./devexec-mission-control.mjs";
import {
  beginMissionChildLaunch,
  requestMissionChildLaunch,
} from "./devexec-mission-launch.mjs";
import {
  dispatchMissionContinuation,
  dispatchMissionContinuationSync,
} from "./devexec-mission-continuation-dispatch.mjs";

function setup() {
  const base=fs.mkdtempSync(path.join(os.tmpdir(),"devexec-mission-continuation-"));
  const mission_id="MISSION-DISPATCH";
  const parent_run_id="RUN-PARENT";
  const control=openMissionControl({base,mission_id,parent_run_id:null,run_id:parent_run_id});
  const requested=requestMissionChildLaunch(control,{
    parent_run_id,
    child_run_id:"RUN-CHILD",
    launch_id:"LAUNCH-1",
    idempotency_key:"launch-1",
    goal:"continue safely",
  },{boundary:{safe:true,pending_action:false,ambiguous_action:false}});
  return {base,mission_id,parent_run_id,control,launch:requested.launch};
}

test("dispatch forwards the durable base into child spawn environment", async () => {
  const ctx=setup();
  let observed=null;
  const result=await dispatchMissionContinuation({
    base:ctx.base,
    mission_id:ctx.mission_id,
    parent_run_id:ctx.parent_run_id,
    launch_id:ctx.launch.launch_id,
  },{
    dispatch_impl:async (_control,launch,options)=>{
      observed=options;
      return {launch:{...launch,status:"LAUNCHED"},receipt:{ok:true}};
    },
  });
  assert.equal(observed.spawn_env.LOCALAPPDATA,ctx.base);
  assert.equal(observed.launch_attempt_id,"LAUNCH-1:attempt-1");
  assert.equal(result.launch.status,"LAUNCHED");
  assert.equal(result.deduplicated,false);
});

test("LAUNCHING is fail-closed instead of spawning again", async () => {
  const ctx=setup();
  beginMissionChildLaunch(ctx.control,ctx.launch.launch_id,{
    launch_attempt_id:"LAUNCH-1:attempt-1",
    launcher_request_id:"LAUNCH-1:request-1",
    lease_token:"LAUNCH-1:lease-1",
  });
  let called=false;
  await assert.rejects(
    dispatchMissionContinuation({
      base:ctx.base,
      mission_id:ctx.mission_id,
      parent_run_id:ctx.parent_run_id,
      launch_id:ctx.launch.launch_id,
    },{dispatch_impl:async()=>{called=true;}}),
    /MISSION_CONTINUATION_NOT_DISPATCHABLE:LAUNCHING/,
  );
  assert.equal(called,false);
});

test("sync wrapper transports one JSON payload and parses one receipt", () => {
  const input={base:"C:\\Temp\\mission",mission_id:"M",parent_run_id:"R",launch_id:"L"};
  let decoded=null;
  const result=dispatchMissionContinuationSync(input,{
    cli_path:"C:\\repo\\tools\\dispatch.mjs",
    spawn_sync:(_command,args,options)=>{
      assert.equal(args[1],"--dispatch");
      decoded=JSON.parse(Buffer.from(args[2],"base64url").toString("utf8"));
      assert.equal(options.windowsHide,true);
      return {status:0,stdout:JSON.stringify({status:"LAUNCHED",child_run_id:"CHILD"})+"\n",stderr:""};
    },
  });
  assert.deepEqual(decoded,input);
  assert.equal(result.status,"LAUNCHED");
  assert.equal(result.child_run_id,"CHILD");
});
