// Where the wearer's head is in the immersive space (ARKit world tracking; no permission prompt).
import ARKit
import QuartzCore
import simd

@MainActor
final class HeadTracker {
    // (a provider can't run again once its session stopped: both are made anew for every start)
    private var session: ARKitSession?
    private var provider: WorldTrackingProvider?

    /// Head pose assumed until tracking answers (seated, facing the space's -Z).
    static let fallback = simd_float4x4(translation: SIMD3(0, 1.2, 0))

    func start() async {
        guard session == nil, WorldTrackingProvider.isSupported else { return }
        let s = ARKitSession(), p = WorldTrackingProvider()
        session = s
        provider = p
        do { try await s.run([p]) } catch {
            print("head tracking unavailable: \(error)")
            session = nil
            provider = nil
        }
    }

    func stop() {
        session?.stop()
        session = nil
        provider = nil
    }

    /// Head pose now, or nil while tracking has none.
    func pose() -> simd_float4x4? {
        guard let provider, provider.state == .running,
              let a = provider.queryDeviceAnchor(atTimestamp: CACurrentMediaTime()), a.isTracked else { return nil }
        return a.originFromAnchorTransform
    }
}
