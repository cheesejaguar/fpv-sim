import GameController
import RealityKit
import SwiftUI

struct ImmersiveView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        RealityView { content, attachments in
            content.add(model.renderer.spaceRoot)
            if let panel = attachments.entity(for: "osd") {
                model.renderer.spaceRoot.addChild(panel)
                model.overlay = panel
            }
            model.frameSubscription = content.subscribe(to: SceneEvents.Update.self) { _ in
                MainActor.assumeIsolated { model.frame() }
            }
        } attachments: {
            Attachment(id: "osd") {
                OSDView().environment(model)
            }
        }
        .handlesGameControllerEvents(matching: .gamepad)
        .task { await model.immersiveOpened() }
        .onDisappear { model.immersiveClosed() }
    }
}

/// The Betaflight OSD as the page drew it, and the lap line, in front of the pilot's eyes.
struct OSDView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        ZStack {
            if model.osdOn, let img = model.osdImage {
                Image(uiImage: img)
                    .interpolation(.none)
                    .resizable()
                    .aspectRatio(contentMode: .fit)
                    .opacity(0.92)
            }
            VStack {
                HStack {
                    if model.hud.gates > 0 {
                        Text(lapLine).font(.system(size: 30, weight: .semibold, design: .monospaced))
                            .padding(.horizontal, 14).padding(.vertical, 6)
                            .background(.black.opacity(0.35), in: Capsule())
                    }
                    Spacer()
                }
                Spacer()
                if model.hud.menuOpen {
                    Text("Paused: the menu is open in the window")
                        .font(.system(size: 30, weight: .semibold))
                        .padding(.horizontal, 18).padding(.vertical, 8)
                        .background(.black.opacity(0.45), in: Capsule())
                }
            }
            .padding(24)
        }
        .foregroundStyle(.white)
        .frame(width: 1400, height: 1050)
        .allowsHitTesting(false)
    }

    private var lapLine: String {
        let h = model.hud
        var s = "LAP \(h.laps + 1)  GATE \(min(h.gate + 1, h.gates))/\(h.gates)"
        if h.lap >= 0 { s += String(format: "  %.1f", h.lap) }
        if h.bestLap > 0 { s += String(format: "  BEST %.3f", h.bestLap) }
        return s
    }
}
