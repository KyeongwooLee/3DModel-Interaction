"""One-PC/one-tablet research server. No image files, database or user accounts."""
import argparse
import asyncio
import base64
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
import hashlib
from io import BytesIO
import ipaddress
import json
import math
import os
from pathlib import Path
import secrets
import socket
import ssl
import uuid

from aiohttp import web, WSMsgType

ROOT = Path(__file__).resolve().parent


def encode(value):
    return json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(',', ':'))


def finite(values, size):
    return (isinstance(values, list) and len(values) == size
            and all(type(v) in (int, float) and math.isfinite(v) for v in values))


def check_frame(packet):
    from PIL import Image
    if not isinstance(packet.get('frame_id'), int) or packet['frame_id'] < 0:
        raise ValueError('Invalid frame ID')
    if not finite([packet.get('t')], 1) or packet['t'] < 0:
        raise ValueError('Invalid frame time')
    if not finite(packet.get('viewport'), 2) or not all(1 <= n <= 10000 for n in packet['viewport']):
        raise ValueError('Invalid viewport')
    if packet.get('phase') not in ('calibration', 'validation', 'validation_post', 'observing', 'response'):
        raise ValueError('Invalid frame phase')
    if packet.get('target') is not None:
        if not finite(packet['target'], 2) or not all(0 <= v <= m for v, m in zip(packet['target'], packet['viewport'])):
            raise ValueError('Invalid target')
        if not isinstance(packet.get('target_id'), str) or len(packet['target_id']) > 40:
            raise ValueError('Invalid target ID')
    view = packet.get('view')
    if not isinstance(view, dict) or not all(finite(view.get(k), n) for k, n in
            [('camera',16),('projection',16),('model',16),('rect',4)]):
        raise ValueError('Invalid render state')
    jpeg = base64.b64decode(packet.get('image', ''), validate=True)
    if not jpeg or len(jpeg) > 800_000:
        raise ValueError('Frame exceeds 800 KB')
    with Image.open(BytesIO(jpeg)) as img:
        if img.format != 'JPEG' or max(img.size) > 1536 or img.width * img.height > 2_000_000:
            raise ValueError('JPEG frame dimensions exceed limit')
    return jpeg


class Session:
    def __init__(self, directory, sid, metadata):
        self.directory = directory
        self.path = directory / f'{sid}.jsonl'
        if self.path.exists():
            raise ValueError('서버 재시작 전 세션입니다. 로그를 내보낸 뒤 새 세션을 시작하세요.')
        self.sid = sid
        self.events = {}
        self.tracker = None
        self.tracker_error = None
        self.closed = False
        self.append([{'id':'metadata','type':'metadata','t':0,'data':metadata}])

    def append(self, events):
        fresh = []
        seen = {}
        for event in events:
            if not isinstance(event, dict) or not isinstance(event.get('id'), str) or len(event['id']) > 100:
                raise ValueError('Invalid event ID')
            serialized = encode(event)
            if len(serialized) > 100_000 or '"image":' in serialized:
                raise ValueError('Invalid log payload (images are never logged)')
            old = self.events.get(event['id'], seen.get(event['id']))
            if old is not None and old != event:
                raise ValueError('Conflicting duplicate event ID')
            if old is None:
                fresh.append(event)
                seen[event['id']] = event
        if not fresh:
            return
        if len(self.events) + len(fresh) > 250_000:
            raise ValueError('세션 이벤트 한도 초과. 종료하고 내보내세요.')
        self.directory.mkdir(parents=True, exist_ok=True)
        with self.path.open('a', encoding='utf-8') as out:
            out.write(''.join(encode(e) + '\n' for e in fresh))
            out.flush()
            os.fsync(out.fileno())
        self.events.update((e['id'], e) for e in fresh)


async def websocket(request):
    ws = web.WebSocketResponse(max_msg_size=1_500_000, heartbeat=20)
    await ws.prepare(request)
    app = request.app
    session = None
    try:
        hello = await asyncio.wait_for(ws.receive_json(), 8)
        if not isinstance(hello,dict):
            raise ValueError('Connection message must be an object')
        if not secrets.compare_digest(str(hello.get('token', '')), app['token']):
            raise ValueError('연결 토큰이 올바르지 않습니다.')
        sid = str(uuid.UUID(hello.get('session_id', '')))
        if app['active_ws'] is not None:
            raise ValueError('이미 연결된 참가자가 있습니다.')
        app['active_ws'] = ws
        # ponytail: one participant and one inference thread per PC; isolate workers if concurrent studies are needed.
        if sid not in app['sessions']:
            if app['sessions']:
                for previous in app['sessions'].values():
                    if previous.tracker:
                        await worker(app, previous.tracker.close)
                app['sessions'].clear()
            metadata = hello.get('metadata')
            if not isinstance(metadata, dict) or len(encode(metadata)) > 20000:
                raise ValueError('Invalid session metadata')
            session = Session(app['directory'], sid, metadata)
            app['sessions'][sid] = session
            if not metadata.get('diagnostic'):
                try:
                    from gaze import Tracker
                    threshold = metadata.get('eye_closure_threshold', .12)
                    if not finite([threshold],1) or not 0 <= threshold <= .5:
                        raise ValueError('Invalid eye closure threshold')
                    session.tracker = await worker(app, Tracker, app['directory'] / sid, threshold)
                except Exception as error:
                    session.tracker_error = f'{type(error).__name__}: {error}'
            info = session.tracker.info if session.tracker else None
            session.append([{'id':'tracker','type':'tracker','t':0,'data':info,'error':session.tracker_error}])
        else:
            session = app['sessions'][sid]
        await ws.send_json({'type':'ready', 'tracker':session.tracker.info if session.tracker else None,
                            'tracker_error':session.tracker_error, 'closed':session.closed})
        async for message in ws:
            if message.type != WSMsgType.TEXT:
                break
            data = {}
            try:
                data = json.loads(message.data)
                if not isinstance(data, dict):
                    data = {}
                    raise ValueError('Message must be a JSON object')
                kind = data.get('type')
                result = None
                if kind == 'events':
                    events = data.get('events')
                    if not isinstance(events, list) or len(events) > 250 or not all(isinstance(e,dict) for e in events):
                        raise ValueError('Invalid event batch')
                    # Reserve server-owned IDs; clients may acknowledge the identical returned gaze record.
                    if any(e.get('id', '').startswith(('g:', 'metadata', 'tracker')) and session.events.get(e.get('id')) != e for e in events):
                        raise ValueError('Reserved event ID')
                    session.append(events)
                    result = {'saved':len(events)}
                elif kind == 'frame':
                    if session.closed or session.tracker is None:
                        raise ValueError('시선 추적 세션이 준비되지 않았습니다.')
                    jpeg = check_frame(data)
                    key = f'g:{data["frame_id"]}'
                    if key in session.events:
                        result = session.events[key]
                    else:
                        values = await worker(app, session.tracker.process, jpeg, data)
                        result = {k:data[k] for k in ('frame_id','t','phase','view','viewport','target','target_id','time_source') if k in data}
                        result.update(values)
                        result.update(id=key, type='gaze')
                        session.append([result])
                elif kind in ('reset_calibration', 'fit'):
                    if session.closed or session.tracker is None:
                        raise ValueError('추적기를 먼저 준비하세요.')
                    result = await worker(app, session.tracker.reset if kind == 'reset_calibration' else session.tracker.fit)
                elif kind == 'finish':
                    session.closed = True
                    result = {'saved':len(session.events), 'finished':True}
                else:
                    raise ValueError('Unknown command')
                await ws.send_json({'rid':data.get('rid'), 'ok':True, 'result':result})
            except Exception as error:
                # Failed inference/save is explicit; never return the previous gaze coordinate.
                await ws.send_json({'rid':data.get('rid'), 'ok':False, 'error':str(error)})
    except (ValueError, KeyError, TypeError, asyncio.TimeoutError) as error:
        await ws.send_json({'type':'error','error':str(error)})
    finally:
        if app['active_ws'] is ws:
            app['active_ws'] = None
        await ws.close()
    return ws


async def worker(app, function, *args):
    return await asyncio.get_running_loop().run_in_executor(app['executor'], function, *args)


async def session_file(request):
    if not secrets.compare_digest(request.headers.get('Authorization',''), 'Bearer ' + request.app['token']):
        raise web.HTTPUnauthorized()
    try:
        sid = str(uuid.UUID(request.match_info['sid']))
    except ValueError:
        raise web.HTTPBadRequest()
    path = request.app['directory'] / f'{sid}.jsonl'
    if not path.exists():
        raise web.HTTPNotFound()
    if request.method == 'DELETE':
        if request.app['active_ws'] is not None:
            raise web.HTTPConflict(text='연결을 종료한 뒤 삭제하세요.')
        path.unlink()
        session = request.app['sessions'].pop(sid, None)
        if session and session.tracker:
            await worker(request.app, session.tracker.close)
        folder = request.app['directory'] / sid
        if folder.is_dir() and not folder.is_symlink():
            (folder/'tracker.log').unlink(missing_ok=True)
            if not any(folder.iterdir()):
                folder.rmdir()
        return web.json_response({'deleted':True})
    events, truncated = [], False
    for line in path.read_text(encoding='utf-8').splitlines():
        try:
            events.append(json.loads(line))
        except json.JSONDecodeError:
            truncated = True
    return web.json_response({'schema_version':1,'session_id':sid,'events':events,'recovered_partial':truncated},
                             dumps=encode, headers={'Cache-Control':'no-store'})


async def static(request):
    name = request.match_info.get('name', 'index.html')
    if name not in ('index.html','app.js','core.js','style.css'):
        raise web.HTTPNotFound()
    return web.FileResponse(ROOT / 'static' / name, headers={'Cache-Control':'no-cache'})


def make_app(token, directory):
    app = web.Application(client_max_size=1_500_000)
    app.update(token=token, directory=Path(directory), sessions={}, active_ws=None,
               executor=ThreadPoolExecutor(max_workers=1, thread_name_prefix='gaze'))
    app.router.add_get('/ws', websocket)
    app.router.add_get('/api/session/{sid}', session_file)
    app.router.add_delete('/api/session/{sid}', session_file)
    app.router.add_static('/vendor/three/', ROOT/'node_modules/three', show_index=False)
    app.router.add_static('/vendor/spark/', ROOT/'node_modules/@sparkjsdev/spark', show_index=False)
    app.router.add_get('/', static)
    app.router.add_get('/{name}', static)
    async def shutdown(app):
        if app['active_ws'] is not None:
            await app['active_ws'].close()
        for session in app['sessions'].values():
            if session.tracker:
                await worker(app, session.tracker.close)
        app['executor'].shutdown(wait=True)
    app.on_shutdown.append(shutdown)
    return app


def certificate(addresses):
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.x509.oid import NameOID, ExtendedKeyUsageOID
    folder = ROOT/'certs'
    folder.mkdir(exist_ok=True)
    cert, key = folder/'server.crt', folder/'server.key'
    ca_cert, ca_key = folder/'roi-ca.crt', folder/'roi-ca.key'
    now = datetime.now(timezone.utc)
    if not ca_cert.exists() or not ca_key.exists():
        ca_private = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        ca_subject = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, 'ROI local research CA')])
        authority = (x509.CertificateBuilder().subject_name(ca_subject).issuer_name(ca_subject)
                     .public_key(ca_private.public_key()).serial_number(x509.random_serial_number())
                     .not_valid_before(now-timedelta(minutes=5)).not_valid_after(now+timedelta(days=365))
                     .add_extension(x509.BasicConstraints(ca=True,path_length=0),critical=True)
                     .add_extension(x509.KeyUsage(digital_signature=True,key_encipherment=False,
                         content_commitment=False,data_encipherment=False,key_agreement=False,
                         key_cert_sign=True,crl_sign=True,encipher_only=None,decipher_only=None),critical=True)
                     .sign(ca_private,hashes.SHA256()))
        ca_key.write_bytes(ca_private.private_bytes(serialization.Encoding.PEM,serialization.PrivateFormat.PKCS8,serialization.NoEncryption()))
        ca_cert.write_bytes(authority.public_bytes(serialization.Encoding.PEM))
    ca_private = serialization.load_pem_private_key(ca_key.read_bytes(),password=None)
    authority = x509.load_pem_x509_certificate(ca_cert.read_bytes())
    names = sorted(set(addresses + ['127.0.0.1']))
    marker = folder/'addresses.json'
    renew = (not cert.exists() or not key.exists() or not marker.exists() or json.loads(marker.read_text()) != names)
    if cert.exists():
        existing = x509.load_pem_x509_certificate(cert.read_bytes())
        renew = renew or existing.issuer != authority.subject or existing.not_valid_after_utc <= now+timedelta(days=1)
    if renew:
        private = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        subject = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, 'ROI research PC')])
        signed = (x509.CertificateBuilder().subject_name(subject).issuer_name(authority.subject)
                  .public_key(private.public_key()).serial_number(x509.random_serial_number())
                  .not_valid_before(now-timedelta(minutes=5)).not_valid_after(now+timedelta(days=90))
                  .add_extension(x509.SubjectAlternativeName([x509.DNSName('localhost')] +
                    [x509.IPAddress(ipaddress.ip_address(a)) for a in names]), critical=False)
                  .add_extension(x509.BasicConstraints(ca=False,path_length=None),critical=True)
                  .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]),critical=False)
                  .sign(ca_private, hashes.SHA256()))
        key.write_bytes(private.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
        cert.write_bytes(signed.public_bytes(serialization.Encoding.PEM))
        marker.write_text(json.dumps(names))
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(cert, key)
    return context


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--host', default='0.0.0.0')
    parser.add_argument('--port', type=int, default=8443)
    parser.add_argument('--http', action='store_true', help='Loopback diagnostic checks only')
    args = parser.parse_args()
    if args.http and args.host not in ('localhost','127.0.0.1','::1'):
        parser.error('--http is only allowed on a loopback address')
    token = secrets.token_urlsafe(24)
    addresses = sorted(set(socket.gethostbyname_ex(socket.gethostname())[2]))
    context = None if args.http else certificate(addresses)
    scheme = 'http' if args.http else 'https'
    for address in ['localhost'] + addresses:
        print(f'{scheme}://{address}:{args.port}/#{token}', flush=True)
    web.run_app(make_app(token, ROOT/'sessions'), host=args.host, port=args.port,
                ssl_context=context, access_log=None)
