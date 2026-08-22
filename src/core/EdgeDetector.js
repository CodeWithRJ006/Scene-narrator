/**
 * EdgeDetector.js – Resilient object detection with COCO-SSD + instant motion fallback.
 *
 * Architecture:
 *   1. Attempt COCO-SSD load (CDN, auto-weight download).
 *   2. 3-second timeout → canvas frame-differencing motion detector as instant fallback.
 *   3. If COCO-SSD loads late, hot-swap transparently.
 *   4. AR HUD renderer with LERP smoothing, distance badges, and urgency-graded glow.
 */

export class EdgeDetector {
    /**
     * @param {string} canvasId – DOM id of the overlay <canvas>.
     */
    constructor(canvasId) {
        this.canvas = document.getElementById(canvasId);
        this.ctx    = this.canvas.getContext('2d');
        this.model  = null;
        this.useFallback = false;

        // Motion fallback internals
        this.prevFrame = null;
        this._mc = document.createElement('canvas');
        this._mx = this._mc.getContext('2d', { willReadFrequently: true });
        this.MW = 160;
        this.MH = 120;
        this._mc.width  = this.MW;
        this._mc.height = this.MH;

        // LERP tracker for smooth rendering
        this.tracked = [];
    }

    /* ─────────────────── Model Loading ─────────────────── */

    /**
     * Load COCO-SSD asynchronously without blocking the UI thread.
     * 3s timeout falls back to motion detection so the feed never freezes at 0 FPS.
     */
    async load() {
        const timeout = new Promise(r => setTimeout(() => r('TIMEOUT'), 3000));
        const ml = this._loadCoco();
        const result = await Promise.race([ml, timeout]);

        if (result === 'TIMEOUT' && !this.model) {
            console.warn('EdgeDetector: COCO-SSD timed out — lightweight motion fallback active.');
            this.useFallback = true;
            // Keep loading in background for hot-swap
            ml.then(() => {
                if (this.model) {
                    this.useFallback = false;
                    console.log('EdgeDetector: COCO-SSD late-loaded. Swapping to neural detection.');
                }
            }).catch(() => {});
        }
    }

    /** @private */
    async _loadCoco() {
        try {
            /* global cocoSsd */
            this.model = await cocoSsd.load({ base: 'lite_mobilenet_v2' });
            console.log('EdgeDetector: COCO-SSD ready.');
        } catch (e) {
            console.error('EdgeDetector: COCO-SSD failed, offline or unavailable:', e);
            this.useFallback = true;
        }
    }

    /* ─────────────────── Detection ─────────────────── */

    /**
     * Run detection on the current video frame.
     * @param {HTMLVideoElement} video
     * @returns {Promise<Array<{bbox: number[], className: string, score: number}>>}
     */
    async detect(video) {
        if (this.canvas.width !== video.videoWidth || this.canvas.height !== video.videoHeight) {
            this.canvas.width  = video.videoWidth;
            this.canvas.height = video.videoHeight;
        }

        if (this.model && !this.useFallback) {
            let raw = await this.model.detect(video);
            raw = raw.filter(d => d.score >= 0.60); // Confidence threshold >= 0.60

            // Custom NMS to prevent double detections (IoU > 0.45)
            raw = raw.sort((a, b) => b.score - a.score);
            const nms = [];
            for (const d of raw) {
                let overlap = false;
                for (const keep of nms) {
                    if (this._iou(d.bbox, keep.bbox) > 0.45) {
                        overlap = true;
                        break;
                    }
                }
                if (!overlap) nms.push(d);
            }

            return nms.map(d => ({ bbox: d.bbox, className: d.class, score: d.score })); // Normalized bounding boxes
        }
        return this._motionDetect(video);
    }

    /* ──────────── Motion Fallback ──────────── */

    /** @private Frame-difference lightweight motion detection. */
    _motionDetect(video) {
        this._mx.drawImage(video, 0, 0, this.MW, this.MH);
        const frame = this._mx.getImageData(0, 0, this.MW, this.MH);
        if (!this.prevFrame) { this.prevFrame = frame; return []; }

        const d = frame.data, p = this.prevFrame.data;
        const BLK = 16;
        const cols = (this.MW / BLK) | 0;
        const rows = (this.MH / BLK) | 0;
        const hot = [];

        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                let sum = 0, n = 0;
                for (let y = r * BLK; y < (r + 1) * BLK; y++) {
                    for (let x = c * BLK; x < (c + 1) * BLK; x++) {
                        const i = (y * this.MW + x) * 4;
                        sum += Math.abs(d[i] - p[i])
                             + Math.abs(d[i + 1] - p[i + 1])
                             + Math.abs(d[i + 2] - p[i + 2]);
                        n++;
                    }
                }
                if (sum / n > 50) hot.push({ r, c });
            }
        }
        this.prevFrame = frame;
        if (!hot.length) return [];

        const sx = video.videoWidth  / this.MW;
        const sy = video.videoHeight / this.MH;
        return this._cluster(hot).map(cl => {
            const x = cl.c0 * BLK * sx;
            const y = cl.r0 * BLK * sy;
            const w = (cl.c1 - cl.c0 + 1) * BLK * sx;
            const h = (cl.r1 - cl.r0 + 1) * BLK * sy;
            return { bbox: [x, y, w, h], className: 'motion', score: 0.5 };
        });
    }

    /** @private Flood-fill cluster connected motion blocks. */
    _cluster(blocks) {
        const vis = new Set();
        const key = (r, c) => `${r},${c}`;
        const set = new Set(blocks.map(b => key(b.r, b.c)));
        const out = [];

        for (const b of blocks) {
            const k = key(b.r, b.c);
            if (vis.has(k)) continue;
            const cl = [];
            const stk = [b];
            while (stk.length) {
                const cur = stk.pop();
                const ck = key(cur.r, cur.c);
                if (vis.has(ck)) continue;
                vis.add(ck);
                cl.push(cur);
                for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
                    const nk = key(cur.r + dr, cur.c + dc);
                    if (set.has(nk) && !vis.has(nk)) stk.push({ r: cur.r + dr, c: cur.c + dc });
                }
            }
            if (cl.length >= 2) {
                const rs = cl.map(c => c.r);
                const cs = cl.map(c => c.c);
                out.push({
                    r0: Math.min(...rs), r1: Math.max(...rs),
                    c0: Math.min(...cs), c1: Math.max(...cs)
                });
            }
        }
        return out;
    }

    /* ─────────────────── AR HUD Renderer ─────────────────── */

    /**
     * Draw AR overlay with LERP-smoothed bounding boxes, distance badges, and urgency glow.
     * @param {Array} predictions
     */
    drawHUD(predictions) {
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        const LERP = 0.35;
        const next = [];

        for (const pred of predictions) {
            let best = -1, bestIoU = 0.22;
            for (let i = 0; i < this.tracked.length; i++) {
                const t = this.tracked[i];
                if (t._used || t.className !== pred.className) continue;
                const iou = this._iou(pred.bbox, t._r);
                if (iou > bestIoU) { bestIoU = iou; best = i; }
            }
            if (best >= 0) {
                const t = this.tracked[best];
                t._used = true;
                t.bbox  = pred.bbox;
                t.score = pred.score;
                if (pred.urgencyTier   !== undefined) t.urgencyTier   = pred.urgencyTier;
                if (pred.distance      !== undefined) t.distance      = pred.distance;
                if (pred.priorityLabel !== undefined) t.priorityLabel = pred.priorityLabel;
                t.alpha = Math.min((t.alpha || 0) + 0.15, 1);
                next.push(t);
            } else {
                pred._r = [...pred.bbox];
                pred.alpha = 0.1;
                next.push(pred);
            }
        }
        this.tracked = next;

        for (const obj of this.tracked) {
            obj._used = false;
            if (!obj._r) obj._r = [...obj.bbox];
            for (let i = 0; i < 4; i++) obj._r[i] += (obj.bbox[i] - obj._r[i]) * LERP;
            obj.alpha = Math.min((obj.alpha || 0) + 0.08, 1);

            const [x, y, w, h] = obj._r;
            const tier = obj.urgencyTier || 3;
            const dist = obj.distance;

            // Distance-graded color: <1.8m red, 1.8–3.5m amber, >3.5m emerald
            let color;
            if      (dist !== undefined && dist < 1.8) color = '#ef4444';
            else if (dist !== undefined && dist < 3.5) color = '#f59e0b';
            else if (dist !== undefined)               color = '#10b981';
            else if (tier === 1)                       color = '#ef4444';
            else if (tier === 2)                       color = '#f59e0b';
            else                                       color = '#00f0ff';

            this.ctx.save();
            this.ctx.globalAlpha = obj.alpha;

            // Glow
            this.ctx.shadowColor = color;
            this.ctx.shadowBlur  = tier === 1 ? 24 : 12;
            this.ctx.strokeStyle = color;
            this.ctx.lineWidth   = tier === 1 ? 3 : 2;
            this.ctx.lineJoin    = 'round';

            // AR corner brackets
            const cl = Math.min(24, w / 4, h / 4);
            this.ctx.beginPath();
            this.ctx.moveTo(x, y + cl);           this.ctx.lineTo(x, y);             this.ctx.lineTo(x + cl, y);
            this.ctx.moveTo(x + w - cl, y);       this.ctx.lineTo(x + w, y);         this.ctx.lineTo(x + w, y + cl);
            this.ctx.moveTo(x + w, y + h - cl);   this.ctx.lineTo(x + w, y + h);     this.ctx.lineTo(x + w - cl, y + h);
            this.ctx.moveTo(x + cl, y + h);       this.ctx.lineTo(x, y + h);         this.ctx.lineTo(x, y + h - cl);
            this.ctx.stroke();

            // Faint fill
            this.ctx.shadowBlur = 0;
            this.ctx.fillStyle = this._hexA(color, 0.07);
            this.ctx.fillRect(x, y, w, h);

            // ── Distance & Priority Badge ──
            if (obj.className !== 'motion') {
                const distStr  = dist !== undefined ? `${dist.toFixed(1)}m` : '?';
                const prioStr  = obj.priorityLabel || '';
                const label    = `${obj.className.toUpperCase()}  |  ${distStr}  |  ${prioStr}`;

                this.ctx.font = '600 12px Inter, system-ui, sans-serif';
                const tw = this.ctx.measureText(label).width;

                // Pill background
                this.ctx.shadowColor = 'rgba(0,0,0,0.6)';
                this.ctx.shadowBlur  = 8;
                this.ctx.fillStyle   = 'rgba(12,16,28,0.88)';
                this._pill(x, y - 30, tw + 22, 24, 12);
                this.ctx.fill();

                // Colored left accent bar
                this.ctx.fillStyle = color;
                this.ctx.fillRect(x, y - 30, 3, 24);

                // Text
                this.ctx.shadowBlur  = 0;
                this.ctx.fillStyle   = '#ffffff';
                this.ctx.fillText(label, x + 11, y - 13);
            }

            this.ctx.restore();
        }
    }

    /* ─────────── Helpers ─────────── */

    /** @private Convert hex color to rgba string. */
    _hexA(hex, a) {
        const r = parseInt(hex.slice(1, 3), 16);
        const g = parseInt(hex.slice(3, 5), 16);
        const b = parseInt(hex.slice(5, 7), 16);
        return `rgba(${r},${g},${b},${a})`;
    }

    /** @private Draw a rounded-rect (pill) path. */
    _pill(x, y, w, h, r) {
        this.ctx.beginPath();
        this.ctx.moveTo(x + r, y);
        this.ctx.lineTo(x + w - r, y);
        this.ctx.quadraticCurveTo(x + w, y, x + w, y + r);
        this.ctx.lineTo(x + w, y + h - r);
        this.ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
        this.ctx.lineTo(x + r, y + h);
        this.ctx.quadraticCurveTo(x, y + h, x, y + h - r);
        this.ctx.lineTo(x, y + r);
        this.ctx.quadraticCurveTo(x, y, x + r, y);
        this.ctx.closePath();
    }

    /** @private Intersection-over-Union for bbox matching. */
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
