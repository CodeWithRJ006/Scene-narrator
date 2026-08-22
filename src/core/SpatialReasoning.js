/**
 * SpatialReasoning.js – Spatial hazard classification with pinhole optical distance calculation.
 *
 * Distance Model:
 *   Distance (m) = (RealObjectHeight_m * FocalLength_px) / BBoxHeight_px
 *   FocalLength_px ≈ frameHeight
 */

export const TIER = { HAZARD: 1, CAUTION: 2, BG: 3 };

/** Height heuristics for pinhole distance calculation */
const REAL_HEIGHTS = {
    person: 1.7,
    bicycle: 1.1,
    car: 1.5, vehicle: 1.5, truck: 2.4, bus: 3.0, motorcycle: 1.2,
    chair: 0.85, bench: 0.85,
    dog: 0.5, cat: 0.3,
    bottle: 0.25, cup: 0.25,
    suitcase: 0.7, backpack: 0.55, handbag: 0.35,
    'traffic light': 0.6, 'stop sign': 0.75, 'fire hydrant': 0.6,
    'potted plant': 0.5,
    default: 1.0
};

export class SpatialReasoning {
    /**
     * @param {number} w – Frame width in pixels.
     * @param {number} h – Frame height in pixels.
     */
    constructor(w, h) {
        this.W = w;
        this.H = h;
        this.focalPx  = h;
        this.tracks   = new Map();
        this.nextId   = 0;
        this.COOLDOWN = 500; // hysteresis cooldown ms
    }

    /**
     * Update frame dimensions after resize.
     * @param {number} w
     * @param {number} h
     */
    resize(w, h) {
        this.W = w;
        this.H = h;
        this.focalPx = h;
    }

    /* ──────────── Distance ──────────── */

    /**
     * Pinhole Optical Distance Calculation
     * @param {string} className – Object class name.
     * @param {number} bboxHeight – Bounding box height in pixels.
     * @returns {number} Distance in meters, clamped 0.5–8.0, 1-decimal precision.
     */
    estimateDistance(className, bboxHeight) {
        const realH = REAL_HEIGHTS[className] || REAL_HEIGHTS.default;
        if (bboxHeight < 1) return 8.0;
        const d = (realH * this.focalPx) / bboxHeight;
        // Clamp output between 0.5m and 8.0m with 1-decimal precision
        return Math.round(Math.max(0.5, Math.min(8.0, d)) * 10) / 10;
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

            // Distance estimation
            const distance = this.estimateDistance(pred.className, h);
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

            // ── Tier Classification ──
            let target = TIER.BG;
            if (inCenter && (distance < 1.8 || isApproaching)) {
                // Tier 1 (Immediate Hazard): In center path AND distance < 1.8m OR approaching fast
                target = TIER.HAZARD;
            } else if ((inCenter && distance >= 1.8 && distance <= 3.5) || (!inCenter && distance < 3.5)) {
                // Tier 2 (Caution): In center path 1.8m–3.5m or flanking lateral paths (< 3.5m)
                target = TIER.CAUTION;
            } else {
                // Tier 3 (Context): >3.5m or static peripheral objects
                target = TIER.BG;
            }

            // Hysteresis: instant upgrade, delayed downgrade
            if (target < tr.tier) {
                tr.tier = target;
                tr.lastChange = now;
            } else if (target > tr.tier && now - tr.lastChange >= this.COOLDOWN) {
                tr.tier = target;
                tr.lastChange = now;
            }

            // Priority label for HUD badge
            let prioLabel = 'LOW';
            if (tr.tier === TIER.HAZARD)       prioLabel = 'HIGH PRIORITY';
            else if (tr.tier === TIER.CAUTION) prioLabel = 'CAUTION';

            // Attach results to prediction
            pred.urgencyTier   = tr.tier;
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
