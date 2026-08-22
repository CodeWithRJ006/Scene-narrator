/**
 * SubtitleManager.js – Live AR subtitle rendering.
 *
 * Manages the bottom subtitle HUD, showing up to 3 most urgent detections
 * with high-contrast text and glowing badges.
 */

export class SubtitleManager {
    /**
     * @param {string} subtitleElementId – DOM id of the subtitle container.
     */
    constructor(subtitleElementId) {
        this.$subtitleStrip = document.getElementById(subtitleElementId);
    }

    /**
     * Update the subtitle HUD with the latest detection predictions.
     * Render format: [ PERSON | 1.4m | TIER 1 ]
     * @param {Array} preds – Augmented predictions from SpatialReasoning.
     */
    update(preds) {
        if (!this.$subtitleStrip) return;

        if (!preds.length) {
            this.$subtitleStrip.innerHTML = '<span style="color:var(--text-3); font-weight:500;">Scanning environment…</span>';
            return;
        }

        const sorted = [...preds]
            .filter(p => p.className !== 'motion')
            .sort((a, b) => (a.urgencyTier - b.urgencyTier) || ((a.distance || 8) - (b.distance || 8)));

        const parts = sorted.slice(0, 3).map(p => {
            const d = p.distance ?? 0;
            const tStr = p.urgencyTier === 1 ? 'TIER 1' : (p.urgencyTier === 2 ? 'TIER 2' : 'TIER 3');
            const clsName = p.className.toUpperCase();
            
            const badgeClass = p.urgencyTier === 1 ? 'badge-t1' : (p.urgencyTier === 2 ? 'badge-t2' : 'badge-t3');
            
            return `<span class="sub-badge ${badgeClass}">[ ${clsName} | ${d.toFixed(1)}m | ${tStr} ]</span>`;
        });

        this.$subtitleStrip.innerHTML = parts.join('');
    }

    /**
     * Show raw spoken text in the subtitle bar (called by SpeechSynthesizer).
     * @param {string} text
     */
    showSpoken(text) {
        if (this.$subtitleStrip) {
            this.$subtitleStrip.innerHTML = `<span class="spoken">${text}</span>`;
        }
    }
}
