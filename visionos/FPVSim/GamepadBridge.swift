// Game controllers (GameController framework) to the page, as a standard-mapping Gamepad
// (window.__fpvNative.pad): the simulator's own controller code, stick wizard and menu navigation
// then work as they do in a browser, whichever window or immersive space has the focus.
import Foundation
import GameController

@MainActor
final class GamepadBridge {
    private weak var web: WebHost?
    private var timer: Timer?
    private var last = ""
    private var lastSent = Date.distantPast
    private var connected = false
    private(set) var name: String?
    var onChange: ((String?) -> Void)?

    init(web: WebHost) { self.web = web }

    func start() {
        guard timer == nil else { return }
        // ~120 Hz: the page stamps each update and hands the sticks to Betaflight's RC link
        let t = Timer(timeInterval: 1.0 / 120.0, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.poll() }
        }
        RunLoop.main.add(t, forMode: .common)
        timer = t
    }

    private func pad() -> (GCController, GCExtendedGamepad)? {
        let all = GCController.controllers()
        let pick = GCController.current.flatMap { c in c.extendedGamepad != nil ? c : nil } ?? all.first { $0.extendedGamepad != nil }
        guard let c = pick, let g = c.extendedGamepad else { return nil }
        return (c, g)
    }

    private func poll() {
        guard let (c, g) = pad() else {
            if connected { connected = false; name = nil; last = ""; web?.call("padGone"); onChange?(nil) }
            return
        }
        let label = "\(c.vendorName ?? "Game controller") \(c.productCategory) (STANDARD GAMEPAD)"
        if !connected || name != label { connected = true; name = label; onChange?(label) }
        func f(_ v: Float) -> String { String(format: "%.4f", v) }
        // Gamepad API: y axes grow downwards
        let axes = [g.leftThumbstick.xAxis.value, -g.leftThumbstick.yAxis.value, g.rightThumbstick.xAxis.value, -g.rightThumbstick.yAxis.value]
        let buttons: [Float] = [
            g.buttonA.value, g.buttonB.value, g.buttonX.value, g.buttonY.value,
            g.leftShoulder.value, g.rightShoulder.value, g.leftTrigger.value, g.rightTrigger.value,
            g.buttonOptions?.value ?? 0, g.buttonMenu.value,
            g.leftThumbstickButton?.value ?? 0, g.rightThumbstickButton?.value ?? 0,
            g.dpad.up.value, g.dpad.down.value, g.dpad.left.value, g.dpad.right.value,
            g.buttonHome?.value ?? 0,
        ]
        let payload = "[\(axes.map(f).joined(separator: ","))],[\(buttons.map(f).joined(separator: ","))]"
        // every change at once; otherwise a keep-alive, so the page sees the pad as live
        let now = Date()
        if payload == last && now.timeIntervalSince(lastSent) < 0.05 { return }
        last = payload
        lastSent = now
        let id = label.replacingOccurrences(of: "\\", with: "").replacingOccurrences(of: "\"", with: "")
        web?.call("pad", "\"\(id)\",\(payload)")
    }
}
