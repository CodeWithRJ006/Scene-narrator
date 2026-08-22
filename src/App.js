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
import { UIController, syncCanvasDimensions }       from './ui/UIController.js';
import { VoiceCommand }      from './core/VoiceCommand.js';
import { NavigationEngine }  from './core/NavigationEngine.js';

export class App {
    constructor() {
        this.ui       = new UIController();
        this.speech   = new SpeechSynthesizer();
        this.detector = new EdgeDetector('overlay');
        this.subtitles = new SubtitleManager('subtitle-strip'); 
        this.camera   = null;
        this.urgency  = null;
        this.narrator = null;
        this.navEngine = new NavigationEngine(this.speech);
        this.voice    = new VoiceCommand(async (intent) => {
            if (!intent) return;
            if (typeof intent === 'string') intent = { type: 'TARGET', payload: intent };
            
            const srLive = document.getElementById('aria-live-polite');

            if (intent.type === 'TARGET') {
                this.navEngine.setTarget(intent.payload);
                this.ui.updateTargetRadar(intent.payload);
            } else if (intent.type === 'PROXIMITY') {
                let val = Math.max(1, Math.min(10, intent.payload));
                const proxSlider = document.getElementById('proximity');
                const proxTag = document.getElementById('prox-tag');
                if (proxSlider) { proxSlider.value = val; proxSlider.setAttribute('aria-valuenow', val); }
                if (proxTag) proxTag.textContent = val;
                
                this.urgency.hazardDistance = val * 0.35; // Map 1-10 to 0.35m - 3.5m
                this.speech.speakT1(`Proximity threshold set to ${val}`);
                if (srLive) srLive.textContent = `Proximity threshold set to ${val}`;
            } else if (intent.type === 'CAMERA') {
                const devs = await this.camera.getAvailableCameras();
                if (devs.length > 1) {
                    const currentIdx = devs.findIndex(d => d.deviceId === this.camera.selectedDeviceId);
                    const nextIdx = (currentIdx + 1) % devs.length;
                    await this.camera.startCamera(devs[nextIdx].deviceId);
                    this.speech.speakT1(`Camera switched`);
                    if (srLive) srLive.textContent = `Camera switched`;
                } else {
                    this.speech.speakT1(`No other cameras found`);
                }
            } else if (intent.type === 'CLOUD') {
                if (intent.payload) {
                    this.speech.speakT1(`Cloud narration enabled`);
                    if (srLive) srLive.textContent = `Cloud narration enabled`;
                } else {
                    this.narrator.stop();
                    this.speech.speakT1(`Cloud narration disabled`);
                    if (srLive) srLive.textContent = `Cloud narration disabled`;
                }
            } else if (intent.type === 'CLEAR_KEY') {
                localStorage.removeItem('geminiApiKey');
                const apiKeyEl = document.getElementById('api-key');
                if (apiKeyEl) apiKeyEl.value = '';
                this.narrator.setKey('');
                this.speech.speakT1(`API key cleared`);
                if (srLive) srLive.textContent = `Gemini API key cleared`;
            }
        });

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

        // Voice Command Trigger (FAB)
        const btnVoice = document.getElementById('voice-btn');
        if (btnVoice) {
            btnVoice.addEventListener('click', () => {
                this.speech.synth.cancel(); // Stop current speech
                const u = new SpeechSynthesisUtterance("Listening");
                this.speech.synth.speak(u);
                this.voice.startListening();
            });
        }

        // Voice Command Trigger (Find Object Button)
        const btnFindObj = document.getElementById('btn-find-object');
        if (btnFindObj) {
            btnFindObj.addEventListener('click', () => {
                this.speech.synth.cancel(); // Stop current speech
                const u = new SpeechSynthesisUtterance("Listening");
                this.speech.synth.speak(u);
                this.voice.startListening();
            });
        }
    }

    /* ─────────── Stage 1 → Stage 2 ─────────── */

    /** @private Launch sequence: camera → model → HUD → core loop. */
    async _launch() {
        this.speech.unlockAudio(); // Updated method name
        this.ui.showCalibrating();

        try {
            this.camera = new CameraManager('webcam');
            await this.camera.start();
            
            // Populate Camera Dropdown
            const camSelect = document.getElementById('camera-select');
            if (camSelect) {
                const devices = await this.camera.getAvailableCameras();
                devices.forEach(d => {
                    const opt = document.createElement('option');
                    opt.value = d.deviceId;
                    opt.text = d.label || `Camera ${camSelect.length}`;
                    camSelect.appendChild(opt);
                });
                
                camSelect.addEventListener('change', async (e) => {
                    const devId = e.target.value || null;
                    await this.camera.startCamera(devId);
                });
            }

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

            // Audio Onboarding (Accessibility)
            if (!localStorage.getItem('onboarded_v2')) {
                setTimeout(() => {
                    this.speech.speakT1("Welcome to Insight Lens Pro. Voice commands are active. You can say: Find an object, Set proximity to 5, Switch camera, or Enable cloud narration.");
                    localStorage.setItem('onboarded_v2', 'true');
                }, 3500); // Give the system online message time to finish
            }

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
        this._emptyFrames = 0;

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

                        let triggeredInspect = false;
                        for (const p of preds) {
                            const [x, y, w, h] = p.bbox;
                            const cx = x + w / 2;
                            const isExactCenter = cx > video.videoWidth * 0.40 && cx < video.videoWidth * 0.60;
                            
                            if (p.distance < 0.4 && isExactCenter && !this._isInspecting) {
                                this._isInspecting = true;
                                triggeredInspect = true;
                                this.narrator.inspectItem(video).then(item => {
                                    this._isInspecting = false;
                                    if (item) {
                                        const cleanItem = item.replace(/[\r\n.]/g, '');
                                        this.speech.speakT1(`Holding: ${cleanItem}`);
                                        this.subtitles.showSpoken(`Holding: ${cleanItem}`);
                                    }
                                });
                                break;
                            }
                        }

                        if (!triggeredInspect) {
                            this._dispatchSpeech(preds, spoken);
                        }
                        
                        this.navEngine.update(preds, video.videoWidth);
                        this._updateHUD(preds);
                        this.subtitles.update(preds);
                    }
                    
                    // Graceful Degradation: Visibility Check
                    if (!raw || raw.length === 0) {
                        this._emptyFrames++;
                        if (this._emptyFrames > 60) { // ~5 seconds of zero detections
                            this.speech.speakT2("Visibility low. No objects detected.", "visibility_low");
                            this._emptyFrames = 0; // reset to avoid spamming
                        }
                    } else {
                        // Reset if we see mature predictions or any raw predictions > threshold
                        if (raw.some(p => p.score > 0.5)) {
                            this._emptyFrames = 0;
                        }
                    }
                    
                    inferring = false;
                }).catch(() => { inferring = false; });
            }

            // ── 60 FPS render (LERP inside drawHUD) ──
            syncCanvasDimensions(video, this.detector.canvas);
            this.detector.drawHUD(preds, this.navEngine.activeTarget);
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
        
        // Debug overlay logging
        const debugOverlay = document.getElementById('debug-overlay');
        let debugHTML = `<div style="margin-bottom:8px"><strong>Vision Debug</strong> | FPS: ${Math.round(1000/12)} (Cap)</div>`;

        for (const p of preds) {
            if (p.trackId === undefined || p.className === 'motion') continue;

            const isMature = p.isMature;
            debugHTML += `<div style="color:${isMature ? '#0f0' : '#888'}">[T${p.urgencyTier}] ${p.className} @ ${p.distance}m (Mature: ${isMature})</div>`;

            if (!isMature) continue; // Debounce newly detected objects

            const trackState = spoken.get(p.trackId) || { lastTime: 0, lastTier: 4 };
            
            // Re-trigger if 4 seconds passed OR if it escalated to a more severe tier
            const escalated = p.urgencyTier < trackState.lastTier;
            if (now - trackState.lastTime < 4000 && !escalated) continue;

            const text = SpeechSynthesizer.formatAlert(
                p.className,
                p.distance ?? 3.0,
                p.lateral ?? 'ahead',
                p.urgencyTier
            );

            // Deduplication key so slightly different distances on the same frame don't bypass speech synthesizer deduping
            const dedupeKey = `${p.className}_${p.urgencyTier}`;

            if (p.urgencyTier === TIER.HAZARD) {
                this.speech.speakT1(text, dedupeKey);
                spoken.set(p.trackId, { lastTime: now, lastTier: p.urgencyTier });
            } else if (p.urgencyTier === TIER.CAUTION) {
                this.speech.speakT2(text, dedupeKey);
                spoken.set(p.trackId, { lastTime: now, lastTier: p.urgencyTier });
            }
        }

        if (debugOverlay && debugOverlay.style.display === 'block') {
            debugOverlay.innerHTML = debugHTML;
        }
    }
}
