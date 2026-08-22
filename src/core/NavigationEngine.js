export class NavigationEngine {
  constructor(speechSynth) {
    this.activeTarget = null;
    this.speech = speechSynth;
    this.lastNavTime = 0;
  }

  setTarget(targetName) {
    this.activeTarget = targetName.toLowerCase();
    this.speech.speakT1(`Target lock: ${this.activeTarget}. Pan camera slowly.`);
  }

  update(detections, frameWidth) {
    if (!this.activeTarget) return;
    const now = Date.now();
    if (now - this.lastNavTime < 2500) return; // Throttle to 2.5s

    const matches = detections.filter(d => 
      d.class.toLowerCase().includes(this.activeTarget) || 
      this.activeTarget.includes(d.class.toLowerCase())
    );

    if (matches.length === 0) return;

    if (matches.length > 1) {
      matches.sort((a, b) => a.distance - b.distance);
      this.speech.speakT2(`Multiple ${this.activeTarget}s. Closest is ${matches[0].distance.toFixed(1)} meters.`);
      this.lastNavTime = now;
      return;
    }

    const target = matches[0];
    const centerX = target.bbox[0] + (target.bbox[2] / 2);
    const pos = centerX / frameWidth;

    if (pos < 0.35) {
      this.speech.speakT2(`${this.activeTarget} on your left. Turn left.`);
    } else if (pos > 0.65) {
      this.speech.speakT2(`${this.activeTarget} on your right. Turn right.`);
    } else {
      this.speech.speakT2(`${this.activeTarget} ahead, ${target.distance.toFixed(1)} meters. Proceed.`);
    }
    this.lastNavTime = now;
  }
}
