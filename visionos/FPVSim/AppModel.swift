// The app's state: the loopback server and web view that run the simulator, the native scene, and
// the immersive session.
import QuartzCore
import RealityKit
import SwiftUI

struct Hud: Equatable {
    var map = ""
    var menuOpen = false
    var armed = false
    var volts = 0.0
    var laps = 0
    var lastLap = 0.0
    var bestLap = 0.0
    /// current lap time (s), or < 0 while no lap is being timed
    var lap = -1.0
    var gate = 0
    var gates = 0
}

@MainActor
@Observable
final class AppModel {
    enum Phase: Equatable { case starting, running, failed(String) }

    var phase: Phase = .starting
    var mode: ViewMode = .fpv {
        didSet {
            guard mode != oldValue else { return }
            if mode == .tabletop { immersionStyle = .mixed } else { immersionStyle = .full }
        }
    }
    var immersionStyle: any ImmersionStyle = .full
    var immersiveOpen = false
    var controllerName: String?
    var sceneSummary = "Starting the simulator…"
    var notice: String?
    var osdImage: UIImage?
    var osdOn = false
    var hud = Hud()

    @ObservationIgnored let web = WebHost()
    @ObservationIgnored let renderer = WorldRenderer()
    @ObservationIgnored private let tracker = HeadTracker()
    @ObservationIgnored private var pads: GamepadBridge?
    @ObservationIgnored private var server: LocalServer?
    @ObservationIgnored private var flight = FlightState()
    @ObservationIgnored private var started = false
    /// the head pose the views are centred on (nil: taken from the next tracked pose)
    @ObservationIgnored private var seat: simd_float4x4?
    @ObservationIgnored private var lastHead = HeadTracker.fallback
    @ObservationIgnored var frameSubscription: EventSubscription?
    /// the OSD / HUD panel in the immersive space (a SwiftUI attachment)
    @ObservationIgnored var overlay: Entity?

    // MARK: start-up

    func start() async {
        guard !started else { return }
        started = true
        guard let root = Bundle.main.url(forResource: "WebBundle", withExtension: nil),
              FileManager.default.fileExists(atPath: root.appendingPathComponent("index.html").path) else {
            phase = .failed("The simulator core is not in this build. Run visionos/build-web.sh in the repository, then build the app again.")
            return
        }
        let server = LocalServer(root: root)
        server.onUpload = { [weak self] _, query, body in
            Task { @MainActor in await self?.receiveScene(query: query, body: body) }
        }
        do {
            let port = try await server.start()
            self.server = server
            web.onMessage = { [weak self] body in self?.handle(body) }
            web.onLoadFailed = { [weak self] why in self?.phase = .failed("The simulator page did not load: \(why)") }
            let pads = GamepadBridge(web: web)
            pads.onChange = { [weak self] name in self?.controllerName = name }
            pads.start()
            self.pads = pads
            web.load(port: port)
            phase = .running
        } catch {
            phase = .failed("The local server did not start: \(error.localizedDescription)")
        }
    }

    // MARK: from the page

    private func receiveScene(query: [String: String], body: Data) async {
        do {
            let blob = try await Task.detached(priority: .userInitiated) { try SceneBlob(data: body) }.value
            try await renderer.install(blob)
            sceneSummary = renderer.summary
        } catch {
            sceneSummary = "The scene did not load: \(error)"
        }
    }

    private func handle(_ body: [String: Any]) {
        guard let kind = body["k"] as? String else { return }
        switch kind {
        case "s":
            if let a = body["a"] as? [Double], let s = FlightSample(a) { flight.push(s, arrivalMs: CACurrentMediaTime() * 1000) }
        case "d":
            if let part = body["part"] as? String, let seq = body["seq"] as? Int, let n = body["n"] as? [[Any]] { renderer.applyMoves(part: part, seq: seq, items: n) }
        case "m":
            if let part = body["part"] as? String, let seq = body["seq"] as? Int, let n = body["n"] as? [[Any]] { renderer.applyLooks(part: part, seq: seq, items: n) }
        case "osd":
            osdOn = (body["on"] as? Bool) ?? false
            if osdOn, let b64 = body["png"] as? String, let data = Data(base64Encoded: b64), let img = UIImage(data: data) { osdImage = img }
        case "hud":
            var h = Hud()
            h.map = (body["map"] as? String) ?? ""
            h.menuOpen = (body["menu"] as? Bool) ?? false
            h.armed = (body["armed"] as? Bool) ?? false
            h.volts = (body["volts"] as? Double) ?? 0
            h.laps = (body["laps"] as? Int) ?? 0
            h.lastLap = (body["last"] as? Double) ?? 0
            h.bestLap = (body["best"] as? Double) ?? 0
            h.lap = (body["lap"] as? Double) ?? -1
            h.gate = (body["gate"] as? Int) ?? 0
            h.gates = (body["gates"] as? Int) ?? 0
            if h != hud { hud = h }
        case "ready":
            // the page (re)loaded: it sends its scene on its own; tell it who draws
            if immersiveOpen { web.call("setImmersive", "true") }
            web.checkIsolation { [weak self] ok in
                self?.notice = ok ? nil : "This page is not cross-origin isolated: the simulator's shared memory is unavailable and it cannot start."
            }
        default:
            break
        }
    }

    // MARK: immersive session

    func immersiveOpened() async {
        immersiveOpen = true
        seat = nil
        await tracker.start()
        web.call("setImmersive", "true")
    }

    func immersiveClosed() {
        guard immersiveOpen else { return }
        immersiveOpen = false
        frameSubscription?.cancel()
        frameSubscription = nil
        overlay = nil
        tracker.stop()
        web.call("setImmersive", "false")
    }

    /// Centre the view on where the wearer is now.
    func recenter() { seat = nil }
    func respawn() { web.call("respawn") }
    func toggleMenu() { web.call("toggleMenu") }

    /// Once per rendered frame.
    func frame() {
        guard immersiveOpen else { return }
        let tracked = tracker.pose()
        let head = tracked ?? lastHead
        lastHead = head
        if seat == nil, tracked != nil { seat = head }
        let (p, q) = flight.pose(nowMs: CACurrentMediaTime() * 1000)
        renderer.place(mode: mode, seat: seat ?? head, position: p, orientation: q)
        if let overlay {
            // the goggles' OSD: in front of the eyes, wherever they look
            overlay.isEnabled = mode == .fpv
            overlay.transform = Transform(matrix: head * simd_float4x4(translation: SIMD3(0, -0.02, -1.5)))
        }
    }
}
