/**
 * UIController.js – HUD state management, drawer controls, and DOM bindings.
 *
 * Manages:
 *   - Landing → App view transition
 *   - Bottom drawer (expand/collapse)
 *   - Proximity slider
 *   - API key persistence
 *   - Urgency dot indicator
 *   - FPS counter
 *   - Test buttons
 */

import { TIER } from '../core/SpatialReasoning.js';

export class UIController {
    constructor() {
        // Landing
        this.$land   = document.getElementById('landing-page');
        this.$app    = document.getElementById('app-view');
        this.$launch = document.getElementById('launch-btn');

        // Drawer
        this.$drawer  = document.getElementById('drawer');
        this.$handle  = document.getElementById('drawer-handle');
        this.$key     = document.getElementById('api-key');
        this.$prox    = document.getElementById('proximity');
        this.$proxTag = document.getElementById('prox-tag');

        // HUD
        this.$dot     = document.getElementById('urgency-dot');
        this.$dotLbl  = document.getElementById('urgency-label');
        this.$fps     = document.getElementById('fps-counter');
        this.$subText = document.getElementById('sub-text');

        // Test buttons
        this.$testT1  = document.getElementById('test-t1');
        this.$testT2  = document.getElementById('test-t2');

        // Drawer state
        this._drawerOpen = true;

        this._initDrawer();
        this._initSlider();
        this._restoreApiKey();
    }

    /* ──────── Drawer ──────── */

    /** @private */
    _initDrawer() {
        this.$handle.addEventListener('click', () => {
            this._drawerOpen = !this._drawerOpen;
            this.$drawer.classList.toggle('collapsed', !this._drawerOpen);
        });
    }

    /** @private */
    _initSlider() {
        this.$prox.addEventListener('input', () => {
            this.$proxTag.textContent = this.$prox.value;
        });
    }

    /** @private Restore persisted Gemini API key. */
    _restoreApiKey() {
        const saved = localStorage.getItem('geminiApiKey');
        if (saved) this.$key.value = saved;
    }

    /**
     * Register a callback for API key changes.
     * @param {(key: string) => void} cb
     */
    onApiKeyChange(cb) {
        this.$key.addEventListener('input', () => {
            const v = this.$key.value.trim();
            localStorage.setItem('geminiApiKey', v);
            cb(v);
        });
    }

    /**
     * Get the current API key value.
     * @returns {string}
     */
    getApiKey() {
        return this.$key.value.trim();
    }

    /**
     * Register the launch button click handler.
     * @param {() => Promise<void>} cb
     */
    onLaunch(cb) {
        this.$launch.addEventListener('click', cb);
    }

    /**
     * Register test button click handlers.
     * @param {() => void} onT1
     * @param {() => void} onT2
     */
    onTestButtons(onT1, onT2) {
        this.$testT1.addEventListener('click', onT1);
        this.$testT2.addEventListener('click', onT2);
    }

    /* ──────── Transitions ──────── */

    /** Show calibrating state on the launch button. */
    showCalibrating() {
        this.$launch.disabled = true;
        this.$launch.textContent = 'CALIBRATING CAMERA…';
    }

    /** Show camera-denied error and allow retry. */
    showError() {
        this.$launch.textContent = 'CAMERA DENIED – TAP TO RETRY';
        this.$launch.disabled = false;
        this.$launch.onclick = () => location.reload();
    }

    /** Transition from landing page to the active HUD view. */
    transitionToApp() {
        this.$land.classList.add('out');
        this.$app.classList.remove('hidden');
        setTimeout(() => {
            this.$drawer.classList.remove('collapsed');
            this._drawerOpen = true;
        }, 500);
    }

    /* ──────── HUD Updates ──────── */

    /**
     * Update the urgency dot indicator.
     * @param {number} tier – TIER.HAZARD, TIER.CAUTION, or TIER.BG.
     */
    updateUrgencyDot(tier) {
        this.$dot.className = 'urgency-dot';
        if (tier === TIER.HAZARD)       { this.$dot.classList.add('hazard'); this.$dotLbl.textContent = 'Hazard'; }
        else if (tier === TIER.CAUTION) { this.$dot.classList.add('warn');   this.$dotLbl.textContent = 'Caution'; }
        else                            { this.$dotLbl.textContent = 'Clear'; }
    }

    /**
     * Update the FPS counter display.
     * @param {number} fps
     */
    updateFPS(fps) {
        this.$fps.textContent = Math.round(fps);
    }
}
