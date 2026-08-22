# InsightLens Pro

When navigating a dynamic environment like a crowded hackathon floor or an unfamiliar office, a visually impaired individual doesn't just need a static photo description of the room—they need continuous, real-time spatial awareness. If someone suddenly pulls out a chair directly into their walking path, the user needs to know *immediately*, and that critical alert must forcefully interrupt whatever else their screen reader is currently saying. 

**How it differs:** While tools like Seeing AI, Envision, or Be My Eyes excel at static text reading or remote human assistance, InsightLens Pro operates entirely locally as a continuous spatial radar, preempting its own audio with stereo-panned earcons to warn users of immediate physical hazards at 12 frames per second.

## How It Works

InsightLens Pro is built on a privacy-first, zero-network-dependency architecture designed for high-stress mobile environments.

*   **Asynchronous Vision Engine:** We run `lite_mobilenet_v2` (COCO-SSD) in an isolated Web Worker via TensorFlow.js. This guarantees the main UI and audio threads never block, maintaining 60 FPS for screen readers and touch events even when the neural net maxes out the mobile GPU.
*   **Geometric Distance Estimation:** Computes depth via Pinhole Optical Approximation `((RealHeight * FocalLength) / BoundingBox)`. By applying strict distance-based hysteresis (e.g., 0.25m padding on Tier 1 boundaries) and tracking object maturity (filtering out <3 frame ghost detections), the engine provides stable, zero-flicker spatial tracking. (Note: A provided `eval.html` script allows for continuous ground-truth MAE calibration).
*   **Barge-In Audio Architecture:** Built on a strict 3-tier priority queue. Tier-1 hazards (e.g., a person < 1.8m dead ahead) physically cancel ongoing Web Speech TTS. The system utilizes the Web Audio API to inject an ascending "listening" earcon and applies stereo panning (left/center/right) so the user intuitively *hears* the direction of the hazard before the TTS even speaks.
*   **Resilient Fallbacks:** The app is fully functional in Airplane mode, utilizing a PWA Service Worker to cache model weights locally. Optional high-fidelity scene narration uses Gemini 2.5 Flash, but relies on a strict 4.0-second `Promise.race` circuit breaker that seamlessly falls back to a local bounding-box string generator if the venue's Wi-Fi fails.

## Current System Limitations

To maintain engineering transparency, the following architectural limits are explicitly defined:

*   **Negative Obstacles (Step-Downs):** Currently, "Step-Down Hazards" (curbs, descending stairs) are a UI mock for demonstration purposes. The underlying MobileNet COCO-SSD bounding box engine cannot natively detect negative space. Reliable step-down detection requires integrating monocular depth layers (e.g., MiDaS) or ground-plane segmentation, which fall outside our current 12-FPS thermal budget constraint.
*   **Occlusion Inflates Distance:** Because our pinhole math relies on average object heights (e.g., assuming a person is 1.7m), severely occluded objects—like a person standing behind a waist-high desk—will mathematically appear smaller to the sensor, artificially inflating the estimated distance. To prevent false confidence, the TTS engine aggressively rounds distances >1m and explicitly pre-pends them with uncertainty (e.g., *"about 2 meters"*).
*   **Thermal/FPS Caps:** The inference loop is intentionally throttled to a maximum of 12 FPS. This prevents thermal throttling and severe battery degradation during continuous use on mid-range Android and iOS devices.

## Setup & Local Development

1. Clone the repository and install dependencies:
   ```bash
   npm install
   ```
2. Start the local Vite server:
   ```bash
   npm run dev
   ```
3. Open the app at `https://localhost:5173` (ensure you are using HTTPS, or browser camera APIs and Service Workers will be blocked).

## Try It In Under 60 Seconds (Judge Path)

Don't have time to read the code? Verify our architecture instantly:

1. **The PWA / Offline Test:** Open the app on your mobile device, grant camera permissions, and wait for the "Vision Engine: ONLINE" prompt. **Turn on Airplane Mode.** Observe that the app continues tracking and narrating the room perfectly.
2. **The Voice Command Test:** Tap the floating microphone icon (or trigger it via keyboard `Space`) and say *"Set proximity to 4"*. Note the system's ascending/descending earcons and the immediate haptic confirmation that the math threshold has scaled.
3. **The Barge-In Test:** While the app is calmly describing the room (Tier 3), quickly step directly in front of the camera. You will instantly hear the TTS get canceled, an aggressive haptic vibration trigger, and a stereo-panned Tier 1 hazard alert interrupt the previous sentence.
