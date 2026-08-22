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
     * Call inside a direct user click to unlock iOS/Android audio.
     */
    unlockAudio() {
        const u = new SpeechSynthesisUtterance('');
        u.volume = 0;
        this.synth.speak(u);
        this.synth.cancel();
        this.lastEnd = performance.now();
        this._hud('Unlocked');
    }

    /* ═══════════════════ PUBLIC API ═══════════════════ */

    /**
     * Tier 1 – Barge-in hazard alert. Immediately cancels current speech.
     * @param {string} text  e.g. "Warning. Person 1.2 meters directly ahead."
     */
    speakT1(text) {
        const now = performance.now();
        if (now - this.lastT1 < this.T1_COOL) return;
        if (this._isRecent(text, 2500)) return;
        this.lastT1 = now;
        
        // Immediately cancel for barge-in
        this.synth.cancel();
        this.queue2   = null;
        this.speaking = false;
        
        this._speak(text);
        this._markRecent(text);
    }

    /**
     * Tier 2 – Queued caution alert. Spoken smoothly in silent gaps.
     * @param {string} text  e.g. "Chair on your right, about 2.5 meters away."
     */
    speakT2(text) {
        if (this._isRecent(text, 4000)) return;
        if (this.speaking || this.synth.speaking) {
            this.queue2 = text;
            return;
        }
        this._speak(text);
        this._markRecent(text);
    }

    /**
     * Tier 3 – Ambient scene description (only after 5 s silence).
     * @param {string} text  Scene narration from LLM.
     */
    speakT3(text) {
        const idle = !this.speaking && !this.synth.speaking && this.queue2 === null;
        if (idle && performance.now() - this.lastEnd >= this.T3_SILENCE) {
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
        const d = dist.toFixed(1);

        if (tier === 1) {
            if (lateral === 'ahead') return `Warning. ${name} ${d} meters directly ahead.`;
            return `Warning. ${name} ${d} meters on your ${lateral}.`;
        }
        if (tier === 2) {
            if (lateral === 'ahead') return `${name} ahead, about ${d} meters away.`;
            return `${name} on your ${lateral}, about ${d} meters away.`;
        }
        // Tier 3
        if (lateral === 'ahead') return `${name}, ${d} meters ahead.`;
        return `${name} on your ${lateral}, ${d} meters.`;
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
            const t = this.queue2;
            this.queue2 = null;
            setTimeout(() => { this._speak(t); this._markRecent(t); }, 140);
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

    /** @private Flash spoken text in live subtitles. */
    _sub(text) {
        // Not used by the main subtitle manager directly, but a hook if needed.
    }
}
