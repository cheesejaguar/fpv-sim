// The scene the page exports (src/visionos/sceneExport.ts), decoded.
//
//   u32 magic 'FPVS' · u32 version · u32 jsonBytes · JSON · padding to 4 bytes · buffers
// The JSON refers to buffers as [offset, byteLength], counted from the first buffer byte.
import Foundation
import simd

struct GeoJSON: Decodable, Sendable { let pos: [Int]; let nrm: [Int]; let uv: [Int]?; let idx: [Int]; let verts: Int; let tris: Int }

struct MatJSON: Decodable, Sendable {
    var unlit: Bool
    var color: [Float]
    var opacity: Float
    var transparent: Bool
    var alphaTest: Float
    var doubleSided: Bool
    var additive: Bool
    var roughness: Float
    var metalness: Float
    var emissive: [Float]
    var map: Int
}

struct TexJSON: Decodable, Sendable { let data: [Int]; let mime: String; let width: Int; let height: Int; let `repeat`: Bool }

struct MeshJSON: Decodable, Sendable {
    let id: Int
    let name: String
    let geo: Int
    let mat: Int
    let m: [Float]
    let visible: Bool
    let fpvHidden: Bool
    let shadow: Bool
}

struct WorldInfo: Decodable, Sendable {
    let mapId: String
    let mapName: String
    let sky: Int
    let sunDir: [Float]
    let sunColor: [Float]
    let sunIntensity: Float
    let ambient: [Float]
    let night: Bool
    let pilot: [Float]
    let pilotFace: [Float]
    let focus: [Float]
    let radius: Float
}

struct DroneInfo: Decodable, Sendable {
    let lens: [Float]
    let mount: [Float]
    let wheelbase: Float
}

struct SceneJSON: Decodable, Sendable {
    let part: String
    let seq: Int
    let geos: [GeoJSON]
    let mats: [MatJSON]
    let texs: [TexJSON]
    let meshes: [MeshJSON]
    let world: WorldInfo?
    let drone: DroneInfo?
}

enum SceneBlobError: Error { case truncated, badMagic, badVersion(UInt32), badRange }

struct SceneBlob: Sendable {
    static let magic: UInt32 = 0x5356_5046
    static let version: UInt32 = 1

    let json: SceneJSON
    private let data: Data
    private let base: Int

    init(data raw: Data) throws {
        let data = Data(raw) // indices from 0
        guard data.count >= 12 else { throw SceneBlobError.truncated }
        func u32(_ at: Int) -> UInt32 {
            UInt32(data[at]) | UInt32(data[at + 1]) << 8 | UInt32(data[at + 2]) << 16 | UInt32(data[at + 3]) << 24
        }
        guard u32(0) == Self.magic else { throw SceneBlobError.badMagic }
        guard u32(4) == Self.version else { throw SceneBlobError.badVersion(u32(4)) }
        let jsonBytes = Int(u32(8))
        guard data.count >= 12 + jsonBytes else { throw SceneBlobError.truncated }
        self.json = try JSONDecoder().decode(SceneJSON.self, from: data.subdata(in: 12..<(12 + jsonBytes)))
        var b = 12 + jsonBytes
        b += (4 - b % 4) % 4
        self.base = b
        self.data = data
    }

    func bytes(_ ref: [Int]) throws -> Data {
        guard ref.count == 2, ref[0] >= 0, ref[1] >= 0, base + ref[0] + ref[1] <= data.count else { throw SceneBlobError.badRange }
        return data.subdata(in: (base + ref[0])..<(base + ref[0] + ref[1]))
    }

    private func array<T>(_ ref: [Int], of: T.Type, zero: T) throws -> [T] {
        let d = try bytes(ref)
        let n = d.count / MemoryLayout<T>.stride
        var out = [T](repeating: zero, count: n)
        out.withUnsafeMutableBufferPointer { dst in _ = d.copyBytes(to: dst) }
        return out
    }

    func floats(_ ref: [Int]) throws -> [Float] { try array(ref, of: Float.self, zero: 0) }
    func indices(_ ref: [Int]) throws -> [UInt32] { try array(ref, of: UInt32.self, zero: 0) }

    func vec3(_ ref: [Int]) throws -> [SIMD3<Float>] {
        let f = try floats(ref)
        var out = [SIMD3<Float>](repeating: .zero, count: f.count / 3)
        for i in 0..<out.count { out[i] = SIMD3(f[i * 3], f[i * 3 + 1], f[i * 3 + 2]) }
        return out
    }

    func vec2(_ ref: [Int], flipV: Bool) throws -> [SIMD2<Float>] {
        let f = try floats(ref)
        var out = [SIMD2<Float>](repeating: .zero, count: f.count / 2)
        for i in 0..<out.count { out[i] = SIMD2(f[i * 2], flipV ? 1 - f[i * 2 + 1] : f[i * 2 + 1]) }
        return out
    }
}
