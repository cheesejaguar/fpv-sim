// FPV Sim for Apple Vision Pro.
//
// The window runs the simulator itself (the web build, served from inside the app bundle): real
// Betaflight / ArduPilot firmware, the physics, menus, the drone builder, settings. The immersive
// space draws the same flight natively in RealityKit, in stereo, from the scene and state the page
// hands over. Nothing is loaded from the network.
import SwiftUI

@main
struct FPVSimApp: App {
    @State private var model = AppModel()

    var body: some Scene {
        WindowGroup(id: "main") {
            ContentView()
                .environment(model)
        }
        .defaultSize(width: 1280, height: 800)

        ImmersiveSpace(id: "flight") {
            ImmersiveView()
                .environment(model)
        }
        .immersionStyle(selection: $model.immersionStyle, in: .mixed, .full)
    }
}
