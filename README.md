# ROI Viewer

태블릿에서 3D Gaussian Splatting(3DGS) 상품을 관찰하면서 시선 추정값과 조작 로그를 수집하는 연구용 프로토타입입니다.

- **태블릿**: 3DGS `.ply` 모델 표시, 카메라 프레임 캡처, 터치·뷰 조작 로그
- **연구용 PC**: Python `GazeFollower` 추론, 보정·검증, 세션 저장
- **결과**: 화면 시선 좌표를 3DGS 표면의 모델 로컬 좌표로 매핑한 JSON

> 이 프로젝트는 연구용 프로토타입입니다. 시선값은 전용 아이트래커의 정답값이 아니라 태블릿 전면 카메라 기반 추정값입니다. 실제 참가자 실험에서는 보정 오차, 유효 샘플 비율, 매핑 성공률을 별도로 측정하세요.

## 요구 사항

### PC

- Windows 10/11
- Python 3.12 권장
- Node.js 22 권장
- 태블릿과 같은 Wi-Fi 네트워크
- PowerShell

### 태블릿

- Android 11(API 30) 이상 권장
- 가로 화면 사용
- 카메라 권한
- Android System WebView 최신 버전

## 빠른 시작: PC 서버

PowerShell에서 **저장소 루트**로 이동한 뒤 실행합니다.

```powershell
powershell -ExecutionPolicy Bypass -File .\start.ps1
```

첫 실행 시 다음 작업이 자동으로 진행됩니다.

1. Python 가상환경 `.venv` 생성
2. Python 의존성 설치
3. GazeFollower 실행 환경 준비
4. JavaScript 의존성 설치
5. HTTPS 서버 실행

성공하면 다음과 같은 주소가 출력됩니다.

```text
https://localhost:9443/#TOKEN
https://192.168.0.5:9443/#TOKEN
```

서버를 종료하려면 PowerShell에서 `Ctrl+C`를 누릅니다.

### 태블릿에서 사용할 주소

태블릿에서는 `localhost`를 사용하지 않습니다. `ipconfig`에서 PC의 Wi-Fi IPv4 주소를 확인하고, 서버가 출력한 해당 주소 전체를 사용합니다.

```powershell
ipconfig
```

예시:

```text
https://192.168.0.5:9443/#TOKEN
```

`#TOKEN`은 세션마다 바뀌므로 서버를 실행할 때마다 새로 복사하세요. PC와 태블릿은 같은 Wi-Fi에 연결되어 있어야 합니다.

## HTTPS 인증서 설정

카메라를 사용하려면 HTTPS가 필요합니다. 서버 첫 실행 후 다음 파일이 생성됩니다.

```text
certs/roi-ca.crt   # 태블릿에 설치할 공개 루트 인증서
certs/roi-ca.key   # 비밀키: 배포하거나 GitHub에 올리지 않음
certs/server.crt
certs/server.key
```

### Android 태블릿

1. `certs/roi-ca.crt`만 태블릿으로 복사합니다.
2. 설정에서 **CA 인증서**로 설치합니다. 제조사에 따라 경로가 다르지만 보통 다음과 같습니다.

   ```text
   설정 → 보안 및 개인정보 보호
   → 기타 보안 설정 또는 암호화 및 자격 증명
   → 인증서 설치 → CA 인증서
   ```

3. ROI Viewer 앱 또는 브라우저를 다시 실행합니다.

`server.key`와 `roi-ca.key`는 태블릿에 복사하지 않습니다.

## Android WebView 앱 사용

브라우저 주소창과 시스템 UI를 숨기려면 WebView 앱을 사용할 수 있습니다. 앱은 실제 서버를 실행하지 않고, PC에서 실행 중인 ROI 서버에 연결하는 클라이언트입니다.

### APK가 이미 있는 경우

빌드된 APK를 태블릿에 설치하고 실행합니다.

```text
android/dist/ROIViewer.apk
```

앱 시작 화면에 PC 서버가 출력한 URL 전체를 붙여 넣습니다.

```text
https://192.168.0.5:9443/#TOKEN
```

처음 연결할 때 카메라 권한을 허용합니다. APK가 저장소에 없다면 아래 방법으로 직접 빌드합니다.

### APK 빌드

JDK 17~25가 `PATH`에 있어야 합니다.

```powershell
cd android
powershell -ExecutionPolicy Bypass -File .\build.ps1 -Setup
powershell -ExecutionPolicy Bypass -File .\build.ps1
```

빌드 결과:

```text
android/dist/ROIViewer.apk
android/dist/ROIViewer.apk.sha256
```

`-Setup`은 고정된 Android SDK를 내려받으므로 최초 한 번만 실행하면 됩니다.

## 실험 진행 순서

1. PC에서 `start.ps1` 실행
2. 태블릿에서 최신 HTTPS URL 접속
3. 참가자 ID 입력
4. 사용할 `.ply` 파일 선택
5. `진단용 실행` 옵션은 **해제**
6. 연구 동의 확인
7. `세션 준비` 선택
8. 카메라 권한 허용
9. `시선 보정·검증` 실행
10. 화면의 보정점 9개를 순서대로 응시
11. 검증 기준 통과 확인
12. `관찰 시작` 선택
13. 상품을 관찰하며 줌·회전·드래그 수행
14. `타겟 발견`과 응답 입력
15. `관찰 종료` 선택
16. `응시점 매핑` 선택
17. `JSON 내보내기` 선택

### 진단 모드 주의

`시선 측정 없이 뷰어·기하 매핑만 점검`을 선택하면 카메라 프레임과 시선 이벤트가 생성되지 않습니다. 이 모드는 3D 뷰어와 터치 조작만 확인할 때 사용합니다.

## 로그와 매핑 결과

PC 세션 로그는 다음 위치에 JSONL 형식으로 저장됩니다.

```text
sessions/<session-id>.jsonl
```

태블릿에서 내보낸 결과는 다음 구조의 JSON입니다.

```json
{
  "schema_version": 1,
  "session_id": "...",
  "events": []
}
```

주요 이벤트:

| 이벤트 | 설명 |
|---|---|
| `metadata` | 참가자, 모델 해시, 화면·카메라 설정 |
| `tracker` | GazeFollower 정보와 오류 |
| `gaze` | 추정 시선 좌표와 유효성 |
| `view_change` | 카메라 회전·줌·뷰 변경 |
| `pointerdown/move/up` | 터치 조작 |
| `wheel` | 휠 또는 줌 조작 |
| `mapping` | 시선 또는 점검점의 3D 모델 좌표 |

정상적인 시선 이벤트 예시:

```json
{
  "type": "gaze",
  "valid": true,
  "xy": [512.3, 341.7],
  "face_detected": true,
  "reason": null
}
```

`응시점 매핑`은 각 유효 시선 좌표와 해당 시점의 카메라·투영·모델 행렬을 이용해 3DGS 표면과 광선을 교차시킵니다.

```json
{
  "type": "mapping",
  "source_type": "gaze",
  "hit": true,
  "local": [0.12, -0.44, 0.87]
}
```

`local`은 모델 로컬 좌표입니다. 현재 매핑은 의미적 부품 라벨을 생성하지 않고, 광선이 처음 만나는 3DGS 표면 위치를 기록합니다.

## 로그 품질 확인

정상적인 실험 로그에는 다음 항목이 있어야 합니다.

```text
metadata.data.diagnostic = false
tracker.data.name = GazeFollower
camera_settings
calibration_fit
validation_summary
gaze
frame_received
observation_start
observation_end
```

특히 다음 조건을 확인하세요.

- `gaze` 이벤트가 여러 개 존재하는가
- `valid: true` 샘플이 존재하는가
- `xy`가 `null`이 아닌가
- `face_detected`가 대부분 `true`인가
- `quality_tick.submitted_frames`가 0보다 큰가
- `mapping.hit` 비율이 충분한가

대표적인 실패 원인:

| 로그 상태 | 원인 |
|---|---|
| `gaze` 0개 | 진단 모드이거나 카메라 프레임이 전송되지 않음 |
| `reason: face_missing` | 얼굴이 검출되지 않음 |
| `valid: false` | 보정 전이거나 얼굴·눈 상태가 불안정함 |
| `xy: null` | 유효한 화면 시선 좌표가 생성되지 않음 |
| `submitted_frames: 0` | 관찰 중 카메라 캡처가 시작되지 않음 |

## 검증 명령

### Python 검증

```powershell
.\.venv\Scripts\python.exe check.py --tracker
```

### JavaScript·브라우저 검증

```powershell
npm.cmd run check
npm.cmd run check -- --browser
npm.cmd run check -- --browser --camera
npm.cmd run check -- --browser --camera --native
```

브라우저 검증 결과 이미지는 `tmp/browser-result.png`에 저장됩니다.

자동 검증은 기능 동작 확인을 위한 것입니다. 실제 Galaxy Tab 참가자 실험의 시선 정확도, 지연시간, 조작 중 추적 품질을 대신하지 않습니다.

## 문제 해결

### 태블릿에서 연결되지 않음

- `localhost`가 아닌 PC의 Wi-Fi IPv4 주소 사용
- PC와 태블릿이 같은 Wi-Fi인지 확인
- PC 서버가 실행 중인지 확인
- Windows 방화벽에서 Python의 사설 네트워크 통신 허용
- URL의 포트가 `9443`인지 확인

### 인증서 오류

- `certs/roi-ca.crt`만 CA 인증서로 설치
- `roi-ca.key` 또는 `server.key`를 설치하지 않음
- 인증서 설치 후 앱과 WebView를 재실행
- PC IP가 바뀌면 서버를 다시 실행하고 새 URL 사용

### 시선 로그가 없음

- 진단 모드 해제
- 카메라 권한 허용
- 시선 보정·검증 완료
- 얼굴을 카메라 중앙에 배치
- `camera_settings`와 `submitted_frames` 확인

### 모델 파일을 불러올 수 없음

- 실험에 사용한 것과 동일한 `.ply` 파일인지 확인
- 세션 복원 시 모델 SHA-256이 일치해야 함
- 3DGS 바이너리 PLY의 파일 크기와 태블릿 저장 공간 확인

## 데이터 및 보안

다음 파일은 개인키, 세션 로그 또는 로컬 빌드 산출물이므로 GitHub에 커밋하지 않습니다.

```text
certs/*.key
sessions/
.venv/
node_modules/
android/keys/
android/dist/
```

카메라 원본 영상은 저장하지 않도록 설계되어 있지만, 시선·조작 로그에는 참가자 행동 정보가 포함될 수 있습니다. 참가자 동의, 익명화, 보관 기간, 삭제 절차를 연구 계획에 명시하세요.

## 주요 구성

```text
server.py             HTTPS/WebSocket 서버와 세션 저장
gaze.py               GazeFollower 얼굴·시선 추정
prepare_runtime.py    Windows 실행환경 준비
start.ps1             PC 서버 실행 스크립트
static/               3DGS 뷰어와 실험 UI
android/              전체 화면 Android WebView 앱
check.py              Python 기능 검증
check.mjs             브라우저 검증
data/                 실험용 PLY 파일
```

## 라이선스 및 출처

- [GazeFollower](https://github.com/GanchengZhu/GazeFollower): CC BY-NC-SA 4.0
- [Spark](https://sparkjs.dev/docs/): 3DGS 렌더링 및 raycast
- [Three.js](https://threejs.org/): 3D 렌더링 기반

각 의존성과 모델의 라이선스를 확인한 뒤 연구·배포 목적에 맞게 사용하세요.
