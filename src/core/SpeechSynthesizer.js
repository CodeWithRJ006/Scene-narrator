/**
 * SpeechSynthesizer.js – Natural-cadence 3-tier priority speech queue.
 *
 * Tier 1 (Barge-In):  Cancels all current speech. 1.8 s cooldown.
 *   → "Warning. [Object] [Distance] meters directly ahead."
 *
 * Tier 2 (Queued):    Spoken in next idle gap. Single-slot queue.
 *   → "Chair on your right, about 2.5 meters away."
 *
 * Tier 3 (Scene):     Only after 5 s of absolute silence.
 *   → "Room door open, 4 meters ahead."
 *
 * Voice: rate 0.92 (natural, unhurried tempo), pitch 1.0.
 */

export class SpeechSynthesizer {
    constructor() {
        this.synth    = window.speechSynthesis;
        this.voice    = null;
        this.speaking = false;
        this.isUnlocked = false;
        this.lastEnd  = 0;
        this.lastT1   = 0;
        this.queue2   = null;
        this.T1_COOL    = 1800;
        this.T3_SILENCE = 5000;

        // Deduplication: track recently spoken text to avoid repeating stationary hazards
        this.recentUtterances = new Map(); // text → timestamp

        this._pickVoice();
        if (this.synth.onvoiceschanged !== undefined) {
            this.synth.onvoiceschanged = () => this._pickVoice();
        }
    }

    /**
     * Unlock speech synthesis and initialize Web Audio API for spatial pings.
     * Must be called on user interaction.
     */
    unlockAudio() {
        if (!this.synth) return;
        const u = new SpeechSynthesisUtterance('');
        u.volume = 0;
        this.synth.speak(u);

        // Initialize Web Audio Context for Earcons and Spatial Audio
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        if (AudioContext) {
            this.audioCtx = new AudioContext();
        }

        if (this.isUnlocked) return;
        // Force a silent utterance, followed immediately by a vocal confirmation
        const prime = new SpeechSynthesisUtterance("");
        this.synth.speak(prime);
        
        setTimeout(() => {
            const confirm = new SpeechSynthesisUtterance("System Online. Vision active.");
            confirm.rate = 1.0;
            if (this.voice) confirm.voice = this.voice;
            this.synth.speak(confirm);
            this.isUnlocked = true;
            this.lastEnd = performance.now();
            this._hud('System Online');
        }, 100);
    }

    /**
     * Play a directional sonar ping using Web Audio API.
     * @param {string} lateral - 'left', 'ahead', or 'right'
     */
    playSpatialPing(lateral) {
        if (!this.audioCtx) return;
        if (this.audioCtx.state === 'suspended') this.audioCtx.resume();

        const osc = this.audioCtx.createOscillator();
        const gain = this.audioCtx.createGain();
        let panner = null;
        
        if (this.audioCtx.createStereoPanner) {
            panner = this.audioCtx.createStereoPanner();
            panner.pan.value = lateral === 'left' ? -0.8 : (lateral === 'right' ? 0.8 : 0);
        }
        
        osc.type = 'sine';
        osc.frequency.setValueAtTime(lateral === 'ahead' ? 800 : 1200, this.audioCtx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(lateral === 'ahead' ? 400 : 600, this.audioCtx.currentTime + 0.15);

        gain.gain.setValueAtTime(0, this.audioCtx.currentTime);
        gain.gain.linearRampToValueAtTime(0.2, this.audioCtx.currentTime + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.001, this.audioCtx.currentTime + 0.15);

        osc.connect(gain);
        if (panner) {
            gain.connect(panner);
            panner.connect(this.audioCtx.destination);
        } else {
            gain.connect(this.audioCtx.destination);
        }

        osc.start();
        osc.stop(this.audioCtx.currentTime + 0.2);
    }

    /**
     * Play an earcon to indicate barge-in listening state.
     * @param {string} type - 'start' or 'stop'
     */
    playEarcon(type) {
        if (!this.audioCtx) return;
        if (this.audioCtx.state === 'suspended') this.audioCtx.resume();
        
        const osc = this.audioCtx.createOscillator();
        const gain = this.audioCtx.createGain();
        osc.type = 'triangle';
        
        if (type === 'start') {
            osc.frequency.setValueAtTime(600, this.audioCtx.currentTime);
            osc.frequency.linearRampToValueAtTime(900, this.audioCtx.currentTime + 0.1);
        } else {
            osc.frequency.setValueAtTime(900, this.audioCtx.currentTime);
            osc.frequency.linearRampToValueAtTime(600, this.audioCtx.currentTime + 0.1);
        }
        
        gain.gain.setValueAtTime(0.1, this.audioCtx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, this.audioCtx.currentTime + 0.2);
        
        osc.connect(gain);
        gain.connect(this.audioCtx.destination);
        osc.start();
        osc.stop(this.audioCtx.currentTime + 0.25);
    }

    /* ═══════════════════ PUBLIC API ═══════════════════ */

    /**
     * Tier 1 – Barge-in hazard alert. Immediately cancels current speech.
     * @param {string} text  e.g. "Warning. Person 1.2 meters directly ahead."
     * @param {string} dedupeKey Unique tracking key to avoid rapid double-fires.
     */
    speakT1(text, dedupeKey = null) {
        const now = performance.now();
        const key = dedupeKey || text;
        if (now - this.lastT1 < this.T1_COOL) return;
        if (this._isRecent(key, 2500)) return;
        this.lastT1 = now;
        
        // Immediately cancel for barge-in
        this.synth.cancel();
        this.queue2   = null;
        this.speaking = false;

        if (navigator.vibrate) navigator.vibrate([200, 100, 200, 100, 200]);
        
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.rate = 0.95;
        utterance.pitch = 1.1;
        if (this.voice) utterance.voice = this.voice;
        
        utterance.onstart = () => { this.speaking = true; this._hud('Speaking'); this._sub(text, true); };
        utterance.onend   = () => { this.speaking = false; this.lastEnd = performance.now(); this._hud('Idle'); this._drain(); };
        utterance.onerror = () => { this.speaking = false; this.lastEnd = performance.now(); this._hud('Idle'); this._drain(); };
        
        this.synth.speak(utterance);
        this._markRecent(key);
    }

    /**
     * Tier 2 – Queued caution alert. Spoken smoothly in silent gaps.
     * @param {string} text  e.g. "Chair on your right, about 2.5 meters away."
     * @param {string} dedupeKey Unique tracking key.
     */
    speakT2(text, dedupeKey = null) {
        const key = dedupeKey || text;
        if (this._isRecent(key, 4000)) return;
        if (this.speaking || this.synth.speaking) {
            this.queue2 = { text, key };
            return;
        }
        if (navigator.vibrate) navigator.vibrate([150, 100, 150]);
        this._speak(text);
        this._markRecent(key);
    }

    /**
     * Tier 3 – Ambient scene description (only after 5 s silence).
     * @param {string} text  Scene narration from LLM.
     */
    speakT3(text) {
        const idle = !this.speaking && !this.synth.speaking && this.queue2 === null;
        if (idle && performance.now() - this.lastEnd >= this.T3_SILENCE) {
            if (navigator.vibrate) navigator.vibrate([50]);
            this._speak(text);
        }
    }

    /* ═══════════════ NATURAL SPEECH FORMATTER ═══════════════ */

    /**
     * Build a natural distance-aware hazard sentence.
     * @param {string}  cls      Object class name.
     * @param {number}  dist     Distance in meters.
     * @param {string}  lateral  'ahead' | 'left' | 'right'.
     * @param {number}  tier     Urgency tier.
     * @returns {string}
     */
    static formatAlert(cls, dist, lateral, tier) {
        const name = cls.charAt(0).toUpperCase() + cls.slice(1);
        
        // Remove false precision: Round to nearest 0.5 meters if > 1m
        let dStr;
        if (dist < 1.0) {
            dStr = dist.toFixed(1);
        } else {
            const rounded = Math.round(dist * 2) / 2;
            dStr = (rounded % 1 === 0) ? rounded.toString() : rounded.toFixed(1);
            dStr = `about ${dStr}`;
        }

        const isGadget = ['Cell phone', 'Phone', 'Watch', 'Clock', 'Glasses', 'Specs', 'Earbuds', 'Earphones', 'Keys', 'Mouse'].includes(name);

        if (isGadget && dist < 0.8) {
            return `${name}, ${dStr}.`;
        }

        if (tier === 1) {
            if (lateral === 'ahead') return `Hazard: ${name}, ${dStr} ahead.`;
            return `Hazard: ${name}, ${lateral}.`; // Very short
        }
        if (tier === 2) {
            if (lateral === 'ahead') return `${name}, ${dStr} ahead.`;
            return `${name}, ${lateral}, ${dStr}.`;
        }
        // Tier 3
        if (lateral === 'ahead') return `${name}, ${dStr} ahead.`;
        return `${name}, ${lateral}, ${dStr}.`;
    }

    /* ═══════════════════ INTERNAL ═══════════════════ */

    /** @private Speak with natural 0.92x rate pacing. */
    _speak(text) {
        const u = new SpeechSynthesisUtterance(text);
        if (this.voice) u.voice = this.voice;
        
        // Unhurried natural tempo
        u.rate  = 0.92;
        u.pitch = 1.0;

        u.onstart = () => { this.speaking = true;  this._hud('Speaking'); this._sub(text); };
        u.onend   = () => { this.speaking = false; this.lastEnd = performance.now(); this._hud('Idle'); this._drain(); };
        u.onerror = () => { this.speaking = false; this.lastEnd = performance.now(); this._hud('Idle'); this._drain(); };
        this.synth.speak(u);
    }

    /** @private Drain Tier 2 queue after current utterance finishes. */
    _drain() {
        if (this.queue2) {
            const t = this.queue2.text;
            const k = this.queue2.key;
            this.queue2 = null;
            setTimeout(() => { this._speak(t); this._markRecent(k); }, 140);
        }
    }

    /** @private Select the best available English voice. */
    _pickVoice() {
        const v = this.synth.getVoices();
        this.voice =
            v.find(x => /Google US English/i.test(x.name)) ||
            v.find(x => /Samantha/i.test(x.name)) ||
            v.find(x => /Alex/i.test(x.name) && x.lang.startsWith('en')) ||
            v.find(x => /Premium/i.test(x.name) && x.lang.startsWith('en')) ||
            v.find(x => x.lang.startsWith('en')) ||
            v[0] || null;
    }

    /** @private Check if text was spoken recently within the given window. */
    _isRecent(text, window) {
        const last = this.recentUtterances.get(text);
        return last !== undefined && performance.now() - last < window;
    }

    /** @private Mark text as recently spoken. */
    _markRecent(text) {
        this.recentUtterances.set(text, performance.now());
        // Prune old entries
        if (this.recentUtterances.size > 50) {
            const now = performance.now();
            for (const [k, t] of this.recentUtterances) {
                if (now - t > 10000) this.recentUtterances.delete(k);
            }
        }
    }

    /** @private Update HUD speech status indicator. */
    _hud(s) {
        const el = document.getElementById('speech-status');
        if (el) el.textContent = s;
    }

    /** @private Flash spoken text in live subtitles and ARIA live regions. */
    _sub(text, isUrgent = false) {
        // Find ARIA regions
        const assertive = document.getElementById('aria-live-assertive');
        const polite = document.getElementById('aria-live-polite');
        
        if (isUrgent && assertive) {
            assertive.textContent = text;
        } else if (!isUrgent && polite) {
            polite.textContent = text;
        }
    }
}
