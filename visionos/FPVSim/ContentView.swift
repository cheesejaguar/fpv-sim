import GameController
import SwiftUI

struct ContentView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.openImmersiveSpace) private var openImmersiveSpace
    @Environment(\.dismissImmersiveSpace) private var dismissImmersiveSpace
    @State private var switching = false

    var body: some View {
        ZStack {
            Color(red: 0.06, green: 0.06, blue: 0.14)
            switch model.phase {
            case .failed(let why):
                VStack(spacing: 16) {
                    Image(systemName: "exclamationmark.triangle").font(.system(size: 44))
                    Text("FPV Sim can't start").font(.title)
                    Text(why).multilineTextAlignment(.center).foregroundStyle(.secondary).frame(maxWidth: 560)
                }
                .padding(40)
            default:
                WebView(host: model.web)
            }
            if let notice = model.notice {
                VStack {
                    Text(notice).padding(12).glassBackgroundEffect()
                    Spacer()
                }
                .padding(20)
            }
        }
        .handlesGameControllerEvents(matching: .gamepad)
        .task { await model.start() }
        .ornament(attachmentAnchor: .scene(.bottom), contentAlignment: .top) { controls }
    }

    private var controls: some View {
        @Bindable var model = model
        return HStack(spacing: 16) {
            Picker("View", selection: $model.mode) {
                ForEach(ViewMode.allCases) { m in Text(m.title).tag(m) }
            }
            .pickerStyle(.segmented)
            .frame(width: 360)

            Button(model.immersiveOpen ? "Leave immersive view" : "Fly immersive") {
                Task { await toggleImmersive() }
            }
            .disabled(switching || model.phase != .running)

            if model.immersiveOpen {
                Button("Recentre") { model.recenter() }
                Button("Respawn") { model.respawn() }
            }

            VStack(alignment: .leading, spacing: 2) {
                Text(model.sceneSummary)
                Text(model.controllerName ?? "No controller: pair a Bluetooth gamepad in Settings")
            }
            .font(.caption)
            .foregroundStyle(.secondary)
            .frame(maxWidth: 320, alignment: .leading)
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 12)
        .glassBackgroundEffect()
    }

    private func toggleImmersive() async {
        switching = true
        defer { switching = false }
        if model.immersiveOpen {
            await dismissImmersiveSpace()
        } else {
            switch await openImmersiveSpace(id: "flight") {
            case .opened: break
            default: model.sceneSummary = "The immersive view did not open."
            }
        }
    }
}
