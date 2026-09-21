"""GazeFollower components, calibrated against tablet coordinates (no desktop UI)."""
from collections import Counter
import hashlib
from importlib.metadata import version, distribution
import os
from pathlib import Path
import time
import shutil
import tempfile

ROOT = Path(__file__).resolve().parent
os.environ.setdefault('MPLCONFIGDIR', str(ROOT / 'tmp' / 'matplotlib'))
os.environ.setdefault('PYGAME_HIDE_SUPPORT_PROMPT', '1')


def eye_ratio(landmarks):
    import numpy as np
    values = []
    for upper, lower, left, right in [(159,145,33,133),(386,374,362,263)]:
        width = np.linalg.norm(landmarks[left,:2]-landmarks[right,:2])
        values.append(float(np.linalg.norm(landmarks[upper,:2]-landmarks[lower,:2])/width) if width else 0.)
    return min(values)


class Tracker:
    def __init__(self, directory, eye_closure_threshold=.12):
        # Native MediaPipe/MNN file loaders need ASCII asset paths on Windows.
        assets = Path(tempfile.gettempdir()) / 'roi-gaze-assets-1.0.2'
        assets.mkdir(exist_ok=True)
        modules = Path(distribution('mediapipe').locate_file('mediapipe/modules'))
        if not (assets/'mediapipe/modules/face_landmark/face_landmark_front_cpu.binarypb').exists():
            shutil.copytree(modules, assets/'mediapipe/modules', dirs_exist_ok=True)
        source = Path(distribution('gazefollower').locate_file('gazefollower/res/model_weights/base.mnn'))
        model = assets/'base.mnn'
        if not model.exists() or hashlib.sha256(model.read_bytes()).digest() != hashlib.sha256(source.read_bytes()).digest():
            shutil.copyfile(source, model)
        os.environ['ROI_MEDIAPIPE_RESOURCE_DIR'] = str(assets)
        from gazefollower.face_alignment import MediaPipeFaceAlignment
        from gazefollower.gaze_estimator import MGazeNetGazeEstimator
        from gazefollower.logger import Log
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True)
        Log.init(str(self.directory/'tracker.log'))
        self.face = MediaPipeFaceAlignment()
        self.estimator = MGazeNetGazeEstimator(model_path=str(model))
        self.reset()
        self.eye_closure_threshold = eye_closure_threshold
        self.info = {'name': 'GazeFollower', 'version': version('gazefollower'),
                     'model_sha256': hashlib.sha256(self.estimator.model_path.read_bytes()).hexdigest(),
                     'calibration': 'GazeFollower SVR, normalized tablet viewport labels',
                     'smoothing': False, 'raw_units': 'model output (not screen pixels)',
                     'license': 'CC-BY-NC-SA-4.0', 'input_color': 'RGB',
                     'eye_closure_threshold':eye_closure_threshold}

    def reset(self):
        from gazefollower.calibration import SVRCalibration
        # Unique session path; never load another participant's calibration.
        self.calibration = SVRCalibration(model_save_path=str(self.directory))
        self.calibration.has_calibrated = False
        self.samples = []
        self.collecting = True
        self.generation = getattr(self, 'generation', 0) + 1

    def process(self, jpeg, packet):
        import cv2
        import numpy as np
        start = time.perf_counter()
        image = cv2.imdecode(np.frombuffer(jpeg, np.uint8), cv2.IMREAD_COLOR)
        if image is None:
            raise ValueError('JPEG 디코딩 실패')
        # Upstream WebCamCamera also converts BGR to RGB before both components.
        rgb = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
        face = self.face.detect(int(packet['t'] * 1_000_000), rgb)
        # ponytail: eyelid-ratio quality gate, not a validated blink classifier; tune on the pilot.
        openness = eye_ratio(face.face_landmarks) if face.status and face.can_gaze_estimation else None
        closed = openness is not None and openness < self.eye_closure_threshold
        if closed:
            face.can_gaze_estimation = False
        gaze = self.estimator.detect(rgb, face)
        result = {'raw': None, 'xy': None, 'valid': False, 'reason': 'face_missing',
                  'face_detected': bool(face.status), 'confidence': None,
                  'calibration_id': self.generation, 'eye_open_ratio':openness}
        if gaze.status and np.isfinite(gaze.features).all():
            raw = np.asarray(gaze.raw_gaze_coordinates)
            result['raw'] = raw.astype(float).tolist()
            result['reason'] = 'uncalibrated'
            if packet['phase'] == 'calibration' and packet.get('target') is not None:
                if not self.collecting:
                    raise ValueError('보정 학습은 고정되었습니다. 재보정을 먼저 시작하세요.')
                if len(self.samples) >= 3000:
                    raise ValueError('보정 샘플 한도 초과')
                norm = np.asarray(packet['target']) / np.asarray(packet['viewport'])
                self.samples.append((gaze.features.copy(), norm, packet['target_id']))
            ok, norm = self.calibration.predict(gaze.features, raw)
            if ok:
                xy = np.asarray(norm) * np.asarray(packet['viewport'])
                result['valid'] = bool(np.isfinite(xy).all())
                result['xy'] = xy.astype(float).tolist() if result['valid'] else None
                result['reason'] = None if result['valid'] else 'nonfinite_prediction'
        elif face.status:
            result['reason'] = 'eyes_closed_suspected' if closed else 'eyes_or_face_out_of_bounds'
        result['processing_ms'] = (time.perf_counter() - start) * 1000
        return result

    def fit(self):
        import numpy as np
        counts = Counter(row[2] for row in self.samples)
        if len(counts) < 9 or min(counts.values()) < 5:
            raise ValueError('9개 보정점마다 유효 샘플이 5개 이상 필요합니다. 자세·조명을 확인하고 재시도하세요.')
        features, labels, ids = zip(*self.samples)
        ok, error, _ = self.calibration.calibrate(np.asarray(features), np.asarray(labels), np.asarray(ids))
        if not ok:
            raise ValueError('보정 모델 학습 실패')
        self.collecting = False
        self.samples.clear()
        return {'calibration_id': self.generation, 'counts': dict(counts),
                'training_error_normalized': float(error), 'frozen': True}

    def close(self):
        self.face.face_mesh.close()
        self.estimator.release()
        from gazefollower.logger import Log
        for handler in Log.instance.logger.handlers:
            handler.close()
