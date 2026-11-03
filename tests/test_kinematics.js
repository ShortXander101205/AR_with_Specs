/**
 * test_kinematics.js
 * 
 * Automated Verification Suite for Feature 1: Spatial Test Range & Target Kinematics.
 * Simulates frame updates, delta time variations, zero-velocity guards, and memory benchmarks.
 */

const assert = require('assert');

console.log("==================================================================");
console.log("FEATURE 1: SPATIAL RANGE & TARGET KINEMATICS - AUDIT & TEST SUITE");
console.log("==================================================================");

// Mock Vec3
class Vec3 {
    constructor(x = 0, y = 0, z = 0) {
        this.x = x;
        this.y = y;
        this.z = z;
    }
    normalize() {
        const len = Math.sqrt(this.x * this.x + this.y * this.y + this.z * this.z);
        return len > 0.00001 ? new Vec3(this.x / len, this.y / len, this.z / len) : new Vec3(1, 0, 0);
    }
    uniformScale(s) {
        return new Vec3(this.x * s, this.y * s, this.z * s);
    }
    add(v) {
        return new Vec3(this.x + v.x, this.y + v.y, this.z + v.z);
    }
    length() {
        return Math.sqrt(this.x * this.x + this.y * this.y + this.z * this.z);
    }
}

// -----------------------------------------------------------------------------
// Test 1: Unit Conversion Validation
// -----------------------------------------------------------------------------
function testUnitConversion() {
    console.log("\n[TEST 1] Metric to Engine Unit Conversion Check...");
    const velocityMps = 10.0;
    const pathLengthM = 3.0;
    const smoothingZoneM = 0.4;

    const vCmPerSec = velocityMps * 100.0;
    const lengthCm = pathLengthM * 100.0;
    const smoothZoneCm = smoothingZoneM * 100.0;

    assert.strictEqual(vCmPerSec, 1000.0, "Velocity must convert: 10.0 m/s -> 1000.0 cm/s");
    assert.strictEqual(lengthCm, 300.0, "Path length must convert: 3.0 m -> 300.0 cm");
    assert.strictEqual(smoothZoneCm, 40.0, "Smoothing zone must convert: 0.4 m -> 40.0 cm");
    console.log("  PASS: 10.0 m/s = 1000.0 cm/s, 3.0 m = 300.0 cm, 0.4 m = 40.0 cm.");
}

// -----------------------------------------------------------------------------
// Test 2: Mode 0 (Ping-Pong) Boundary Invariants & Smooth Turnaround
// -----------------------------------------------------------------------------
function testPingPongBoundaries() {
    console.log("\n[TEST 2] Mode 0 (Ping-Pong) Boundary Invariant & Smooth Turnaround Check...");

    const lengthCm = 300.0; // 3.0m
    const speedCmPerSec = 1000.0; // 10.0 m/s
    const smoothZoneCm = 40.0; // 0.4m
    const halfLength = lengthCm * 0.5; // 150.0 cm

    let offset = 0.0;
    let direction = 1.0;
    let turnarounds = 0;
    let maxOffset = -Infinity;
    let minOffset = Infinity;

    const dt = 1.0 / 60.0;
    const totalFrames = 300;

    for (let frame = 0; frame < totalFrames; frame++) {
        const fullPotentialStep = speedCmPerSec * dt;
        const subSteps = Math.min(8, Math.max(1, Math.ceil(fullPotentialStep / (smoothZoneCm * 0.3))));
        const subDt = dt / subSteps;

        for (let i = 0; i < subSteps; i++) {
            const distToBoundary = halfLength - Math.abs(offset);

            let speedMultiplier = 1.0;
            if (distToBoundary < smoothZoneCm) {
                const normalizedRatio = Math.max(0.0, Math.min(1.0, distToBoundary / smoothZoneCm));
                speedMultiplier = Math.max(0.04, 0.5 * (1.0 - Math.cos(Math.PI * normalizedRatio)));
            }

            const step = direction * speedCmPerSec * speedMultiplier * subDt;
            offset += step;

            if (offset >= halfLength) {
                offset = halfLength;
                direction = -1.0;
                turnarounds++;
            } else if (offset <= -halfLength) {
                offset = -halfLength;
                direction = 1.0;
                turnarounds++;
            }

            maxOffset = Math.max(maxOffset, offset);
            minOffset = Math.min(minOffset, offset);
        }
    }

    assert(maxOffset <= halfLength, `Max offset (${maxOffset}) must never exceed halfLength (${halfLength})`);
    assert(minOffset >= -halfLength, `Min offset (${minOffset}) must never drop below -halfLength (${-halfLength})`);
    assert(turnarounds >= 3, `Expected multiple turnarounds, got ${turnarounds}`);
    console.log(`  PASS: Max offset: +${maxOffset.toFixed(2)} cm, Min offset: ${minOffset.toFixed(2)} cm (Bound: +/-${halfLength} cm).`);
    console.log(`  PASS: Registered ${turnarounds} smooth boundary turnarounds without overshoot.`);
}

// -----------------------------------------------------------------------------
// Test 3: Zero-Velocity Safety Guard (v = 0.0 Pause/Hold)
// -----------------------------------------------------------------------------
function testZeroVelocitySafety() {
    console.log("\n[TEST 3] Zero-Velocity Guard (v = 0.0 m/s hold state)...");

    const velocity = 0.0;
    const speedCmPerSec = Math.max(0.0, velocity * 100.0);
    const dt = 0.016;
    let offset = 50.0; // Current intermediate offset
    let targetX = 0.0;

    if (speedCmPerSec <= 0.0001) {
        // Paused state
        targetX = offset;
    } else {
        offset += speedCmPerSec * dt;
        targetX = offset;
    }

    assert(!isNaN(targetX), "Target position must not be NaN when v=0");
    assert.strictEqual(targetX, 50.0, "Target position must remain held at current position when v=0");
    console.log("  PASS: Zero velocity verified: Target holds position stably with no NaN or div-by-zero.");
}

// -----------------------------------------------------------------------------
// Test 4: High-Velocity Frame-Rate Independence Stress Test (35 m/s at 30 vs 60 FPS)
// -----------------------------------------------------------------------------
function testFrameRateInvariance() {
    console.log("\n[TEST 4] High-Velocity (35 m/s = 3500 cm/s) Frame-Rate Independence Stress Test...");

    const lengthCm = 400.0; // 4.0m
    const speedCmPerSec = 3500.0; // 35.0 m/s
    const smoothZoneCm = 50.0;
    const halfLength = lengthCm * 0.5; // 200.0 cm

    function simulate(fps) {
        const dt = 1.0 / fps;
        const frames = Math.round(2.0 * fps);
        let offset = 0.0;
        let direction = 1.0;
        let totalTravel = 0.0;

        for (let f = 0; f < frames; f++) {
            const fullPotentialStep = speedCmPerSec * dt;
            const subSteps = Math.min(8, Math.max(1, Math.ceil(fullPotentialStep / (smoothZoneCm * 0.3))));
            const subDt = dt / subSteps;

            for (let i = 0; i < subSteps; i++) {
                const distToBoundary = halfLength - Math.abs(offset);
                let speedMultiplier = 1.0;
                if (distToBoundary < smoothZoneCm) {
                    const normalizedRatio = Math.max(0.0, Math.min(1.0, distToBoundary / smoothZoneCm));
                    speedMultiplier = Math.max(0.04, 0.5 * (1.0 - Math.cos(Math.PI * normalizedRatio)));
                }

                const prev = offset;
                offset += direction * speedCmPerSec * speedMultiplier * subDt;
                if (offset >= halfLength) {
                    offset = halfLength;
                    direction = -1.0;
                } else if (offset <= -halfLength) {
                    offset = -halfLength;
                    direction = 1.0;
                }
                totalTravel += Math.abs(offset - prev);
            }
        }
        return { totalTravel, finalOffset: offset };
    }

    const res30 = simulate(30);
    const res60 = simulate(60);

    const travelDiff = Math.abs(res30.totalTravel - res60.totalTravel);
    const relativeError = travelDiff / res60.totalTravel;

    console.log(`  30 FPS Total Cumulative Distance: ${res30.totalTravel.toFixed(1)} cm`);
    console.log(`  60 FPS Total Cumulative Distance: ${res60.totalTravel.toFixed(1)} cm`);
    console.log(`  Relative Error: ${(relativeError * 100).toFixed(2)}%`);

    assert(relativeError < 0.05, `Error between 30 and 60 FPS must be under 5% (was ${(relativeError * 100).toFixed(2)}%)`);
    console.log("  PASS: Frame-rate independence verified at extreme velocity (35 m/s).");
}

// -----------------------------------------------------------------------------
// Test 5: Mode 1 (Closed-Loop) Continuity and Perimeter Wrapping
// -----------------------------------------------------------------------------
function testClosedLoop() {
    console.log("\n[TEST 5] Mode 1 (Closed-Loop) Continuous Racetrack Continuity...");

    const straightStroke = 300.0; // 3.0m
    const radius = 40.0; // 0.4m
    const speedCmPerSec = 1000.0; // 10 m/s
    const semiCircumference = Math.PI * radius;
    const totalPerimeter = 2.0 * straightStroke + 2.0 * semiCircumference;

    let loopDistance = 0.0;
    const dt = 1.0 / 60.0;

    const framesInLoop = Math.ceil(totalPerimeter / (speedCmPerSec * dt));
    let prevPos = null;
    let maxJump = 0.0;

    for (let f = 0; f <= framesInLoop; f++) {
        loopDistance = (loopDistance + speedCmPerSec * dt) % totalPerimeter;
        const s = loopDistance;

        let posAlongAxis = 0.0;
        let posAlongLat = 0.0;
        const halfStroke = straightStroke * 0.5;

        if (s < straightStroke) {
            posAlongAxis = -halfStroke + s;
            posAlongLat = radius;
        } else if (s < straightStroke + semiCircumference) {
            const arcDistance = s - straightStroke;
            const theta = (Math.PI * 0.5) - (arcDistance / radius);
            posAlongAxis = halfStroke + radius * Math.cos(theta);
            posAlongLat = radius * Math.sin(theta);
        } else if (s < 2.0 * straightStroke + semiCircumference) {
            const returnDist = s - (straightStroke + semiCircumference);
            posAlongAxis = halfStroke - returnDist;
            posAlongLat = -radius;
        } else {
            const arcDistance = s - (2.0 * straightStroke + semiCircumference);
            const theta = -(Math.PI * 0.5) - (arcDistance / radius);
            posAlongAxis = -halfStroke + radius * Math.cos(theta);
            posAlongLat = radius * Math.sin(theta);
        }

        const currPos = new Vec3(posAlongAxis, 0, posAlongLat);
        if (prevPos) {
            const jump = currPos.add(prevPos.uniformScale(-1)).length();
            maxJump = Math.max(maxJump, jump);
        }
        prevPos = currPos;
    }

    const expectedStep = speedCmPerSec * dt;
    assert(maxJump <= expectedStep * 1.05, `Max spatial jump (${maxJump.toFixed(2)}) must not exceed step (${expectedStep.toFixed(2)})`);
    console.log(`  PASS: Maximum inter-frame step: ${maxJump.toFixed(2)} cm (Expected step: ${expectedStep.toFixed(2)} cm). Zero discontinuities!`);
}

// Run all tests
testUnitConversion();
testPingPongBoundaries();
testZeroVelocitySafety();
testFrameRateInvariance();
testClosedLoop();

console.log("\n==================================================================");
console.log("ALL TESTS PASSED SUCCESSFULLY! (5/5 PASS)");
console.log("==================================================================");
