import test from 'node:test';
import assert from 'node:assert/strict';
import {createConsoleServer} from './devexec-native-console.mjs';

test('Mission Console is a thin exact-identity adapter with same-origin controls',async()=>{
  const calls=[];
  const projection={mission_id:'mission-one',revision:3,status:'RUNNING',goal:{title:'Fixture'},episodes:[]};
  const service={list:()=>[projection],inspect:id=>id==='mission-one'?projection:null,submit:input=>{calls.push(['submit',input]);return {mission_id:'mission-one'};},control:input=>{calls.push(['control',input]);return {status:'APPLIED'};}};
  const server=createConsoleServer({missionService:service});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  const post=(route,value,origin=base)=>fetch(base+route,{method:'POST',headers:{'content-type':'application/json',origin},body:JSON.stringify(value)});
  try{
    assert.match(await(await fetch(base+'/')).text(),/href="\/missions"/);
    assert.match(await(await fetch(base+'/missions')).text(),/新しいMissionの目的/);
    assert.deepEqual(await(await fetch(base+'/api/missions')).json(),{missions:[projection]});
    assert.deepEqual(await(await fetch(base+'/api/missions/mission-one')).json(),projection);
    assert.equal((await fetch(base+'/api/missions/missing')).status,404);
    assert.equal((await post('/api/missions',{goal:'Fixture',request_id:'request-1'})).status,200);
    const command={action:'PAUSE',expected_revision:3,request_id:'request-2'};
    assert.equal((await post('/api/missions/mission-one/control',command)).status,200);
    assert.deepEqual(calls[1],['control',{mission_id:'mission-one',...command}]);
    const before=calls.length;
    assert.equal((await post('/api/missions/mission-one/control',command,'http://127.0.0.1:9')).status,403);
    for(const alteration of [{action:'COMPLETE'},{expected_revision:0},{actor:{role:'GOVERNANCE'}},{mission_id:'mission-other'}]){
      assert.equal((await post('/api/missions/mission-one/control',{...command,...alteration})).status,400);
    }
    assert.equal((await post('/api/missions',{goal:'Fixture',request_id:'request-3',scope:'outside'})).status,400);
    assert.equal(calls.length,before);
  }finally{await new Promise(resolve=>server.close(resolve));}
});

test('Mission routes require explicitly injected service and do not enable themselves',async()=>{
  const server=createConsoleServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{assert.equal((await fetch(`http://127.0.0.1:${server.address().port}/api/missions`)).status,404);}finally{await new Promise(resolve=>server.close(resolve));}
});
