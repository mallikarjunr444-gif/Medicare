// Copies the MediaPipe WASM runtime from node_modules into public/ so it is served from our own origin
// (no third-party CDN needed for the runtime). Runs automatically before `next build` via the "prebuild" script.
import { cpSync, existsSync, mkdirSync } from 'node:fs'
const src = 'node_modules/@mediapipe/tasks-vision/wasm'
const dest = 'public/mediapipe/wasm'
if (!existsSync(src)) { console.warn('[copy-mediapipe] @mediapipe/tasks-vision not installed; skipping'); process.exit(0) }
mkdirSync(dest, { recursive: true })
cpSync(src, dest, { recursive: true })
console.log('[copy-mediapipe] copied WASM runtime to', dest)
