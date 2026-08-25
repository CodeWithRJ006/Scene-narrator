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
        this.voice = new VoiceCommand(async (intent) => {
            this.speech.playEarcon('stop');
            if (!intent) return;
            if (typeof intent === 'string') intent = { type: 'TARGET', payload: intent };
            
            const srLive = document.getElementById('aria-live-polite');

            if (intent.type === 'TARGET') {
                console.log(`[App] Target intent matched: ${intent.payload}`);
                this.navModeOnly = true;
                const navStatus = document.getElementById('nav-mode-status');
                if (navStatus) navStatus.textContent = 'Target: ON';
                const btnNavigation = document.getElementById('btn-navigation');
                if (btnNavigation) btnNavigation.style.color = '#10b981';

                // Cancel any previous navigation cleanly, then start fresh
                this.navEngine.cancelNavigation();
                this.navEngine.startTargetNavigation(intent.payload);
                this.ui.updateTargetRadar(intent.payload);
            } else if (intent.type === 'CANCEL') {
                console.log("[App] Cancel intent matched.");
                this._resetTargetMode();
                this.speech.speakT1("Navigation cancelled.");
            } else if (intent.type === 'ERROR') {
                console.log(`[App] Error intent matched: ${intent.payload}`);
                this.speech.speakT1(intent.payload);
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

        // Unified Target Mode Handler
        const triggerBtns = ['voice-btn', 'btn-voice', 'btn-find-object', 'btn-navigation'];
        triggerBtns.forEach(id => {
            const btn = document.getElementById(id);
            if (btn) {
                // Ensure only ONE listener per element
                btn.replaceWith(btn.cloneNode(true));
                document.getElementById(id).addEventListener('click', () => this._handleFindTargetTrigger());
            }
        });

        // Wire arrival callback to reset Target Mode
        this.navEngine.onArrival = () => {
            console.log("[App] Arrival detected via engine. Resetting Target Mode.");
            this._resetTargetMode();
        };
    }

    _handleFindTargetTrigger() {
        console.log("[Find Target] Triggered via UI tap.");
        if (this.navModeOnly) {
             console.log("[Find Target] Toggled OFF via button tap.");
             this._resetTargetMode();
             this.speech.speakT1("Navigation cancelled. Resuming general hazard detection.");
             return;
        }

        console.log("[Find Target] Speech synthesis cancelled.");
        this.speech.synth.cancel();
        
        this.speech.playEarcon('start');
        this.speech.speakT1("Listening...");
        
        this.voice.startListening();
    }

    _resetTargetMode() {
        this.navModeOnly = false;
        this.navEngine.cancelNavigation();   // cleans state, arrived timer, and lockedTrackId
        this.ui.updateTargetRadar(null);
        const navStatus = document.getElementById('nav-mode-status');
        if (navStatus) navStatus.textContent = 'Target: OFF';
        const btnNavigation = document.getElementById('btn-navigation');
        if (btnNavigation) btnNavigation.style.color = '';
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
            this.speech.speakT1("Camera access denied or unavailable. Please check permissions and tap anywhere on the screen to retry.");
            
            // Allow clicking anywhere to retry for blind users
            document.body.addEventListener('click', () => {
                location.reload();
            }, { once: true });
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
                const currentFps = Math.round(fpsCnt / ((t - fpsT) / 1000));
                this.ui.updateFPS(currentFps);
                
                // Live Status Bar Update
                const liveStatus = document.getElementById('live-status');
                const qDepth = this.speech.queue2 ? 1 : 0;
                const statusText = `FPS: ${currentFps} | DET: ${preds.length} | Q: ${qDepth}`;
                if (liveStatus) liveStatus.textContent = statusText;
                
                // Console log occasionally for demo verification
                if (Math.random() < 0.25) {
                    console.log(`[Health] ${statusText}`);
                }

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
                        if (!this.navModeOnly) {
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
                        }

                        if (!triggeredInspect) {
                            if (this.navModeOnly) {
                                // Mute chatter, but allow Tier-1 hazards in central path
                                const hazards = preds.filter(p => {
                                    if (p.urgencyTier !== 1) return false;
                                    const cx = p.bbox[0] + (p.bbox[2]/2);
                                    const pos = cx / video.videoWidth;
                                    return pos > 0.25 && pos < 0.75;
                                });
                                if (hazards.length > 0) {
                                    this._dispatchSpeech(hazards, spoken);
                                }
                            } else {
                                this._dispatchSpeech(preds, spoken);
                            }
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
            this.detector.drawHUD(preds, this.navEngine.activeTarget, this.navEngine.navState, this.navEngine.lockedTrackId);
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
                if (p.lateral) this.speech.playSpatialPing(p.lateral);
                this.speech.speakT1(text, dedupeKey);
                spoken.set(p.trackId, { lastTime: now, lastTier: p.urgencyTier });
            } else if (p.urgencyTier === TIER.CAUTION) {
                if (p.lateral) this.speech.playSpatialPing(p.lateral);
                this.speech.speakT2(text, dedupeKey);
                spoken.set(p.trackId, { lastTime: now, lastTier: p.urgencyTier });
            }
        }

        if (debugOverlay && debugOverlay.style.display === 'block') {
            debugOverlay.innerHTML = debugHTML;
        }
    }
}
