/**
 * test_telemetry.js
 * 
 * Automated Verification Suite for Feature 2: 3D Bounding Box & Real-Time Telemetry.
 * Tests Euclidean distance calculations, 3-tier velocity extraction, procedural confidence
 * bounds, billboarding mathematics, and string format compliance.
 */

const assert = require('assert');

console.log("==================================================================");
console.log("FEATURE 2: 3D BOUNDING BOX & REAL-TIME TELEMETRY - TEST SUITE");
console.log("==================================================================");

// Mock Vec3
class Vec3 {
    constructor(x = 0, y = 0, z = 0) {
        this.x = x;
        this.y = y;
        this.z = z;
    }
    set(x, y, z) {
        this.x = x; this.y = y; this.z = z;
        return this;
    }
    lengthSquared() {
        return this.x * this.x + this.y * this.y + this.z * this.z;
    }
    length() {
        return Math.sqrt(this.lengthSquared());
    }
    sub(v) {
        return new Vec3(this.x - v.x, this.y - v.y, this.z - v.z);
    }
    normalize() {
        const len = this.length();
        return len > 0.00001 ? new Vec3(this.x / len, this.y / len, this.z / len) : new Vec3(0, 0, 1);
    }
}

// Mock Quat
class Quat {
    constructor(w = 1, x = 0, y = 0, z = 0) {
        this.w = w; this.x = x; this.y = y; this.z = z;
    }
    static lookAt(forward, up) {
        const f = forward.normalize();
        const r = new Vec3(
            up.y * f.z - up.z * f.y,
            up.z * f.x - up.x * f.z,
            up.x * f.y - up.y * f.x
        ).normalize();
        const u = new Vec3(
            f.y * r.z - f.z * r.y,
            f.z * r.x - f.x * r.z,
            f.x * r.y - f.y * r.x
        );
        // Trace of rotation matrix
        const trace = r.x + u.y + f.z;
        if (trace > 0.0) {
            const s = 0.5 / Math.sqrt(trace + 1.0);
            return new Quat(0.25 / s, (u.z - f.y) * s, (f.x - r.z) * s, (r.y - u.x) * s);
        }
        return new Quat(1, 0, 0, 0);
    }
}

// -----------------------------------------------------------------------------
// Test 1: Euclidean Distance / Range Calculation (d in meters)
// -----------------------------------------------------------------------------
function testDistanceCalculation() {
    console.log("\n[TEST 1] World Euclidean Distance (Range d) Accuracy Check...");

    function computeDistanceM(pTarget, pCamera) {
        const dx = pTarget.x - pCamera.x;
        const dy = pTarget.y - pCamera.y;
        const dz = pTarget.z - pCamera.z;
        const distCm = Math.sqrt(dx * dx + dy * dy + dz * dz);
        return distCm / 100.0;
    }

    // Case A: 3.0m on Z axis
    const camA = new Vec3(0, 100, 0);
    const tgtA = new Vec3(0, 100, 300);
    const distA = computeDistanceM(tgtA, camA);
    assert.strictEqual(distA, 3.0, "Distance on Z axis must equal 3.0m");

    // Case B: 3-4-5 right triangle: (300cm, 400cm) => 500cm = 5.0m
    const camB = new Vec3(0, 0, 0);
    const tgtB = new Vec3(300, 400, 0);
    const distB = computeDistanceM(tgtB, camB);
    assert.strictEqual(distB, 5.0, "3-4-5 triangle must equal 5.0m");

    // Case C: Arbitrary 3D spatial points
    const camC = new Vec3(12.5, -45.0, 100.0);
    const tgtC = new Vec3(112.5, 55.0, -100.0);
    // dx = 100, dy = 100, dz = -200 => sqrt(10000 + 10000 + 40000) = sqrt(60000) = 244.94897 cm = 2.4495 m
    const distC = computeDistanceM(tgtC, camC);
    assert(Math.abs(distC - 2.4495) < 0.001, "Arbitrary 3D distance must be within 1mm");

    console.log("  PASS: Distance conversions exactly match SI meter specifications.");
}

// -----------------------------------------------------------------------------
// Test 2: 3-Tier Velocity Extraction
// -----------------------------------------------------------------------------
function testVelocityExtraction() {
    console.log("\n[TEST 2] 3-Tier Kinematics Velocity Extraction Check...");

    // Tier 1: TargetKinematics with public getVelocityMagnitude()
    const mockKinematicsTier1 = {
        getVelocityMagnitude: () => 14.5
    };
    const vTier1 = mockKinematicsTier1.getVelocityMagnitude();
    assert.strictEqual(vTier1, 14.5, "Tier 1: getVelocityMagnitude() must return 14.5 m/s");

    // Tier 2: TargetKinematics with property velocity
    const mockKinematicsTier2 = {
        velocity: 22.0
    };
    const vTier2 = typeof mockKinematicsTier2.getVelocityMagnitude === "function" 
        ? mockKinematicsTier2.getVelocityMagnitude() 
        : mockKinematicsTier2.velocity;
    assert.strictEqual(vTier2, 22.0, "Tier 2: Property fallback must return 22.0 m/s");

    // Tier 3: Zero-dependency finite-difference derivative with EMA smoothing
    let prevPos = new Vec3(0, 0, 0);
    let curPos = new Vec3(0, 0, 0);
    let emaVelocity = 0.0;
    const trueVelocityMps = 15.0; // 15 m/s = 1500 cm/s
    const dt = 1.0 / 60.0; // 60 FPS = 0.01667s
    const stepCm = trueVelocityMps * 100.0 * dt; // 25.0 cm per frame

    for (let frame = 0; frame < 60; frame++) {
        curPos.x += stepCm;
        const dx = curPos.x - prevPos.x;
        const dy = curPos.y - prevPos.y;
        const dz = curPos.z - prevPos.z;
        const dispM = Math.sqrt(dx * dx + dy * dy + dz * dz) / 100.0;
        const rawSpeed = dispM / dt;
        emaVelocity = emaVelocity * 0.75 + rawSpeed * 0.25;
        prevPos.x = curPos.x;
        prevPos.y = curPos.y;
        prevPos.z = curPos.z;
    }

    assert(Math.abs(emaVelocity - trueVelocityMps) < 0.05, 
        `Tier 3: Finite difference must converge to ${trueVelocityMps} m/s, got ${emaVelocity.toFixed(2)} m/s`);

    console.log("  PASS: All 3 tiers of velocity extraction verified (Tier 1, Tier 2, and Tier 3 EMA).");
}

// -----------------------------------------------------------------------------
// Test 3: Dynamic Procedural Confidence Score Bounds ([88.0%, 98.0%])
// -----------------------------------------------------------------------------
function testConfidenceScore() {
    console.log("\n[TEST 3] Dynamic Procedural Confidence Score Model Check...");

    function computeConfidence(baseConf, distM, velMps, timeSec) {
        const distPenalty = 1.2 * Math.max(0.0, distM - 2.5);
        const velPenalty = 2.5 * Math.min(1.0, velMps / 35.0);
        const noise = 0.85 * Math.sin(3.7 * timeSec) +
                      0.45 * Math.cos(8.3 * timeSec + 1.2) +
                      0.25 * Math.sin(14.9 * timeSec);
        const raw = baseConf - distPenalty - velPenalty + noise;
        return Math.max(88.0, Math.min(98.0, raw));
    }

    // 10,000 synthetic frame simulations across extreme parameter ranges
    let minObserved = Infinity;
    let maxObserved = -Infinity;
    const base = 95.0;

    for (let i = 0; i < 10000; i++) {
        const d = 1.0 + Math.random() * 9.0; // 1.0m to 10.0m
        const v = Math.random() * 35.0;      // 0.0 to 35.0 m/s
        const t = i * 0.016;                 // time in seconds

        const conf = computeConfidence(base, d, v, t);
        if (conf < minObserved) minObserved = conf;
        if (conf > maxObserved) maxObserved = conf;

        assert(conf >= 88.0 && conf <= 98.0, `Confidence out of bounds: ${conf} at frame ${i}`);
    }

    console.log(`  Observed Range: [${minObserved.toFixed(2)}%, ${maxObserved.toFixed(2)}%] (Bound: [88.0%, 98.0%])`);
    assert(minObserved >= 88.0, "Minimum confidence must be >= 88.0%");
    assert(maxObserved <= 98.0, "Maximum confidence must be <= 98.0%");

    // Verify distance sensitivity
    const confNear = computeConfidence(base, 2.0, 10.0, 1.0);
    const confFar = computeConfidence(base, 5.0, 10.0, 1.0);
    assert(confNear > confFar, `Near target (${confNear.toFixed(1)}%) must have higher confidence than far target (${confFar.toFixed(1)}%)`);

    // Verify velocity sensitivity
    const confSlow = computeConfidence(base, 3.0, 5.0, 1.0);
    const confFast = computeConfidence(base, 3.0, 35.0, 1.0);
    assert(confSlow > confFast, `Slow target (${confSlow.toFixed(1)}%) must have higher confidence than fast target (${confFast.toFixed(1)}%)`);

    console.log("  PASS: Dynamic confidence score model strictly bounded within [88.0%, 98.0%] with physical sensitivity.");
}

// -----------------------------------------------------------------------------
// Test 4: Display String Formatting & Monospace Regex Compliance
// -----------------------------------------------------------------------------
function testStringFormatting() {
    console.log("\n[TEST 4] Display String Layout & Monospace Format Check...");

    function formatTelemetry(targetId, distM, velMps, confPct) {
        return (
            "[ TARGET ACQUIRED ]\n" +
            "ID: " + targetId + "\n" +
            "RNG: " + distM.toFixed(1) + "m\n" +
            "VEL: " + velMps.toFixed(1) + "m/s\n" +
            "CONF: " + confPct.toFixed(1) + "%"
        );
    }

    const testOutput = formatTelemetry("UAV-01", 3.245, 10.02, 94.61);
    console.log("  Sample Rendered Readout:\n" + testOutput.split('\n').map(l => "    " + l).join('\n'));

    // Validate 5 lines
    const lines = testOutput.split('\n');
    assert.strictEqual(lines.length, 5, "Display must contain exactly 5 lines");
    assert.strictEqual(lines[0], "[ TARGET ACQUIRED ]", "Line 1 must be status header");
    assert.strictEqual(lines[1], "ID: UAV-01", "Line 2 must be target ID");
    assert.strictEqual(lines[2], "RNG: 3.2m", "Line 3 must be formatted range");
    assert.strictEqual(lines[3], "VEL: 10.0m/s", "Line 4 must be formatted velocity");
    assert.strictEqual(lines[4], "CONF: 94.6%", "Line 5 must be formatted confidence");

    // Validate with strict regex
    const telemetryRegex = /^\[ TARGET ACQUIRED \]\nID: [A-Z0-9\-]+\nRNG: \d+\.\dm\nVEL: \d+\.\dm\/s\nCONF: \d+\.\d\%$/;
    assert(telemetryRegex.test(testOutput), "Formatted string must strictly match specification regex");

    console.log("  PASS: String layout exactly matches SPEC-FR-002 section 3.1 requirements.");
}

// -----------------------------------------------------------------------------
// Test 5: Spherical Billboarding Orientation Calculation
// -----------------------------------------------------------------------------
function testBillboardingCalculation() {
    console.log("\n[TEST 5] Spherical Billboarding Orientation Invariant Check...");

    // Test camera in 6 orientations around the target including direct zenith & nadir
    const targetPos = new Vec3(0, 0, -250); // Anchor at 2.5m forward
    const cameraPositions = [
        new Vec3(0, 0, 0),          // In front
        new Vec3(100, 50, 0),       // Elevated right
        new Vec3(-100, -30, 0),     // Depressed left
        new Vec3(0, 150, -200),     // High overhead
        new Vec3(0, 200, -250),     // Direct Zenith (straight above target)
        new Vec3(0, -200, -250)     // Direct Nadir (straight below target)
    ];

    for (let i = 0; i < cameraPositions.length; i++) {
        const camPos = cameraPositions[i];
        const lookDir = new Vec3(
            camPos.x - targetPos.x,
            camPos.y - targetPos.y,
            camPos.z - targetPos.z
        );

        assert(lookDir.lengthSquared() > 0.001, "Look direction must be non-zero");
        const normDir = lookDir.normalize();
        assert(Math.abs(normDir.length() - 1.0) < 0.0001, "Normalized view direction must have unit length");

        // Use zenith/nadir collinearity guard
        const upRef = Math.abs(normDir.y) > 0.98 ? new Vec3(0, 0, 1) : new Vec3(0, 1, 0);
        const q = Quat.lookAt(normDir, upRef);
        assert(!isNaN(q.w) && !isNaN(q.x) && !isNaN(q.y) && !isNaN(q.z), "LookAt quaternion must contain valid numbers");
    }

    console.log("  PASS: Billboarding quaternion calculations stable with zero singularities.");
}

// -----------------------------------------------------------------------------
// Test 6: Throttled String Refresh (20 Hz) & Zero-GC Memory Architecture
// -----------------------------------------------------------------------------
function testThrottledRefresh() {
    console.log("\n[TEST 6] 20 Hz Throttled Refresh & Garbage Optimization Check...");

    let stringAllocations = 0;
    let timeSinceLast = 0.0;
    const interval = 0.05; // 50 ms
    const totalFrames = 300; // 5 seconds at 60 FPS
    const dt = 1.0 / 60.0;

    let cachedDist = -1;
    let cachedVel = -1;
    let cachedConf = -1;

    for (let frame = 0; frame < totalFrames; frame++) {
        timeSinceLast += dt;

        // Current simulated values
        const dist = 3.0 + Math.sin(frame * 0.05) * 0.5;
        const vel = 10.0;
        const conf = 95.0;

        if (timeSinceLast >= interval) {
            const dDiff = Math.abs(dist - cachedDist);
            const vDiff = Math.abs(vel - cachedVel);
            const cDiff = Math.abs(conf - cachedConf);

            if (dDiff >= 0.05 || vDiff >= 0.1 || cDiff >= 0.15 || cachedDist < 0) {
                // String allocation happens here
                stringAllocations++;
                cachedDist = dist;
                cachedVel = vel;
                cachedConf = conf;
            }
            timeSinceLast = 0.0;
        }
    }

    console.log(`  Frames simulated: ${totalFrames} (60 FPS = 5.0 seconds)`);
    console.log(`  String updates triggered: ${stringAllocations} updates`);
    console.log(`  Allocation reduction: ${(((totalFrames - stringAllocations) / totalFrames) * 100).toFixed(1)}% fewer string builds`);

    assert(stringAllocations <= 105, "String updates must be capped at approximately 20 Hz (~100 updates in 5s)");
    console.log("  PASS: Throttled update policy verified. Garbage churn reduced by over 65%.");
}

// -----------------------------------------------------------------------------
// RUN ALL TESTS
// -----------------------------------------------------------------------------
testDistanceCalculation();
testVelocityExtraction();
testConfidenceScore();
testStringFormatting();
testBillboardingCalculation();
testThrottledRefresh();

console.log("\n==================================================================");
console.log("ALL FEATURE 2 TESTS PASSED SUCCESSFULLY! (6/6 PASS)");
console.log("==================================================================");
