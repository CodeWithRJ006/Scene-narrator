import * as tf from '@tensorflow/tfjs';
import '@tensorflow/tfjs-backend-webgl';
import * as cocoSsd from '@tensorflow-models/coco-ssd';

export class EdgeDetector {
    /**
     * @param {string} canvasId – DOM id of the overlay <canvas>.
     */
    constructor(canvasId) {
        this.canvas = document.getElementById(canvasId);
        this.ctx    = this.canvas ? this.canvas.getContext('2d') : null;
        this.isReady = false;
        
        // Setup Worker
        this.worker = new Worker(new URL('../worker.js', import.meta.url), { type: 'module' });
        this.resolves = new Map();
        this.msgId = 0;

        this.worker.onmessage = (e) => {
            if (e.data.type === 'ready') {
                this.isReady = true;
                console.log("Vision Engine (Worker): ONLINE");
            } else if (e.data.type === 'result' || e.data.type === 'error') {
                const resolve = this.resolves.get(e.data.id);
                if (resolve) {
                    resolve(e.data.predictions || []);
                    this.resolves.delete(e.data.id);
                }
            }
        };
        
        // LERP tracker for smooth rendering
        this.tracked = [];
    }

    async initialize() {
        this.worker.postMessage({ type: 'init' });
        // Return a promise that resolves when worker is ready
        return new Promise(resolve => {
            const check = setInterval(() => {
                if (this.isReady) {
                    clearInterval(check);
                    resolve();
                }
            }, 100);
        });
    }

    // App.js currently calls detector.load().
    async load() {
        await this.initialize();
    }

    async detect(videoElement) {
        if (!this.isReady) return [];
        
        // Ensure the HUD canvas internal resolution scales perfectly over the video on mobile devices
        if (this.canvas && (this.canvas.width !== videoElement.videoWidth || this.canvas.height !== videoElement.videoHeight)) {
            this.canvas.width = videoElement.videoWidth;
            this.canvas.height = videoElement.videoHeight;
        }

        try {
            // Offload pixel data to worker via ImageBitmap
            const bitmap = await createImageBitmap(videoElement);
            const id = this.msgId++;
            
            return new Promise(resolve => {
                this.resolves.set(id, (predictions) => {
                    const mapped = predictions
                        .filter(p => p.score > 0.45)
                        .map(p => ({
                            class: p.class,
                            className: p.class, 
                            score: p.score,
                            bbox: [p.bbox[0], p.bbox[1], p.bbox[2], p.bbox[3]]
                        }));
                    resolve(mapped);
                });
                
                // Transfer bitmap to worker to avoid main-thread copy overhead
                this.worker.postMessage({ type: 'detect', id, bitmap }, [bitmap]);
            });
        } catch (e) {
            console.error("Worker detect failed:", e);
            return [];
        }
    }

    /* ─────────────────── AR HUD Renderer ─────────────────── */

    /**
     * Draw AR overlay with LERP-smoothed bounding boxes, distance badges, and urgency glow.
     * @param {Array} predictions
     * @param {string|null} activeTarget
     */
    drawHUD(predictions, activeTarget = null) {
        if (!this.ctx) return;
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

            let isTargetLock = false;
            if (activeTarget && (obj.className.toLowerCase().includes(activeTarget) || activeTarget.includes(obj.className.toLowerCase()))) {
                isTargetLock = true;
            }

            let color;
            if (isTargetLock)                          color = '#ffffff';
            else if (dist !== undefined && dist < 1.8) color = '#ef4444';
            else if (dist !== undefined && dist < 3.5) color = '#f59e0b';
            else if (dist !== undefined)               color = '#10b981';
            else if (tier === 1)                       color = '#ef4444';
            else if (tier === 2)                       color = '#f59e0b';
            else                                       color = '#00f0ff';

            this.ctx.save();
            this.ctx.globalAlpha = obj.alpha;

            this.ctx.shadowColor = color;
            this.ctx.shadowBlur  = isTargetLock ? 24 : (tier === 1 ? 24 : 12);
            this.ctx.strokeStyle = color;
            this.ctx.lineWidth   = isTargetLock ? 4 : (tier === 1 ? 3 : 2);
            this.ctx.lineJoin    = 'round';

            const cl = Math.min(24, w / 4, h / 4);
            this.ctx.beginPath();
            this.ctx.moveTo(x, y + cl);           this.ctx.lineTo(x, y);             this.ctx.lineTo(x + cl, y);
            this.ctx.moveTo(x + w - cl, y);       this.ctx.lineTo(x + w, y);         this.ctx.lineTo(x + w, y + cl);
            this.ctx.moveTo(x + w, y + h - cl);   this.ctx.lineTo(x + w, y + h);     this.ctx.lineTo(x + w - cl, y + h);
            this.ctx.moveTo(x + cl, y + h);       this.ctx.lineTo(x, y + h);         this.ctx.lineTo(x, y + h - cl);
            this.ctx.stroke();

            this.ctx.shadowBlur = 0;
            this.ctx.fillStyle = this._hexA(color, 0.07);
            this.ctx.fillRect(x, y, w, h);

            if (obj.className !== 'motion') {
                let distStr = '?';
                if (dist !== undefined) {
                    if (dist < 1.0) distStr = `${dist.toFixed(1)}m`;
                    else distStr = `~${(Math.round(dist * 2) / 2).toFixed(1).replace('.0', '')}m`;
                }
                const prioStr  = obj.priorityLabel || '';
                const label    = `${obj.className.toUpperCase()}  |  ${distStr}  |  ${prioStr}`;

                this.ctx.font = '600 12px Inter, system-ui, sans-serif';
                const tw = this.ctx.measureText(label).width;

                this.ctx.shadowColor = 'rgba(0,0,0,0.6)';
                this.ctx.shadowBlur  = 8;
                this.ctx.fillStyle   = 'rgba(12,16,28,0.88)';
                this._pill(x, y - 30, tw + 22, 24, 12);
                this.ctx.fill();

                this.ctx.fillStyle = color;
                this.ctx.fillRect(x, y - 30, 3, 24);

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
