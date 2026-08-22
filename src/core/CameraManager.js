/**
 * CameraManager.js – Rear-facing camera setup with iOS/Android inline playback.
 *
 * Handles getUserMedia constraints, stream lifecycle, and resolution negotiation.
 * Supports environment-facing (rear) camera with graceful fallback to front-facing.
 */

export class CameraManager {
    /**
     * @param {string} videoId – DOM id of the <video> element.
     */
    constructor(videoId) {
        this.video = typeof videoId === 'string' ? document.getElementById(videoId) : videoId;
        this.currentStream = null;
        this.selectedDeviceId = null;
    }

    async getAvailableCameras() {
        const devices = await navigator.mediaDevices.enumerateDevices();
        return devices.filter(device => device.kind === 'videoinput');
    }

    async startCamera(deviceId = null) {
        if (this.currentStream) {
            this.currentStream.getTracks().forEach(track => track.stop());
        }

        this.selectedDeviceId = deviceId;
        const constraints = {
            video: deviceId 
                ? { deviceId: { exact: deviceId } }
                : { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
            audio: false
        };

        try {
            this.currentStream = await navigator.mediaDevices.getUserMedia(constraints);
        } catch (err) {
            console.warn("Retrying with loose constraints:", err);
            this.currentStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        }

        this.video.srcObject = this.currentStream;
        this.video.setAttribute('playsinline', 'true');
        this.video.muted = true;

        return new Promise((resolve) => {
            this.video.onloadedmetadata = () => {
                this.video.play();
                resolve(this.video);
            };
        });
    }

    /** Legacy alias for App.js */
    async start() {
        return this.startCamera(null);
    }

    /**
     * Auto-sync canvas overlay aspect ratio on window resize and mobile orientation change.
     * @param {Function} onResizeCallback - Callback receiving (width, height)
     */
    syncCanvasOnResize(onResizeCallback) {
        const handleResize = () => {
            if (this.video && this.video.videoWidth) {
                onResizeCallback(this.video.videoWidth, this.video.videoHeight);
            }
        };
        window.addEventListener('resize', handleResize);
        window.addEventListener('orientationchange', () => setTimeout(handleResize, 150));
    }

    /**
     * Provide frame capture helper for image blobs and local processing.
     * @param {number} quality - JPEG quality 0.0 to 1.0
     * @returns {Promise<Blob|null>}
     */
    async getSnapshotBlob(quality = 0.8) {
        if (!this.video || !this.video.videoWidth) return null;
        const canvas = document.createElement('canvas');
        canvas.width = this.video.videoWidth;
        canvas.height = this.video.videoHeight;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(this.video, 0, 0, canvas.width, canvas.height);
        return new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
    }

    /**
     * Stop all tracks and release the camera.
     */
    stop() {
        if (this.currentStream) {
            this.currentStream.getTracks().forEach(t => t.stop());
            this.currentStream = null;
        }
        if (this.video) {
            this.video.srcObject = null;
        }
    }
}
