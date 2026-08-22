# InsightLens Pro

**Autonomous Real-Time Spatial Hazard & Scene Narration for the Visually Impaired.**

[![Build & Deploy](https://github.com/CodeWithRJ006/Scene-narrator/actions/workflows/build.yml/badge.svg)](https://github.com/CodeWithRJ006/Scene-narrator/actions/workflows/build.yml)

---

## Competitive Edge
Unlike traditional assistive apps (like BeMyEyes) that rely on static photo uploads and slow cloud inference, **InsightLens Pro** processes a 12 FPS video stream locally on the device. It provides **instant, sub-100ms spatial reasoning** and dynamic distance estimation, ensuring visually impaired users receive immediate barge-in alerts for approaching hazards before a collision occurs. Cloud narration is reserved purely for idle non-hazard scene context.

## Features

| Feature | Description |
|---|---|
| **Edge CV Detection** | COCO-SSD neural object detection with instant motion-fallback (frame differencing) |
| **Pinhole Optical Distance** | Geometric distance estimation using known real-world object heights |
| **3-Tier Speech Queue** | Barge-in hazard alerts (T1), queued caution (T2), ambient scene narration (T3) |
| **Natural Pacing** | 0.92× speech rate tuned for walking tempo with deduplication |
| **Tokyo Night HUD** | Frosted-glass AR overlay with LERP-smoothed bounding boxes and urgency glow |
| **Live AR Subtitles** | `[ PERSON | 1.4m | TIER 1 ]` formatted high-contrast subtitle badges |
| **Dual Scene Narrator** | Free HuggingFace BLIP captioning by default, Gemini 2.5 Flash when API key is provided |
| **Circuit Breakers** | Suppresses API calls during Tier-1 hazards to prioritize safety |

## Architecture

```
src/
├── core/
│   ├── CameraManager.js      — Rear-camera setup with iOS/Android inline playback + auto-sync canvas
│   ├── EdgeDetector.js       — COCO-SSD + motion fallback + AR HUD renderer (confidence threshold >= 0.5)
│   ├── SpatialReasoning.js   — Pinhole distance + hazard scoring + tracking (center cone 40%)
│   └── SpeechSynthesizer.js  — 3-tier barge-in priority speech queue (0.92x rate)
├── modules/
│   ├── SceneNarrator.js      — Dual-mode LLM scene captioning (BLIP / Gemini)
│   └── SubtitleManager.js    — Live AR subtitle badge rendering
├── ui/
│   ├── styles/
│   │   ├── main.css          — CSS variables, reset, glass utility, layout
│   │   └── components.css    — Badge, hero, HUD, drawer, controls
│   └── UIController.js       — DOM bindings, transitions, HUD state
├── App.js                    — Orchestrator master loop: Camera -> Detector -> Spatial -> Speech -> Subtitles -> HUD
└── main.js                   — Entry point (style imports + bootstrap)
```

## Quick Start

```bash
# Install dependencies
npm install

# Start development server
npm run dev

# Build for production
npm run build

# Preview production build
npm run preview
```

## Hackathon Demo Flow
1. **Launch**: Open the app and observe the Tokyo Night glass hero screen. Tap "LAUNCH SYSTEM".
2. **Real-time Engine**: Show the top HUD indicating FPS and the live camera feed smoothly tracking objects in real-time.
3. **Geometric Distance & AR**: Move a chair or walk towards a person. Note the glowing AR brackets and the `[ PERSON | 1.4m | TIER 1 ]` badge updating instantly in the subtitle strip.
4. **Barge-in Alert**: Move the object into the "Center Cone" (middle 40% of screen) at less than 1.8 meters. The system will trigger an immediate audio interrupt: *"Warning. Person 1.4 meters directly ahead."*
5. **Contextual Scene**: Place the device down idly. After 5 seconds of silence, the system silently captures a snapshot and sends it to the free BLIP/Gemini model, gracefully speaking the ambient environment (e.g., *"Living room with a couch."*).

## Requirements

- Modern browser with `getUserMedia` support (camera access)
- Web Speech API support (for TTS)
- Internet connection for TensorFlow.js model download and scene narration APIs

## Privacy

All computer vision runs **on-device** via TensorFlow.js. No video data leaves your device. Scene narration API calls only occur when explicitly enabled and are suppressed during hazard situations.

## License

MIT
