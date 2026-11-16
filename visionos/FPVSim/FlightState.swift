// The quad's newest state from the simulator and its extrapolation to the frame being drawn.
// Samples arrive at ~120 Hz from the page (src/visionos/nativeHost.ts, message 's'); the headset
// draws at 90-120 Hz on its own clock, so each frame takes the newest sample forward by its age.
import Foundation
import simd

struct FlightSample {
    /// when the page took it (ms since the epoch)
    var wallMs: Double = 0
    /// simulator time (s)
    var simT: Double = 0
    var position = SIMD3<Float>(0, 0, 0)
    var orientation = simd_quatf(ix: 0, iy: 0, iz: 0, r: 1)
    var velocity = SIMD3<Float>(0, 0, 0)
    /// body rates (rad/s) about the body's own axes, in the scene's mapping of them
    var bodyRates = SIMD3<Float>(0, 0, 0)
    var rpm = SIMD4<Float>(0, 0, 0, 0)
    var armed = false
    var replay = false

    init() {}

    /// [wallMs, t, px, py, pz, qx, qy, qz, qw, vx, vy, vz, wx, wy, wz, rpm0..3, armed, replay]
    init?(_ a: [Double]) {
        guard a.count >= 21 else { return nil }
        wallMs = a[0]; simT = a[1]
        position = SIMD3(Float(a[2]), Float(a[3]), Float(a[4]))
        orientation = simd_quatf(ix: Float(a[5]), iy: Float(a[6]), iz: Float(a[7]), r: Float(a[8]))
        velocity = SIMD3(Float(a[9]), Float(a[10]), Float(a[11]))
        bodyRates = SIMD3(Float(a[12]), Float(a[13]), Float(a[14]))
        rpm = SIMD4(Float(a[15]), Float(a[16]), Float(a[17]), Float(a[18]))
        armed = a[19] > 0.5; replay = a[20] > 0.5
    }
}

struct FlightState {
    private(set) var latest = FlightSample()
    private(set) var hasSample = false
    /// the simulator's clock is running (it stops in the menus)
    private(set) var running = false
    /// page clock -> this clock (ms): the smallest (arrival - stamp) seen lately, i.e. the stamp's own
    /// time here plus the shortest delivery. Samples are aged from their stamps, not from when they
    /// happened to arrive: a millisecond of delivery jitter is centimetres at racing speed.
    private var offsetMs = Double.infinity

    /// Looking this far past "now" (ms): roughly the time until the frame reaches the displays.
    var leadMs: Double = 11
    /// Never extrapolate further than this (ms): a stalled page must not fling the world away.
    var maxAheadMs: Double = 45

    mutating func push(_ s: FlightSample, arrivalMs: Double) {
        running = hasSample && s.simT != latest.simT
        // (the estimate creeps up so it follows a clock that drifts, and drops at once to a quicker delivery)
        offsetMs = min(offsetMs + 0.002, arrivalMs - s.wallMs)
        latest = s
        hasSample = true
    }

    /// Position and orientation at the frame being drawn; nowMs on the clock `arrivalMs` used.
    func pose(nowMs: Double) -> (SIMD3<Float>, simd_quatf) {
        guard hasSample, running, offsetMs.isFinite else { return (latest.position, latest.orientation) }
        let age = nowMs - (latest.wallMs + offsetMs)
        let dt = Float(min(maxAheadMs, max(0, age + leadMs)) / 1000)
        let p = latest.position + latest.velocity * dt
        let w = latest.bodyRates, rate = simd_length(w)
        var q = latest.orientation
        if rate > 1e-5 { q = simd_normalize(q * simd_quatf(angle: rate * dt, axis: w / rate)) }
        return (p, q)
    }
}
