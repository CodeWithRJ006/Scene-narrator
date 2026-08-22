/**
 * SpatialReasoning.js – Spatial hazard classification with pinhole optical distance calculation.
 *
 * Distance Model:
 *   Distance (m) = (RealObjectHeight_m * FocalLength_px) / max(BBoxWidth, BBoxHeight)
 *   FocalLength_px dynamically adjusted for Desktop vs Mobile FOV.
 */

export const TIER = { HAZARD: 1, CAUTION: 2, BG: 3 };

/** Comprehensive Size Dictionary (Real-world heights in meters) */
const REAL_HEIGHTS = {
    person: 1.70, car: 1.50, motorcycle: 1.00, airplane: 10.0, bus: 3.00, train: 3.00, truck: 2.50, boat: 2.00,
    'traffic light': 0.80, 'fire hydrant': 0.60, 'stop sign': 0.80, 'parking meter': 1.20, bench: 0.90,
    bird: 0.20, cat: 0.30, dog: 0.50, horse: 1.50, sheep: 1.00, cow: 1.40, elephant: 3.00, bear: 1.00, zebra: 1.40, giraffe: 4.00,
    backpack: 0.40, umbrella: 1.00, handbag: 0.30, tie: 0.40, suitcase: 0.60, frisbee: 0.25, skis: 1.50, snowboard: 1.50, 'sports ball': 0.22, kite: 1.00, 'baseball bat': 1.00, 'baseball glove': 0.30, skateboard: 0.80, surfboard: 2.00, 'tennis racket': 0.70,
    bottle: 0.25, 'wine glass': 0.20, cup: 0.15, fork: 0.20, knife: 0.20, spoon: 0.15, bowl: 0.15,
    banana: 0.20, apple: 0.08, sandwich: 0.15, orange: 0.08, broccoli: 0.15, carrot: 0.15, 'hot dog': 0.15, pizza: 0.30, donut: 0.10, cake: 0.20,
    chair: 0.85, couch: 0.90, 'potted plant': 0.50, bed: 0.60, 'dining table': 0.80, toilet: 0.40, tv: 0.60, laptop: 0.30, mouse: 0.10, remote: 0.20, keyboard: 0.15, 'cell phone': 0.15, phone: 0.15, microwave: 0.30, oven: 0.80, toaster: 0.20, sink: 0.20, refrigerator: 1.80, book: 0.20, clock: 0.30, vase: 0.30, scissors: 0.15, 'teddy bear': 0.40, 'hair drier': 0.20, toothbrush: 0.15,
    watch: 0.15, glasses: 0.15, specs: 0.15, earbuds: 0.15, earphones: 0.15, keys: 0.08,
    fallback_default: 0.40, default: 0.40
};

export class SpatialReasoning {
    /**
     * @param {number} w – Frame width in pixels.
     * @param {number} h – Frame height in pixels.
     */
    constructor(w, h) {
        this.W = w;
        this.H = h;
        this._updateFocalLength();
        this.tracks   = new Map();
        this.nextId   = 0;
        this.COOLDOWN = 500; // hysteresis cooldown ms
    }

    /**
     * Update frame dimensions and dynamic focal length after resize.
     * @param {number} w
     * @param {number} h
     */
    resize(w, h) {
        this.W = w;
        this.H = h;
        this._updateFocalLength();
    }

    /** @private Update focal length based on Desktop vs Mobile FOV. */
    _updateFocalLength() {
        const isDesktop = window.innerWidth > window.innerHeight;
        this.focalPx = isDesktop ? 600 : 800;
    }

    /* ──────────── Distance ──────────── */

    /**
     * Pinhole Optical Distance Calculation
     * 
     * MATH: Distance = (RealHeight * FocalLength) / BoundingBoxHeight
     * ASSUMPTIONS:
     * - Relies on `REAL_HEIGHTS` averages (e.g., assumes ALL people are exactly 1.7m tall).
     * - Assumes the object is fully visible and not severely occluded (seeing only half a person doubles the calculated distance).
     * - Assumes the camera is perpendicular to the object (extreme high/low angles compress the bounding box, creating false distance).
     * - Uses `max(w, h)` to prevent catastrophic failure if an object (like a phone) is held horizontally.
     * 
     * @param {string} className – Object class name.
     * @param {number} bboxWidth – Bounding box width in pixels.
     * @param {number} bboxHeight – Bounding box height in pixels.
     * @returns {number} Distance in meters, clamped 0.2–8.0. (Known to degrade exponentially beyond 5m).
     */
    estimateDistance(className, bboxWidth, bboxHeight) {
        const realH = REAL_HEIGHTS[className] || REAL_HEIGHTS.fallback_default;
        const maxDim = Math.max(bboxWidth, bboxHeight);
        if (maxDim < 1) return 8.0;
        
        const d = (realH * this.focalPx) / maxDim;
        // Clamp output between 0.2m (to allow close items) and 8.0m with 1-decimal precision
        return Math.round(Math.max(0.2, Math.min(8.0, d)) * 10) / 10;
    }

    /* ──────────── Spatial / Lateral Position ──────────── */

    /**
     * Determine lateral position relative to walking path.
     * Center walking cone is Middle 40% of frame width (0.30 * W to 0.70 * W).
     * @param {number} cx – Object center-x in pixels.
     * @returns {'left' | 'ahead' | 'right'}
     */
    lateralPosition(cx) {
        const norm = cx / this.W;
        if (norm < 0.30) return 'left';
        if (norm > 0.70) return 'right';
        return 'ahead';
    }

    /* ──────────── Main Processing ──────────── */

    /**
     * Process raw detection predictions: assign tracks, compute distances, urgency tiers.
     * @param {Array} predictions – Raw detection results from EdgeDetector.
     * @returns {Array} Augmented predictions with trackId, distance, urgencyTier, etc.
     */
    process(predictions) {
        const now  = performance.now();
        const used = new Set();

        for (const pred of predictions) {
            // ── Match to existing track ──
            let bestId = null, bestIoU = 0.25;
            for (const [id, tr] of this.tracks) {
                if (used.has(id) || tr.cls !== pred.className) continue;
                const iou = this._iou(pred.bbox, tr.bbox);
                if (iou > bestIoU) { bestIoU = iou; bestId = id; }
            }

            let tr;
            if (bestId !== null) {
                tr = this.tracks.get(bestId);
                used.add(bestId);
            } else {
                const id = this.nextId++;
                tr = { id, cls: pred.className, history: [], tier: TIER.BG, lastChange: now };
                this.tracks.set(id, tr);
                used.add(id);
            }

            const [x, y, w, h] = pred.bbox;
            const cx   = x + w / 2;
            const area = w * h;

            // Distance estimation (using max dim)
            const distance = this.estimateDistance(pred.className, w, h);
            pred.distance = distance;

            // Lateral tag
            const lateral = this.lateralPosition(cx);
            pred.lateral = lateral;

            // Track history for approach detection
            tr.bbox = pred.bbox;
            tr.history.push({ t: now, cx, cy: y + h / 2, area, distance });
            if (tr.history.length > 30) tr.history.shift();

            // ── Approach Detection ──
            let isApproaching = false;
            if (tr.history.length > 2) {
                const old = tr.history[0];
                const dt = now - old.t;
                if (dt > 80) {
                    const growthPer300 = ((area - old.area) / Math.max(old.area, 1)) * (300 / dt);
                    isApproaching = growthPer300 > 0.15; // Approaching fast (>15% area growth per 300ms)
                    tr.growthRate = growthPer300;
                }
            }

            // ── Center Cone ──
            const inCenter = cx > this.W * 0.30 && cx < this.W * 0.70;
            const hDist = this.hazardDistance || 1.8;
            const cDist = hDist * 1.94; // roughly 3.5m when hDist is 1.8

            // ── Tier Classification with Distance Hysteresis ──
            let target = TIER.BG;
            const isGadget = ['cell phone', 'phone', 'watch', 'clock', 'glasses', 'specs', 'earbuds', 'earphones', 'keys', 'mouse'].includes(pred.className);
            
            // Expand thresholds slightly if already in that tier (Hysteresis)
            const hazardThreshold = (tr.tier === TIER.HAZARD) ? (hDist + 0.25) : hDist;
            const cautionThreshold = (tr.tier === TIER.CAUTION) ? (cDist + 0.4) : cDist;

            if (inCenter && (distance < hazardThreshold || isApproaching)) {
                target = TIER.HAZARD;
            } else if (isGadget && distance < 0.8) {
                target = TIER.HAZARD;
            } else if ((inCenter && distance <= cautionThreshold) || (!inCenter && distance < cautionThreshold)) {
                target = TIER.CAUTION;
            } else {
                target = TIER.BG;
            }

            // Hysteresis: instant upgrade, delayed downgrade (time-based)
            if (target < tr.tier) {
                tr.tier = target;
                tr.lastChange = now;
            } else if (target > tr.tier && now - tr.lastChange >= this.COOLDOWN) {
                tr.tier = target;
                tr.lastChange = now;
            }

            pred.urgencyTier = tr.tier;
            pred.trackId = tr.id;
            
            // Debouncing: Track must persist for at least 3 frames before it is "mature" and allowed to speak
            pred.isMature = tr.history.length >= 3;
            let prioLabel = 'LOW';
            if (tr.tier === TIER.HAZARD)       prioLabel = 'HIGH PRIORITY';
            else if (tr.tier === TIER.CAUTION) prioLabel = 'CAUTION';

            // Attach results to prediction
            pred.trackId       = tr.id;
            pred.priorityLabel = prioLabel;
            pred.isApproaching = isApproaching;
        }

        // Prune stale tracks (>600 ms unseen)
        for (const [id, tr] of this.tracks) {
            if (!used.has(id)) {
                const last = tr.history[tr.history.length - 1];
                if (now - last.t > 600) this.tracks.delete(id);
            }
        }

        return predictions;
    }

    /**
     * Return the highest (most urgent) tier across all active tracks.
     * @returns {number} TIER.HAZARD (1), TIER.CAUTION (2), or TIER.BG (3).
     */
    highestTier() {
        let best = TIER.BG;
        for (const [, tr] of this.tracks) {
            if (tr.tier < best) best = tr.tier;
        }
        return best;
    }

    /** @private IoU for bbox matching. */
    _iou(a, b) {
        const [ax, ay, aw, ah] = a;
        const [bx, by, bw, bh] = b;
        const x1 = Math.max(ax, bx), y1 = Math.max(ay, by);
        const x2 = Math.min(ax + aw, bx + bw), y2 = Math.min(ay + ah, by + bh);
        if (x2 <= x1 || y2 <= y1) return 0;
        const i = (x2 - x1) * (y2 - y1);
        return i / (aw * ah + bw * bh - i);
    }
}
