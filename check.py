"""Run: .venv/Scripts/python.exe check.py [--tracker]. No camera required."""
import asyncio
import base64
from io import BytesIO
import json
from pathlib import Path
import sys
import tempfile
import uuid

from aiohttp import ClientSession, web
from PIL import Image
from server import Session, check_frame, make_app


async def check():
    with tempfile.TemporaryDirectory(prefix='roi-check-') as folder:
        directory=Path(folder)
        s=Session(directory,str(uuid.uuid4()),{'diagnostic':True})
        event={'id':'e:1','type':'pointerdown','t':1}
        s.append([event,event]);s.append([event])
        assert len(s.path.read_text(encoding='utf-8').splitlines())==2, 'Retries must not duplicate records'
        try:
            s.append([{**event,'t':2}]);raise AssertionError('Conflicting duplicate accepted')
        except ValueError:pass
        buffer=BytesIO();Image.new('RGB',(640,480)).save(buffer,format='JPEG')
        identity=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]
        frame={'frame_id':1,'t':123,'phase':'validation','viewport':[1200,800],
               'view':{'camera':identity,'projection':identity,'model':identity,'rect':[0,0,1200,800]},
               'image':base64.b64encode(buffer.getvalue()).decode()}
        assert check_frame(frame)==buffer.getvalue()
        try:
            check_frame({**frame,'viewport':[float('nan'),800]});raise AssertionError('NaN accepted')
        except ValueError:pass
        if '--tracker' in sys.argv:
            import numpy as np
            from gaze import Tracker
            from gazefollower.misc import FaceInfo
            t=Tracker(directory/'tracker')
            result=t.process(buffer.getvalue(),frame)
            assert result['xy'] is None and not result['valid'], 'Blank image produced gaze'
            try:t.fit();raise AssertionError('Empty calibration succeeded')
            except ValueError:pass
            # Exercise the real MNN forward path with synthetic crops (not a human accuracy test).
            face=FaceInfo(status=True,can_gaze_estimation=True,img_w=640,img_h=480,
                          face_rect=[100,50,300,300],left_rect=[140,130,80,60],right_rect=[260,130,80,60])
            output=t.estimator.detect(np.full((480,640,3),127,dtype=np.uint8),face)
            assert output.status and np.isfinite(output.features).all(), 'MNN forward failed'
            t.close()
        app=make_app('test-token',directory)
        runner=web.AppRunner(app);await runner.setup()
        site=web.TCPSite(runner,'127.0.0.1',0);await site.start()
        port=site._server.sockets[0].getsockname()[1];url=f'http://127.0.0.1:{port}'
        try:
            async with ClientSession() as client:
                sid=str(uuid.uuid4())
                bad=await client.ws_connect(url+'/ws')
                await bad.send_json({'token':'wrong','session_id':sid})
                assert (await bad.receive_json())['type']=='error';await bad.close()
                ws=await client.ws_connect(url+'/ws')
                hello={'token':'test-token','session_id':sid,'metadata':{'diagnostic':True}}
                await ws.send_json(hello);assert (await ws.receive_json())['type']=='ready'
                for _ in range(2):
                    await ws.send_json({'type':'events','rid':1,'events':[event]})
                    assert (await ws.receive_json())['ok']
                await ws.close()
                ws=await client.ws_connect(url+'/ws');await ws.send_json(hello)
                assert (await ws.receive_json())['type']=='ready'
                await ws.send_json({'type':'events','rid':2,'events':[event]})
                assert (await ws.receive_json())['ok']
                await ws.close()
                assert (await client.get(url+f'/api/session/{sid}')).status==401
                response=await client.get(url+f'/api/session/{sid}',headers={'Authorization':'Bearer test-token'})
                saved=await response.json()
                assert len([e for e in saved['events'] if e['id']=='e:1'])==1
                assert '"image"' not in json.dumps(saved)
                if '--tracker' in sys.argv:
                    real_id=str(uuid.uuid4())
                    real=await client.ws_connect(url+'/ws')
                    await real.send_json({'token':'test-token','session_id':real_id,'metadata':{'diagnostic':False}})
                    ready=await real.receive_json()
                    assert ready.get('tracker'), ready
                    await real.send_json({'type':'frame','rid':3,**frame})
                    message=await real.receive_json()
                    assert message['ok'],message
                    gaze=message['result']
                    assert gaze['frame_id']==1 and gaze['t']==123 and gaze['view']==frame['view']
                    assert not gaze['valid'] and gaze['xy'] is None
                    await real.close()
        finally:await runner.cleanup()
    print('PASS: deduplication, auth, reconnect, frame validation, image exclusion' + ('; real tracker blank/forward checks' if '--tracker' in sys.argv else ''))


if __name__=='__main__':asyncio.run(check())
