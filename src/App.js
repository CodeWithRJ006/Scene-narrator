/**
 * App.js – Application orchestrator.
 *
 * Wires together all core modules, manages the two-stage lifecycle
 * (landing → active HUD), and runs the real-time inference/render loop.
 */

import { CameraManager }     from './core/CameraManager.js';
import { EdgeDetector }       from './core/EdgeDetector.js';
import { SpatialReasoning, TIER } from './core/SpatialReasoning.js';
import { SpeechSynthesizer } from './core/SpeechSynthesizer.js';
import { SceneNarrator }     from './modules/SceneNarrator.js';
import { SubtitleManager }   from './modules/SubtitleManager.js';
import { UIController }       from './ui/UIController.js';

export class App {
    constructor() {
        this.ui       = new UIController();
        this.speech   = new SpeechSynthesizer();
        this.detector = new EdgeDetector('overlay');
        this.subtitles = new SubtitleManager('subtitle-strip'); // Updated to use subtitle-strip
        this.camera   = null;
        this.urgency  = null;
        this.narrator = null;

        this._bindEvents();
    }

    /* ─────────── Event Bindings ─────────── */

    /** @private */
    _bindEvents() {
        // Launch button
        this.ui.onLaunch(() => this._launch());

        // API key sync
        this.ui.onApiKeyChange((key) => {
            if (this.narrator) this.narrator.setKey(key);
        });

        // Test buttons
        this.ui.onTestButtons(
            () => this.speech.speakT1('Warning. Person 1.2 meters directly ahead.'),
            () => this.speech.speakT2('Chair on your right, about 2.5 meters away.')
        );
    }

    /* ─────────── Stage 1 → Stage 2 ─────────── */

    /** @private Launch sequence: camera → model → HUD → core loop. */
    async _launch() {
        this.speech.unlockAudio(); // Updated method name
        this.ui.showCalibrating();

        try {
            this.camera = new CameraManager('webcam');
            await this.camera.start();
            const video = this.camera.video;

            this.urgency  = new SpatialReasoning(video.videoWidth, video.videoHeight);
            this.narrator = new SceneNarrator(this.speech, this.urgency);
            this.narrator.setKey(this.ui.getApiKey());

            await this.detector.load();

            // Auto-sync canvas overlay aspect ratio
            this.camera.syncCanvasOnResize((w, h) => {
                this.detector.canvas.width = w;
                this.detector.canvas.height = h;
                if (this.urgency) this.urgency.resize(w, h);
            });

            // Transition to active HUD
            this.ui.transitionToApp();

            // Start scene narration & core loop
            this.narrator.start(video);
            this._runCoreLoop(video);

        } catch (e) {
            console.error('Launch error:', e);
            this.ui.showError();
        }
    }

    /* ─────────── Core Loop ─────────── */

    /**
     * @private Main loop: Master loop wiring Camera -> Detector -> Spatial -> Speech -> Subtitles -> HUD
     * @param {HTMLVideoElement} video
     */
    _runCoreLoop(video) {
        let inferring = false;
        let lastInfer = 0;
        const THROTTLE = 1000 / 12;  // 12 FPS inference cap
        let preds = [];
        const spoken = new Map();    // trackId → lastSpokenTime
        let fpsCnt = 0, fpsT = performance.now();

        const loop = (t) => {
            requestAnimationFrame(loop);
            if (video.readyState < 2) return;

            // ── FPS Counter ──
            fpsCnt++;
            if (t - fpsT >= 500) {
                this.ui.updateFPS(fpsCnt / ((t - fpsT) / 1000));
                fpsCnt = 0;
                fpsT = t;
            }

            // ── Inference (async, throttled to 12 FPS) ──
            if (!inferring && t - lastInfer > THROTTLE) {
                inferring = true;
                lastInfer = t;

                this.detector.detect(video).then(raw => {
                    if (raw) {
                        preds = this.urgency.process(raw);
                        this._updateHUD(preds);
                        this._dispatchSpeech(preds, spoken);
                        this.subtitles.update(preds);
                    }
                    inferring = false;
                }).catch(() => { inferring = false; });
            }

            // ── 60 FPS render (LERP inside drawHUD) ──
            this.detector.drawHUD(preds);
        };

        requestAnimationFrame(loop);
    }

    /* ─────────── HUD & Speech Helpers ─────────── */

    /**
     * @private Update urgency dot based on highest active tier.
     * @param {Array} _preds – unused but kept for signature consistency.
     */
    _updateHUD(_preds) {
        const best = this.urgency.highestTier();
        this.ui.updateUrgencyDot(best);
    }

    /**
     * @private Dispatch speech alerts based on urgency tiers.
     * @param {Array} preds
     * @param {Map} spoken – Track-level cooldown map.
     */
    _dispatchSpeech(preds, spoken) {
        const now = performance.now();
        for (const p of preds) {
            if (p.trackId === undefined || p.className === 'motion') continue;
            const last = spoken.get(p.trackId) || 0;
            if (now - last < 4000) continue;

            const text = SpeechSynthesizer.formatAlert(
                p.className,
                p.distance ?? 3.0,
                p.lateral ?? 'ahead',
                p.urgencyTier
            );

            if (p.urgencyTier === TIER.HAZARD) {
                this.speech.speakT1(text);
                spoken.set(p.trackId, now);
            } else if (p.urgencyTier === TIER.CAUTION) {
                this.speech.speakT2(text);
                spoken.set(p.trackId, now);
            }
        }
    }
}
