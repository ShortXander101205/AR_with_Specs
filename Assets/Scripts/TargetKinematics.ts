/**
 * TargetKinematics.ts
 * 
 * Controls high-speed kinematic trajectories (5.0 m/s to 35.0 m/s) for simulated
 * UAV drone targets in a World AR anchored frame.
 * 
 * Complies with Feature 1 Specification: SPEC-FR-001
 * Target System: Snap Lens Studio 5.24+ (Spectacles / World AR)
 */
@component
export class TargetKinematics extends BaseScriptComponent {
    // =========================================================================
    // STATIC CONSTANTS & ZERO-GC PRE-ALLOCATED ASSETS
    // =========================================================================

    private static readonly COLOR_PATH = new vec4(0.0, 0.898, 1.0, 0.5);      // Cyan flight path
    private static readonly COLOR_START = new vec4(0.9, 0.2, 0.2, 0.9);      // Red start marker
    private static readonly COLOR_END = new vec4(0.2, 0.9, 0.3, 0.9);        // Green end marker
    private static readonly COLOR_VELOCITY = new vec4(1.0, 0.9, 0.0, 1.0);   // Yellow velocity vector
    private static readonly COLOR_BOX = new vec4(0.0, 0.9, 1.0, 0.85);       // Drone bounding proxy
    private static readonly COLOR_DECEL = new vec4(1.0, 0.5, 0.0, 0.4);      // Orange deceleration zone

    private static readonly DEBUG_SPLINE_SEGMENTS = 32;

    // =========================================================================
    // INSPECTOR INPUTS
    // =========================================================================

    @ui.group_start("Kinematics Configuration")

    /**
     * Target travel speed in meters per second (0.0 to 35.0 m/s).
     * Mapped to centimeters per second in engine space (v_engine = velocity * 100).
     */
    @input
    @label("Velocity (m/s)")
    @hint("Target travel speed in meters per second (0.0 to 35.0 m/s)")
    @widget(new SliderWidget(0.0, 35.0, 0.5))
    velocity: number = 10.0;

    /**
     * Stroke distance between boundaries in meters (2.0 to 5.0 m).
     * Mapped to centimeters in engine space (L_engine = pathLength * 100).
     */
    @input
    @label("Path Length (m)")
    @hint("Stroke distance between boundaries in meters (2.0 to 5.0 m)")
    @widget(new SliderWidget(2.0, 5.0, 0.1))
    pathLength: number = 3.0;

    /**
     * SceneObject representing the drone or target entity to displace.
     */
    @input
    @label("Target Entity")
    @hint("SceneObject representing the drone/target entity to displace")
    @allowUndefined
    targetObject: SceneObject | null = null;

    /**
     * Trajectory loop mode:
     * 0: Linear Ping-Pong with S-Curve boundary smoothing
     * 1: Continuous Closed-Loop (racetrack oval with smooth end-cap arcs)
     */
    @input
    @label("Motion Mode")
    @hint("Ping-Pong linear oscillation vs Continuous Closed-Loop")
    @widget(new ComboBoxWidget([
        new ComboBoxItem("Linear Ping-Pong", 0),
        new ComboBoxItem("Continuous Closed-Loop", 1)
    ]))
    motionMode: number = 0;

    /**
     * Travel vector axis in local anchor coordinates.
     */
    @input
    @label("Motion Axis")
    @hint("Direction vector of flight path in local anchor space")
    motionAxis: vec3 = new vec3(1.0, 0.0, 0.0);

    /**
     * Boundary buffer distance in meters for turnaround deceleration.
     */
    @input
    @label("Smoothing Zone (m)")
    @hint("Boundary buffer distance for turnaround deceleration (0.1 to 1.0 m)")
    @widget(new SliderWidget(0.1, 1.0, 0.05))
    smoothingZone: number = 0.4;

    /**
     * Automatically orient target forward vector along velocity heading.
     */
    @input
    @label("Auto-Orient Target")
    @hint("Align target forward heading with instantaneous velocity vector")
    autoOrientTarget: boolean = true;

    /**
     * Draw visual trajectory path, boundary limits, and velocity vector.
     */
    @input
    @label("Show Debug Trajectory")
    @hint("Draw real-time flight path and boundary markers in AR")
    showDebugTrajectory: boolean = true;

    @ui.group_end

    // =========================================================================
    // INTERNAL STATE VARIABLES & SCRATCH BUFFERS (ZERO-GC)
    // =========================================================================

    private direction: number = 1.0;                 // Current Ping-Pong direction (+1.0 or -1.0)
    private currentOffset: number = 0.0;              // Linear offset along axis in centimeters
    private loopDistance: number = 0.0;               // Accumulated perimeter distance for closed-loop
    private activeTarget: SceneObject | null = null;  // Resolved target SceneObject
    private initialLocalPosition: vec3 = new vec3(0.0, 0.0, 0.0); // Anchor reference origin
    private currentRotation: quat = quat.quatIdentity();
    private normalizedAxis: vec3 = new vec3(1.0, 0.0, 0.0);
    private lateralAxis: vec3 = new vec3(0.0, 0.0, 1.0);
    private upAxis: vec3 = new vec3(0.0, 1.0, 0.0);
    private hasWarnedMissingTarget: boolean = false;
    private isInitialized: boolean = false;

    // Zero-allocation scratch buffers reused every frame
    private localDisplacement: vec3 = new vec3(0.0, 0.0, 0.0);
    private instantaneousVelocity: vec3 = new vec3(0.0, 0.0, 0.0);
    private currentTargetPos: vec3 = new vec3(0.0, 0.0, 0.0);
    private forwardDirection: vec3 = new vec3(0.0, 0.0, 1.0);

    // Debug scratch buffers reused every frame
    private debugLineEnd: vec3 = new vec3(0.0, 0.0, 0.0);
    private debugStartPoint: vec3 = new vec3(0.0, 0.0, 0.0);
    private debugEndPoint: vec3 = new vec3(0.0, 0.0, 0.0);
    private debugDecelStart: vec3 = new vec3(0.0, 0.0, 0.0);
    private debugDecelEnd: vec3 = new vec3(0.0, 0.0, 0.0);
    private debugSplinePoints: vec3[] = [];

    // =========================================================================
    // ENGINE LIFECYCLE
    // =========================================================================

    onAwake(): void {
        // Pre-allocate closed-loop spline point buffer once to avoid per-frame allocations
        this.debugSplinePoints = [];
        for (let i = 0; i <= TargetKinematics.DEBUG_SPLINE_SEGMENTS; i++) {
            this.debugSplinePoints.push(new vec3(0.0, 0.0, 0.0));
        }

        this.initializeController();
        this.createEvent("UpdateEvent").bind(this.onUpdate.bind(this));
    }

    private initializeController(): void {
        const target = this.targetObject ?? this.getSceneObject();
        if (!target) {
            if (!this.hasWarnedMissingTarget) {
                print("[TargetKinematics] Notice: No target SceneObject found. Assign 'targetObject' in the Inspector.");
                this.hasWarnedMissingTarget = true;
            }
            return;
        }

        this.activeTarget = target;

        // Cache baseline origin transform
        const transform = this.activeTarget.getTransform();
        const originPos = transform.getLocalPosition();
        this.initialLocalPosition.x = originPos.x;
        this.initialLocalPosition.y = originPos.y;
        this.initialLocalPosition.z = originPos.z;

        const originRot = transform.getLocalRotation();
        this.currentRotation = quat.fromEulerAngles(0, 0, 0); // copy initial rotation safely
        this.currentRotation.x = originRot.x;
        this.currentRotation.y = originRot.y;
        this.currentRotation.z = originRot.z;
        this.currentRotation.w = originRot.w;

        // Calculate orthonormal frame for motion axes
        this.updateCoordinateFrame();

        this.direction = 1.0;
        this.currentOffset = 0.0;
        this.loopDistance = 0.0;
        this.isInitialized = true;
    }

    /**
     * Calculates orthonormal motion vectors (travel axis, lateral axis, up axis).
     */
    private updateCoordinateFrame(): void {
        let axis = new vec3(this.motionAxis.x, this.motionAxis.y, this.motionAxis.z);
        if (axis.lengthSquared < 0.0001) {
            axis = new vec3(1.0, 0.0, 0.0);
        }
        const norm = axis.normalize();
        this.normalizedAxis.x = norm.x;
        this.normalizedAxis.y = norm.y;
        this.normalizedAxis.z = norm.z;

        // Determine appropriate perpendicular lateral axis
        const worldUp = vec3.up();
        const dotUp = Math.abs(this.normalizedAxis.dot(worldUp));

        if (dotUp < 0.9) {
            const lat = this.normalizedAxis.cross(worldUp).normalize();
            this.lateralAxis.x = lat.x;
            this.lateralAxis.y = lat.y;
            this.lateralAxis.z = lat.z;

            const up = this.lateralAxis.cross(this.normalizedAxis).normalize();
            this.upAxis.x = up.x;
            this.upAxis.y = up.y;
            this.upAxis.z = up.z;
        } else {
            const worldForward = vec3.forward();
            const lat = this.normalizedAxis.cross(worldForward).normalize();
            this.lateralAxis.x = lat.x;
            this.lateralAxis.y = lat.y;
            this.lateralAxis.z = lat.z;

            const up = this.lateralAxis.cross(this.normalizedAxis).normalize();
            this.upAxis.x = up.x;
            this.upAxis.y = up.y;
            this.upAxis.z = up.z;
        }
    }

    /**
     * Per-frame simulation update cycle (Zero Heap Allocations).
     */
    private onUpdate(): void {
        if (!this.activeTarget) {
            this.initializeController();
            if (!this.activeTarget) return;
        }

        // Clamp delta time to protect against pause/backgrounding spikes (max 50ms)
        const rawDt = getDeltaTime();
        const dt = Math.max(0.0001, Math.min(rawDt, 0.05));

        // Convert user metric units to engine centimeters
        const lengthCm = Math.max(50.0, this.pathLength * 100.0);
        const speedCmPerSec = Math.max(0.0, this.velocity * 100.0);
        const smoothZoneCm = Math.max(5.0, Math.min(this.smoothingZone * 100.0, lengthCm * 0.45));

        // Guard for zero velocity (hold / paused position)
        if (speedCmPerSec <= 0.0001) {
            this.instantaneousVelocity.x = 0.0;
            this.instantaneousVelocity.y = 0.0;
            this.instantaneousVelocity.z = 0.0;

            this.currentTargetPos.x = this.initialLocalPosition.x + this.localDisplacement.x;
            this.currentTargetPos.y = this.initialLocalPosition.y + this.localDisplacement.y;
            this.currentTargetPos.z = this.initialLocalPosition.z + this.localDisplacement.z;

            this.activeTarget.getTransform().setLocalPosition(this.currentTargetPos);

            if (this.showDebugTrajectory && global.debugRenderSystem) {
                this.renderDebugVisuals(lengthCm, smoothZoneCm);
            }
            return;
        }

        if (this.motionMode === 0) {
            // =================================================================
            // MODE 0: LINEAR PING-PONG WITH S-CURVE BOUNDARY SMOOTHING
            // =================================================================
            const halfLength = lengthCm * 0.5;
            const fullPotentialStep = speedCmPerSec * dt;

            // Sub-step integration to ensure smooth turnaround even during frame drops
            const subSteps = Math.min(8, Math.max(1, Math.ceil(fullPotentialStep / (smoothZoneCm * 0.3))));
            const subDt = dt / subSteps;

            for (let i = 0; i < subSteps; i++) {
                const distToBoundary = halfLength - Math.abs(this.currentOffset);

                let speedMultiplier = 1.0;
                if (distToBoundary < smoothZoneCm) {
                    const normalizedRatio = Math.max(0.0, Math.min(1.0, distToBoundary / smoothZoneCm));
                    // Cosine S-curve ease-out: 0.5 * (1 - cos(pi * ratio))
                    speedMultiplier = Math.max(0.04, 0.5 * (1.0 - Math.cos(Math.PI * normalizedRatio)));
                }

                const step = this.direction * speedCmPerSec * speedMultiplier * subDt;
                this.currentOffset += step;

                // Turnaround threshold check
                if (this.currentOffset >= halfLength) {
                    this.currentOffset = halfLength;
                    this.direction = -1.0;
                } else if (this.currentOffset <= -halfLength) {
                    this.currentOffset = -halfLength;
                    this.direction = 1.0;
                }
            }

            // In-place displacement and velocity calculation
            this.localDisplacement.x = this.normalizedAxis.x * this.currentOffset;
            this.localDisplacement.y = this.normalizedAxis.y * this.currentOffset;
            this.localDisplacement.z = this.normalizedAxis.z * this.currentOffset;

            const velMag = this.direction * speedCmPerSec;
            this.instantaneousVelocity.x = this.normalizedAxis.x * velMag;
            this.instantaneousVelocity.y = this.normalizedAxis.y * velMag;
            this.instantaneousVelocity.z = this.normalizedAxis.z * velMag;

        } else {
            // =================================================================
            // MODE 1: CONTINUOUS CLOSED-LOOP (RACETRACK OVAL WITH SMOOTH ARCS)
            // =================================================================
            const straightStroke = lengthCm;
            const radius = smoothZoneCm;
            const semiCircumference = Math.PI * radius;
            const totalPerimeter = 2.0 * straightStroke + 2.0 * semiCircumference;

            this.loopDistance = (this.loopDistance + speedCmPerSec * dt) % totalPerimeter;
            const s = this.loopDistance;

            let posAlongAxis = 0.0;
            let posAlongLat = 0.0;
            let tangentAxis = 0.0;
            let tangentLat = 0.0;

            const halfStroke = straightStroke * 0.5;

            if (s < straightStroke) {
                // Segment 1: Forward linear stroke
                posAlongAxis = -halfStroke + s;
                posAlongLat = radius;
                tangentAxis = 1.0;
                tangentLat = 0.0;
            } else if (s < straightStroke + semiCircumference) {
                // Segment 2: Turnaround semicircular arc (+X end)
                const arcDistance = s - straightStroke;
                const theta = (Math.PI * 0.5) - (arcDistance / radius);
                posAlongAxis = halfStroke + radius * Math.cos(theta);
                posAlongLat = radius * Math.sin(theta);
                tangentAxis = -Math.sin(theta);
                tangentLat = Math.cos(theta);
            } else if (s < 2.0 * straightStroke + semiCircumference) {
                // Segment 3: Return linear stroke
                const returnDist = s - (straightStroke + semiCircumference);
                posAlongAxis = halfStroke - returnDist;
                posAlongLat = -radius;
                tangentAxis = -1.0;
                tangentLat = 0.0;
            } else {
                // Segment 4: Turnaround semicircular arc (-X end)
                const arcDistance = s - (2.0 * straightStroke + semiCircumference);
                const theta = -(Math.PI * 0.5) - (arcDistance / radius);
                posAlongAxis = -halfStroke + radius * Math.cos(theta);
                posAlongLat = radius * Math.sin(theta);
                tangentAxis = -Math.sin(theta);
                tangentLat = Math.cos(theta);
            }

            // In-place displacement and velocity calculation
            this.localDisplacement.x = this.normalizedAxis.x * posAlongAxis + this.lateralAxis.x * posAlongLat;
            this.localDisplacement.y = this.normalizedAxis.y * posAlongAxis + this.lateralAxis.y * posAlongLat;
            this.localDisplacement.z = this.normalizedAxis.z * posAlongAxis + this.lateralAxis.z * posAlongLat;

            this.instantaneousVelocity.x = (this.normalizedAxis.x * tangentAxis + this.lateralAxis.x * tangentLat) * speedCmPerSec;
            this.instantaneousVelocity.y = (this.normalizedAxis.y * tangentAxis + this.lateralAxis.y * tangentLat) * speedCmPerSec;
            this.instantaneousVelocity.z = (this.normalizedAxis.z * tangentAxis + this.lateralAxis.z * tangentLat) * speedCmPerSec;
        }

        // In-place local position update
        const transform = this.activeTarget.getTransform();
        this.currentTargetPos.x = this.initialLocalPosition.x + this.localDisplacement.x;
        this.currentTargetPos.y = this.initialLocalPosition.y + this.localDisplacement.y;
        this.currentTargetPos.z = this.initialLocalPosition.z + this.localDisplacement.z;
        transform.setLocalPosition(this.currentTargetPos);

        // Apply heading orientation if enabled
        const velSq = this.instantaneousVelocity.lengthSquared;
        if (this.autoOrientTarget && velSq > 1.0) {
            const invLen = 1.0 / Math.sqrt(velSq);
            this.forwardDirection.x = this.instantaneousVelocity.x * invLen;
            this.forwardDirection.y = this.instantaneousVelocity.y * invLen;
            this.forwardDirection.z = this.instantaneousVelocity.z * invLen;

            const targetRotation = quat.lookAt(this.forwardDirection, this.upAxis);
            const slerpFactor = Math.min(1.0, 12.0 * dt);
            this.currentRotation = quat.slerp(this.currentRotation, targetRotation, slerpFactor);
            transform.setLocalRotation(this.currentRotation);
        }

        // Render real-time spatial trajectory & boundary debug visuals (Zero Allocations)
        if (this.showDebugTrajectory && global.debugRenderSystem) {
            this.renderDebugVisuals(lengthCm, smoothZoneCm);
        }
    }

    /**
     * Renders real-time spatial debug lines, boundary datum markers, and UAV bounding box.
     * Reuses pre-allocated scratch vectors and static colors to ensure ZERO GC allocations.
     */
    private renderDebugVisuals(lengthCm: number, smoothZoneCm: number): void {
        const debug = global.debugRenderSystem;
        const halfLength = lengthCm * 0.5;

        // 1. Draw Target UAV Geometric Bounding Box (40 x 10 x 60 cm)
        debug.drawBox(this.currentTargetPos, 40.0, 10.0, 60.0, TargetKinematics.COLOR_BOX);

        // 2. Draw Instantaneous Velocity Vector (scaled for visibility)
        if (this.instantaneousVelocity.lengthSquared > 1.0) {
            this.debugLineEnd.x = this.currentTargetPos.x + this.instantaneousVelocity.x * 0.08;
            this.debugLineEnd.y = this.currentTargetPos.y + this.instantaneousVelocity.y * 0.08;
            this.debugLineEnd.z = this.currentTargetPos.z + this.instantaneousVelocity.z * 0.08;
            debug.drawLine(this.currentTargetPos, this.debugLineEnd, TargetKinematics.COLOR_VELOCITY);
        }

        if (this.motionMode === 0) {
            // Mode 0: Linear Path Line and Boundaries
            this.debugStartPoint.x = this.initialLocalPosition.x - this.normalizedAxis.x * halfLength;
            this.debugStartPoint.y = this.initialLocalPosition.y - this.normalizedAxis.y * halfLength;
            this.debugStartPoint.z = this.initialLocalPosition.z - this.normalizedAxis.z * halfLength;

            this.debugEndPoint.x = this.initialLocalPosition.x + this.normalizedAxis.x * halfLength;
            this.debugEndPoint.y = this.initialLocalPosition.y + this.normalizedAxis.y * halfLength;
            this.debugEndPoint.z = this.initialLocalPosition.z + this.normalizedAxis.z * halfLength;

            debug.drawLine(this.debugStartPoint, this.debugEndPoint, TargetKinematics.COLOR_PATH);
            debug.drawSphere(this.debugStartPoint, 6.0, TargetKinematics.COLOR_START);
            debug.drawSphere(this.debugEndPoint, 6.0, TargetKinematics.COLOR_END);

            // Deceleration boundary markers
            const decelDist = halfLength - smoothZoneCm;
            this.debugDecelStart.x = this.initialLocalPosition.x + this.normalizedAxis.x * decelDist;
            this.debugDecelStart.y = this.initialLocalPosition.y + this.normalizedAxis.y * decelDist;
            this.debugDecelStart.z = this.initialLocalPosition.z + this.normalizedAxis.z * decelDist;

            this.debugDecelEnd.x = this.initialLocalPosition.x - this.normalizedAxis.x * decelDist;
            this.debugDecelEnd.y = this.initialLocalPosition.y - this.normalizedAxis.y * decelDist;
            this.debugDecelEnd.z = this.initialLocalPosition.z - this.normalizedAxis.z * decelDist;

            debug.drawSphere(this.debugDecelStart, 4.0, TargetKinematics.COLOR_DECEL);
            debug.drawSphere(this.debugDecelEnd, 4.0, TargetKinematics.COLOR_DECEL);

        } else {
            // Mode 1: Closed-Loop Racetrack Path using pre-allocated point buffer
            const straightStroke = lengthCm;
            const radius = smoothZoneCm;
            const semiCircumference = Math.PI * radius;
            const totalPerimeter = 2.0 * straightStroke + 2.0 * semiCircumference;
            const segments = TargetKinematics.DEBUG_SPLINE_SEGMENTS;

            for (let i = 0; i <= segments; i++) {
                const s = (i / segments) * totalPerimeter;
                const halfStroke = straightStroke * 0.5;
                let axisDisp = 0.0;
                let latDisp = 0.0;

                if (s < straightStroke) {
                    axisDisp = -halfStroke + s;
                    latDisp = radius;
                } else if (s < straightStroke + semiCircumference) {
                    const arcDistance = s - straightStroke;
                    const theta = (Math.PI * 0.5) - (arcDistance / radius);
                    axisDisp = halfStroke + radius * Math.cos(theta);
                    latDisp = radius * Math.sin(theta);
                } else if (s < 2.0 * straightStroke + semiCircumference) {
                    const returnDist = s - (straightStroke + semiCircumference);
                    axisDisp = halfStroke - returnDist;
                    latDisp = -radius;
                } else {
                    const arcDistance = s - (2.0 * straightStroke + semiCircumference);
                    const theta = -(Math.PI * 0.5) - (arcDistance / radius);
                    axisDisp = -halfStroke + radius * Math.cos(theta);
                    latDisp = radius * Math.sin(theta);
                }

                const pt = this.debugSplinePoints[i];
                pt.x = this.initialLocalPosition.x + this.normalizedAxis.x * axisDisp + this.lateralAxis.x * latDisp;
                pt.y = this.initialLocalPosition.y + this.normalizedAxis.y * axisDisp + this.lateralAxis.y * latDisp;
                pt.z = this.initialLocalPosition.z + this.normalizedAxis.z * axisDisp + this.lateralAxis.z * latDisp;
            }

            // Draw line segments connecting pre-allocated points
            for (let i = 0; i < segments; i++) {
                debug.drawLine(this.debugSplinePoints[i], this.debugSplinePoints[i + 1], TargetKinematics.COLOR_PATH);
            }
        }
    }

    // =========================================================================
    // PUBLIC TELEMETRY ACCESSORS (SPEC-FR-002)
    // =========================================================================

    /**
     * Returns instantaneous linear velocity magnitude in meters per second (m/s).
     * Complies with Feature 2 SPEC-FR-002 telemetry readout interface.
     */
    public getVelocityMagnitude(): number {
        return Math.sqrt(this.instantaneousVelocity.lengthSquared) / 100.0;
    }

    /**
     * Copies instantaneous linear velocity vector (in cm/s) into the provided vector
     * or returns a new vec3 instance.
     */
    public getInstantaneousVelocity(out?: vec3): vec3 {
        if (out) {
            out.x = this.instantaneousVelocity.x;
            out.y = this.instantaneousVelocity.y;
            out.z = this.instantaneousVelocity.z;
            return out;
        }
        return new vec3(this.instantaneousVelocity.x, this.instantaneousVelocity.y, this.instantaneousVelocity.z);
    }
}
