import * as THREE from 'three';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import {SparkRenderer, SplatMesh} from '@sparkjsdev/spark';
import {plyInfo, focusBounds, normalizedPoint, validationSummary, mappedDisplayPoints, observationArrowTail, shuffled} from './core.js';

const $ = id => document.getElementById(id);
const sleep = ms => new Promise(resolve => setTimeout(resolve,ms));
const token = location.hash.slice(1);
const host = window.ROIHost || null;
let nativeInfo=null, nativeId=0, nativePending=new Map(), lastNativeState='';
function nativeCall(type,data={},timeout=10000) {
  const rid=++nativeId;
  return new Promise((resolve,reject)=>{
    const timer=timeout?setTimeout(()=>{nativePending.delete(rid);reject(Error('앱 응답 시간이 초과되었습니다.'));},timeout):null;
    nativePending.set(rid,{resolve,reject,timer});
    host.postMessage(JSON.stringify({rid,type,...data}));
  });
}
if(host)host.onmessage=message=>{
  const data=JSON.parse(message.data),p=nativePending.get(data.rid);if(!p)return;
  nativePending.delete(data.rid);clearTimeout(p.timer);
  if(data.ok)p.resolve(data.result);else p.reject(Error(data.error));
};
const available=()=>!document.hidden&&(!host||nativeInfo?.available===true);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45,1,.01,100);
camera.position.set(0,0,4);
const renderer = new THREE.WebGLRenderer({antialias:false});
renderer.setPixelRatio(Math.min(devicePixelRatio,2));
renderer.setClearColor(0xe3e9e8);
$('viewer').append(renderer.domElement);
const overlay = document.createElement('canvas');
$('viewer').append(overlay); overlay.style.pointerEvents='none';
const ink = overlay.getContext('2d');
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping=false; controls.minDistance=.2; controls.maxDistance=12;
controls.touches.ONE=THREE.TOUCH.ROTATE; controls.touches.TWO=THREE.TOUCH.DOLLY_PAN;
scene.add(new SparkRenderer({renderer}));
let model=null, modelInfo=null, initialPosition=null, initialTarget=null, lastView=null;
let session=null, metadata=null, phase='setup', priorPhase=null, events=[], seq=0, startTime=0;
let ws=null, online=false, trackerReady=false, stopped=false, readOnly=false;
let requestId=0, pending=new Map(), unsaved=[], flushing=false, frameBusy=false, frameId=0;
let validation=null, target=null, targetId=null, sampleAfter=0, calibrationCancelled=false;
let videoStream=null, lastSend=0, cameraRunning=false, totalFrames=0, droppedFrames=0;
let cameraGeneration=0, cameraPreparing=false, calibrationBusy=false, calibrationViewport=null, exporting=false, exportedCount=0;
let points=[], showPoints=true, showOrder=true, showDirection=false, probeArmed=false, visibilityIndex=0, viewChangedAt=0;
let mapping=false, frameCount=0, fpsStart=performance.now(), fps=0, reconnectTimer=null;
let viewportKey=`${innerWidth}x${innerHeight}`;
const viewport=()=>[innerWidth,innerHeight];
const elapsed=()=>performance.now()-startTime;
const status=text=>{$('status').textContent=text;};
const db = new Promise((resolve,reject)=>{
  const open=indexedDB.open('roi-session-backup',1);
  open.onupgradeneeded=()=>open.result.createObjectStore('events');
  open.onsuccess=()=>resolve(open.result); open.onerror=()=>reject(open.error);
});

async function backup(batch) {
  const database=await db;
  await new Promise((resolve,reject)=>{
    const tx=database.transaction('events','readwrite');
    for(const e of batch) tx.objectStore('events').put(e,`${session}:${e.id}`);
    tx.oncomplete=resolve; tx.onerror=()=>reject(tx.error); tx.onabort=()=>reject(tx.error);
  });
}

function log(type,data={},t=elapsed()) {
  if(!session || readOnly) return;
  const e={id:`e:${++seq}`,type,t,phase,...data};
  events.push(e); unsaved.push(e); syncNative(); return e;
}
function receiveGaze(e) {
  events.push(e);
  // PC has persisted this record; retain the same record in the local backup.
  backup([e]).catch(error=>pause(`로컬 백업 실패: ${error.message}`));
}
async function rpc(type,data={},timeout=15000) {
  if(!online) throw Error('PC 연결이 끊겼습니다.');
  const rid=++requestId;
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{pending.delete(rid);reject(Error(`${type}: PC 응답 시간 초과`));},timeout);
    pending.set(rid,{resolve,reject,timer});
    ws.send(JSON.stringify({type,rid,...data}));
  });
}
async function flush() {
  if(flushing || !unsaved.length || readOnly) return;
  flushing=true;
  const batch=unsaved.slice(0,200);
  try {
    await backup(batch);
    if(online) {await rpc('events',{events:batch});unsaved.splice(0,batch.length);}
  } catch(error) {pause(`로그 저장 대기: ${error.message}`);}
  finally{flushing=false;syncNative();if(phase==='results')showSummary();}
}
setInterval(flush,500);

async function connect() {
  clearTimeout(reconnectTimer);
  return new Promise((resolve,reject)=>{
    ws=new WebSocket(`${location.protocol==='https:'?'wss':'ws'}://${location.host}/ws`);
    let ready=false;
    const timeout=setTimeout(()=>{ws.close();reject(Error('PC 준비 시간 초과'));},45000);
    ws.onopen=()=>ws.send(JSON.stringify({token,session_id:session,metadata}));
    ws.onmessage=message=>{
      const data=JSON.parse(message.data);
      if(data.type==='ready') {
        ready=true; online=true;clearTimeout(timeout);
        trackerReady=!!data.tracker; $('connection').textContent='PC 연결됨';
        if(!events.some(e=>e.id==='tracker')) events.push({id:'tracker',type:'tracker',t:0,data:data.tracker,error:data.tracker_error});
        if(data.tracker_error) status(`추적기 준비 실패: ${data.tracker_error}`);
        if(data.closed) {stopped=true; phase='results';}
        buttons(); resolve(data);
      } else if(data.type==='error') {clearTimeout(timeout);reject(Error(data.error));ws.close();}
      else if(pending.has(data.rid)) {
        const p=pending.get(data.rid);pending.delete(data.rid);clearTimeout(p.timer);
        if(data.ok) p.resolve(data.result); else p.reject(Error(data.error));
      }
    };
    ws.onerror=()=>{if(!ready){clearTimeout(timeout);reject(Error('PC 연결 실패. 주소와 인증서를 확인하세요.'));}};
    ws.onclose=()=>{
      clearTimeout(timeout);online=false; $('connection').textContent='PC 연결 끊김';
      for(const p of pending.values()){clearTimeout(p.timer);p.reject(Error('PC 연결 끊김'));}pending.clear();
      if(!ready) reject(Error('PC 연결이 종료되었습니다.'));
      if(!stopped && session) {
        pause('연결이 끊겨 과제를 중지했습니다. 재연결 후 일시 중지를 해제하세요.');
        reconnectTimer=setTimeout(()=>connect().catch(error=>status(error.message)),2500);
      }
      buttons();
    };
  });
}

function snapshot() {
  const r=$('viewer').getBoundingClientRect();
  return {camera:camera.matrixWorld.toArray(),projection:camera.projectionMatrix.toArray(),
    model:model?model.matrixWorld.toArray():new THREE.Matrix4().toArray(),rect:[r.x,r.y,r.width,r.height],
    near:camera.near,far:camera.far,rendered_t:session?elapsed():0,target:controls.target.toArray()};
}
function resize() {
  const r=$('viewer').getBoundingClientRect();
  renderer.setSize(r.width,r.height,false);overlay.width=Math.round(r.width);overlay.height=Math.round(r.height);
  camera.aspect=r.width/r.height; camera.updateProjectionMatrix(); invalidatePoints();
  const key=`${innerWidth}x${innerHeight}`;
  if(session && key!==viewportKey && !stopped) {
    if(!['response','finishing'].includes(phase))suspend('화면 크기/방향이 바뀌었습니다. 카메라와 시선 보정을 다시 준비하세요.');
    log('viewport_change',{viewport:viewport()});
  }
  viewportKey=key;
}
new ResizeObserver(resize).observe($('viewer'));
function invalidatePoints() {viewChangedAt=performance.now();visibilityIndex=0;for(const p of points)p.visible=false;}
controls.addEventListener('change',()=>{invalidatePoints();if(session && !stopped) log('view_change',{view:snapshot()});});
for(const name of ['pointerdown','pointermove','pointerup','pointercancel']) {
  renderer.domElement.addEventListener(name,e=>{
    if(['observing','response'].includes(phase)) log(name,{pointer_id:e.pointerId,xy:[e.clientX,e.clientY],buttons:e.buttons,pointer_type:e.pointerType});
  },{passive:true});
}
renderer.domElement.addEventListener('wheel',e=>{if(phase==='observing')log('wheel',{delta:[e.deltaX,e.deltaY],mode:e.deltaMode});},{passive:true});

function cast(x,y,view) {
  const ndc=normalizedPoint(x,y,view.rect);if(!ndc || !model)return null;
  const c=new THREE.PerspectiveCamera();c.matrixWorld.fromArray(view.camera);
  c.projectionMatrix.fromArray(view.projection);c.projectionMatrixInverse.copy(c.projectionMatrix).invert();
  const ray=new THREE.Raycaster();ray.setFromCamera(new THREE.Vector2(...ndc),c);
  const saved=model.matrixWorld.clone();model.matrixWorld.fromArray(view.model);
  try {
    const all=[];model.raycast(ray,all);
    const hits=all.filter(h=>h.distance>=(view.near??.01)&&h.distance<=(view.far??100));hits.sort((a,b)=>a.distance-b.distance);
    return hits.length ? hits[0].point.clone().applyMatrix4(new THREE.Matrix4().fromArray(view.model).invert()).toArray() : null;
  } finally {model.matrixWorld.copy(saved);}
}
function projected(p,clipToViewport=true) {
  const world=new THREE.Vector3(...p.local).applyMatrix4(model.matrixWorld);
  const v=world.clone().project(camera);
  if(v.z< -1 || v.z>1 || (clipToViewport&&(Math.abs(v.x)>1 || Math.abs(v.y)>1)))return null;
  return {x:(v.x+1)*overlay.width/2,y:(1-v.y)*overlay.height/2,world};
}
renderer.setAnimationLoop(()=>{
  controls.update();renderer.render(scene,camera);lastView=snapshot();
  frameCount++;
  if(performance.now()-fpsStart>=1000){fps=frameCount*1000/(performance.now()-fpsStart);frameCount=0;fpsStart=performance.now();}
  ink.clearRect(0,0,overlay.width,overlay.height);
  if(model && showPoints && !mapping && performance.now()-viewChangedAt>200 && visibilityIndex<points.length) {
    const p=points[visibilityIndex++],screen=projected(p);
    if(screen){
      const r=lastView.rect,hit=cast(screen.x+r[0],screen.y+r[1],lastView);
      p.visible=!!hit && new THREE.Vector3(...hit).distanceTo(new THREE.Vector3(...p.local))<(modelInfo.focus_diagonal||modelInfo.local_diagonal)*.02;
    }
  }
  if(showPoints && model) for(const p of points) {
    if(!p.visible)continue;const v=projected(p);if(!v)continue;
    if(showDirection && p.arrowTail){
      const tail=projected({local:p.arrowTail},false);
      if(tail){
        const dx=v.x-tail.x,dy=v.y-tail.y,length=Math.hypot(dx,dy);
        // A head-on arrow has no reliable 2D direction; rotating the view reveals it.
        if(length>2){
          const ux=dx/length,uy=dy/length,head=Math.min(9,length*.4);
          ink.strokeStyle='#305da8';ink.lineWidth=2;ink.beginPath();
          ink.moveTo(tail.x,tail.y);ink.lineTo(v.x,v.y);
          ink.moveTo(v.x-head*ux+head*.5*uy,v.y-head*uy-head*.5*ux);ink.lineTo(v.x,v.y);
          ink.lineTo(v.x-head*ux-head*.5*uy,v.y-head*uy+head*.5*ux);ink.stroke();
        }
      }
    }
    ink.strokeStyle=p.kind==='probe'?'#b9530b':'#007d73';ink.lineWidth=2;ink.beginPath();
    if(p.kind==='probe'){ink.moveTo(v.x-5,v.y);ink.lineTo(v.x+5,v.y);ink.moveTo(v.x,v.y-5);ink.lineTo(v.x,v.y+5);}
    else ink.arc(v.x,v.y,4,0,2*Math.PI);
    ink.stroke();
    if(showOrder && p.order){
      ink.font='12px system-ui';ink.textAlign='center';ink.textBaseline='bottom';
      ink.strokeStyle='white';ink.lineWidth=3;ink.fillStyle='#007d73';
      ink.strokeText(String(p.order),v.x,v.y-7);ink.fillText(String(p.order),v.x,v.y-7);
    }
  }
});

async function loadModel(file) {
  if(!file)return;
  if(file.size>300*1024*1024)throw Error('초기 버전의 파일 한도는 300MB입니다.');
  if(session&&!stopped)throw Error('진행 중인 세션의 모델을 바꿀 수 없습니다.');
  $('prepare').disabled=true;status('PLY 확인 중…');
  const info=plyInfo(new Uint8Array(await file.slice(0,16384).arrayBuffer()),file.size);
  const bytes=new Uint8Array(await file.arrayBuffer());
  const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map(v=>v.toString(16).padStart(2,'0')).join('');
  status(`${info.count.toLocaleString()}개 스플랫 불러오는 중…`);
  const next=new SplatMesh({fileBytes:bytes,raycastable:true,minRaycastOpacity:.2});
  try{await next.initialized;}catch(error){next.dispose();throw error;}
  const fullBox=next.getBoundingBox(),focus=focusBounds(bytes,info);
  const box=new THREE.Box3(new THREE.Vector3(...focus.min),new THREE.Vector3(...focus.max));
  const size=box.getSize(new THREE.Vector3()),center=box.getCenter(new THREE.Vector3());
  if(![...size.toArray(),...center.toArray()].every(Number.isFinite)||size.length()<=0){next.dispose();throw Error('모델 경계가 유효하지 않습니다.');}
  if(model){scene.remove(model);model.dispose();} model=next;
  const scale=2/Math.max(size.x,size.y,size.z);model.scale.setScalar(scale);
  // PLY has no universal axis convention: preserve its axes (the supplied shoe uses +Y up).
  model.position.copy(center).applyQuaternion(model.quaternion).multiplyScalar(-scale);
  scene.add(model);scene.updateMatrixWorld(true);
  controls.target.set(0,0,0);camera.position.set(0,1.6,3.6);controls.update();
  initialPosition=camera.position.clone();initialTarget=controls.target.clone();
  modelInfo={name:file.name,sha256:hash,bytes:file.size,splats:info.count,local_diagonal:fullBox.getSize(new THREE.Vector3()).length(),
    focus_diagonal:size.length(),framing:'sampled 5–95% center bounds; no splats removed',
    initial_matrix:model.matrixWorld.toArray(),units:'original PLY units',mapping:'Spark 2.2.0 raycast',min_opacity:.2};
  points=[];$('empty').hidden=true;status(`상품 준비 완료 · ${info.count.toLocaleString()} 스플랫`);$('prepare').disabled=false;
}
$('modelFile').onchange=()=>loadModel($('modelFile').files[0]).catch(error=>{status(error.message);$('prepare').disabled=false;});
$('reset').onclick=()=>{if(initialPosition){camera.position.copy(initialPosition);controls.target.copy(initialTarget);controls.update();log('reset_view',{view:snapshot()});}};
$('fullView').onclick=()=>{
  if(!model)return;const box=model.getBoundingBox().applyMatrix4(model.matrixWorld);
  const center=box.getCenter(new THREE.Vector3()),radius=box.getSize(new THREE.Vector3()).length();
  controls.maxDistance=Math.max(12,radius*2);camera.far=Math.max(100,radius*4);camera.updateProjectionMatrix();
  controls.target.copy(center);camera.position.copy(center).add(new THREE.Vector3(0,.4*radius,radius));controls.update();log('full_view',{view:snapshot()});
};

function buttons() {
  const ready=online && !!model && available();
  $('calibrate').disabled=!ready || !trackerReady || !cameraRunning || stopped || calibrationBusy || !['ready','paused'].includes(phase);
  $('start').disabled=!ready || phase!=='ready' || !(metadata?.diagnostic || validation?.passed || (validation&&$('acceptLowQuality').checked));
  $('found').disabled=phase!=='observing';$('finish').disabled=!session||!['ready','observing','response','paused'].includes(phase);
  $('export').disabled=!session||exporting;
  $('resume').disabled=!ready || phase!=='paused' || !priorPhase || !(metadata?.diagnostic || (cameraRunning&&validation&&(validation.passed||$('acceptLowQuality').checked)));
  $('cameraRestart').disabled=!ready||cameraPreparing||calibrationBusy;
  controls.enabled=!['calibration','validation','validation_post','fitting','finishing','paused'].includes(phase);
  document.body.classList.toggle('compact',!!session&&!stopped&&phase!=='results');
  const visible={calibrate:['ready','paused'].includes(phase),start:phase==='ready',found:phase==='observing',
    finish:!!session&&['ready','observing','response','paused'].includes(phase),resume:phase==='paused'&&!!priorPhase,
    cameraRestart:!!trackerReady&&!cameraRunning&&!metadata?.diagnostic&&!stopped&&['ready','paused'].includes(phase),
    export:!!session&&phase!=='observing',fullView:!session||phase==='results',
    leaveApp:!!host&&(!session||['ready','paused'].includes(phase)),newSession:stopped};
  for(const [id,show] of Object.entries(visible))$(id).hidden=!show;
  $('responseRow').hidden=phase!=='response'&&!(phase==='paused'&&priorPhase==='response');
  $('phaseLabel').textContent=({setup:'상품 미리보기',ready:'측정 준비',calibration:'시선 보정',validation:'독립 검증',validation_post:'종료 검증',observing:'상품 관찰',response:'발견 응답',paused:'일시 중지',results:'관찰 결과'})[phase]||phase;
  syncNative();
}
function syncNative() {
  if(!host||!nativeInfo)return;
  const data={session:session||'',active:!!session&&!stopped,awake:!!session&&!stopped&&available(),
    unfinished:!!session&&!readOnly&&(!stopped||unsaved.length>0||frameBusy)};
  const key=JSON.stringify(data);if(key===lastNativeState)return;lastNativeState=key;
  nativeCall('state',data).catch(error=>status(error.message));
}
function pause(reason) {
  if(!session || stopped)return;
  if(phase!=='paused'){priorPhase=['observing','response'].includes(phase)?phase:null;log('pause',{reason});phase='paused';}
  calibrationCancelled=true;status(reason);buttons();
}
function stopCamera() {
  cameraGeneration++;cameraRunning=false;
  if(videoStream)for(const track of videoStream.getTracks()){track.onended=null;track.stop();}
  videoStream=null;$('video').srcObject=null;
}
function suspend(reason) {
  if(!session||stopped)return;
  validation=null;calibrationViewport=null;$('acceptLowQuality').checked=false;$('diagnosticOverride').hidden=true;
  target=null;stopCamera();pause(reason);
}
window.roiNativeEvent=info=>{
  nativeInfo=info;
  if(session&&!stopped)log('app_environment',{data:info});
  if(!info.available&&!stopped&&phase!=='setup'){
    // Answer entry is outside the search interval; its keyboard must not erase the completed calibration.
    if(!(['response','finishing'].includes(phase)&&info.foreground&&info.landscape&&!info.multi_window&&
      info.display_rotation===metadata.native_environment?.display_rotation))suspend(info.reason);
  }
  buttons();
};
window.roiSuspend=suspend;
window.roiCanLeave=()=>!exporting&&!mapping&&!frameBusy&&(!session||(stopped&&((!readOnly&&unsaved.length===0)||exportedCount===events.length)));
document.addEventListener('visibilitychange',()=>{if(document.hidden)suspend('화면이 비활성화되어 과제를 중지했습니다. 카메라와 시선 보정을 다시 준비하세요.');});
$('resume').onclick=()=>{phase=priorPhase;priorPhase=null;log('resume');buttons();status('측정을 재개했습니다.');};
$('acceptLowQuality').onchange=buttons;
$('cameraRestart').onclick=()=>prepareCamera().catch(error=>status(error.message));
$('leaveApp').onclick=()=>nativeCall('leave').catch(error=>status(error.message));
$('newSession').onclick=()=>{
  if(!window.roiCanLeave()){status('미저장 로그를 먼저 내보내세요.');return;}
  if(host)nativeCall('leave').catch(error=>status(error.message));else location.reload();
};

async function prepareCamera() {
  if(cameraPreparing||!available())throw Error('앱의 가로 전체 화면으로 돌아온 뒤 카메라를 준비하세요.');
  stopCamera();cameraPreparing=true;buttons();const generation=cameraGeneration;
  try{
    const stream=await navigator.mediaDevices.getUserMedia({audio:false,video:{facingMode:'user',width:{ideal:metadata.video_width},height:{ideal:720}}});
    if(generation!==cameraGeneration||!available()){
      stream.getTracks().forEach(t=>t.stop());throw Error('카메라 권한 확인 후 카메라 다시 준비를 눌러 주세요.');
    }
    videoStream=stream;$('video').srcObject=stream;await $('video').play();
    if(generation!==cameraGeneration||!available()){stopCamera();throw Error('카메라 준비 중 화면 상태가 바뀌었습니다.');}
    log('camera_settings',{settings:stream.getVideoTracks()[0].getSettings()});
    stream.getVideoTracks()[0].onended=()=>suspend('카메라 입력이 종료되었습니다. 권한을 확인하고 다시 준비하세요.');
    cameraRunning=true;captureLoop(generation);status('카메라 준비 완료. 시선 보정·검증을 시작하세요.');
  }catch(error){if(generation===cameraGeneration)stopCamera();throw error;}
  finally{cameraPreparing=false;buttons();}
}

async function prepare() {
  if(!available())throw Error('앱의 가로 전체 화면과 PC 연결 준비를 확인하세요.');
  if(!model)throw Error('상품 PLY를 먼저 선택하세요.');
  if(!token)throw Error('서버가 출력한 #토큰이 포함된 주소로 접속하세요.');
  if(!$('participant').value.trim())throw Error('참가자 ID를 입력하세요.');
  if(!Number.isFinite(Number($('targetSize').value))||Number($('targetSize').value)<10||Number($('targetSize').value)>1000)throw Error('최소 타겟 폭은 10~1000px 범위로 입력하세요.');
  if(!$('diagnostic').checked && !$('consent').checked)throw Error('측정 동의가 필요합니다.');
  if(session)throw Error('새 참가자는 페이지를 새로 열어 시작하세요.');
  session=crypto.randomUUID();startTime=performance.now();phase='ready';
  metadata={schema_version:1,participant_id:$('participant').value.trim(),task:$('task').value,
    model:modelInfo,diagnostic:$('diagnostic').checked,consent:$('consent').checked,
    started_utc:new Date().toISOString(),viewport:viewport(),dpr:devicePixelRatio,user_agent:navigator.userAgent,
    client:host?'Android WebView':'browser',web_version:'2026-09-20',native_environment:nativeInfo,
    video_width:Number($('videoWidth').value),rotation:Number($('rotation').value),mirror:$('mirror').checked,
    eye_closure_threshold:Number($('eyeThreshold').value),
    geometry_note:$('geometry').value,target_min_width_px:Number($('targetSize').value),
    timestamps:'tablet performance.now relative to session; frame canvas read time, NOT sensor exposure time',
    matrix_layout:'Three.js column-major, model local → world; camera matrixWorld',
    inference_hz_target:10,jpeg_quality:.85,raw_video_saved:false};
  events=[{id:'metadata',type:'metadata',t:0,data:metadata}];await backup(events);
  for(const input of $('setup').querySelectorAll('input,select,button'))input.disabled=true;
  $('setup').hidden=true;window.scrollTo(0,0);
  $('instruction').textContent=metadata.task;status('PC 추적기를 준비하고 있습니다…');
  const ready=await connect();
  if(!metadata.diagnostic && !ready.tracker_error){
    await prepareCamera();
  } else if(metadata.diagnostic) status('기하 점검 세션입니다. 시선 데이터는 생성하지 않습니다.');
  buttons();
}
$('prepare').onclick=()=>prepare().catch(error=>{status(error.message);buttons();});

const frameCanvas=document.createElement('canvas');const frameContext=frameCanvas.getContext('2d');
function captureLoop(generation) {
  const video=$('video');
  const tick=()=>{
    if(!cameraRunning||generation!==cameraGeneration)return;
    if(video.requestVideoFrameCallback)video.requestVideoFrameCallback(tick);else setTimeout(tick,100);
    if(!['calibration','validation','validation_post','observing'].includes(phase)||!online||!trackerReady||!available())return;
    if(performance.now()-lastSend<100)return;
    if(frameBusy){droppedFrames++;return;}
    if(['calibration','validation','validation_post'].includes(phase) && (!target || performance.now()<sampleAfter))return;
    frameBusy=true;lastSend=performance.now();totalFrames++;
    const width=Math.min(metadata.video_width,video.videoWidth),height=Math.round(video.videoHeight*width/video.videoWidth);
    const swap=metadata.rotation%180!==0;
    frameCanvas.width=swap?height:width;frameCanvas.height=swap?width:height;
    frameContext.save();frameContext.translate(frameCanvas.width/2,frameCanvas.height/2);
    if(metadata.mirror)frameContext.scale(-1,1);frameContext.rotate(metadata.rotation*Math.PI/180);
    const t=elapsed();frameContext.drawImage(video,-width/2,-height/2,width,height);frameContext.restore();
    const packet={frame_id:++frameId,t,phase,view:structuredClone(lastView),viewport:viewport(),
      target:target?.slice()||null,target_id:targetId,time_source:'canvas_read_time (sensor latency unknown)'};
    frameCanvas.toBlob(async blob=>{
      try{
        if(!blob)throw Error('카메라 프레임 인코딩 실패');
        if(generation!==cameraGeneration||!available()){log('frame_failed',{frame_id:packet.frame_id,reason:'camera_interrupted_before_send'});return;}
        const image=await new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result.split(',')[1]);r.onerror=()=>reject(r.error);r.readAsDataURL(blob);});
        const result=await rpc('frame',{...packet,image});receiveGaze(result);
        log('frame_received',{frame_id:packet.frame_id,round_trip_ms:elapsed()-t});
      }catch(error){log('frame_failed',{frame_id:packet.frame_id,reason:error.message});pause(error.message);}
      finally{frameBusy=false;syncNative();}
    },'image/jpeg',.85);
  };
  if(video.requestVideoFrameCallback)video.requestVideoFrameCallback(tick);else setTimeout(tick,100);
}
setInterval(()=>{if(session&&!stopped)log('quality_tick',{fps,submitted_frames:totalFrames,dropped_busy_frames:droppedFrames});},1000);

async function drainFrames() {
  const deadline=performance.now()+17000;
  while(frameBusy && performance.now()<deadline)await sleep(30);
  if(frameBusy)throw Error('마지막 시선 결과를 받지 못했습니다.');
}
async function showTargets(mode,positions) {
  phase=mode;buttons();$('calibrationOverlay').hidden=false;document.body.style.overflow='hidden';
  const start=events.length;
  for(const [i,position] of shuffled(positions).entries()) {
    if(calibrationCancelled)throw Error('보정/검증이 중단되었습니다.');
    target=position.map((v,i)=>v*viewport()[i]);targetId=`${mode}:${i}`;
    $('target').style.left=`${target[0]}px`;$('target').style.top=`${target[1]}px`;
    $('calibrationText').textContent=`${mode==='calibration'?'보정':'독립 검증'} ${i+1}/${positions.length} · 점을 바라봐 주세요. 누르지 않아도 됩니다.`;
    log('target_show',{target:target.slice(),target_id:targetId});
    sampleAfter=performance.now()+700;
    const until=performance.now()+2500;
    while(performance.now()<until){if(calibrationCancelled||!available()||!cameraRunning)throw Error('보정/검증이 중단되었습니다.');await sleep(50);}
    target=null;await drainFrames();
  }
  return events.slice(start).filter(e=>e.type==='gaze'&&e.phase===mode);
}
async function validate(post=false) {
  const samples=await showTargets(post?'validation_post':'validation',[[.25,.25],[.75,.25],[.25,.75],[.75,.75],[.55,.4]]);
  const summary=validationSummary(samples,metadata.target_min_width_px);
  const ids=new Set(samples.filter(s=>s.valid).map(s=>s.target_id));
  summary.passed=summary.passed&&ids.size===5;
  log(post?'post_validation':'validation_summary',{data:summary});return summary;
}
function endOverlay() {target=null;targetId=null;$('calibrationOverlay').hidden=true;document.body.style.overflow='';}
$('calibrate').onclick=async()=>{
  try{
    if(calibrationBusy||!cameraRunning||!available())throw Error('카메라와 화면 상태를 확인하세요.');
    calibrationBusy=true;
    calibrationCancelled=false;validation=null;$('acceptLowQuality').checked=false;
    await drainFrames();await rpc('reset_calibration');
    await showTargets('calibration',[.1,.5,.9].flatMap(y=>[.1,.5,.9].map(x=>[x,y])));
    phase='fitting';const fit=await rpc('fit');log('calibration_fit',{data:fit});
    validation=await validate();calibrationViewport=viewportKey;phase=priorPhase?'paused':'ready';
    $('diagnosticOverride').hidden=validation.passed;
    status(`독립 검증: 중앙값 ${validation.median_px?.toFixed(1)??'없음'}px · 90백분위 ${validation.p90_px?.toFixed(1)??'없음'}px · 유효 ${(validation.valid_ratio*100).toFixed(0)}%\n${validation.passed?'측정 기준을 통과했습니다.':'기준 미달입니다. 재보정하거나 진단용 진행을 선택하세요.'}`);
  }catch(error){phase=priorPhase?'paused':'ready';status(error.message);}
  finally{calibrationBusy=false;endOverlay();buttons();}
};
$('cancelCalibration').onclick=()=>{calibrationCancelled=true;target=null;};
$('start').onclick=()=>{
  phase='observing';log('observation_start',{diagnostic:metadata.diagnostic||!validation?.passed,view:snapshot()});
  buttons();status('타겟을 찾으면서 상품을 관찰하세요.');
};
$('found').onclick=()=>{log('target_found');phase='response';$('responseRow').hidden=false;buttons();status('발견한 내용을 입력하고 관찰을 종료하세요.');};
$('finish').onclick=async()=>{
  if(calibrationBusy)return;
  const previous=phase;phase='finishing';buttons();target=null;
  try{
    document.activeElement?.blur();
    await drainFrames();log(events.some(e=>e.type==='observation_start')?'observation_end':'preparation_end',{answer:$('answer').value,ended_from:previous});
    if(trackerReady&&validation&&online&&cameraRunning&&previous!=='paused'){
      const deadline=performance.now()+2500;while(!available()&&performance.now()<deadline)await sleep(50);
      if(!available()||calibrationViewport!==viewportKey)throw Error('종료 검증 화면이 보정 때와 달라 검증을 완료하지 못했습니다.');
      calibrationCancelled=false;const post=await validate(true);status(`종료 검증 90백분위 ${post.p90_px?.toFixed(1)??'없음'}px`);
    } else if(!metadata.diagnostic)log('post_validation_skipped',{reason:'camera_calibration_or_connection_unavailable'});
  }catch(error){log('incomplete',{reason:error.message});status(error.message);}
  finally{
    endOverlay();phase='results';stopCamera();
    log('session_end',{submitted_frames:totalFrames,dropped_busy_frames:droppedFrames});
    const deadline=performance.now()+20000;
    while(online&&unsaved.length&&performance.now()<deadline){await flush();await sleep(30);}
    try{if(unsaved.length)throw Error('일부 로그가 PC 저장 대기 중입니다. JSON을 내보내세요.');await rpc('finish');}
    catch(error){status(error.message);}
    stopped=true;$('results').hidden=false;buttons();showSummary();
  }
};

function showSummary() {
  const gaze=events.filter(e=>e.type==='gaze'&&e.phase==='observing');
  const mapped=events.filter(e=>e.type==='mapping');
  const lines=[`세션 ${session}`,`시선 샘플 ${gaze.length} · 유효 ${gaze.filter(e=>e.valid).length}`,
    `모델 매핑 ${mapped.filter(e=>e.hit).length}/${mapped.length} · 화면 표시 최대 120개`,
    `PC 미저장 이벤트 ${unsaved.length}`,metadata?.diagnostic?'기하 점검 전용 · 시선 연구 데이터 아님':'카메라 기반 추정치 · 절대적인 Ground Truth가 아님'];
  $('summary').textContent=lines.join('\n');
}
function refreshPoints() {
  points=mappedDisplayPoints(events);
  const length=(modelInfo.focus_diagonal||modelInfo.local_diagonal)*.08;
  for(const p of points)p.arrowTail=observationArrowTail(p.local,p.view,length);
  invalidatePoints();showSummary();
}
$('map').onclick=async()=>{
  if(mapping||!model)return;mapping=true;$('map').disabled=true;
  try{
    const known=new Set(events.filter(e=>e.type==='mapping').map(e=>e.source_id));
    const gaze=events.filter(e=>e.type==='gaze'&&e.phase==='observing'&&!known.has(e.id));
    for(let i=0;i<gaze.length;i++){
      const e=gaze[i];const local=e.valid&&e.xy?cast(...e.xy,e.view):null;
      const row={source_id:e.id,source_type:'gaze',hit:!!local,local,reason:local?null:(!e.valid?'invalid_gaze':'outside_or_no_intersection'),method:'Spark raycast, opacity >= 0.2'};
      if(readOnly)events.push({id:`map:${e.id}`,type:'mapping',t:e.t,...row});else log('mapping',row,e.t);
      if(i%10===0)status(`매핑 ${i+1}/${gaze.length}`);await sleep(0);
    }
    refreshPoints();status('매핑 완료. 점은 제품 좌표에 고정됩니다.');
  }catch(error){status(error.message);}finally{mapping=false;$('map').disabled=false;}
};
$('probe').onclick=()=>{probeArmed=true;status('모델 위를 한 번 누르세요. 시선과 구분된 기하 점검점으로 기록합니다.');};
renderer.domElement.addEventListener('click',e=>{
  if(!probeArmed||!stopped||!model)return;probeArmed=false;
  const view=snapshot(),local=cast(e.clientX,e.clientY,view),id=`probe:${crypto.randomUUID()}`;
  const p={id,type:'probe',t:elapsed(),xy:[e.clientX,e.clientY],view};
  if(readOnly)events.push(p);else{events.push(p);unsaved.push(p);}
  const row={source_id:id,source_type:'probe',hit:!!local,local,method:'Spark raycast, opacity >= 0.2'};
  if(readOnly)events.push({id:`map:${id}`,type:'mapping',t:p.t,...row});else log('mapping',row);
  refreshPoints();status(local?'기하 점검점을 표시했습니다.':'상품과 교차하지 않는 위치입니다.');
});
$('toggle').onclick=()=>{showPoints=!showPoints;$('toggle').textContent=showPoints?'점 숨기기':'점 표시';};
$('toggleOrder').onclick=()=>{
  showOrder=!showOrder;$('toggleOrder').textContent=showOrder?'순서 숨기기':'순서 표시';
  $('toggleOrder').setAttribute('aria-pressed',String(showOrder));
};
$('toggleDirection').onclick=()=>{
  showDirection=!showDirection;$('toggleDirection').textContent=showDirection?'관찰 방향 숨기기':'관찰 방향 표시';
  $('toggleDirection').setAttribute('aria-pressed',String(showDirection));
};

async function download() {
  if(exporting)return;exporting=true;buttons();
  try{
  await flush();let combined=events;
  if(!readOnly){
    try{
      const response=await fetch(`/api/session/${session}`,{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(5000)});
      if(response.ok){const saved=await response.json();combined=[...new Map([...saved.events,...events].map(e=>[e.id,e])).values()];}
    }catch{ /* Local backup still exports when PC is disconnected. */ }
  }
  const payload={schema_version:1,session_id:session,events:combined,unsaved_events:unsaved.length};
  const data=JSON.stringify(payload,null,2),count=events.length;
  if(host){
    const bytes=new TextEncoder().encode(data);
    if(bytes.length>100*1024*1024)throw Error('앱 내보내기 한도 100MB를 넘었습니다. PC 세션 파일을 사용하세요.');
    await nativeCall('exportBegin',{session});
    try{
      for(let i=0;i<bytes.length;i+=65536){
        let binary='';for(const byte of bytes.subarray(i,i+65536))binary+=String.fromCharCode(byte);
        await nativeCall('exportChunk',{data:btoa(binary)});
      }
      await nativeCall('exportEnd',{},0);exportedCount=count;status('JSON 파일을 저장했습니다.');
    }catch(error){await nativeCall('exportAbort').catch(()=>{});throw error;}
  }else{
    const url=URL.createObjectURL(new Blob([data],{type:'application/json'}));
    const a=document.createElement('a');a.href=url;a.download=`ROI-${session}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  }finally{exporting=false;buttons();}
}
$('export').onclick=()=>download().catch(error=>status(error.message));
window.roiExport=()=>download().catch(error=>status(error.message));
$('restoreButton').onclick=()=>$('restoreFile').click();
$('restoreFile').onchange=async()=>{
  try{
    if(session&&!window.roiCanLeave())throw Error('현재 세션을 종료하고 미저장 로그를 먼저 내보내세요.');
    if(!model)throw Error('기록에 사용한 PLY를 먼저 불러오세요.');
    const file=$('restoreFile').files[0];if(!file)return;if(file.size>100*1024*1024)throw Error('JSON 파일이 너무 큽니다.');
    const saved=JSON.parse(await file.text());
    if(saved.schema_version!==1||!Array.isArray(saved.events)||saved.events.length>250000||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(saved.session_id))throw Error('지원하지 않는 세션 형식');
    const meta=saved.events.find(e=>e.type==='metadata')?.data;
    if(!meta||meta.model?.sha256!==modelInfo.sha256)throw Error('모델 파일 해시가 세션과 다릅니다.');
    const finiteArray=(value,size)=>Array.isArray(value)&&value.length===size&&value.every(Number.isFinite);
    if(!finiteArray(meta.model.initial_matrix,16))throw Error('손상된 모델 변환');
    for(const e of saved.events){
      if(e.type==='mapping'&&e.hit&&(!Array.isArray(e.local)||e.local.length!==3||!e.local.every(Number.isFinite)))throw Error('손상된 매핑 좌표');
      if(e.type==='gaze'&&e.valid&&(!finiteArray(e.xy,2)||!e.view||
        !['camera','projection','model'].every(key=>finiteArray(e.view[key],16))||!finiteArray(e.view.rect,4)))throw Error('손상된 시선 데이터');
    }
    stopped=true;stopCamera();ws?.close();clearTimeout(reconnectTimer);readOnly=true;
    session=saved.session_id;metadata=meta;events=saved.events;exportedCount=events.length;unsaved=[];phase='results';
    model.matrix.fromArray(meta.model.initial_matrix);model.matrix.decompose(model.position,model.quaternion,model.scale);model.updateMatrixWorld(true);
    $('results').hidden=false;$('prepare').disabled=true;$('setup').hidden=true;$('instruction').textContent=metadata.task;window.scrollTo(0,0);refreshPoints();buttons();status('저장한 세션을 불러왔습니다.');
  }catch(error){status(error.message);}
};
$('delete').onclick=async()=>{
  try{
    if(readOnly)throw Error('불러온 파일은 원래 저장 위치에서 삭제하세요.');
    if(!confirm('PC에 저장된 이 세션 로그를 삭제할까요? 필요한 JSON을 먼저 내보내세요.'))return;
    stopped=true;ws?.close();await sleep(200);
    const r=await fetch(`/api/session/${session}`,{method:'DELETE',headers:{Authorization:`Bearer ${token}`}});
    if(!r.ok)throw Error(await r.text());status('PC 세션 로그를 삭제했습니다. 브라우저 백업은 유지됩니다.');
  }catch(error){status(error.message);}
};
window.addEventListener('beforeunload',e=>{if(session&&(!stopped||unsaved.length)){e.preventDefault();e.returnValue='';}});
window.addEventListener('error',e=>status(`오류: ${e.message}`));
window.addEventListener('unhandledrejection',e=>status(`오류: ${e.reason?.message||e.reason}`));
if(host)nativeCall('hello').then(info=>window.roiNativeEvent(info)).catch(error=>status(error.message));
status('신발 PLY를 선택하고 측정 조건을 확인하세요.');buttons();resize();
