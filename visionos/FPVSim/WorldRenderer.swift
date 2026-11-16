// Rebuilds the simulator's scene in RealityKit from the blobs the page exports, and keeps it in step:
// transforms, visibility and tints of what moves (props, gate highlights, actors), the quad's pose,
// and where the whole world sits around the wearer for each view.
//
// The scene arrives in Three.js conventions: metres, right-handed, +Y up, -Z forward, counter-clockwise
// front faces. RealityKit uses the same, so geometry and matrices are used as they are.
import CoreGraphics
import Foundation
import ImageIO
import Metal
import RealityKit
import UIKit
import simd

enum ViewMode: String, CaseIterable, Identifiable, Sendable {
    /// through the quad's camera: the world moves around you
    case fpv
    /// standing where the pilot stands, watching the quad fly
    case lineOfSight
    /// the course as a model on a table, in your room
    case tabletop

    var id: String { rawValue }
    var title: String {
        switch self {
        case .fpv: return "FPV"
        case .lineOfSight: return "Line of sight"
        case .tabletop: return "Tabletop"
        }
    }
}

@MainActor
final class WorldRenderer {
    /// Texture rows: the page sends v = 0 at the bottom row of the image (Three.js, flipY). RealityKit
    /// mesh descriptors use the same origin; if textures ever show upside down on device, flip here.
    static let flipV = false

    /// everything, in the immersive space's coordinates
    let spaceRoot = Entity()
    /// the simulator's world; placed by `place(...)` every frame
    let worldRoot = Entity()
    /// the quad's body, inside the world
    let droneRoot = Entity()
    private let sky = ModelEntity()
    private let sun = Entity()

    private(set) var world: WorldInfo?
    private(set) var drone: DroneInfo?
    private var worldPart: Part?
    private var dronePart: Part?
    private var fpvView = false

    /// One exported part (the world, or the quad), as entities.
    private final class Part {
        let container = Entity()
        var seq = 0
        var entities: [Int: ModelEntity] = [:]
        var looks: [Int: Look] = [:]
        var shown: [Int: Bool] = [:]
        var fpvHidden: Set<Int> = []
    }
    /// What a mesh's material is made from (kept so a tint can rebuild it).
    private struct Look { var mat: MatJSON; var texture: TextureResource?; var repeats: Bool }

    init() {
        spaceRoot.name = "space"
        worldRoot.name = "world"
        droneRoot.name = "drone"
        spaceRoot.addChild(worldRoot)
        worldRoot.addChild(droneRoot)
        sky.name = "sky"
        sky.isEnabled = false
        worldRoot.addChild(sky)
        sun.name = "sun"
        worldRoot.addChild(sun)
    }

    var summary: String {
        let w = worldPart?.entities.count ?? 0, d = dronePart?.entities.count ?? 0
        guard w > 0 else { return "Waiting for the scene…" }
        return "\(world?.mapName ?? "Map"): \(w) + \(d) meshes"
    }
    var ready: Bool { worldPart != nil && dronePart != nil }

    // MARK: building

    /// Build the entities of a blob and swap them in for the part's previous ones.
    func install(_ blob: SceneBlob) async throws {
        let json = blob.json
        let isWorld = json.part == "world"

        var textures: [TextureResource?] = []
        var skyImage: CGImage?
        for (i, t) in json.texs.enumerated() {
            guard let cg = Self.decodeImage(try blob.bytes(t.data)) else { textures.append(nil); continue }
            if isWorld, i == json.world?.sky { skyImage = cg }
            textures.append(try? await Compat.texture(cg))
            await Task.yield()
        }

        var meshes: [MeshResource?] = []
        for (i, g) in json.geos.enumerated() {
            var d = MeshDescriptor(name: "\(json.part)-\(i)")
            d.positions = MeshBuffers.Positions(try blob.vec3(g.pos))
            d.normals = MeshBuffers.Normals(try blob.vec3(g.nrm))
            if let uv = g.uv { d.textureCoordinates = MeshBuffers.TextureCoordinates(try blob.vec2(uv, flipV: Self.flipV)) }
            d.primitives = .triangles(try blob.indices(g.idx))
            meshes.append(try? MeshResource.generate(from: [d]))
            if i % 8 == 7 { await Task.yield() }
        }

        let part = Part()
        part.seq = json.seq
        part.container.name = json.part
        for m in json.meshes {
            guard m.geo >= 0, m.geo < meshes.count, let mesh = meshes[m.geo], m.mat >= 0, m.mat < json.mats.count else { continue }
            let mat = json.mats[m.mat]
            let tex: TextureResource? = mat.map >= 0 && mat.map < textures.count ? textures[mat.map] : nil
            let look = Look(mat: mat, texture: tex, repeats: mat.map >= 0 && mat.map < json.texs.count ? json.texs[mat.map].repeat : false)
            let e = ModelEntity(mesh: mesh, materials: [Self.material(look)])
            e.name = m.name
            if let mx = simd_float4x4(columnMajor: m.m) { e.transform = Transform(matrix: mx) }
            part.entities[m.id] = e
            part.looks[m.id] = look
            part.shown[m.id] = m.visible
            if m.fpvHidden { part.fpvHidden.insert(m.id) }
            e.isEnabled = m.visible && !(fpvView && m.fpvHidden)
            part.container.addChild(e)
        }

        // (two exports of one part can overlap: the newer one stays)
        if let current = isWorld ? worldPart : dronePart, current.seq > part.seq { return }
        if isWorld {
            worldPart?.container.removeFromParent()
            worldPart = part
            worldRoot.addChild(part.container)
            world = json.world
            if let w = json.world { await light(w, skyImage: skyImage, skyTexture: w.sky >= 0 && w.sky < textures.count ? textures[w.sky] : nil) }
        } else {
            dronePart?.container.removeFromParent()
            dronePart = part
            droneRoot.addChild(part.container)
            drone = json.drone
        }
    }

    private static func decodeImage(_ data: Data) -> CGImage? {
        guard let src = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        return CGImageSourceCreateImageAtIndex(src, 0, nil)
    }

    private static func color(_ c: [Float], _ alpha: Float = 1) -> UIColor {
        UIColor(red: CGFloat(c.count > 0 ? c[0] : 1), green: CGFloat(c.count > 1 ? c[1] : 1), blue: CGFloat(c.count > 2 ? c[2] : 1), alpha: CGFloat(alpha))
    }

    private static func material(_ look: Look) -> any RealityKit.Material {
        let m = look.mat
        let tex = look.texture.map { Compat.sampled($0, repeats: look.repeats) }
        // (additive glows are drawn as plain see-through colour: close enough for gate halos and beams)
        let seeThrough = m.transparent || m.additive || m.opacity < 0.999
        if m.unlit {
            var u = UnlitMaterial()
            u.color = .init(tint: color(m.color), texture: tex)
            if seeThrough { u.blending = .transparent(opacity: .init(floatLiteral: m.additive ? min(1, m.opacity * 1.6) : m.opacity)) }
            if m.alphaTest > 0 { u.opacityThreshold = m.alphaTest }
            if m.doubleSided { u.faceCulling = .none }
            return u
        }
        var p = PhysicallyBasedMaterial()
        p.baseColor = .init(tint: color(m.color), texture: tex)
        p.roughness = .init(floatLiteral: max(0.05, min(1, m.roughness)))
        p.metallic = .init(floatLiteral: max(0, min(1, m.metalness)))
        if m.emissive.contains(where: { $0 > 0.004 }) {
            p.emissiveColor = .init(color: color(m.emissive))
            p.emissiveIntensity = 1
        }
        if seeThrough { p.blending = .transparent(opacity: .init(floatLiteral: m.opacity)) }
        if m.alphaTest > 0 {
            p.blending = .transparent(opacity: .init(floatLiteral: m.opacity))
            p.opacityThreshold = m.alphaTest
        }
        if m.doubleSided { p.faceCulling = .none }
        return p
    }

    // MARK: sky and light

    private func light(_ w: WorldInfo, skyImage: CGImage?, skyTexture: TextureResource?) async {
        if let skyTexture {
            var u = UnlitMaterial()
            u.color = .init(tint: .white, texture: Compat.sampled(skyTexture, repeats: false))
            if let dome = try? MeshResource.generate(from: [Self.skyDome(radius: 2000)]) {
                sky.model = ModelComponent(mesh: dome, materials: [u])
                sky.isEnabled = true
            }
        }
        // the sky's own light on everything in the world
        if let skyImage, let env = try? await Compat.environment(skyImage) {
            worldRoot.components.set(ImageBasedLightComponent(source: .single(env), intensityExponent: w.night ? -1.5 : 0.4))
            worldRoot.components.set(ImageBasedLightReceiverComponent(imageBasedLight: worldRoot))
        }
        // the sun (the moon at night); it points from `sunDir` towards the ground
        let dir = simd_normalize(vec3(w.sunDir, SIMD3(0.3, 0.8, 0.5)))
        var l = DirectionalLightComponent()
        l.color = Self.color(w.sunColor)
        l.intensity = 2600 * max(0.05, w.sunIntensity / 4.5)
        sun.components.set(l)
        Compat.castShadows(sun)
        sun.look(at: .zero, from: dir * 100, relativeTo: worldRoot)
    }

    /// Inside-out latitude / longitude sphere whose texture coordinates match the page's
    /// equirectangular sky: u = 0.5 looks down -Z, u grows towards +X, v = 1 is straight up.
    private static func skyDome(radius r: Float) -> MeshDescriptor {
        let cols = 48, rows = 24
        var pos: [SIMD3<Float>] = [], uv: [SIMD2<Float>] = [], idx: [UInt32] = []
        for j in 0...rows {
            let lat = (Float(j) / Float(rows) - 0.5) * .pi
            for i in 0...cols {
                let lon = (Float(i) / Float(cols) - 0.5) * 2 * .pi
                pos.append(SIMD3(r * cos(lat) * sin(lon), r * sin(lat), -r * cos(lat) * cos(lon)))
                uv.append(SIMD2(Float(i) / Float(cols), flipV ? 1 - Float(j) / Float(rows) : Float(j) / Float(rows)))
            }
        }
        let w = UInt32(cols + 1)
        for j in 0..<UInt32(rows) {
            for i in 0..<UInt32(cols) {
                let a = j * w + i, b = a + 1, c = a + w, d = c + 1
                // seen from the inside, counter-clockwise
                idx.append(contentsOf: [a, b, c, b, d, c])
            }
        }
        var d = MeshDescriptor(name: "sky")
        d.positions = MeshBuffers.Positions(pos)
        d.textureCoordinates = MeshBuffers.TextureCoordinates(uv)
        d.primitives = .triangles(idx)
        return d
    }

    // MARK: live changes from the page

    private func part(_ name: String, _ seq: Int) -> Part? {
        let p = name == "world" ? worldPart : dronePart
        return p?.seq == seq ? p : nil
    }

    /// Transforms and visibility: [[id, visible, [16 floats]?], …]
    func applyMoves(part name: String, seq: Int, items: [[Any]]) {
        guard let p = part(name, seq) else { return }
        for it in items {
            guard it.count >= 2, let id = (it[0] as? NSNumber)?.intValue, let e = p.entities[id] else { continue }
            let vis = ((it[1] as? NSNumber)?.intValue ?? 1) != 0
            p.shown[id] = vis
            e.isEnabled = vis && !(fpvView && p.fpvHidden.contains(id))
            if it.count >= 3, let arr = it[2] as? [NSNumber], let mx = simd_float4x4(columnMajor: arr.map { $0.floatValue }) {
                e.transform = Transform(matrix: mx)
            }
        }
    }

    /// Tints: [[id, [r, g, b]?, opacity, [er, eg, eb]?], …]
    func applyLooks(part name: String, seq: Int, items: [[Any]]) {
        guard let p = part(name, seq) else { return }
        for it in items {
            guard it.count >= 3, let id = (it[0] as? NSNumber)?.intValue, let e = p.entities[id], var look = p.looks[id] else { continue }
            if let c = it[1] as? [NSNumber], c.count >= 3 { look.mat.color = c.map { $0.floatValue } }
            if let o = it[2] as? NSNumber { look.mat.opacity = o.floatValue }
            if it.count >= 4, let em = it[3] as? [NSNumber], em.count >= 3 { look.mat.emissive = em.map { $0.floatValue } }
            p.looks[id] = look
            e.model?.materials = [Self.material(look)]
        }
    }

    // MARK: placing the world around the wearer

    /// - Parameters:
    ///   - seat: where the wearer's head was, and the way it faced, when the view was (re)centred
    ///   - position, orientation: the quad, in world coordinates
    func place(mode: ViewMode, seat: simd_float4x4, position: SIMD3<Float>, orientation: simd_quatf) {
        droneRoot.transform = Transform(scale: .one, rotation: orientation, translation: position)
        setFpvView(mode == .fpv)

        let seatPos = seat.translation, seatYaw = simd_float4x4(yaw: seat.heading)
        switch mode {
        case .fpv:
            // the lens sits where the head was: world = seat · lens⁻¹ (turning the head looks around)
            let lensLocal = vec3(drone?.lens ?? [], .zero)
            let mount = drone.map { simd_quatf(ix: $0.mount[0], iy: $0.mount[1], iz: $0.mount[2], r: $0.mount[3]) } ?? simd_quatf(ix: 0, iy: 0, iz: 0, r: 1)
            let lensPos = position + orientation.act(lensLocal)
            let lens = simd_float4x4(translation: lensPos) * simd_float4x4(simd_normalize(orientation * mount))
            worldRoot.transform = Transform(matrix: simd_float4x4(translation: seatPos) * seatYaw * lens.inverse)
            sky.position = lensPos
            sky.isEnabled = sky.model != nil
        case .lineOfSight:
            // the pilot's spot on the ground under the wearer, facing the launch pad
            let pilot = vec3(world?.pilot ?? [], .zero), face = vec3(world?.pilotFace ?? [], SIMD3(0, 0, -1))
            let faceYaw = (abs(face.x) < 1e-4 && abs(face.z) < 1e-4) ? 0 : atan2(-face.x, -face.z)
            let floor = simd_float4x4(translation: SIMD3(seatPos.x, 0, seatPos.z)) * seatYaw
            worldRoot.transform = Transform(matrix: floor * simd_float4x4(yaw: -faceYaw) * simd_float4x4(translation: -pilot))
            sky.position = pilot
            sky.isEnabled = sky.model != nil
        case .tabletop:
            // the course as a 1.2 m model, just below eye level in front of the wearer
            let focus = vec3(world?.focus ?? [], .zero), radius = max(4, world?.radius ?? 30)
            let s = 0.6 / radius
            let table = simd_float4x4(translation: SIMD3(seatPos.x, max(0.5, seatPos.y - 0.5), seatPos.z)) * seatYaw * simd_float4x4(translation: SIMD3(0, 0, -0.95))
            worldRoot.transform = Transform(matrix: table * simd_float4x4(uniformScale: s) * simd_float4x4(translation: -focus))
            sky.isEnabled = false
        }
    }

    private func setFpvView(_ on: Bool) {
        guard on != fpvView else { return }
        fpvView = on
        guard let p = dronePart else { return }
        for id in p.fpvHidden { p.entities[id]?.isEnabled = (p.shown[id] ?? true) && !on }
    }
}
