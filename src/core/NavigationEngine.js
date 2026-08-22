/**
 * NavigationEngine.js - Visual Servoing / Target Lock for Active Wayfinding
 */

export class NavigationEngine {
    constructor(speech) {
        this.speech = speech;
        this.activeTarget = null;
        this.lastNavInstruction = 0;
    }

    setTarget(targetName) {
        this.activeTarget = targetName.toLowerCase();
        this.speech.speakT1(`Target lock engaged. Scanning for ${this.activeTarget}.`);
        this._updateRadarUI(`Scanning: ${this.activeTarget.toUpperCase()}`);
    }

    clearTarget() {
        this.activeTarget = null;
        this._updateRadarUI('Radar Idle');
    }

    process(predictions) {
        if (!this.activeTarget) return;

        // 1. Filter for the requested target
        const matches = predictions.filter(p => p.className.toLowerCase() === this.activeTarget);

        if (matches.length === 0) return;

        // 2. Multiple target handling: Sort by closest distance
        matches.sort((a, b) => a.distance - b.distance);
        const bestMatch = matches[0];
        
        const now = performance.now();
        
        // Rate-limit navigation instructions so we don't spam the user
        // Allow faster updates if distance is very close
        const throttleDelay = bestMatch.distance < 2.0 ? 3000 : 5000;
        
        if (now - this.lastNavInstruction > throttleDelay) {
            this.lastNavInstruction = now;

            const [x, y, w, h] = bestMatch.bbox;
            const cx = x + w / 2;
            const dist = bestMatch.distance.toFixed(1);

            // Determine steering
            let steering = "Walk Forward";
            let lateral = "ahead";
            if (bestMatch.lateral === 'left') {
                steering = "Turn Left";
                lateral = "on your left";
            } else if (bestMatch.lateral === 'right') {
                steering = "Turn Right";
                lateral = "on your right";
            }

            // Construct instruction
            let instruction = "";
            if (matches.length > 1) {
                instruction = `${matches.length} ${this.activeTarget}s found. Closest is ${dist} meters ${lateral}. ${steering}.`;
            } else {
                instruction = `${this.activeTarget} is ${dist} meters ${lateral}. ${steering}.`;
            }

            // Speak instruction (Tier 2 so it doesn't override hazards)
            this.speech.speakT2(instruction);
            
            // Update UI
            this._updateRadarUI(`LOCKED: ${this.activeTarget.toUpperCase()} | ${dist}m | ${steering.toUpperCase()}`, true);
        }
    }

    _updateRadarUI(text, isLocked = false) {
        const radar = document.getElementById('target-radar');
        if (radar) {
            radar.textContent = text;
            if (isLocked) {
                radar.classList.add('radar-locked');
                radar.classList.remove('radar-scanning');
            } else {
                radar.classList.add('radar-scanning');
                radar.classList.remove('radar-locked');
            }
        }
    }
}
