// Run npm run check; add -- --browser for a real Edge/WebGL smoke check.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {Matrix4,Vector3,PerspectiveCamera} from 'three';
import {plyInfo, focusBounds, normalizedPoint, validationSummary, mappedDisplayPoints, observationArrowTail} from './static/core.js';

const orderedFrames=[3,1,2].flatMap(n=>[
  {id:`g${n}`,type:'gaze',phase:'observing',t:n*10,frame_id:n},
  {type:'mapping',source_type:'gaze',source_id:`g${n}`,hit:n!==2,local:[n,0,0]}
]);
orderedFrames.push({type:'mapping',source_type:'probe',hit:true,local:[0,0,0]},
  {id:'calibration',type:'gaze',phase:'calibration',t:0});
assert.deepEqual(mappedDisplayPoints(orderedFrames).map(p=>p.order),[1,3,undefined]);
const manyFrames=Array.from({length:245},(_,i)=>[
  {id:`g${i}`,type:'gaze',phase:'observing',t:i,frame_id:i},
  {type:'mapping',source_type:'gaze',source_id:`g${i}`,hit:true,local:[i,0,0]}
]).flat();
const displayed=mappedDisplayPoints(manyFrames.reverse());
assert(displayed.length<=120);
assert.deepEqual(displayed.slice(0,3).map(p=>p.order),[1,4,7]);
assert.equal(displayed.at(-1).order,244);
console.log('PASS: chronological frame numbers, missing hits, probe exclusion and display thinning');

const capturedModel=new Matrix4().makeRotationZ(Math.PI/2).scale(new Vector3(2,3,4)).setPosition(8,-3,2);
const cameraPosition=new Vector3(0,5,0).applyMatrix4(capturedModel);
const capturedView={model:capturedModel.toArray(),camera:new Matrix4().setPosition(cameraPosition).toArray()};
const arrowTail=observationArrowTail([0,0,0],capturedView,.2);
assert(new Vector3(...arrowTail).distanceTo(new Vector3(0,.2,0))<1e-10,'Above-product view must point down toward the hit, regardless of captured model transform');
const reviewModel=new Matrix4().makeRotationX(Math.PI/2);
assert(new Vector3(...arrowTail).applyMatrix4(reviewModel).distanceTo(new Vector3(0,0,.2))<1e-10);
assert.equal(observationArrowTail([0,0,0],null,.2),null);
assert.equal(observationArrowTail([0,0,0],{...capturedView,model:Array(16).fill(0)},.2),null);
assert.equal(observationArrowTail([0,0,0],{model:new Matrix4().toArray(),camera:new Matrix4().toArray()},.2),null);
const linked=mappedDisplayPoints([{id:'source',type:'gaze',phase:'observing',t:0,frame_id:1,view:capturedView},
  {type:'mapping',source_id:'source',source_type:'gaze',hit:true,local:[0,0,0]},
  {type:'mapping',source_id:'source',source_type:'probe',hit:true,local:[0,0,0]}]);
assert.equal(linked[0].view,capturedView);assert.equal(linked[1].view,undefined);
console.log('PASS: captured-camera arrow direction, model transforms and missing/degenerate data');

assert.deepEqual(normalizedPoint(150,100,[50,50,200,100]),[0,0]);
assert.equal(normalizedPoint(49,100,[50,50,200,100]),null);
assert.equal(validationSummary([],120).passed,false);
assert.equal(validationSummary(Array.from({length:20},()=>({valid:true,xy:[12,10],target:[10,10]})),120).p90_px,2);
const modelPath=path.resolve('데이터/신발.ply');
const file=await fs.open(modelPath);const buffer=Buffer.alloc(16384);await file.read(buffer,0,buffer.length,0);
const size=(await file.stat()).size;await file.close();
assert.equal(plyInfo(buffer,size).count,310629);
const fullBytes=await fs.readFile(modelPath);const focus=focusBounds(fullBytes,plyInfo(buffer,size));
assert(focus.max[0]-focus.min[0]<1 && focus.max[2]-focus.min[2]<1,'Background splats dominate initial framing');
assert.throws(()=>plyInfo(buffer,size-1),/길이/);
assert.throws(()=>plyInfo(new TextEncoder().encode('ply\nformat binary_little_endian 1.0\nelement vertex 1\nproperty float x\nend_header\n'),4),/Gaussian/);
console.log('PASS: PLY schema/length, viewport offset, empty/error metrics');

if(process.argv.includes('--browser')){
  const native=process.argv.includes('--native');
  const {chromium}=await import('playwright');
  const server=spawn(path.resolve('.venv/Scripts/python.exe'),['-u','server.py','--http','--host','127.0.0.1','--port','8844'],{windowsHide:true});
  let browser;
  try{
    const url=await new Promise((resolve,reject)=>{
      let out='';const timer=setTimeout(()=>reject(Error('Server startup timeout')),15000);
      server.stdout.on('data',chunk=>{out+=chunk.toString();const match=out.match(/http:\/\/localhost:8844\/#[\w-]+/);if(match){clearTimeout(timer);resolve(match[0]);}});
      server.on('error',reject);server.on('exit',code=>{if(code)reject(Error(`Server exit ${code}`));});
    });
    browser=await chromium.launch({channel:'msedge',headless:true,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader','--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream']});
    const page=await browser.newPage({viewport:{width:1280,height:900}});
    // The 77 MB fixture uses software rendering in CI; input dispatch can exceed 30 seconds.
    page.setDefaultTimeout(90000);
    if(native)await page.addInitScript(()=>{
      window.nativeEnvironment={available:true,foreground:true,landscape:true,multi_window:false,display_rotation:0,
        app_version:'check',webview_version:'mock bridge in desktop Edge'};
      window.nativeMessages=[];window.nativeChunks=[];window.nativeFailure='';window.nativeSaved=null;
      window.ROIHost={postMessage(text){
        const m=JSON.parse(text);window.nativeMessages.push(m);
        let result={},error=null;
        if(m.type==='hello')result=window.nativeEnvironment;
        if(m.type==='exportBegin'){window.nativeChunks=[];window.nativeSaved=null;}
        if(m.type==='exportChunk')window.nativeChunks.push(m.data);
        if(m.type==='exportEnd'){
          if(window.nativeFailure)error=window.nativeFailure;
          else{
            const binary=window.nativeChunks.map(atob).join('');
            window.nativeSaved=JSON.parse(new TextDecoder().decode(Uint8Array.from(binary,c=>c.charCodeAt(0))));
          }
          // A real document picker changes focus. Results must stay exportable after it returns.
          window.roiNativeEvent({...window.nativeEnvironment,available:false,foreground:false});
          window.roiNativeEvent(window.nativeEnvironment);
        }
        queueMicrotask(()=>window.ROIHost.onmessage({data:JSON.stringify({rid:m.rid,ok:!error,result,error})}));
      }};
    });
    async function saveSession(destination){
      if(native){
        await page.locator('#export').click();
        await page.waitForFunction(()=>document.querySelector('#status').textContent==='JSON 파일을 저장했습니다.');
        await fs.writeFile(destination,JSON.stringify(await page.evaluate(()=>window.nativeSaved)));
      }else{
        const pending=page.waitForEvent('download');await page.locator('#export').click();
        await (await pending).saveAs(destination);
      }
    }
    const errors=[];page.on('pageerror',e=>{errors.push(e.message);console.log('PAGE ERROR:',e.message);});
    page.on('console',message=>{if(message.type()==='error')console.log('BROWSER:',message.text());});
    await page.goto(url);await page.locator('#modelFile').setInputFiles(modelPath);
    try {await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('상품 준비 완료'),{},{timeout:45000});}
    catch(error){console.log('STATUS:',await page.locator('#status').textContent());await fs.mkdir('tmp',{recursive:true});await page.screenshot({path:'tmp/browser-error.png',fullPage:true});throw error;}
    await page.locator('#diagnostic').check();
    if(native){
      await page.evaluate(()=>window.roiNativeEvent({...window.nativeEnvironment,available:false,landscape:false}));
      await page.locator('#prepare').click();
      assert(await page.locator('#setup').isVisible(),'Portrait view entered a session');
      await page.evaluate(()=>window.roiNativeEvent(window.nativeEnvironment));
    }
    await page.locator('#prepare').click();await page.locator('#start').click();
    assert(await page.evaluate(()=>document.documentElement.scrollHeight<=innerHeight+1),'Observation requires vertical scrolling');
    if(native){
      assert.equal(await page.evaluate(()=>window.roiCanLeave()),false);
      await page.evaluate(()=>window.roiNativeEvent({...window.nativeEnvironment,available:false,foreground:false}));
      assert.equal(await page.locator('#phaseLabel').textContent(),'일시 중지');
      await page.evaluate(()=>window.roiNativeEvent(window.nativeEnvironment));
      assert.equal(await page.locator('#phaseLabel').textContent(),'일시 중지','App resume restarted measurement');
      await page.locator('#resume').click();
    }
    await page.locator('#found').click();
    await page.locator('#answer').fill('기하 점검');await page.locator('#finish').click();
    await page.locator('#results').waitFor({state:'visible'});
    if(native)await page.context().setOffline(true);
    await page.locator('#probe').click();await page.locator('#viewer').click({position:{x:500,y:220}});
    await page.waitForTimeout(2000);
    await fs.mkdir('tmp',{recursive:true});
    if(native){
      for(const failure of ['파일 저장을 취소했습니다.','파일 저장에 실패했습니다.']){
        await page.evaluate(value=>window.nativeFailure=value,failure);await page.locator('#export').click();
        await page.waitForFunction(value=>document.querySelector('#status').textContent===value,failure);
        assert.equal(await page.evaluate(()=>window.roiCanLeave()),false,'Canceled/failed export allowed discarding unsaved events');
      }
      await page.evaluate(()=>window.nativeFailure='');
    }
    await saveSession('tmp/browser-session.json');
    if(native){
      assert.equal(await page.evaluate(()=>window.roiCanLeave()),true,'Successful offline export still blocked exit');
      await page.context().setOffline(false);
      console.log('PASS: mocked native origin bridge, orientation/leave guards, manual resume, offline save/cancel/failure');
    }
    const payload=JSON.parse(await fs.readFile('tmp/browser-session.json','utf8'));
    assert(payload.events.some(e=>e.type==='observation_start'));
    assert(payload.events.some(e=>e.type==='session_end'));
    assert(!payload.events.some(e=>e.type==='gaze'),'Diagnostic mode must never fabricate gaze');
    assert(payload.events.some(e=>e.type==='mapping'&&e.hit),'Known model probe did not intersect');
    const hit=payload.events.find(e=>e.type==='mapping'&&e.hit),source=payload.events.find(e=>e.id===hit.source_id);
    const c=new PerspectiveCamera();c.matrixWorld.fromArray(source.view.camera);c.matrixWorldInverse.copy(c.matrixWorld).invert();c.projectionMatrix.fromArray(source.view.projection);
    const projected=new Vector3(...hit.local).applyMatrix4(new Matrix4().fromArray(source.view.model)).project(c);
    const r=source.view.rect,screen=[r[0]+(projected.x+1)*r[2]/2,r[1]+(1-projected.y)*r[3]/2];
    assert(Math.hypot(screen[0]-source.xy[0],screen[1]-source.xy[1])<1,'Local hit does not reproject to source pixel');
    await page.screenshot({path:'tmp/browser-initial.png',fullPage:true});
    await page.reload();
    await page.locator('#modelFile').setInputFiles(modelPath);
    await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('상품 준비 완료'),{},{timeout:45000});
    const damaged=structuredClone(payload);damaged.events.find(e=>e.type==='metadata').data.model.initial_matrix=[1,2];
    await page.locator('#restoreFile').setInputFiles({name:'damaged.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(damaged))});
    await page.waitForFunction(()=>document.querySelector('#status').textContent==='손상된 모델 변환');
    assert(await page.locator('#setup').isVisible(),'Bad JSON changed the current session');
    await page.locator('#restoreFile').setInputFiles(path.resolve('tmp/browser-session.json'));
    await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('저장한 세션을 불러왔습니다.'));
    // Synthetic gaze at the verified probe tests only label drawing; never save it as measured gaze.
    const numbered=structuredClone(payload);
    const directionView=structuredClone(source.view),captureCamera=new PerspectiveCamera();
    captureCamera.matrixWorld.fromArray(source.view.camera).decompose(captureCamera.position,captureCamera.quaternion,captureCamera.scale);
    captureCamera.position.y+=1;captureCamera.lookAt(new Vector3(...hit.local).applyMatrix4(new Matrix4().fromArray(source.view.model)));
    captureCamera.updateMatrixWorld();directionView.camera=captureCamera.matrixWorld.toArray();
    numbered.events.push({id:'gaze-order-check',type:'gaze',phase:'observing',frame_id:1,t:10,valid:true,
      xy:[source.view.rect[0]+source.view.rect[2]/2,source.view.rect[1]+source.view.rect[3]/2],view:directionView},
      {id:'mapping-order-check',type:'mapping',source_type:'gaze',source_id:'gaze-order-check',t:10,hit:true,local:hit.local});
    await page.evaluate(()=>{
      const ink=document.querySelectorAll('#viewer canvas')[1].getContext('2d'),draw=ink.fillText.bind(ink);
      window.numberLabels=[];ink.fillText=(...args)=>{window.numberLabels.push(args[0]);draw(...args);};
      const stroke=ink.stroke.bind(ink);window.directionStrokes=0;
      ink.stroke=(...args)=>{if(ink.strokeStyle==='#305da8')window.directionStrokes++;stroke(...args);};
    });
    await page.locator('#restoreFile').setInputFiles({name:'number-check.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(numbered))});
    await page.waitForFunction(()=>window.numberLabels.includes('1'));
    await page.locator('#toggleOrder').click();
    assert.equal(await page.locator('#toggleOrder').getAttribute('aria-pressed'),'false');
    await page.evaluate(()=>window.numberLabels=[]);await page.waitForTimeout(300);
    assert.deepEqual(await page.evaluate(()=>window.numberLabels),[],'Hidden numbers still draw');
    await page.locator('#toggleOrder').click();
    await page.waitForFunction(()=>window.numberLabels.includes('1'));
    console.log('PASS: gaze number drawing and independent on/off button');
    assert.equal(await page.evaluate(()=>window.directionStrokes),0,'Direction arrows should default off');
    await page.locator('#toggleDirection').click();
    await page.waitForFunction(()=>window.directionStrokes>0);
    assert.equal(await page.locator('#toggleDirection').getAttribute('aria-pressed'),'true');
    await page.locator('#toggleDirection').click();
    await page.evaluate(()=>window.directionStrokes=0);await page.waitForTimeout(300);
    assert.equal(await page.evaluate(()=>window.directionStrokes),0,'Hidden direction arrows still draw');
    await page.locator('#toggleDirection').click();
    await page.waitForFunction(()=>window.directionStrokes>0);
    await page.screenshot({path:'tmp/browser-direction.png',fullPage:true});
    console.log('PASS: captured-view direction arrows, default off and on/off button');
    // Reprojection must stay attached after an actual camera orbit.
    const rect=await page.locator('#viewer').boundingBox();
    await page.mouse.move(rect.x+rect.width/2,rect.y+rect.height/2);
    await page.mouse.down();await page.mouse.move(rect.x+rect.width/2+80,rect.y+rect.height/2+15,{steps:8});await page.mouse.up();
    await page.waitForTimeout(1500);
    await page.screenshot({path:'tmp/browser-result.png',fullPage:true});
    assert.deepEqual(errors,[]);
    console.log('PASS: real shoe PLY render, session/export, geometry probe; screenshot tmp/browser-result.png');
    if(process.argv.includes('--camera')){
      await page.reload();await page.locator('#modelFile').setInputFiles(modelPath);
      await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('상품 준비 완료'),{},{timeout:45000});
      await page.locator('#consent').check();await page.locator('#prepare').click();
      await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('카메라 준비 완료'),{},{timeout:30000});
      await page.locator('#calibrate').click();await page.waitForTimeout(4500);
      if(native){
        await page.evaluate(()=>{
          window.interruptedTracks=document.querySelector('#video').srcObject.getTracks();
          window.roiNativeEvent({...window.nativeEnvironment,available:false,foreground:false});
        });
        await page.locator('#calibrationOverlay').waitFor({state:'hidden'});
        assert(await page.evaluate(()=>window.interruptedTracks.every(t=>t.readyState==='ended')&&!document.querySelector('#video').srcObject));
        await page.evaluate(()=>window.roiNativeEvent(window.nativeEnvironment));
        assert(await page.locator('#calibrate').isDisabled(),'Camera restarted automatically');
        await page.locator('#cameraRestart').click();
        await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('카메라 준비 완료'));
        await page.locator('#calibrate').click();await page.waitForTimeout(4500);
      }
      await page.locator('#cancelCalibration').click();
      await page.locator('#calibrationOverlay').waitFor({state:'hidden'});
      assert(await page.locator('#start').isDisabled(),'Unvalidated participant can start');
      await page.locator('#finish').click();await page.locator('#results').waitFor({state:'visible'});
      await saveSession('tmp/camera-session.json');
      const capture=JSON.parse(await fs.readFile('tmp/camera-session.json','utf8'));
      assert(capture.events.some(e=>e.type==='tracker'&&e.data?.name==='GazeFollower'));
      const records=capture.events.filter(e=>e.type==='gaze');assert(records.length>0,'No camera frames reached tracker');
      assert(records.every(e=>Number.isFinite(e.t)&&e.view&&e.frame_id>0));
      assert(!JSON.stringify(capture).includes('"image":'));
      console.log(`PASS: browser camera → PC GazeFollower → timestamped results (${records.length} frames); incomplete calibration blocked`);
    }
  }finally{await browser?.close();server.kill();}
}
