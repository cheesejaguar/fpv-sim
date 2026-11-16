// The few RealityKit calls whose spelling has moved between visionOS releases, in one place.
// Everything here targets visionOS 2 and later.
import CoreGraphics
import Metal
import RealityKit

@MainActor
enum Compat {
    /// A colour texture with mipmaps from a decoded image.
    static func texture(_ image: CGImage) async throws -> TextureResource {
        try await TextureResource(image: image, withName: nil, options: .init(semantic: .color, mipmapsMode: .allocateAndGenerateAll))
    }

    /// The texture with the sampler the page's material asked for (repeating terrain and walls).
    static func sampled(_ texture: TextureResource, repeats: Bool) -> MaterialParameters.Texture {
        let d = MTLSamplerDescriptor()
        d.minFilter = .linear
        d.magFilter = .linear
        d.mipFilter = .linear
        d.maxAnisotropy = 8
        d.sAddressMode = repeats ? .repeat : .clampToEdge
        d.tAddressMode = repeats ? .repeat : .clampToEdge
        return MaterialParameters.Texture(texture, sampler: MaterialParameters.Texture.Sampler(d))
    }

    /// Image-based light from an equirectangular image.
    static func environment(_ image: CGImage) async throws -> EnvironmentResource {
        try await EnvironmentResource(equirectangular: image)
    }

    /// Sun shadows.
    static func castShadows(_ light: Entity) {
        light.components.set(DirectionalLightComponent.Shadow(maximumDistance: 40, depthBias: 2))
    }
}
