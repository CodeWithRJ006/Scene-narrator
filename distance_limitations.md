# InsightLens Pro: Geometric Distance & Hazard Detection Limitations

This document outlines the core math, assumptions, and physical limitations of the local `SpatialReasoning.js` engine.

## Distance Estimation Logic

Currently, the engine uses **Pinhole Optical Distance Approximation** rather than true stereo-depth, LiDAR, or dual-lens disparity. It estimates how far away an object is by comparing its pixel size on the 2D camera sensor to an assumed "real world" physical size.

**The Math:**
```javascript
Distance (m) = (RealObjectHeight_m * FocalLength_px) / max(BoundingBoxWidth_px, BoundingBoxHeight_px)
```

### Assumptions & Known Failure Modes

1. **The "Standard Size" Fallacy**
   - *Assumption:* The math strictly relies on a `REAL_HEIGHTS` dictionary containing generic averages (e.g., it inherently assumes every `person` is exactly 1.70m tall, and every `chair` is 0.85m tall).
   - *Failure:* A small child or a person in a wheelchair will be falsely calculated as being significantly further away than they actually are. An oversized decorative chair will be calculated as being dangerously close.
2. **Occlusion & Cropping**
   - *Assumption:* The engine assumes the bounding box encompasses the *entire* object.
   - *Failure:* If a person is standing behind a desk, the AI only draws a box around their upper half. Because the box is artificially short, the math divides by a smaller number, causing the distance to spike (e.g., a person 2m away might read as 4m away).
3. **Camera Angle (Perspective Distortion)**
   - *Assumption:* The camera is held perpendicular (straight on) to the target.
   - *Failure:* A blind user wearing the phone on a lanyard might have the camera angled slightly downward. Viewing objects from high or extreme angles compresses their vertical height on a 2D sensor, artificially inflating the perceived distance.
4. **False Precision**
   - We recently modified the UI and TTS Engine to round distances to the nearest 0.5 meters (e.g. "about 2 meters") because outputting raw floats ("2.17 meters") communicates a level of millimeter-accuracy that the pinhole algorithm mathematically cannot provide.

## Step-Down Hazards (Stairs/Curbs)

**Important limitations for user testing and Hackathon judging:**

Currently, the "Step-Down Hazard" is a **UI mockup only**. 
The underlying vision model (`COCO-SSD / MobileNetV2`) is trained strictly on 80 discrete physical objects (cars, backpacks, people, dogs). It *does not* possess segmentation maps, depth-estimation buffers, or edge-contrast heuristics necessary to identify negative obstacles like curbs, descending stairs, or drop-offs. 

*If presented at a hackathon, do not imply the application natively protects against curbs using the current edge model.* Reliable step-down detection requires integrating a monocular depth model (like MiDaS or Depth Anything) or edge-detection heuristics which are outside the scope of the current 12-FPS MobileNet pipeline.
