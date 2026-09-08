import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {DevExecMissionController} from './devexec-mission-controller.mjs';
import {createMissionConsoleService} from './devexec-mission-console-service.mjs';

const BINDING=`sha256:${'a'.repeat(64)}`;
function fixture(t){
  const stateDir=fs.mkdtempSync(path.join(os.tmpdir(),'devexec-f05-service-'));
  t.after(()=>fs.rmSync(stateDir,{recursive:true,force:true}));
  const wakes=[];
  let clock=Date.parse('2026-09-08T00:00:00.000Z');
  let allowed=true;
  function restart(){
    const controller=new DevExecMissionController({stateDir,validateAuthority:({actor,requested_authority})=>({allowed:allowed&&actor.binding_id===BINDING&&requested_authority==='READ_ONLY',authority_ref:'test:trusted-f05-profile'})});
    const service=createMissionConsoleService({controller,bindingId:BINDING,acceptanceRefs:['test:f05'],protectedConstraints:['fixture-only'],now:()=>new Date(clock+=60000),notifyRunnable:notification=>wakes.push(notification)});
    return {controller,service};
  }
  return {restart,wakes,deny:()=>{allowed=false;}};
}

test('submit restores canonical timestamp across service/controller restart and rejects changed goal',t=>{
  const f=fixture(t);
  const request={goal:'Inspect the bounded fixture',request_id:'create-one'};
  const first=f.restart().service.submit(request);
  assert.equal(first.status,'APPLIED');
  const {controller,service}=f.restart();
  const duplicate=service.submit(request);
  assert.equal(duplicate.status,'DUPLICATE');
  assert.equal(duplicate.mission_id,first.mission_id);
  const changed=service.submit({...request,goal:'Different bounded goal'});
  assert.equal(changed.status,'BLOCKED');
  assert.equal(changed.reason_code,'IDEMPOTENCY_CONFLICT');
  assert.equal(controller.listMissions().missions.length,1);
  assert.equal(controller.inspect(first.mission_id).goal.summary,request.goal);
  assert.equal(f.wakes.length,0);
  f.deny();
  assert.throws(()=>service.submit(request),{code:'AUTHORITY_DENIED'});
});

test('START and RESUME exact retries survive restart, retain revision checks, and wake once each',async t=>{
  const f=fixture(t);
  let {controller,service}=f.restart();
  const created=service.submit({goal:'Read-only fixture',request_id:'create-control'});
  const mission_id=created.mission_id;
  const start={mission_id,action:'START',expected_revision:controller.inspect(mission_id).revision,request_id:'start-one'};
  assert.equal((await service.control(start)).status,'APPLIED');
  ({controller,service}=f.restart());
  assert.equal((await service.control(start)).status,'DUPLICATE');
  assert.equal(f.wakes.length,1);
  await assert.rejects(service.control({...start,expected_revision:start.expected_revision+1}),{code:'MISSION_COMMAND_REPLAY_CONFLICT'});
  await assert.rejects(service.control({...start,action:'PAUSE'}),{code:'MISSION_COMMAND_REPLAY_CONFLICT'});
  const pause={mission_id,action:'PAUSE',expected_revision:controller.inspect(mission_id).revision,request_id:'pause-one'};
  assert.equal((await service.control(pause)).status,'APPLIED');
  const resume={mission_id,action:'RESUME',expected_revision:controller.inspect(mission_id).revision,request_id:'resume-one'};
  assert.equal((await service.control(resume)).status,'APPLIED');
  const revision=controller.inspect(mission_id).revision;
  ({controller,service}=f.restart());
  assert.equal((await service.control(resume)).status,'DUPLICATE');
  assert.equal(controller.inspect(mission_id).revision,revision);
  assert.equal(f.wakes.filter(wake=>wake.receipt.request_id==='resume-one').length,1);
  assert.equal(f.wakes.length,2);
  await assert.rejects(service.control({...resume,action:'CANCEL'}),{code:'MISSION_COMMAND_REPLAY_CONFLICT'});
  const other=service.submit({goal:'Other fixture',request_id:'create-other'});
  await assert.rejects(service.control({...resume,mission_id:other.mission_id}),{code:'MISSION_COMMAND_REPLAY_CONFLICT'});
  f.deny();
  await assert.rejects(service.control(resume),{code:'AUTHORITY_DENIED'});
  assert.equal(f.wakes.length,2);
});

test('public Event pagination is followed before canonical replay',async t=>{
  const f=fixture(t);
  const {controller,service}=f.restart();
  const mission_id=service.submit({goal:'Paged fixture',request_id:'paged-create'}).mission_id;
  const start={mission_id,action:'START',expected_revision:1,request_id:'paged-start'};
  await service.control(start);
  const readPage=controller.listEvents.bind(controller);
  let pages=0;
  controller.listEvents=(id,{after})=>{pages++;return readPage(id,{after,limit:1});};
  assert.equal((await service.control(start)).status,'DUPLICATE');
  assert.ok(pages>=2);
  assert.equal(f.wakes.length,1);
});
