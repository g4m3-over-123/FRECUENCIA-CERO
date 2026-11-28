"""Grade the street asset in Blender and export its original geometry with new textures."""

import argparse
from copy import deepcopy
import json
from pathlib import Path
import struct
import sys
from tempfile import NamedTemporaryFile, TemporaryDirectory

import bpy
import numpy as np


PROPS = Path(__file__).resolve().parents[1] / "public" / "assets" / "props"
OUTPUT = PROPS / "street_enhanced.glb"
WEBP = "EXT_texture_webp"
NORMAL_STRENGTH = 1.35
ROAD_MATERIAL = "Material.007"  # Plane.002, the road mesh used by WorldBuilder
WET_ROUGHNESS = (0.25, 0.45)
DRY_ROUGHNESS = (0.80, 0.92)
LUMINANCE_WEIGHTS = np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)


def read_glb(path):
    contents = path.read_bytes()
    magic, version, size, json_size, chunk_type = struct.unpack_from("<4sIII4s", contents)
    if (magic, version, size, chunk_type) != (b"glTF", 2, len(contents), b"JSON"):
        raise ValueError(f"Expected a GLB 2.0 file: {path}")

    json_end = 20 + json_size
    document = json.loads(contents[20:json_end])
    binary_size, chunk_type = struct.unpack_from("<I4s", contents, json_end)
    binary = contents[json_end + 8:]
    if chunk_type != b"BIN\x00" or binary_size != len(binary):
        raise ValueError("Expected a single BIN chunk")
    buffers = document["buffers"]
    if len(buffers) != 1 or "uri" in buffers[0]:
        raise ValueError("Expected a single embedded buffer")
    if any("uri" in image or "bufferView" not in image for image in document["images"]):
        raise ValueError("Every source texture must be embedded")
    return document, binary


def pixels(image):
    width, height = image.size
    if not width or not height:
        raise ValueError(f"Missing pixels in {image.name}")
    values = np.empty(width * height * 4, dtype=np.float32)
    image.pixels.foreach_get(values)
    return values.reshape(height, width, 4)


def blur(values):
    padded = np.pad(values, ((0, 0), (1, 1)), mode="edge")
    horizontal = (padded[:, :-2] + 2 * padded[:, 1:-1] + padded[:, 2:]) * 0.25
    padded = np.pad(horizontal, ((1, 1), (0, 0)), mode="edge")
    return (padded[:-2] + 2 * padded[1:-1] + padded[2:]) * 0.25


def grade_albedo(rgba):
    rgb = rgba[..., :3]
    gray = (rgb @ LUMINANCE_WEIGHTS)[..., None]
    saturated = gray + 0.75 * (rgb - gray)
    contrast = saturated + 0.17 * (saturated - 0.5) * (4 * saturated * (1 - saturated))
    graded = contrast - 0.072 * (4 * contrast * (1 - contrast))
    luminance = graded @ LUMINANCE_WEIGHTS
    detail = np.clip(0.42 * (luminance - blur(luminance)), -0.025, 0.025)
    graded_rgba = rgba.copy()
    graded_rgba[..., :3] = np.clip(graded + detail[..., None], 0, 1)
    return graded_rgba


def roughness_pixels(rgba, bounds):
    luminance = rgba[..., :3] @ LUMINANCE_WEIGHTS
    height, width = luminance.shape
    if height % 2 == 0 and width % 2 == 0:
        luminance = luminance.reshape(height // 2, 2, width // 2, 2).mean(axis=(1, 3))
    smoothed = blur(luminance)
    low, high = np.percentile(smoothed, [10, 90])
    inverse = 1 - np.clip((smoothed - low) / max(high - low, 0.01), 0, 1)
    detail = np.clip(np.abs(luminance - smoothed) / 0.06, 0, 1)
    variation = np.clip((0.85 * inverse + 0.15 * detail - 0.04) / 0.80, 0, 1)

    packed = np.ones((*luminance.shape, 4), dtype=np.float32)
    packed[..., 1] = bounds[0] + (bounds[1] - bounds[0]) * variation
    packed[..., 2] = 0
    return packed


def encode_image(path, rgba, file_format, quality, *, alpha=False):
    height, width, _ = rgba.shape
    image = bpy.data.images.new(path.stem, width, height, alpha=alpha, float_buffer=False)
    try:
        image.colorspace_settings.name = "sRGB" if file_format == "WEBP" else "Non-Color"
        image.alpha_mode = "CHANNEL_PACKED"
        image.pixels.foreach_set(rgba.ravel())
        image.update()
        image.file_format = file_format
        image.save(filepath=str(path), quality=quality, save_copy=True)
    finally:
        bpy.data.images.remove(image)

    if alpha:
        decoded = bpy.data.images.load(str(path), check_existing=False)
        try:
            decoded.alpha_mode = "CHANNEL_PACKED"
            if not np.array_equal(pixels(decoded)[..., 3], rgba[..., 3]):
                raise ValueError(f"WebP changed the alpha channel of {path.name}")
        finally:
            bpy.data.images.remove(decoded)
    return path.read_bytes()


def roughness_texture(document, replacements, packed_png, previous_binding):
    if previous_binding is None:
        view_index = len(document["bufferViews"])
        document["bufferViews"].append({"buffer": 0})
        image_index = len(document["images"])
        document["images"].append({"bufferView": view_index, "mimeType": "image/png"})
        texture_index = len(document["textures"])
        document["textures"].append({"source": image_index})
    else:
        # The road has a dedicated packed texture. Reuse its slot for the data PNG.
        texture_index = previous_binding["index"]
        texture = document["textures"][texture_index]
        image_index = texture.pop("extensions")[WEBP]["source"]
        texture["source"] = image_index
        image = document["images"][image_index]
        image["mimeType"] = "image/png"
        view_index = image["bufferView"]

    replacements[view_index] = packed_png
    return texture_index


def enhance_materials(document, scratch):
    replacements = {}
    roughness_textures = {}
    for material in document["materials"]:
        name = material["name"]
        nodes = bpy.data.materials[name].node_tree.nodes
        shader = next(node for node in nodes if node.type == "BSDF_PRINCIPLED")
        images = [node.image.name for node in nodes if node.type == "TEX_IMAGE"]
        print(f"Material {name}: {', '.join(images) or '(no textures)'}")

        pbr = material["pbrMetallicRoughness"]
        pbr["metallicFactor"] = 0.0
        if "normalTexture" in material:
            normal = shader.inputs["Normal"].links[0].from_node
            normal_image = normal.inputs["Color"].links[0].from_node.image
            normal_image.colorspace_settings.name = "Non-Color"
            normal.inputs["Strength"].default_value = NORMAL_STRENGTH
            material["normalTexture"]["scale"] = NORMAL_STRENGTH

        base_binding = pbr.get("baseColorTexture")
        if base_binding is None:
            continue
        base_texture = document["textures"][base_binding["index"]]
        image_index = base_texture["extensions"][WEBP]["source"]
        view_index = document["images"][image_index]["bufferView"]
        base_image = shader.inputs["Base Color"].links[0].from_node.image
        rgba = pixels(base_image)
        if view_index not in replacements:
            replacements[view_index] = encode_image(
                scratch / f"albedo_{image_index}.webp", grade_albedo(rgba), "WEBP", 90,
                alpha=bool(np.any(rgba[..., 3] < 1)),
            )

        bounds = WET_ROUGHNESS if name == ROAD_MATERIAL else DRY_ROUGHNESS
        sampler = base_texture.get("sampler")
        key = (image_index, sampler, bounds)
        if key not in roughness_textures:
            packed = roughness_pixels(rgba, bounds)
            payload = encode_image(scratch / f"roughness_{image_index}.png", packed, "PNG", 100)
            texture_index = roughness_texture(
                document, replacements, payload, pbr.get("metallicRoughnessTexture"),
            )
            if sampler is not None:
                document["textures"][texture_index]["sampler"] = sampler
            roughness_textures[key] = texture_index

        # glTF samples roughness from green. Use the same UV set and transform as the albedo.
        binding = deepcopy(base_binding)
        binding["index"] = roughness_textures[key]
        pbr["metallicRoughnessTexture"] = binding
        pbr["roughnessFactor"] = 1.0
        print(f"  Roughness {bounds[0]:.2f}-{bounds[1]:.2f}")
    return replacements


def write_glb(document, binary, replacements, output):
    views = document["bufferViews"]
    image_views = {image["bufferView"] for image in document["images"]}
    texture_start = min(views[i].get("byteOffset", 0) for i in image_views if "byteLength" in views[i])
    if any(view.get("byteOffset", 0) + view["byteLength"] > texture_start
           for index, view in enumerate(views) if index not in image_views):
        raise ValueError("Expected street.glb texture data to follow its geometry")

    # Copy the full geometry prefix, including its original buffer-view offsets and padding.
    result = bytearray(binary[:texture_start])
    for index in sorted(image_views):
        view = views[index]
        offset = view.get("byteOffset", 0)
        payload = replacements.get(index)
        if payload is None:
            payload = binary[offset:offset + view["byteLength"]]
        result.extend(bytes(-len(result) % 4))
        view.update(byteOffset=len(result), byteLength=len(payload))
        result.extend(payload)

    document["buffers"][0]["byteLength"] = len(result)
    result.extend(bytes(-len(result) % 4))
    metadata = json.dumps(document, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    metadata += b" " * (-len(metadata) % 4)
    size = 28 + len(metadata) + len(result)
    if size >= 20_000_000:
        raise ValueError(f"Enhanced GLB exceeds the size budget ({size:,} bytes)")

    with NamedTemporaryFile(dir=output.parent, suffix=".tmp", delete=False) as stream:
        staged = Path(stream.name)
    try:
        with staged.open("wb") as stream:
            stream.write(struct.pack("<4sIII4s", b"glTF", 2, size, len(metadata), b"JSON"))
            stream.write(metadata)
            stream.write(struct.pack("<I4s", len(result), b"BIN\x00"))
            stream.write(result)
        staged.replace(output)
    finally:
        staged.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=PROPS / "street.glb")
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else [])
    source = args.source.resolve(strict=True)
    if source == OUTPUT.resolve() or (OUTPUT.exists() and OUTPUT.samefile(source)):
        raise ValueError("The source and destination must be different files")

    document, binary = read_glb(source)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(source), loglevel=40)
    for image in bpy.data.images:
        width, height = image.size
        print(f"Image {image.name}: {width}x{height}, {image.colorspace_settings.name}")
        if not image.packed_file:
            raise ValueError(f"Image {image.name} was not packed on import")

    with TemporaryDirectory() as temporary:
        replacements = enhance_materials(document, Path(temporary))
    write_glb(document, binary, replacements, OUTPUT)
    print(f"Original: {source.stat().st_size} bytes")
    print(f"Enhanced: {OUTPUT.stat().st_size} bytes ({OUTPUT})")


if __name__ == "__main__":
    main()
