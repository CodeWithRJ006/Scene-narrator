export class NavigationEngine {
  constructor(speechSynth) {
    this.activeTarget = null;
    this.speech = speechSynth;
    this.lastNavTime = 0;
  }

  setTarget(targetName) {
    this.activeTarget = targetName.toLowerCase();
    // Adjusted speakTier1 to speakT1 to match our SpeechSynthesizer API
    this.speech.speakT1(`Target lock engaged for: ${this.activeTarget}. Please pan camera slowly.`);
  }

  clearTarget() {
    this.activeTarget = null;
    this.speech.speakT1("Target lock disengaged.");
  }

  update(detections, frameWidth) {
    if (!this.activeTarget) return;

    const now = Date.now();
    if (now - this.lastNavTime < 2500) return; // Throttled steering commands (2.5s)

    // Filter detections matching the target (fuzzy match)
    const matches = detections.filter(d => 
      d.class.toLowerCase().includes(this.activeTarget) || 
      this.activeTarget.includes(d.class.toLowerCase())
    );

    if (matches.length === 0) return;

    // Handle multiple targets
    if (matches.length > 1) {
      matches.sort((a, b) => a.distance - b.distance); // Sort by closest
      // Adjusted speakTier2 -> speakT2 and applied toFixed(1) for natural speech
      this.speech.speakT2(`Multiple ${this.activeTarget}s detected. Closest is ${matches[0].distance.toFixed(1)} meters away.`);
      this.lastNavTime = now;
      return;
    }

    // Single Target Steering Logic
    const target = matches[0];
    const centerX = target.bbox[0] + (target.bbox[2] / 2);
    const screenPosition = centerX / frameWidth; // 0.0 (left) to 1.0 (right)

    let instruction = "";
    if (screenPosition < 0.35) {
      instruction = `${this.activeTarget} on your left. Turn left.`;
    } else if (screenPosition > 0.65) {
      instruction = `${this.activeTarget} on your right. Turn right.`;
    } else {
      instruction = `${this.activeTarget} directly ahead, ${target.distance.toFixed(1)} meters. Proceed forward.`;
    }

    this.speech.speakT2(instruction);
    this.lastNavTime = now;
  }
}
