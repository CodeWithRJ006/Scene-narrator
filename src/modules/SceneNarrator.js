/**
 * SceneNarrator.js – Dual-mode scene narrator.
 *
 * Mode 1 (Free Default): HuggingFace BLIP image-captioning — no API key needed.
 * Mode 2 (Gemini 2.5 Flash): Activated when user enters an API key.
 *
 * Circuit breakers suppress API calls during Tier-1 hazards or rapid camera motion.
 */

export class SceneNarrator {
    /**
     * @param {import('../core/SpeechSynthesizer.js').SpeechSynthesizer} speech
     * @param {import('../core/SpatialReasoning.js').SpatialReasoning} urgency
     */
    constructor(speech, urgency) {
        this.speech  = speech;
        this.urgency = urgency;
        this.apiKey  = '';
        this.busy    = false;
        this.timer   = null;
        this.lastInspect = 0;

        this.HF_URL = 'https://api-inference.huggingface.co/models/Salesforce/blip-image-captioning-base';
        this.GEMINI_PROMPT = 'You are an assistive vision guide. Detect and state any visible personal items, gadgets (phone, watch, glasses, earbuds), text, or path obstacles in 1 concise sentence (<10 words).';
    }

    /**
     * Set the Gemini API key (empty string disables Gemini mode).
     * @param {string} k
     */
    setKey(k) {
        this.apiKey = (k || '').trim();
    }

    /**
     * Start periodic scene narration.
     * First capture after 3 s to let camera settle, then every 5 s.
     * @param {HTMLVideoElement} video
     */
    start(video) {
        if (this.timer) return;
        setTimeout(() => this._run(video), 3000);
        this.timer = setInterval(() => this._run(video), 5000);
    }

    /**
     * Stop periodic narration.
     */
    stop() {
        clearInterval(this.timer);
        this.timer = null;
    }

    /**
     * Inspect hyper-specific items held extremely close to the camera.
     * @param {HTMLVideoElement} video
     * @returns {Promise<string|null>} The specific item name.
     */
    async inspectItem(video) {
        const now = performance.now();
        if (now - this.lastInspect < 5000) return null; // 5s debounce for inspection
        this.lastInspect = now;

        const c = this._snap(video);
        const b64 = c.toDataURL('image/jpeg', 0.8).split(',')[1];
        const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.8));
        
        const inspectPrompt = "The user is holding an item close to the camera. Identify the exact item (e.g., 'white wireless earbuds', 'black gaming mouse', 'car keys'). Reply with ONLY the item name, nothing else.";

        try {
            if (this.apiKey) {
                const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${this.apiKey}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        contents: [{
                            parts: [
                                { text: inspectPrompt },
                                { inline_data: { mime_type: "image/jpeg", data: b64 } }
                            ]
                        }]
                    })
                });
                const data = await res.json();
                return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || null;
            } else {
                // HF Fallback
                const res = await fetch(this.HF_URL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/octet-stream' },
                    body: blob
                });
                if (!res.ok) return null;
                const data = await res.json();
                return data[0]?.generated_text?.trim() || null;
            }
        } catch (e) {
            console.error('Inspect error:', e);
            return null;
        }
    }

    /* ──── Circuit Breakers ──── */

    /** @private Returns true if narration should be suppressed. */
    _blocked() {
        if (this.busy) return true;
        if (this.urgency && this.urgency.highestTier() === 1) return true;
        return false;
    }

    /* ──── Capture Frame ──── */

    /**
     * @private Capture the current video frame to a down-scaled canvas.
     * @param {HTMLVideoElement} video
     * @returns {HTMLCanvasElement}
     */
    _snap(video) {
        const c = document.createElement('canvas');
        const scale = 512 / Math.max(video.videoWidth, video.videoHeight);
        c.width  = video.videoWidth  * scale;
        c.height = video.videoHeight * scale;
        c.getContext('2d').drawImage(video, 0, 0, c.width, c.height);
        return c;
    }

    /* ──── Execute ──── */

    /** @private Run a single narration cycle. */
    async _run(video) {
        if (this._blocked()) return;
        this.busy = true;
        try {
            const text = this.apiKey ? await this._gemini(video) : await this._hf(video);
            if (text) this.speech.speakT3(text);
        } catch (e) {
            console.warn('SceneNarrator error:', e);
        } finally {
            this.busy = false;
        }
    }

    /* ──── Mode 1: HuggingFace (Free) ──── */

    /** @private Free serverless image captioning via BLIP. */
    async _hf(video) {
        const c    = this._snap(video);
        const blob = await new Promise(r =>
            c.toDataURL('image/jpeg', 0.7) && c.toBlob(r, 'image/jpeg', 0.7)
        );

        const res = await fetch(this.HF_URL, { method: 'POST', body: blob });
        if (!res.ok) { console.warn('HF status', res.status); return null; }
        const json = await res.json();
        if (Array.isArray(json) && json[0]?.generated_text) return json[0].generated_text;
        return null;
    }

    /* ──── Mode 2: Gemini 2.5 Flash ──── */

    /** @private Multimodal scene captioning via Gemini. */
    async _gemini(video) {
        const c   = this._snap(video);
        const b64 = c.toDataURL('image/jpeg', 0.8).split(',')[1];

        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${this.apiKey}`;
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [
                    { text: this.GEMINI_PROMPT },
                    { inline_data: { mime_type: 'image/jpeg', data: b64 } }
                ]}],
                generationConfig: { temperature: 0.2, maxOutputTokens: 60 }
            })
        });
        if (!res.ok) { console.warn('Gemini status', res.status); return null; }
        const d = await res.json();
        return d.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || null;
    }
}
