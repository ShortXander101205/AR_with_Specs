import { TargetKinematics } from "./TargetKinematics";
import { TargetTelemetry } from "./TargetTelemetry";

/**
 * SpatialRangeSetup.ts
 * 
 * Automates the construction and validation of the World AR spatial range hierarchy:
 * World Tracking Camera -> World Anchor -> Kinematic Target -> TargetKinematics
 * 
 * Complies with Feature 1 Specification: SPEC-FR-001 & Plan: PLAN-FR-001
 * Target System: Snap Lens Studio 5.24+ (Spectacles / World AR)
 */
@component
export class SpatialRangeSetup extends BaseScriptComponent {
    @ui.group_start("Spatial Test Range Auto-Setup")

    @input
    @label("Auto-Provision Hierarchy")
    @hint("Automatically create World Anchor and Kinematic Target nodes if missing")
    autoProvisionHierarchy: boolean = true;

    @input
    @label("Anchor Distance (m)")
    @hint("Forward placement distance of World Anchor in front of user (default: 2.5m)")
    @widget(new SliderWidget(1.0, 5.0, 0.25))
    anchorDistance: number = 2.5;

    @input
    @label("Anchor Elevation (m)")
    @hint("Vertical height offset relative to camera eye-level (default: -0.2m / slightly below eyes)")
    @widget(new SliderWidget(-1.5, 1.0, 0.1))
    anchorElevation: number = -0.2;

    @ui.group_end

    private worldAnchor: SceneObject | null = null;
    private kinematicTarget: SceneObject | null = null;
    private kinematicsController: TargetKinematics | null = null;

    onAwake(): void {
        if (this.autoProvisionHierarchy) {
            this.provisionHierarchy();
        }
    }

    /**
     * Constructs the isolated World AR anchor and kinematic drone hierarchy.
     */
    public provisionHierarchy(): void {
        print("[SpatialRangeSetup] Provisioning Feature 1 Scene Graph Hierarchy...");

        // 1. Locate or create 'World Anchor'
        this.worldAnchor = this.findSceneObjectByName("World Anchor");
        if (!this.worldAnchor) {
            this.worldAnchor = global.scene.createSceneObject("World Anchor");
            print("[SpatialRangeSetup] Created 'World Anchor' SceneObject.");
        }

        // Configure anchor transform (placed in front of user at comfortable viewing altitude)
        const anchorTransform = this.worldAnchor.getTransform();
        const forwardDistanceCm = this.anchorDistance * 100.0;
        const elevationCm = this.anchorElevation * 100.0;
        
        // In Lens Studio, viewer faces world -Z by default
        anchorTransform.setLocalPosition(new vec3(0.0, elevationCm, -forwardDistanceCm));
        anchorTransform.setLocalRotation(quat.quatIdentity());
        anchorTransform.setLocalScale(vec3.one());

        // 2. Locate or create 'KinematicTarget'
        this.kinematicTarget = this.findSceneObjectByName("KinematicTarget");
        if (!this.kinematicTarget) {
            this.kinematicTarget = global.scene.createSceneObject("KinematicTarget");
            this.kinematicTarget.setParent(this.worldAnchor);
            print("[SpatialRangeSetup] Created 'KinematicTarget' SceneObject parented to 'World Anchor'.");
        } else {
            this.kinematicTarget.setParent(this.worldAnchor);
        }

        // Initialize target transform at local origin of World Anchor
        const targetTransform = this.kinematicTarget.getTransform();
        targetTransform.setLocalPosition(vec3.zero());
        targetTransform.setLocalRotation(quat.quatIdentity());
        targetTransform.setLocalScale(vec3.one());

        // 3. Attach or retrieve TargetKinematics component
        this.kinematicsController = this.kinematicTarget.getComponent(TargetKinematics.getTypeName());
        if (!this.kinematicsController) {
            this.kinematicsController = this.kinematicTarget.createComponent(TargetKinematics.getTypeName());
            print("[SpatialRangeSetup] Attached 'TargetKinematics' component to 'KinematicTarget'.");
        }

        if (this.kinematicsController) {
            this.kinematicsController.targetObject = this.kinematicTarget;
            this.kinematicsController.velocity = 10.0; // 10.0 m/s default
            this.kinematicsController.pathLength = 3.0; // 3.0 m stroke
            this.kinematicsController.showDebugTrajectory = true;
        }

        // 4. Locate or create 'TelemetryHUD' (Feature 2)
        let telemetryHud = this.findSceneObjectByName("TelemetryHUD");
        if (!telemetryHud) {
            telemetryHud = global.scene.createSceneObject("TelemetryHUD");
            telemetryHud.setParent(this.kinematicTarget);
            print("[SpatialRangeSetup] Created 'TelemetryHUD' SceneObject parented to 'KinematicTarget'.");
        } else {
            telemetryHud.setParent(this.kinematicTarget);
        }

        const hudTransform = telemetryHud.getTransform();
        hudTransform.setLocalPosition(new vec3(0.0, 25.0, 0.0)); // 25cm above target
        hudTransform.setLocalRotation(quat.quatIdentity());
        hudTransform.setLocalScale(vec3.one());

        // 5. Attach or retrieve Component.Text
        let textComp = telemetryHud.getComponent("Component.Text") as Component.Text;
        if (!textComp) {
            textComp = telemetryHud.createComponent("Component.Text") as Component.Text;
            print("[SpatialRangeSetup] Attached 'Component.Text' to 'TelemetryHUD'.");
        }

        // 6. Attach or retrieve TargetTelemetry component
        let telemetryController = telemetryHud.getComponent(TargetTelemetry.getTypeName());
        if (!telemetryController) {
            telemetryController = telemetryHud.createComponent(TargetTelemetry.getTypeName());
            print("[SpatialRangeSetup] Attached 'TargetTelemetry' component to 'TelemetryHUD'.");
        }

        if (telemetryController) {
            telemetryController.targetObject = this.kinematicTarget;
            telemetryController.telemetryText = textComp;
            telemetryController.baseConfidence = 95.0;
            telemetryController.targetId = "UAV-01";
            telemetryController.verticalOffset = 25.0;
            telemetryController.show3DReticle = true;
            telemetryController.enableDynamicScaling = true;
        }

        print("[SpatialRangeSetup] Feature 1 & Feature 2 Scene Graph hierarchy successfully established!");
    }

    /**
     * Searches all scene objects in current scene matching specified name.
     */
    private findSceneObjectByName(name: string): SceneObject | null {
        const rootCount = global.scene.getRootObjectsCount();
        for (let i = 0; i < rootCount; i++) {
            const root = global.scene.getRootObject(i);
            const found = this.searchInHierarchy(root, name);
            if (found) return found;
        }
        return null;
    }

    private searchInHierarchy(obj: SceneObject, name: string): SceneObject | null {
        if (obj.name === name) return obj;
        const childCount = obj.getChildrenCount();
        for (let i = 0; i < childCount; i++) {
            const child = obj.getChild(i);
            const found = this.searchInHierarchy(child, name);
            if (found) return found;
        }
        return null;
    }
}

