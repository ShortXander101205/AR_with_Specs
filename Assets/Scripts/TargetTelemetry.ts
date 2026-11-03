import { TargetKinematics } from "./TargetKinematics";

/**
 * TargetTelemetry.ts
 * 
 * Implements Feature 2: 3D Bounding Box & Real-Time Telemetry.
 * Complies with Feature 2 Specification: SPEC-FR-002 & Plan: PLAN-FR-002.
 * Target System: Snap Lens Studio 5.24+ (Spectacles / World AR)
 * 
 * Features:
 * 1. AI-style tracking reticle & 3D corner-bracket bounding box (#00FF66).
 * 2. Real-time range calculation (d = ||p_target - p_camera|| / 100).
 * 3. Live velocity extraction from TargetKinematics (or finite-difference fallback).
 * 4. Procedural dynamic AI confidence score (88.0% - 98.0%).
 * 5. Camera-facing spherical billboarding preventing perspective shearing.
 * 6. Throttled 20 Hz string formatting & pre-allocated zero-GC scratch vectors.
 */
@component
export class TargetTelemetry extends BaseScriptComponent {
    // =========================================================================
    // STATIC STYLING CONSTANTS & VISUAL PALETTE
    // =========================================================================

    /**
     * Baseline cyber neon green for computer-vision lock (#00FF66).
     */
    public static readonly COLOR_RETICLE = new vec4(0.0, 1.0, 0.4, 0.95);
    public static readonly COLOR_CORNER = new vec4(0.2, 1.0, 0.5, 1.0);
    public static readonly COLOR_TEXT = new vec4(0.0, 1.0, 0.4, 1.0);

    private static readonly UP_VECTOR = new vec3(0.0, 1.0, 0.0);
    private static readonly FORWARD_VECTOR = new vec3(0.0, 0.0, 1.0);

    /** Pre-allocated sign permutations for 8 corner brackets (eliminates per-frame array allocations) */
    private static readonly CORNER_SIGNS: number[][] = [
        [-1, -1, -1], [1, -1, -1], [-1, 1, -1], [1, 1, -1],
        [-1, -1, 1],  [1, -1, 1],  [-1, 1, 1],  [1, 1, 1]
    ];

    // =========================================================================
    // INSPECTOR INPUTS (SPEC-FR-002 / FR-4)
    // =========================================================================

    @ui.group_start("Target & Display Binding")

    /**
     * Kinematic target SceneObject from Feature 1 to track.
     */
    @input
    @label("Target Entity")
    @hint("SceneObject representing the drone/target entity to track")
    @allowUndefined
    targetObject: SceneObject | null = null;

    /**
     * 3D world text component to render the HUD readouts.
     */
    @input
    @label("Telemetry Text")
    @hint("Component.Text to display real-time telemetry metrics")
    @allowUndefined
    telemetryText: Component.Text | null = null;

    /**
     * World Camera reference (auto-resolved from scene if unassigned).
     */
    @input
    @label("Camera Object")
    @hint("World Camera SceneObject (auto-resolved from scene if unassigned)")
    @allowUndefined
    cameraObject: SceneObject | null = null;

    @ui.group_end

    @ui.group_start("Telemetry Configuration")

    /**
     * Target callsign or identifier displayed in HUD.
     */
    @input
    @label("Target ID")
    @hint("Target identifier name displayed in HUD readout")
    targetId: string = "UAV-01";

    /**
     * Baseline AI tracking confidence percentage (80.0 to 99.0%).
     */
    @input
    @label("Base Confidence (%)")
    @hint("Baseline AI tracking confidence percentage (80.0 to 99.0%)")
    @widget(new SliderWidget(80.0, 99.0, 0.5))
    baseConfidence: number = 95.0;

    /**
     * Elevation of telemetry display above target center in centimeters.
     */
    @input
    @label("HUD Vertical Offset (cm)")
    @hint("Vertical height offset of HUD above target centroid")
    @widget(new SliderWidget(10.0, 80.0, 5.0))
    verticalOffset: number = 25.0;

    /**
     * Scale reticle geometry with distance to maintain visual prominence.
     */
    @input
    @label("Dynamic Scaling")
    @hint("Compensate reticle and text scale across distance variations")
    enableDynamicScaling: boolean = true;

    /**
     * Enable 3D bounding box / corner brackets in AR view.
     */
    @input
    @label("Show 3D Reticle")
    @hint("Render AI-style corner brackets and bounding wireframe around target")
    show3DReticle: boolean = true;

    @ui.group_end

    // =========================================================================
    // INTERNAL SCRATCH BUFFERS & ZERO-GC STATE
    // =========================================================================

    private activeTarget: SceneObject | null = null;
    private activeCamera: SceneObject | null = null;
    private kinematicsController: TargetKinematics | null = null;
    private textTransform: Transform | null = null;

    // Zero-heap allocation scratch vectors
    private scratchCamPos: vec3 = new vec3(0.0, 0.0, 0.0);
    private scratchTargetPos: vec3 = new vec3(0.0, 0.0, 0.0);
    private scratchHudPos: vec3 = new vec3(0.0, 0.0, 0.0);
    private scratchDelta: vec3 = new vec3(0.0, 0.0, 0.0);
    private scratchLookDir: vec3 = new vec3(0.0, 0.0, 0.0);
    private scratchPrevTargetPos: vec3 = new vec3(0.0, 0.0, 0.0);
    private scratchCornerA: vec3 = new vec3(0.0, 0.0, 0.0);
    private scratchCornerB: vec3 = new vec3(0.0, 0.0, 0.0);
    private scratchScale: vec3 = new vec3(1.0, 1.0, 1.0);

    // Dynamic state
    private lastUpdateTime: number = 0;
    private accumulatedTime: number = 0;
    private fallbackVelocity: number = 0.0;
    private hasWarnedMissingTarget: boolean = false;
    private hasWarnedMissingCamera: boolean = false;
    private isFirstFrame: boolean = true;

    // Throttled string formatting state (20 Hz refresh rate)
    private timeSinceLastStringUpdate: number = 0.0;
    private readonly STRING_UPDATE_INTERVAL: number = 0.05; // 50 ms = 20 Hz
    private cachedDistance: number = -1;
    private cachedVelocity: number = -1;
    private cachedConfidence: number = -1;

    // =========================================================================
    // ENGINE LIFECYCLE
    // =========================================================================

    onAwake(): void {
        this.initializeTelemetry();
        // Subscribe to LateUpdateEvent to ensure kinematic translation is finished
        this.createEvent("LateUpdateEvent").bind(this.onLateUpdate.bind(this));
    }

    private initializeTelemetry(): void {
        // Resolve Target Object
        this.activeTarget = this.targetObject ?? this.getSceneObject();
        if (this.activeTarget) {
            // Check for TargetKinematics component on target or parent
            this.kinematicsController = this.activeTarget.getComponent(TargetKinematics.getTypeName());
            if (!this.kinematicsController && this.activeTarget.getParent()) {
                this.kinematicsController = this.activeTarget.getParent()!.getComponent(TargetKinematics.getTypeName());
            }

            // Cache initial target position for finite-difference fallback
            const targetPos = this.activeTarget.getTransform().getWorldPosition();
            this.scratchPrevTargetPos.x = targetPos.x;
            this.scratchPrevTargetPos.y = targetPos.y;
            this.scratchPrevTargetPos.z = targetPos.z;
        }

        // Resolve Camera Object
        this.resolveCamera();

        // Resolve Text Component & Transform
        if (this.telemetryText) {
            this.textTransform = this.telemetryText.getSceneObject().getTransform();
        } else {
            // Check if text is attached to current SceneObject
            const localText = this.getSceneObject().getComponent("Component.Text") as Component.Text;
            if (localText) {
                this.telemetryText = localText;
                this.textTransform = this.getSceneObject().getTransform();
            }
        }
    }

    /**
     * Resolves the primary world camera from input or scene hierarchy.
     */
    private resolveCamera(): void {
        if (this.cameraObject) {
            this.activeCamera = this.cameraObject;
            return;
        }

        // Search root objects for Camera component
        const rootCount = global.scene.getRootObjectsCount();
        for (let i = 0; i < rootCount; i++) {
            const root = global.scene.getRootObject(i);
            const cam = this.findCameraInHierarchy(root);
            if (cam) {
                this.activeCamera = cam;
                return;
            }
        }
    }

    private findCameraInHierarchy(obj: SceneObject): SceneObject | null {
        if (obj.getComponent("Component.Camera")) {
            return obj;
        }
        const childCount = obj.getChildrenCount();
        for (let i = 0; i < childCount; i++) {
            const found = this.findCameraInHierarchy(obj.getChild(i));
            if (found) return found;
        }
        return null;
    }

    // =========================================================================
    // PER-FRAME TELEMETRY CYCLE (LATE UPDATE)
    // =========================================================================

    private onLateUpdate(): void {
        if (!this.activeTarget) {
            this.initializeTelemetry();
            if (!this.activeTarget) {
                if (!this.hasWarnedMissingTarget) {
                    print("[TargetTelemetry] Notice: No targetObject assigned. Telemetry paused.");
                    this.hasWarnedMissingTarget = true;
                }
                return;
            }
        }

        if (!this.activeCamera) {
            this.resolveCamera();
            if (!this.activeCamera) {
                if (!this.hasWarnedMissingCamera) {
                    print("[TargetTelemetry] Notice: World Camera not found. Telemetry paused.");
                    this.hasWarnedMissingCamera = true;
                }
                return;
            }
        }

        const dt = Math.max(0.0001, Math.min(getDeltaTime(), 0.05));
        this.accumulatedTime += dt;
        this.timeSinceLastStringUpdate += dt;

        // 1. Fetch current world positions (Zero Allocations)
        const targetWorldPos = this.activeTarget.getTransform().getWorldPosition();
        this.scratchTargetPos.x = targetWorldPos.x;
        this.scratchTargetPos.y = targetWorldPos.y;
        this.scratchTargetPos.z = targetWorldPos.z;

        const camWorldPos = this.activeCamera.getTransform().getWorldPosition();
        this.scratchCamPos.x = camWorldPos.x;
        this.scratchCamPos.y = camWorldPos.y;
        this.scratchCamPos.z = camWorldPos.z;

        // 2. Compute Euclidean Distance (Range d in meters)
        this.scratchDelta.x = this.scratchTargetPos.x - this.scratchCamPos.x;
        this.scratchDelta.y = this.scratchTargetPos.y - this.scratchCamPos.y;
        this.scratchDelta.z = this.scratchTargetPos.z - this.scratchCamPos.z;
        const distCm = Math.sqrt(
            this.scratchDelta.x * this.scratchDelta.x +
            this.scratchDelta.y * this.scratchDelta.y +
            this.scratchDelta.z * this.scratchDelta.z
        );
        const distanceM = distCm / 100.0;

        // 3. Extract Velocity (v in m/s) via 3-Tier Resolution
        const velocityMps = this.extractVelocity(dt);

        // 4. Compute Dynamic Procedural AI Confidence Score (%)
        const confidencePct = this.calculateConfidence(distanceM, velocityMps, this.accumulatedTime);

        // 5. Update Spatial HUD Position & Spherical Billboarding
        this.updateSpatialHUD(distanceM);

        // 6. Throttled Display Text Update (20 Hz)
        if (this.timeSinceLastStringUpdate >= this.STRING_UPDATE_INTERVAL) {
            this.updateDisplayString(distanceM, velocityMps, confidencePct);
            this.timeSinceLastStringUpdate = 0.0;
        }

        // 7. Render 3D Reticle Wireframe / Corner Brackets (#00FF66)
        if (this.show3DReticle && global.debugRenderSystem) {
            this.render3DReticle(distanceM);
        }

        // Store target position for finite-difference fallback
        this.scratchPrevTargetPos.x = this.scratchTargetPos.x;
        this.scratchPrevTargetPos.y = this.scratchTargetPos.y;
        this.scratchPrevTargetPos.z = this.scratchTargetPos.z;
        this.isFirstFrame = false;
    }

    // =========================================================================
    // VELOCITY RESOLUTION (3-TIER RESOLUTION STRATEGY)
    // =========================================================================

    /**
     * Resolves linear velocity magnitude in meters per second without tight coupling.
     */
    private extractVelocity(dt: number): number {
        // Tier 1: Direct public contract call on TargetKinematics
        if (this.kinematicsController && typeof this.kinematicsController.getVelocityMagnitude === "function") {
            return this.kinematicsController.getVelocityMagnitude();
        }

        // Tier 2: Property access on kinematics component
        if (this.kinematicsController && typeof this.kinematicsController.velocity === "number") {
            return this.kinematicsController.velocity;
        }

        // Tier 3: Zero-dependency finite-difference velocity calculation with EMA smoothing
        if (this.isFirstFrame || dt <= 0.0001) {
            return 0.0;
        }

        const dx = this.scratchTargetPos.x - this.scratchPrevTargetPos.x;
        const dy = this.scratchTargetPos.y - this.scratchPrevTargetPos.y;
        const dz = this.scratchTargetPos.z - this.scratchPrevTargetPos.z;
        const displacementCm = Math.sqrt(dx * dx + dy * dy + dz * dz);
        const rawSpeedMps = (displacementCm / 100.0) / dt;

        // Exponential Moving Average filter (alpha = 0.25)
        this.fallbackVelocity = this.fallbackVelocity * 0.75 + rawSpeedMps * 0.25;
        return this.fallbackVelocity;
    }

    // =========================================================================
    // DYNAMIC CONFIDENCE SCORE MODEL (SPEC-FR-002 / FR-2.4)
    // =========================================================================

    /**
     * Synthesizes an authentic deep-learning AI classification confidence score (88.0% - 98.0%).
     */
    private calculateConfidence(distanceM: number, velocityMps: number, timeSec: number): number {
        // 1. Distance attenuation penalty (drops ~1.2% per meter beyond 2.5m)
        const distPenalty = 1.2 * Math.max(0.0, distanceM - 2.5);

        // 2. Velocity turbulence penalty (drops ~2.5% at maximum 35 m/s)
        const velPenalty = 2.5 * Math.min(1.0, velocityMps / 35.0);

        // 3. Multi-harmonic procedural sensor noise (realistic high-frequency jitter)
        const noise = 0.85 * Math.sin(3.7 * timeSec) +
                      0.45 * Math.cos(8.3 * timeSec + 1.2) +
                      0.25 * Math.sin(14.9 * timeSec);

        // 4. Composite clamped to operational range [88.0%, 98.0%]
        const rawConf = this.baseConfidence - distPenalty - velPenalty + noise;
        return Math.max(88.0, Math.min(98.0, rawConf));
    }

    // =========================================================================
    // SPATIAL HUD POSITIONING & SPHERICAL BILLBOARDING (FR-3)
    // =========================================================================

    /**
     * Positions the HUD container above the target and aligns orientation facing the camera.
     */
    private updateSpatialHUD(distanceM: number): void {
        const hudObject = this.telemetryText ? this.telemetryText.getSceneObject() : this.getSceneObject();
        const transform = hudObject.getTransform();

        // Position HUD above target centroid
        this.scratchHudPos.x = this.scratchTargetPos.x;
        this.scratchHudPos.y = this.scratchTargetPos.y + this.verticalOffset;
        this.scratchHudPos.z = this.scratchTargetPos.z;
        transform.setWorldPosition(this.scratchHudPos);

        // Compute Look-At Vector from HUD to Camera
        this.scratchLookDir.x = this.scratchCamPos.x - this.scratchHudPos.x;
        this.scratchLookDir.y = this.scratchCamPos.y - this.scratchHudPos.y;
        this.scratchLookDir.z = this.scratchCamPos.z - this.scratchHudPos.z;

        const lenSq = this.scratchLookDir.x * this.scratchLookDir.x +
                      this.scratchLookDir.y * this.scratchLookDir.y +
                      this.scratchLookDir.z * this.scratchLookDir.z;

        if (lenSq > 1.0) {
            const invLen = 1.0 / Math.sqrt(lenSq);
            this.scratchLookDir.x *= invLen;
            this.scratchLookDir.y *= invLen;
            this.scratchLookDir.z *= invLen;

            // Guard against zenith/nadir singularity when lookDir is collinear with world up
            const upRef = Math.abs(this.scratchLookDir.y) > 0.98 
                ? TargetTelemetry.FORWARD_VECTOR 
                : TargetTelemetry.UP_VECTOR;

            // Full spherical billboarding facing camera
            const billboardRot = quat.lookAt(this.scratchLookDir, upRef);
            transform.setWorldRotation(billboardRot);
        }

        // Apply dynamic scale compensation if enabled (Zero per-frame heap allocations)
        if (this.enableDynamicScaling) {
            // Distance-adaptive scale factor (reference distance: 3.0m)
            const scaleFactor = Math.max(0.7, Math.min(2.5, 1.0 + 0.25 * ((distanceM - 3.0) / 3.0)));
            this.scratchScale.x = scaleFactor;
            this.scratchScale.y = scaleFactor;
            this.scratchScale.z = scaleFactor;
            transform.setWorldScale(this.scratchScale);
        }
    }

    // =========================================================================
    // THROTTLED STRING FORMATTING (20 Hz REFRESH RATE)
    // =========================================================================

    /**
     * Formats multi-line telemetry HUD feed with change threshold filtering.
     */
    private updateDisplayString(distM: number, velMps: number, confPct: number): void {
        if (!this.telemetryText) return;

        // Skip string reconstruction if values have not meaningfully changed
        const dDiff = Math.abs(distM - this.cachedDistance);
        const vDiff = Math.abs(velMps - this.cachedVelocity);
        const cDiff = Math.abs(confPct - this.cachedConfidence);

        if (dDiff < 0.05 && vDiff < 0.1 && cDiff < 0.15 && this.cachedDistance >= 0) {
            return;
        }

        this.cachedDistance = distM;
        this.cachedVelocity = velMps;
        this.cachedConfidence = confPct;

        // Format compliant string:
        // [ TARGET ACQUIRED ]
        // ID: UAV-01
        // RNG: 3.2m
        // VEL: 10.0m/s
        // CONF: 94.6%
        const formatted = 
            "[ TARGET ACQUIRED ]\n" +
            "ID: " + this.targetId + "\n" +
            "RNG: " + distM.toFixed(1) + "m\n" +
            "VEL: " + velMps.toFixed(1) + "m/s\n" +
            "CONF: " + confPct.toFixed(1) + "%";

        this.telemetryText.text = formatted;
    }

    // =========================================================================
    // 3D RETICLE WIREFRAME & CORNER BRACKET RENDERING
    // =========================================================================

    /**
     * Renders tactical 3D corner brackets and bounding wireframe around the target.
     * Uses pre-allocated scratch vectors to guarantee ZERO heap allocations.
     */
    private render3DReticle(distanceM: number): void {
        const debug = global.debugRenderSystem;
        if (!debug) return;

        // Drone bounding dimensions (40cm width x 10cm height x 60cm length)
        let halfW = 20.0;
        let halfH = 6.0;
        let halfL = 30.0;

        // Slight expansion with distance to keep corner brackets distinct
        if (this.enableDynamicScaling) {
            const expand = Math.max(1.0, Math.min(2.0, 1.0 + 0.15 * (distanceM - 3.0)));
            halfW *= expand;
            halfH *= expand;
            halfL *= expand;
        }

        const cx = this.scratchTargetPos.x;
        const cy = this.scratchTargetPos.y;
        const cz = this.scratchTargetPos.z;

        // 1. Draw Centered Wireframe Bounding Box in baseline Cyber Green (#00FF66)
        debug.drawBox(this.scratchTargetPos, halfW * 2.0, halfH * 2.0, halfL * 2.0, TargetTelemetry.COLOR_RETICLE);

        // 2. Draw 8 Tactical Corner Brackets (bracket arm length = 8cm, Zero Heap Allocations)
        const arm = 8.0;
        const signs = TargetTelemetry.CORNER_SIGNS;

        for (let i = 0; i < 8; i++) {
            const sx = signs[i][0];
            const sy = signs[i][1];
            const sz = signs[i][2];

            const ox = cx + sx * halfW;
            const oy = cy + sy * halfH;
            const oz = cz + sz * halfL;

            // X-arm
            this.scratchCornerA.x = ox; this.scratchCornerA.y = oy; this.scratchCornerA.z = oz;
            this.scratchCornerB.x = ox - sx * arm; this.scratchCornerB.y = oy; this.scratchCornerB.z = oz;
            debug.drawLine(this.scratchCornerA, this.scratchCornerB, TargetTelemetry.COLOR_CORNER);

            // Y-arm
            this.scratchCornerB.x = ox; this.scratchCornerB.y = oy - sy * arm; this.scratchCornerB.z = oz;
            debug.drawLine(this.scratchCornerA, this.scratchCornerB, TargetTelemetry.COLOR_CORNER);

            // Z-arm
            this.scratchCornerB.x = ox; this.scratchCornerB.y = oy; this.scratchCornerB.z = oz - sz * arm;
            debug.drawLine(this.scratchCornerA, this.scratchCornerB, TargetTelemetry.COLOR_CORNER);
        }
    }

    // =========================================================================
    // PUBLIC ACCESSORS FOR TESTING & INTEGRATION
    // =========================================================================

    public getCurrentDistance(): number {
        return this.cachedDistance;
    }

    public getCurrentVelocity(): number {
        return this.cachedVelocity;
    }

    public getCurrentConfidence(): number {
        return this.cachedConfidence;
    }
}

