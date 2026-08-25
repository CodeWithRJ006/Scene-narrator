/**
 * VoiceCommand.js – Voice input for navigation targeting and system commands.
 *
 * ── Target extraction pipeline ──
 *   1. Check for system commands first (PROXIMITY, CAMERA, CLOUD, CANCEL, CLEAR_KEY)
 *   2. Strip any trigger phrase ("navigate to", "find", "where is", etc.)
 *   3. Strip filler/article words ("the", "nearest", "please", ...)
 *   4. Apply synonym map to align spoken words to COCO-SSD class names
 *   5. Emit { type: 'TARGET', payload: resolvedClassName }
 *
 * Examples:
 *   "find the nearest chair"    → TARGET "chair"
 *   "navigate to the sofa"      → TARGET "couch"   (synonym)
 *   "television"                → TARGET "tv"       (synonym)
 *   "take me to the fridge"     → TARGET "refrigerator"
 *   "stop navigation"           → CANCEL
 *   "set proximity to 5"        → PROXIMITY 5
 */

/** Maps common spoken words → COCO-SSD class names */
const SYNONYMS = {
    // Furniture
    'sofa': 'couch', 'settee': 'couch', 'loveseat': 'couch',
    'seat': 'chair', 'stool': 'chair', 'armchair': 'chair',
    'table': 'dining table', 'desk': 'dining table',
    'fridge': 'refrigerator', 'freezer': 'refrigerator',
    // Electronics
    'television': 'tv', 'telly': 'tv', 'screen': 'tv', 'monitor': 'tv', 'display': 'tv',
    'computer': 'laptop', 'pc': 'laptop', 'notebook': 'laptop', 'macbook': 'laptop',
    'phone': 'cell phone', 'mobile': 'cell phone', 'smartphone': 'cell phone',
    'iphone': 'cell phone', 'android': 'cell phone',
    // People / animals
    'human': 'person', 'man': 'person', 'woman': 'person',
    'people': 'person', 'someone': 'person', 'somebody': 'person',
    // Bags
    'bag': 'backpack', 'rucksack': 'backpack', 'schoolbag': 'backpack',
    'handbag': 'handbag', 'purse': 'handbag',
    // Everyday
    'cup': 'cup', 'mug': 'cup',
    'water bottle': 'bottle', 'flask': 'bottle',
    'garbage': 'trash can', 'bin': 'trash can',
    'bicycle': 'bicycle', 'bike': 'bicycle',
    'motorbike': 'motorcycle',
    'aeroplane': 'airplane', 'plane': 'airplane',
};

/** Filler/article words to strip from extracted target phrase */
const STRIP_WORDS = new Set([
    'the', 'a', 'an', 'my', 'that', 'this', 'some',
    'nearest', 'closest', 'nearby', 'please', 'for', 'me',
]);

/** Navigation trigger phrases — longer phrases must come before shorter prefix matches */
const NAV_TRIGGERS = [
    'navigate towards', 'navigate to',
    'go towards', 'go to',
    'take me towards', 'take me to',
    'lead me to',
    'look for',
    'search for',
    'find me',
    'where are', "where's", 'where is',
    'locate',
    'find',
];

export class VoiceCommand {
    constructor(onTargetSet) {
        this.onTargetSet  = onTargetSet;
        this.isListening  = false;

        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SpeechRecognition) {
            console.warn('[Voice] Speech API not supported on this browser.');
            return;
        }

        this.recognition = new SpeechRecognition();
        this.recognition.continuous      = false;
        this.recognition.interimResults  = false;
        this.recognition.lang            = 'en-US';
        this.recognition.maxAlternatives = 3; // try up to 3 alternatives before giving up

        this.recognition.onstart = () => {
            this.isListening = true;
            console.log('[Voice] Speech recognition active and listening.');
        };

        this.recognition.onend = () => {
            this.isListening = false;
            console.log('[Voice] Speech recognition ended.');
        };

        this.recognition.onerror = (e) => {
            this.isListening = false;
            console.warn('[Voice] Speech recognition error:', e.error);
            if (e.error === 'not-allowed') {
                this.onTargetSet({ type: 'ERROR', payload: 'Microphone permission denied.' });
            } else {
                this.onTargetSet(null);
            }
        };

        this.recognition.onresult = (event) => {
            if (!event.results || !event.results[0] || !event.results[0][0]) return;
            const command = event.results[0][0].transcript.toLowerCase().trim();
            console.log('[Voice] Recognition result:', command);

            // ── System commands (checked first, before target extraction) ──

            const proximityMatch = command.match(/set proximity to (\d+)/);
            if (proximityMatch) {
                return this.onTargetSet({ type: 'PROXIMITY', payload: parseInt(proximityMatch[1], 10) });
            }

            if (command.includes('switch camera') || command.includes('next camera')) {
                return this.onTargetSet({ type: 'CAMERA', payload: 'next' });
            }

            if (command.includes('enable cloud narration') || command.includes('start cloud narration')) {
                return this.onTargetSet({ type: 'CLOUD', payload: true });
            }
            if (command.includes('disable cloud narration') || command.includes('stop cloud narration')) {
                return this.onTargetSet({ type: 'CLOUD', payload: false });
            }

            if (command.includes('clear api key') || command.includes('remove api key')) {
                return this.onTargetSet({ type: 'CLEAR_KEY' });
            }

            if (command === 'stop navigation' || command === 'cancel' ||
                command === 'cancel target' || command === 'cancel navigation') {
                console.log('[Voice] Cancel phrase detected.');
                return this.onTargetSet({ type: 'CANCEL' });
            }

            // ── Navigation target extraction ──
            const target = this._extractTarget(command);
            if (target) {
                console.log(`[Voice] Target parsed: "${target}"`);
                this.onTargetSet({ type: 'TARGET', payload: target });
            } else {
                console.warn('[Voice] Could not parse a target from:', command);
                this.onTargetSet(null);
            }
        };
    }

    /** Open the microphone. Safe to call even if already listening. */
    startListening() {
        if (this.isListening) {
            console.log('[Voice] Already listening — ignoring duplicate start.');
            return;
        }
        if (this.recognition) {
            try {
                this.recognition.start();
            } catch (e) {
                console.warn('[Voice] Error calling start:', e);
            }
        } else {
            this.onTargetSet({ type: 'ERROR', payload: 'Speech API not supported.' });
        }
    }

    /** Stop listening immediately. */
    stopListening() {
        if (this.recognition && this.isListening) {
            try { this.recognition.stop(); } catch (_) {}
            this.isListening = false;
        }
    }

    /* ──────────── Private: Target Extraction Pipeline ──────────── */

    /**
     * Extract a COCO-SSD class name from raw transcript.
     * Pipeline:
     *   1. Strip trigger phrase → take remainder
     *   2. Fallback: use whole transcript
     *   3. Strip filler words
     *   4. Apply synonym map (full phrase → last word → first word)
     * @param {string} transcript  Lowercase, trimmed.
     * @returns {string|null}
     */
    _extractTarget(transcript) {
        let raw = null;

        // 1. Strip trigger phrase (longest first to avoid prefix conflicts)
        for (const trigger of NAV_TRIGGERS) {
            if (transcript.includes(trigger)) {
                const after = transcript.split(trigger)[1];
                if (after && after.trim().length > 0) {
                    raw = after.trim();
                    break;
                }
            }
        }

        // 2. Fallback: use entire transcript
        if (!raw) raw = transcript;

        // 3. Strip filler/article words
        const words = raw.split(/\s+/).filter(w => !STRIP_WORDS.has(w));
        raw = words.join(' ').trim();

        if (!raw) return null;

        // 4. Synonym map: try full phrase, then last word, then first word
        return this._synonym(raw)
            || this._synonym(words[words.length - 1])
            || this._synonym(words[0])
            || raw; // pass through — NavigationEngine does fuzzy matching
    }

    /** Apply synonym map to a single word or phrase. */
    _synonym(word) {
        if (!word) return null;
        return SYNONYMS[word.toLowerCase()] || null;
    }
}
