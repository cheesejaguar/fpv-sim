import Foundation
import simd

extension simd_float4x4 {
    static let identity = matrix_identity_float4x4

    init(translation t: SIMD3<Float>) {
        self = matrix_identity_float4x4
        columns.3 = SIMD4(t.x, t.y, t.z, 1)
    }

    init(yaw a: Float) {
        self.init(simd_quatf(angle: a, axis: SIMD3(0, 1, 0)))
    }

    init(uniformScale s: Float) {
        self.init(diagonal: SIMD4(s, s, s, 1))
    }

    /// Column-major 16 floats, as Three.js Matrix4.elements.
    init?(columnMajor e: [Float]) {
        guard e.count == 16 else { return nil }
        self.init(columns: (SIMD4(e[0], e[1], e[2], e[3]), SIMD4(e[4], e[5], e[6], e[7]), SIMD4(e[8], e[9], e[10], e[11]), SIMD4(e[12], e[13], e[14], e[15])))
    }

    var translation: SIMD3<Float> { SIMD3(columns.3.x, columns.3.y, columns.3.z) }

    /// Heading of a pose that looks down its own -Z: the angle a where yaw(a) turns -Z onto the
    /// pose's forward direction, flattened to the horizontal plane.
    var heading: Float {
        let fwd = -SIMD3(columns.2.x, columns.2.y, columns.2.z)
        if abs(fwd.x) < 1e-5 && abs(fwd.z) < 1e-5 { return 0 }
        return atan2(-fwd.x, -fwd.z)
    }
}

func vec3(_ a: [Float], _ fallback: SIMD3<Float> = .zero) -> SIMD3<Float> {
    a.count >= 3 ? SIMD3(a[0], a[1], a[2]) : fallback
}
