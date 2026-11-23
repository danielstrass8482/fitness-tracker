# Vendored third-party files (Zähl-Labor, task 038)

| File | Source | Version | Licence | Size (bytes) | SHA-256 (original) |
|---|---|---|---|---|---|
| mediapipe/vision_bundle.mjs | npm `@mediapipe/tasks-vision` | 1.2.3 | Apache-2.0 | 155973 | fb0c02c296f44ce0cc324ba16bd646d8773eb4a7847db4019cc4d0430db7a9b5 |
| mediapipe/wasm/vision_wasm_internal.js | same package | 1.2.3 | Apache-2.0 | 336624 | 2aa5fd3fdd3d8208cd7587df0bb19fb6925c4ea16a76dd025aedc1f64d6a6309 |
| mediapipe/wasm/vision_wasm_internal.wasm | same package | 1.2.3 | Apache-2.0 | 14665716 | 225bc06c0f51a9cf31fea0e9e0b0243e9e01fb5ef332cc1a7fa6656dbdfdaabf |
| models/pose_landmarker_lite.task | storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest | float16 "latest" (fetched 2026-11-23) | Apache-2.0 (MediaPipe model) | 5777746 | 59929e1d1ee95287735ddd833b19cf4ac46d29bc7afddbbf6753c459690d574a |

Licence text: https://www.apache.org/licenses/LICENSE-2.0

## Modifications (Apache-2.0 §4b)
- `vision_bundle.mjs`: the built-in usage-telemetry logger (`flush()` sends a POST every 60 s to an external
  Google logging endpoint) is disabled: `flush(t,e){if(this.error)` → `flush(t,e){if(this.i=[],t?.(),1)return;if(this.error)`.
  Reason: the page must make no foreign requests. The page CSP (`connect-src 'self'`) would block it anyway.
- `vision_bundle.mjs`: trailing `//# sourceMappingURL=` comment removed (map file not vendored).
- SHA-256 after modification: de8b48d0b1998598952e6a47aba774df684b7c4c54d78889f12e27c2b04b3f54
