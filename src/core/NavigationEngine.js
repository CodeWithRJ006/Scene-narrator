/**
 * NavigationEngine.js – Google Maps-style Walking Navigation for Blind Users.
 *
 * ═══════════════════════════════════════════════════════════════════
 *  STATE MACHINE
 * ═══════════════════════════════════════════════════════════════════
 *
 *   IDLE
 *     │  startTargetNavigation(target)  [or legacy setTarget()]
 *     ▼
 *   SEARCHING  → "Searching for [target]. Pan camera slowly."
 *     │  target detected in frame → locks onto closest-to-center instance ID
 *     ▼
 *   NAVIGATING → Continuous guidance every ~2.2s (strict routing):
 *     │            - Direction: "Turn left to face X." / "Walk straight ahead."
 *     │            - Distance: "3.2 meters to [target]"
 *     │            - Obstacle dodge (independent 2.5s cooldown, anti-spam per trackId)
 *     │            - Milestone every 0.5m reduction
 *     │            - "Almost there!" at 85% progress
 *     │  target ID lost for > 3.5s
 *     │    → SEARCHING  (with "Lost sight of [target], pan camera")
 *     │  distance ≤ 0.9m
 *     ▼
 *   ARRIVED    → "You've reached the [target]!"
 *     │  auto-reset after 4s
 *     ▼
 *   IDLE
 */

export class NavigationEngine {

    /** Navigation states */
    static STATE = {
        IDLE:       'idle',
        SEARCHING:  'searching',
        NAVIGATING: 'navigating',
        ARRIVED:    'arrived',
    };

    constructor(speechSynth) {
        this.speech = speechSynth;

        // ── State ──
        this.state          = NavigationEngine.STATE.IDLE;
        this.target         = null;   // target class name (lowercase)
        this.targetFriendly = null;   // display name (title-cased)
        this.lockedTrackId  = null;   // specific instance we are tracking

        // ── Navigation tracking ──
        this.startDistance    = null; // distance when navigation began (for % progress)
        this.lastDistance     = null; // distance at last announcement
        this.lastSeenTime     = 0;    // timestamp when target was last detected
        this.lastSpeakTime    = 0;    // timestamp of last navigation instruction
        this.lastObstTime     = 0;    // timestamp of last obstacle instruction
        this.searchStart      = 0;    // when SEARCHING state began
        this.arrivedTimer     = null; // setTimeout handle for ARRIVED→IDLE reset

        // ── Anti-spam (stationary obstacles) ──
        this.warnedObstacles  = new Map(); // trackId → { count, distance }

        // ── Walk-only obstacle-avoidance mode ──
        this.navModeActive  = false;
        this.wasBlocked     = false;
        this.lastWalkTime   = 0;
        this.lastBlockTime  = 0;

        // ── Legacy compat ──
        this.onArrival      = null;   // optional external callback (kept for compat)

        // ── Thresholds ──
        this.ARRIVED_DIST        = 0.9;    // m — close enough = arrived
        this.PATH_BLOCK_DIST     = 3.0;    // m — obstacle this close blocks the path
        this.SEARCH_TIMEOUT      = 15000;  // ms — fallback "still searching" reminder
        this.LOST_TIMEOUT        = 3500;   // ms — target lost if not seen for this long
        this.NAV_SPEAK_COOLDOWN  = 2200;   // ms — min gap between navigation instructions
        this.OBST_SPEAK_COOLDOWN = 2500;   // ms — min gap between obstacle instructions
        this.WALK_COOLDOWN       = 4000;   // ms — min gap between walk-mode clear announcements
    }

    /* ══════════════════════════════════════════════════════════
       PUBLIC API
    ══════════════════════════════════════════════════════════ */

    /**
     * Start navigating to a specific target object.
     * Transitions to SEARCHING state.
     * @param {string} targetName – e.g. "tv", "chair", "person"
     */
    startTargetNavigation(targetName) {
        if (this.arrivedTimer) { clearTimeout(this.arrivedTimer); this.arrivedTimer = null; }

        this.target         = targetName.toLowerCase().trim();
        this.targetFriendly = this._friendlyLabel(this.target);
        this.state          = NavigationEngine.STATE.SEARCHING;
        this.lockedTrackId  = null;
        this.startDistance  = null;
        this.lastDistance   = null;
        this.lastSeenTime   = 0;
        this.searchStart    = Date.now();
        this.lastSpeakTime  = 0;
        this.warnedObstacles.clear();

        this.speech.speakT1(`Searching for ${this.targetFriendly}.`);

        // 2s hint: pan camera slowly
        setTimeout(() => {
            if (this.state === NavigationEngine.STATE.SEARCHING) {
                this.speech.speakT2(`Pan camera slowly to find it.`);
            }
        }, 2000);

        // 15s fallback: still searching reminder
        setTimeout(() => {
            if (this.state === NavigationEngine.STATE.SEARCHING) {
                this.speech.speakT2(`Still searching for ${this.targetFriendly}. Keep panning.`);
            }
        }, this.SEARCH_TIMEOUT);
    }

    /**
     * Legacy alias — preserves backward compatibility with old App.js callback.
     * @param {string} targetName
     */
    setTarget(targetName) {
        this.startTargetNavigation(targetName);
    }

    /**
     * Cancel current navigation and return to IDLE.
     */
    cancelNavigation() {
        if (this.arrivedTimer) { clearTimeout(this.arrivedTimer); this.arrivedTimer = null; }
        const wasActive = this.state !== NavigationEngine.STATE.IDLE;
        this.state          = NavigationEngine.STATE.IDLE;
        this.target         = null;
        this.targetFriendly = null;
        this.lockedTrackId  = null;
        this.startDistance  = null;
        this.lastDistance   = null;
        this.warnedObstacles.clear();
        if (wasActive) this.speech.speakT2('Navigation cancelled.');
    }

    /** Start walking-only obstacle avoidance mode (no target). */
    startNavMode() {
        this.navModeActive = true;
        this.wasBlocked    = false;
        this.lastWalkTime  = 0;
        this.speech.speakT1('Navigation mode on. Walking guidance active. Point camera forward.');
    }

    /** Stop walking-only obstacle avoidance mode. */
    stopNavMode() {
        this.navModeActive = false;
        this.speech.speakT2('Navigation mode off.');
    }

    /** Is walk mode active? */
    get isNavActive() { return this.navModeActive; }

    /** Current active target name (for HUD display). */
    get activeTarget() { return this.target; }

    /** Current navigation state string (one of NavigationEngine.STATE values). */
    get navState() { return this.state; }

    /* ══════════════════════════════════════════════════════════
       MASTER UPDATE — called every inference frame from App.js
    ══════════════════════════════════════════════════════════ */

    /**
     * Process detections and emit navigation instructions.
     * @param {Array}  detections  – Augmented preds from SpatialReasoning
     * @param {number} frameWidth  – Video frame width in pixels
     */
    update(detections, frameWidth) {
        // Target navigation takes priority
        if (this.target && this.state !== NavigationEngine.STATE.IDLE) {
            this._runTargetNavigation(detections, frameWidth);
        }

        // Walk-mode obstacle avoidance (independent of target nav)
        if (this.navModeActive) {
            this._runWalkingMode(detections, frameWidth);
        }
    }

    /* ══════════════════════════════════════════════════════════
       TARGET NAVIGATION LOGIC
    ══════════════════════════════════════════════════════════ */

    /** @private */
    _runTargetNavigation(detections, frameWidth) {
        const now = Date.now();

        // ── SEARCHING state ──
        if (this.state === NavigationEngine.STATE.SEARCHING) {
            const matches = detections.filter(d => this._matchesTarget(d));

            if (matches.length > 0) {
                // Lock onto instance closest to frame center (user is pointing at it)
                matches.sort((a, b) => {
                    const cxA = a.bbox[0] + a.bbox[2] / 2;
                    const cxB = b.bbox[0] + b.bbox[2] / 2;
                    return Math.abs(cxA - frameWidth / 2) - Math.abs(cxB - frameWidth / 2);
                });

                const best = matches[0];
                this.lockedTrackId = best.trackId; // LOCK acquired
                this.startDistance = best.distance;
                this.lastDistance  = best.distance;
                this.lastSeenTime  = now;
                this.state         = NavigationEngine.STATE.NAVIGATING;

                const dir = this._directionPhrase(best, frameWidth);
                this.speech.speakT1(`${this.targetFriendly} found! ${(best.distance || 0).toFixed(1)} meters ${dir}.`);
                this.lastSpeakTime = now;
            }
            return;
        }

        // ── NAVIGATING state ──
        if (this.state === NavigationEngine.STATE.NAVIGATING) {
            // Primary lookup: by locked trackId
            let active = detections.find(d => d.trackId === this.lockedTrackId);

            // Fallback: tracker may have re-assigned the ID — recover without SEARCHING bounce
            if (!active) {
                const matches = detections.filter(d => this._matchesTarget(d));
                if (matches.length > 0) {
                    active = this._closestDetection(matches);
                    this.lockedTrackId = active.trackId; // re-lock
                }
            }

            if (active) {
                this.lastSeenTime = now;

                // ── ARRIVED? ──
                if ((active.distance || 99) <= this.ARRIVED_DIST) {
                    this._triggerArrived();
                    return;
                }

                // ── Obstacle avoidance (strictly between user and target) ──
                this._checkObstaclesDuringNav(detections, active, frameWidth, now);

                // ── Navigation instruction (throttled) ──
                if (now - this.lastSpeakTime >= this.NAV_SPEAK_COOLDOWN) {
                    this._speakNavigationStep(active, frameWidth, now);
                }

            } else {
                // Target not detected — wait for LOST_TIMEOUT before giving up
                if (now - this.lastSeenTime > this.LOST_TIMEOUT) {
                    this.state = NavigationEngine.STATE.SEARCHING;
                    this.lockedTrackId = null;
                    this.searchStart = now;
                    this.speech.speakT1(`Lost sight of ${this.targetFriendly}. Pan camera to find it again.`);
                    this.lastSpeakTime = now;
                }
                // Within LOST_TIMEOUT → wait silently; avoid spamming
            }
        }
    }

    /** @private Speak a Google Maps-style navigation instruction. */
    _speakNavigationStep(target, frameWidth, now) {
        const dist = target.distance || 0;
        const [x, , w] = target.bbox;
        const norm = (x + w / 2) / frameWidth;
        const dir  = this._directionPhrase(target, frameWidth);

        const progress = this._progress();
        let instruction;

        if (norm < 0.35) {
            instruction = `Turn left to face ${this.targetFriendly}. ${dist.toFixed(1)} meters.`;
        } else if (norm > 0.65) {
            instruction = `Turn right to face ${this.targetFriendly}. ${dist.toFixed(1)} meters.`;
        } else {
            instruction = `Walk straight ahead. ${dist.toFixed(1)} meters to ${this.targetFriendly}.`;
        }

        // Override with "almost there" at 85% progress
        if (progress >= 0.85 && this.lastDistance !== null && this.lastDistance - dist > 0.1) {
            instruction = `Almost there! ${dist.toFixed(1)} meters ahead.`;
        }

        // Milestone trigger: every 0.5m reduction in distance
        const milestoneReached = this.lastDistance !== null &&
            (Math.floor(this.lastDistance * 2) > Math.floor(dist * 2));

        if (milestoneReached || now - this.lastSpeakTime >= this.NAV_SPEAK_COOLDOWN) {
            // "Walk straight" uses T2 (non-interrupting) — doesn't stomp hazard alerts
            // Turn commands and milestones use T1 (barge-in)
            if (norm >= 0.35 && norm <= 0.65 && !milestoneReached) {
                this.speech.speakT2(instruction, `nav_${this.target}`);
            } else {
                this.speech.speakT1(instruction, `nav_${this.target}`);
            }
            this.lastSpeakTime = now;
            this.lastDistance  = dist;
        }
    }

    /** @private Check for obstacles strictly blocking the corridor to the target. */
    _checkObstaclesDuringNav(detections, target, frameWidth, now) {
        if (now - this.lastObstTime < this.OBST_SPEAK_COOLDOWN) return;

        const [tx, , tw] = target.bbox;
        const tNorm = (tx + tw / 2) / frameWidth;
        const tDist = target.distance || 99;

        const obstacles = detections.filter(d => {
            if (d.trackId === target.trackId) return false;
            if (d.distance === undefined || d.distance >= (tDist - 0.3)) return false;
            if (d.distance > this.PATH_BLOCK_DIST) return false;
            const [x, , w] = d.bbox;
            const oNorm = (x + w / 2) / frameWidth;
            const pathMin = Math.min(0.40, tNorm - 0.15);
            const pathMax = Math.max(0.60, tNorm + 0.15);
            return oNorm >= pathMin && oNorm <= pathMax;
        });

        if (obstacles.length === 0) return;

        obstacles.sort((a, b) => a.distance - b.distance);
        const blocker = obstacles[0];

        // Anti-spam: warned ≥ 2 times about same stationary obstacle → skip
        const warnInfo = this.warnedObstacles.get(blocker.trackId) || { count: 0, distance: 99 };
        if (warnInfo.count >= 2 && Math.abs(warnInfo.distance - blocker.distance) < 0.4) return;

        const [x, , w] = blocker.bbox;
        const pos   = (x + w / 2) / frameWidth;
        const dodge = pos < 0.5
            ? `Obstacle in path, step right to route around.`
            : `Obstacle in path, step left to route around.`;

        this.speech.speakT1(dodge, `obst_${blocker.trackId}`);
        this.lastObstTime = now;
        this.warnedObstacles.set(blocker.trackId, {
            count:    warnInfo.count + 1,
            distance: blocker.distance,
        });
    }

    /** @private Transition to ARRIVED state; self-resets to IDLE after 4s. */
    _triggerArrived() {
        this.state = NavigationEngine.STATE.ARRIVED;
        this.speech.speakT1(`You've reached the ${this.targetFriendly}!`);

        this.arrivedTimer = setTimeout(() => {
            this.state          = NavigationEngine.STATE.IDLE;
            this.target         = null;
            this.targetFriendly = null;
            this.lockedTrackId  = null;
            this.arrivedTimer   = null;
            if (this.onArrival) this.onArrival(); // fire legacy callback after arrived display finishes
        }, 4000);
    }

    /* ══════════════════════════════════════════════════════════
       WALKING MODE (obstacle avoidance only, no target)
    ══════════════════════════════════════════════════════════ */

    /** @private */
    _runWalkingMode(detections, frameWidth) {
        const now = Date.now();

        const LEFT_BOUND  = frameWidth * 0.30;
        const RIGHT_BOUND = frameWidth * 0.70;
        const WALK_BLOCK  = 2.8;

        const nearby = detections.filter(d => d.distance !== undefined && d.distance <= WALK_BLOCK);

        const inZone = (pred, fromX, toX) => {
            const [x, , w] = pred.bbox;
            const cx = x + w / 2;
            return cx >= fromX && cx < toX;
        };

        const centerBlock = nearby.filter(d => inZone(d, LEFT_BOUND, RIGHT_BOUND));
        const leftBlock   = nearby.filter(d => inZone(d, 0, LEFT_BOUND));
        const rightBlock  = nearby.filter(d => inZone(d, RIGHT_BOUND, frameWidth));

        const centerClear = centerBlock.length === 0;
        const leftClear   = leftBlock.length === 0;
        const rightClear  = rightBlock.length === 0;

        // Fast-approaching object — top priority
        const rushing = centerBlock.find(d => d.isApproaching && d.distance < 2.0);
        if (rushing) {
            if (now - this.lastBlockTime >= this.OBST_SPEAK_COOLDOWN) {
                this.speech.speakT1('Warning — object approaching fast. Slow down!');
                this.lastBlockTime = now;
                this.wasBlocked    = true;
            }
            return;
        }

        if (centerClear) {
            if (this.wasBlocked) {
                this.speech.speakT2('Path now clear. Continue straight.');
                this.lastWalkTime = now;
                this.wasBlocked   = false;
                return;
            }
            if (now - this.lastWalkTime >= this.WALK_COOLDOWN) {
                this.speech.speakT2('Path clear. Continue straight.');
                this.lastWalkTime = now;
            }
            return;
        }

        this.wasBlocked = true;
        if (now - this.lastBlockTime < this.OBST_SPEAK_COOLDOWN) return;

        centerBlock.sort((a, b) => a.distance - b.distance);
        const closest = centerBlock[0];

        const warnInfo = this.warnedObstacles.get(closest.trackId) || { count: 0, distance: 99 };
        if (warnInfo.count >= 2 && Math.abs(warnInfo.distance - closest.distance) < 0.4) {
            this.lastBlockTime = now;
            return;
        }

        const name = this._friendlyLabel(closest.className || closest.class || 'obstacle');
        const dist = (closest.distance || 0).toFixed(1);

        if (rightClear && leftClear) {
            this.speech.speakT1(`${name} ${dist} meters ahead — step slightly right, then continue.`);
        } else if (rightClear) {
            this.speech.speakT1(`${name} ${dist} meters ahead — move right to avoid.`);
        } else if (leftClear) {
            this.speech.speakT1(`${name} ${dist} meters ahead — move left to avoid.`);
        } else {
            this.speech.speakT1('Path blocked on all sides. Please stop and wait.');
        }

        this.lastBlockTime = now;
        this.warnedObstacles.set(closest.trackId, {
            count:    warnInfo.count + 1,
            distance: closest.distance,
        });
    }

    /* ══════════════════════════════════════════════════════════
       HELPERS
    ══════════════════════════════════════════════════════════ */

    /**
     * @private Does a detection match our current target?
     * Reads both `className` (SpatialReasoning output) and `class` (raw COCO-SSD) for safety.
     */
    _matchesTarget(d) {
        if (!this.target) return false;
        const cn = (d.className || d.class || '').toLowerCase();
        const tg = this.target.toLowerCase();
        return cn === tg || cn.includes(tg) || tg.includes(cn);
    }

    /** @private Closest detection by distance. */
    _closestDetection(detections) {
        return detections.reduce((best, d) =>
            (d.distance ?? 99) < (best.distance ?? 99) ? d : best
        );
    }

    /**
     * @private Build a 5-zone direction phrase from the detection's lateral position.
     */
    _directionPhrase(detection, frameWidth) {
        const [x, , w] = detection.bbox;
        const norm = (x + w / 2) / frameWidth;
        if (norm < 0.22) return 'to your far left';
        if (norm < 0.40) return 'to your left';
        if (norm > 0.78) return 'to your far right';
        if (norm > 0.60) return 'to your right';
        return 'ahead';
    }

    /** @private Journey completion ratio (0–1). */
    _progress() {
        if (!this.startDistance || !this.lastDistance) return 0;
        if (this.startDistance <= this.ARRIVED_DIST) return 1;
        const pct = 1 - (this.lastDistance - this.ARRIVED_DIST) / (this.startDistance - this.ARRIVED_DIST);
        return Math.max(0, Math.min(1, pct));
    }

    /** @private Title-case a class name for speech. */
    _friendlyLabel(name) {
        if (!name) return 'object';
        return name.charAt(0).toUpperCase() + name.slice(1);
    }
}
