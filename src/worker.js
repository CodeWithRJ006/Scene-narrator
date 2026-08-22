import * as tf from '@tensorflow/tfjs';
import '@tensorflow/tfjs-backend-webgl';
import * as cocoSsd from '@tensorflow-models/coco-ssd';

let model = null;

self.onmessage = async (e) => {
    if (e.data.type === 'init') {
        try {
            await tf.setBackend('webgl');
            await tf.ready();
            model = await cocoSsd.load({ base: 'lite_mobilenet_v2' });
            self.postMessage({ type: 'ready' });
        } catch (err) {
            console.error("Worker webgl failed, falling back to cpu", err);
            await tf.setBackend('cpu');
            await tf.ready();
            model = await cocoSsd.load({ base: 'lite_mobilenet_v2' });
            self.postMessage({ type: 'ready' });
        }
    } else if (e.data.type === 'detect') {
        if (!model) return;
        const bitmap = e.data.bitmap;
        try {
            const predictions = await model.detect(bitmap);
            self.postMessage({ type: 'result', predictions, id: e.data.id });
        } catch (err) {
            self.postMessage({ type: 'error', id: e.data.id, error: err.message });
        } finally {
            bitmap.close();
        }
    }
};
