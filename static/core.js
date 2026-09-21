import {Matrix4, Vector3} from 'three';

// Pure data rules, shared with the runnable checks.
export function plyInfo(bytes, totalBytes) {
  const text = new TextDecoder().decode(bytes);
  const end = text.indexOf('end_header');
  if (!text.startsWith('ply\n') && !text.startsWith('ply\r\n')) throw Error('PLY 파일이 아닙니다.');
  if (end < 0) throw Error('PLY 헤더가 너무 크거나 손상되었습니다.');
  const header = text.slice(0, end).split(/\r?\n/);
  if (!header.includes('format binary_little_endian 1.0')) throw Error('초기 버전은 binary_little_endian PLY만 지원합니다.');
  let vertex = false, count = 0, fields = [];
  for (const line of header) {
    if (line.startsWith('element ')) {
      const [, name, n] = line.split(/\s+/);
      vertex = name === 'vertex';
      if (vertex) count = Number(n);
      else if (Number(n)) throw Error('정점 이외 요소가 있는 PLY는 지원하지 않습니다.');
    } else if (vertex && line.startsWith('property ')) {
      const [, type, name] = line.split(/\s+/);
      if (type !== 'float') throw Error('표준 float Gaussian 속성만 지원합니다.');
      fields.push(name);
    }
  }
  const required = ['x','y','z','opacity','f_dc_0','f_dc_1','f_dc_2',
    'scale_0','scale_1','scale_2','rot_0','rot_1','rot_2','rot_3'];
  if (!required.every(x => fields.includes(x))) throw Error('Gaussian 속성이 없는 일반 점군 PLY입니다.');
  if (!Number.isSafeInteger(count) || count < 1 || count > 1_000_000) throw Error('현재 허용 범위는 1~1,000,000 스플랫입니다.');
  const newline = text.indexOf('\n', end);
  const offset = new TextEncoder().encode(text.slice(0, newline + 1)).length;
  if (newline < 0 || offset + count * fields.length * 4 !== totalBytes) throw Error('PLY 데이터 길이가 헤더와 일치하지 않습니다.');
  return {count, fields, offset};
}

export function normalizedPoint(x, y, rect) {
  if (![x,y,...rect].every(Number.isFinite) || rect[2] <= 0 || rect[3] <= 0) return null;
  const u = (x - rect[0]) / rect[2], v = (y - rect[1]) / rect[3];
  return u >= 0 && u <= 1 && v >= 0 && v <= 1 ? [2*u-1, 1-2*v] : null;
}

export function focusBounds(bytes, info) {
  const data=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),axes=[[],[],[]];
  const offsets=['x','y','z'].map(n=>info.fields.indexOf(n)*4),stride=info.fields.length*4;
  // ponytail: sampled 5–95% bounds only frame the view; use the full-view button for sparse/multipart products.
  const step=Math.max(1,Math.floor(info.count/10000));
  for(let i=0;i<info.count;i+=step)for(let j=0;j<3;j++){
    const value=data.getFloat32(info.offset+i*stride+offsets[j],true);
    if(!Number.isFinite(value))throw Error('모델에 유효하지 않은 좌표가 있습니다.');
    axes[j].push(value);
  }
  axes.forEach(a=>a.sort((a,b)=>a-b));
  return {min:axes.map(a=>a[Math.floor(a.length*.05)]),max:axes.map(a=>a[Math.floor(a.length*.95)])};
}

export function validationSummary(samples, minTargetPx) {
  const errors = samples.filter(s => s.valid && s.xy && s.target)
    .map(s => Math.hypot(s.xy[0]-s.target[0], s.xy[1]-s.target[1])).sort((a,b) => a-b);
  const percentile = p => errors.length ? errors[Math.min(errors.length-1, Math.ceil(p*errors.length)-1)] : null;
  const validRatio = samples.length ? errors.length/samples.length : 0;
  const p90 = percentile(.9);
  return {attempts:samples.length, valid:errors.length, valid_ratio:validRatio,
    median_px:percentile(.5), p90_px:p90, threshold_px:minTargetPx/2,
    passed:errors.length >= 15 && validRatio >= .8 && p90 <= minTargetPx/2};
}

export function mappedDisplayPoints(events) {
  // Number observation frames before filtering hits or thinning the display.
  const order = new Map(events.filter(e=>e.type==='gaze'&&e.phase==='observing')
    .sort((a,b)=>a.t-b.t || a.frame_id-b.frame_id).map((e,i)=>[e.id,{number:i+1,view:e.view}]));
  const mapped = events.filter(e=>e.type==='mapping'&&e.hit).map(e=>({
    local:e.local, kind:e.source_type==='probe'?'probe':'gaze', visible:false,
    order:e.source_type==='probe'?undefined:order.get(e.source_id)?.number,
    view:e.source_type==='probe'?undefined:order.get(e.source_id)?.view
  })).sort((a,b)=>(a.order??Infinity)-(b.order??Infinity));
  const step = Math.max(1,Math.ceil(mapped.length/120));
  return mapped.filter((_,i)=>i%step===0);
}

export function observationArrowTail(local, view, length) {
  if(!Number.isFinite(length)||length<=0||!Array.isArray(local)||local.length!==3||!local.every(Number.isFinite)||
    !view||!['camera','model'].every(key=>Array.isArray(view[key])&&view[key].length===16&&view[key].every(Number.isFinite)))return null;
  const capturedModel=new Matrix4().fromArray(view.model);
  if(capturedModel.determinant()===0)return null;
  const point=new Vector3(...local);
  const towardCamera=new Vector3().setFromMatrixPosition(new Matrix4().fromArray(view.camera))
    .applyMatrix4(capturedModel.invert()).sub(point);
  if(towardCamera.lengthSq()===0)return null;
  // Tail faces the captured viewer camera; the arrowhead stays at the gaze hit.
  const tail=point.add(towardCamera.normalize().multiplyScalar(length)).toArray();
  return tail.every(Number.isFinite)?tail:null;
}

export function shuffled(points) {
  const copy = points.slice();
  for (let i=copy.length-1; i>0; i--) {
    const j=Math.floor(Math.random()*(i+1)); [copy[i],copy[j]]=[copy[j],copy[i]];
  }
  return copy;
}
