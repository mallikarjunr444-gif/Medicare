# Dr. Ananya wellness session: camera observations (phase 1)

Open **Wellness** in the app menu. Everything runs in the browser; no video, image or audio is uploaded or stored.

## What is measured
| Measurement | How |
|---|---|
| Face visible / in frame / more than one face / tracking interruptions | MediaPipe Face Landmarker (478 landmarks) |
| Blinks (count, per minute, median interval, closure time) | Eye Aspect Ratio with a threshold adapted to the person's own open-eye level; closures over 600 ms are not counted as blinks |
| Head orientation (turn, tilt, roll) | Facial transformation matrix. Magnitudes are shown; left/right signs are not claimed |
| Gaze estimate (toward / away from screen) | Iris position inside the eye combined with head pose. A coarse estimate, not true eye tracking |
| Facial movement (smile, brow, mouth-open activation, movement intensity, first minute vs rest) | Face blendshape scores. Reported as numbers only |
| Upper-body posture (shoulder tilt, closer/further than at start, body movement) | Optional MediaPipe Pose Landmarker (lite), shoulders must be in view |
| Lighting | Mean brightness of a 16x12 sample once per second |

The summary text is generated only from these numbers, and tests assert it never contains interpretive words (depression, anxiety, lying, emotion, etc.).

## Privacy behaviour
Explicit consent checkbox before the camera starts. Camera status always visible. "Stop camera" releases the camera completely. The camera is also released when you leave the page. Analysis pauses while the tab is hidden. Nothing is saved unless a later phase asks for it.

## Dependencies and sources
- `@mediapipe/tasks-vision` 1.2.3 (Apache-2.0). Its WASM runtime is copied into `public/mediapipe/wasm` at build time (`scripts/copy-mediapipe.mjs`, `prebuild`) and served from our own origin.
- Model files (`face_landmarker.task`, `pose_landmarker_lite.task`) load from Google's public MediaPipe bucket on first use. To self-host, put them in a folder on the site and set `NEXT_PUBLIC_MEDIAPIPE_MODEL_BASE` to its URL.
- Tests: `workers/api/test/visionMetrics.test.ts` imports `frontend/lib/vision/metrics.ts` (pure logic).

## Other repositories considered
| Repo | Decision |
|---|---|
| MediaPipe (google-ai-edge/mediapipe) | **Used** via the official npm package |
| OpenCV | Not needed: MediaPipe covers the landmarks, and opencv.js is large |
| DeepFace | Not used: it classifies emotions, which this product must not claim |
| InsightFace | Not used: its pretrained models are restricted to non-commercial research use |
| pose-cam, face-mesh, terminator-vision | Not used: small demos built on the same MediaPipe ideas; nothing to gain by copying their code |
Licences of the demo repos were not verified in this session (GitHub access to them was not available), so no code was copied.

## Known limitations
- Not tested on a real camera in this environment. Please test: permission granted/denied, no camera, dim light, face out of frame, two faces, tab switch, phone.
- Head-pose sign conventions and the gaze thresholds are unvalidated and conservative.
- Model download needs access to `storage.googleapis.com` unless self-hosted.
- Phases still to build: consent + check-in flow, PSS-10 and WHO-5, voice analysis, wellness PDF report, session saving and deletion.
