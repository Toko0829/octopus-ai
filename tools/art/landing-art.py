"""
Builds and renders the landing page's art. Two shots, one body of water.

    pnpm art:hero     the hero plate, deep water lit from the surface
    pnpm art:reach    an arm of light reaching out to a human node

Both shots share the volume, the gobo and the sun, because they are the same water
seen from two places. A second scene file would be two copies of it drifting apart.

The .blend is deliberately NOT committed. This script is, for the same reason
rag-lens.html is generated rather than stored: a binary in git is a copy that can
only ever go stale, and a script that rebuilds the art is reviewable in a diff.
Everything below is deterministic, so the same commit renders the same frame.

WHAT THIS RENDERS AND WHAT IT DOES NOT
--------------------------------------
It renders the water: volumetric depth, three light shafts, the falloff to ink,
and the teal bloom below the bottom edge. Those are photographic properties an
SVG gradient can only imitate, and imitating them is what the first version of
this hero was doing.

It deliberately does NOT render the eight arms or the drifting motes. Both were
built here and both were removed. Emissive geometry needs glare compositing to
read as light rather than as wire, and the arms and motes already exist in
`HeroStage.tsx` as SVG that ANIMATES, which a still frame cannot do. The split is:
Blender owns the photograph, SVG owns the moving graphic on top of it.

CONTRAST IS SOLVED IN THE LAYER ABOVE THIS ONE, AND THAT WAS LEARNED THE HARD WAY
---------------------------------------------------------------------------------
The hero copy sits on this plate, so contrast has to be computed against the
LIGHTEST part of the field rather than the average. That is a defect this page has
already shipped once, so it gets measured rather than eyeballed.

The wrong fix was tried first: darken the whole plate until the text clears AA.
Measured at exposure -1.0 the lede was 2.25 and the quiet span 1.53, both far under
AA. Pushing to -4.0 got every tier to pass (white 8.56, lede 5.61, eyebrow 5.47,
quiet 4.73) and produced a **dead** picture: the shafts were gone, the bloom was
gone, and what shipped would have been a near-black rectangle that passed a checker.

So the plate ships rich at `EXPOSURE = -1.6`, and the copy gets a measured scrim in
CSS behind it. That is how every hero with text over a photograph actually works,
and unlike underexposure it costs the image nothing.

**Consequence for whoever changes this file: the numbers that matter are not the
ones `--measure` prints.** `--measure` reports contrast against the bare plate,
which is a lower bound and is expected to fail. The real check is the browser
contrast sweep over the composited page (plate + scrim + vignette + grain), which
is described under "Accessibility enforcement" in
docs/30-modules/design-system-frontend.md. Do not treat a green `--measure` as
permission to ship, and do not treat a red one as a reason to darken the plate.
"""

import argparse
import math
import os
import sys

import bpy

# Tuned values. Each one was arrived at by rendering, so treat them as measured
# rather than as defaults worth tidying.
HERO_EXPOSURE = -2.4     # rich plate; the scrim in CSS does the contrast work.
                         # Matched by measurement, not by eye: the first committed
                         # value rendered 0.79 stops brighter than the frame that was
                         # approved, because the approved one came out of an
                         # interactive session carrying a tweak that never reached
                         # this file. The script is the only source now, so render
                         # FROM it and compare before changing this number.
WATER_DENSITY = 0.009    # 0.030 was a fog wall; the camera sits inside this volume
SUN_ENERGY = 55.0
BLOOM_STRENGTH = 85.0
GOBO_BANDS = 9.0         # the plane is far wider than the frame, so 9 reads as ~3 shafts


def clear_scene():
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for coll in (bpy.data.meshes, bpy.data.materials, bpy.data.lights, bpy.data.curves):
        for block in list(coll):
            if block.users == 0:
                coll.remove(block)


def enable_gpu(scene):
    """
    Select a GPU device explicitly rather than trusting saved preferences.

    `scene.cycles.device = "GPU"` only does anything if the Cycles addon
    preferences already have a device ticked, and those live in the user's saved
    userpref rather than in the file. A machine that renders in seconds in the GUI
    therefore falls back to CPU under `--background` and takes minutes, silently.
    Returns the devices actually used, so the log says which.
    """
    scene.render.engine = "CYCLES"
    prefs = bpy.context.preferences.addons.get("cycles")
    if prefs is None:
        return []
    cprefs = prefs.preferences
    for backend in ("OPTIX", "CUDA", "HIP", "ONEAPI", "METAL"):
        try:
            cprefs.compute_device_type = backend
        except TypeError:
            continue  # not available in this build
        cprefs.refresh_devices()
        chosen = [d for d in cprefs.devices if d.type == backend]
        if chosen:
            for d in cprefs.devices:
                d.use = d.type == backend
            scene.cycles.device = "GPU"
            return [(d.name, backend) for d in chosen]
    scene.cycles.device = "CPU"
    return []


def setup_render(scene, res_x, res_y, samples, exposure):
    used = enable_gpu(scene)
    print(f"cycles device: {used or 'CPU (no GPU backend found)'}")
    scene.cycles.samples = samples
    scene.cycles.use_denoising = True
    # Volumes are the whole image here, so they get the step budget.
    scene.cycles.volume_max_steps = 256
    scene.cycles.volume_step_rate = 0.5

    scene.render.resolution_x = res_x
    scene.render.resolution_y = res_y
    scene.render.resolution_percentage = 100

    # AgX rolls the bloom off instead of clipping it to a white disc.
    scene.view_settings.view_transform = "AgX"
    scene.view_settings.look = "AgX - Base Contrast"
    scene.view_settings.exposure = exposure

    # Ink, never pure black. The design system rejects #000 and the world colour
    # is what the deepest part of the frame resolves to.
    world = bpy.data.worlds.new("DeepWater")
    scene.world = world
    world.use_nodes = True
    bg = world.node_tree.nodes["Background"]
    bg.inputs["Color"].default_value = (0.006, 0.011, 0.018, 1.0)


def build_camera(scene):
    cam_data = bpy.data.cameras.new("HeroCam")
    cam_data.lens = 32
    cam_data.sensor_width = 36
    cam = bpy.data.objects.new("HeroCam", cam_data)
    cam.location = (0.0, -34.0, 1.0)
    # 90 degrees is level; the extra 6 tilts up toward the surface.
    cam.rotation_euler = (math.radians(96.0), 0.0, 0.0)
    scene.collection.objects.link(cam)
    scene.camera = cam


def build_water(scene):
    """One volume, large enough that the camera sits inside it."""
    bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 6, 4))
    dom = bpy.context.active_object
    dom.name = "WaterVolume"
    dom.scale = (90, 110, 70)

    mat = bpy.data.materials.new("Water")
    mat.use_nodes = True
    nt = mat.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)

    out = nt.nodes.new("ShaderNodeOutputMaterial")
    out.location = (300, 0)
    vol = nt.nodes.new("ShaderNodeVolumePrincipled")
    vol.location = (0, 0)
    # Scatter a dark teal and absorb red first, which is what real water does and
    # what makes depth read as depth rather than as fog. A bright scatter colour
    # multiple-scatters into milk, which is exactly how the first attempt failed.
    vol.inputs["Color"].default_value = (0.045, 0.20, 0.22, 1.0)
    vol.inputs["Density"].default_value = WATER_DENSITY
    vol.inputs["Anisotropy"].default_value = 0.62  # forward scatter, so shafts glow
    vol.inputs["Absorption Color"].default_value = (0.30, 0.10, 0.05, 1.0)
    nt.links.new(vol.outputs["Volume"], out.inputs["Volume"])
    dom.data.materials.append(mat)


def build_surface_light(scene):
    """
    A SUN, not an area light. A gobo in front of a 120-unit area light has so much
    penumbra that the pattern washes out entirely and you get a flat teal field.
    Parallel rays are the only way a shaft keeps an edge.
    """
    sd = bpy.data.lights.new("Surface", type="SUN")
    sd.angle = math.radians(1.5)
    sd.energy = SUN_ENERGY
    sd.color = (0.80, 0.94, 0.96)
    sun = bpy.data.objects.new("Surface", sd)
    sun.location = (0, 10, 40)
    # Negative X aims the light down AND back toward the camera. Volumetric shafts
    # only really glow when they are backlit.
    sun.rotation_euler = (math.radians(-24), math.radians(6), 0)
    scene.collection.objects.link(sun)


def build_gobo(scene):
    """
    Breaks the sun into shafts. The Wave texture is driven from Generated coords,
    which run 0..1 across the plane, so Scale IS the band count on the plane. The
    plane is much wider than the frame, so 9 bands on it reads as about 3 shafts
    in shot. Setting this to 3 gives one shaft and setting it to 26 gives a curtain,
    and the design system asks for three.
    """
    bpy.ops.mesh.primitive_plane_add(size=1, location=(0, 12, 58))
    gobo = bpy.context.active_object
    gobo.name = "Gobo"
    gobo.scale = (420, 340, 1)
    gobo.visible_camera = False
    gobo.visible_glossy = False

    gm = bpy.data.materials.new("GoboMat")
    gm.use_nodes = True
    nt = gm.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)

    out = nt.nodes.new("ShaderNodeOutputMaterial")
    out.location = (600, 0)
    mix = nt.nodes.new("ShaderNodeMixShader")
    mix.location = (400, 0)
    trans = nt.nodes.new("ShaderNodeBsdfTransparent")
    trans.location = (200, 120)
    block = nt.nodes.new("ShaderNodeBsdfDiffuse")
    block.location = (200, -120)
    block.inputs["Color"].default_value = (0, 0, 0, 1)

    tc = nt.nodes.new("ShaderNodeTexCoord")
    tc.location = (-420, 0)
    wave = nt.nodes.new("ShaderNodeTexWave")
    wave.location = (-200, 0)
    wave.wave_type = "BANDS"
    wave.bands_direction = "X"
    wave.wave_profile = "SIN"
    wave.inputs["Scale"].default_value = GOBO_BANDS
    wave.inputs["Distortion"].default_value = 3.0
    wave.inputs["Detail"].default_value = 2.0
    # Not a default. Omitting it left the node at 1.0 and the script rendered a
    # different picture from the one that was approved, which is exactly the drift
    # a committed scene script exists to prevent. Caught by rendering the script
    # and comparing, rather than by assuming it matched.
    wave.inputs["Detail Scale"].default_value = 1.4

    ramp = nt.nodes.new("ShaderNodeValToRGB")
    ramp.location = (0, 0)
    ramp.color_ramp.elements[0].position = 0.40  # narrow beams, wide dark between
    ramp.color_ramp.elements[1].position = 0.63

    nt.links.new(tc.outputs["Generated"], wave.inputs["Vector"])
    nt.links.new(wave.outputs["Fac"], ramp.inputs["Fac"])
    nt.links.new(ramp.outputs["Color"], mix.inputs["Fac"])
    nt.links.new(trans.outputs["BSDF"], mix.inputs[1])
    nt.links.new(block.outputs["BSDF"], mix.inputs[2])
    nt.links.new(mix.outputs["Shader"], out.inputs["Surface"])
    gobo.data.materials.append(gm)


def build_bloom(scene):
    """
    The presence, below the bottom edge of frame. It is never seen directly: what
    reaches the picture is its scatter through the water, which is the point. A
    visible creature would be a mascot, and the brand doc rules one out.
    """
    bpy.ops.mesh.primitive_uv_sphere_add(
        radius=7.0, location=(1, 8, -19), segments=48, ring_count=24
    )
    bloom = bpy.context.active_object
    bloom.name = "Bloom"
    bm = bpy.data.materials.new("BloomEmit")
    bm.use_nodes = True
    nt = bm.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    out.location = (300, 0)
    emit = nt.nodes.new("ShaderNodeEmission")
    emit.location = (0, 0)
    emit.inputs["Color"].default_value = (0.055, 0.60, 0.54, 1.0)  # teal-400 #24c9b8
    emit.inputs["Strength"].default_value = BLOOM_STRENGTH
    nt.links.new(emit.outputs["Emission"], out.inputs["Surface"])
    bloom.data.materials.append(bm)



# ------------------------------------------------------------------ shot: reach

# Matched to the approved frame the way the hero's was, by rendering the script and
# comparing, rather than by carrying a number over from a live session.
REACH_EXPOSURE = -2.0
REACH_SUN_ENERGY = 34.0  # dimmer than the hero: a background shaft was competing


def _volume_emitter(name, scatter, density, emit_colour, emit_strength):
    """
    A volume shader with NO surface shader.

    This is the whole reason the arm reads as light. An emissive SURFACE has an
    edge, and an edge is what made several earlier attempts read as wire, or as a
    sea urchin. A pure volume has no boundary, so it glows out into the water
    instead of stopping at one.
    """
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    out.location = (300, 0)
    vol = nt.nodes.new("ShaderNodeVolumePrincipled")
    vol.location = (0, 0)
    vol.inputs["Color"].default_value = (*scatter, 1.0)
    vol.inputs["Density"].default_value = density
    vol.inputs["Emission Color"].default_value = (*emit_colour, 1.0)
    vol.inputs["Emission Strength"].default_value = emit_strength
    nt.links.new(vol.outputs["Volume"], out.inputs["Volume"])
    return mat


def _bezier(name, points, bevel, material, taper):
    curve = bpy.data.curves.new(name, type="CURVE")
    curve.dimensions = "3D"
    spline = curve.splines.new("BEZIER")
    spline.bezier_points.add(len(points) - 1)
    for bp, co in zip(spline.bezier_points, points):
        bp.co = co
        bp.handle_left_type = bp.handle_right_type = "AUTO"
    curve.bevel_depth = bevel
    curve.bevel_resolution = 4
    curve.taper_object = taper
    curve.use_fill_caps = True
    obj = bpy.data.objects.new(name, curve)
    obj.data.materials.append(material)
    bpy.context.scene.collection.objects.link(obj)
    return obj


def build_reach(scene):
    """
    One arm of light leaving frame at the left and narrowing to a single coral
    point. The agent is diffuse and everywhere; the person is one place. That
    contrast IS the picture, and it is why the node is small and solid against an
    arm that has no edges at all.

    Coral because coral means "a person does this" (design-system.md). It nearly
    shipped WHITE: at emission strength 90, AgX desaturates bright emission toward
    white, so the one pixel carrying the meaning had quietly lost its hue. Colour
    that means something must be checked after the tone transform, not before.
    """
    camera = bpy.data.objects["HeroCam"]
    camera.location = (0.0, -55.0, 2.0)
    camera.rotation_euler = (math.radians(92.0), 0.0, 0.0)
    camera.data.lens = 30
    bpy.data.lights["Surface"].energy = REACH_SUN_ENERGY

    # Fat at the root, thin at the tip, and not linearly. A straight taper reads as
    # a needle, which is exactly what the first pass produced.
    taper_curve = bpy.data.curves.new("ReachTaper", type="CURVE")
    taper_curve.dimensions = "3D"
    ts = taper_curve.splines.new("BEZIER")
    ts.bezier_points.add(3)
    for i, (x, y) in enumerate(((0.0, 0.25), (0.35, 1.0), (0.78, 0.55), (1.0, 0.10))):
        bp = ts.bezier_points[i]
        bp.co = (x, y, 0)
        bp.handle_left_type = bp.handle_right_type = "AUTO"
    taper = bpy.data.objects.new("ReachTaper", taper_curve)
    scene.collection.objects.link(taper)
    taper.hide_render = True

    primary = _volume_emitter("TendrilVol", (0.03, 0.30, 0.28), 0.55, (0.10, 0.78, 0.68), 1.7)
    _bezier(
        "Tendril",
        (
            (-52, 30, -16.0),
            (-33, 22, -11.5),
            (-16, 15, -5.0),
            (0, 11, 0.5),
            (14, 9, 4.0),
            (24, 8, 5.2),
        ),
        1.5,
        primary,
        taper,
    )

    # Set further back and dimmer: depth, and the eight-arm idea present without
    # eight of anything competing for the eye.
    faint = _volume_emitter("TendrilFaint", (0.02, 0.22, 0.21), 0.40, (0.07, 0.55, 0.50), 0.55)
    for i, pts in enumerate(
        (
            ((-54, 52, -22), (-32, 44, -16), (-12, 38, -10), (8, 34, -6), (22, 31, -4)),
            ((-50, 66, -26), (-28, 60, -21), (-8, 55, -17), (10, 51, -14), (26, 48, -12)),
        )
    ):
        _bezier(f"TendrilFar{i}", pts, 1.7, faint, taper)

    bpy.ops.mesh.primitive_uv_sphere_add(
        radius=0.85, location=(25.2, 8, 5.2), segments=32, ring_count=16
    )
    node = bpy.context.active_object
    node.name = "HumanNode"
    node.scale = (0.42, 0.42, 0.42)
    cm = bpy.data.materials.new("CoralEmit")
    cm.use_nodes = True
    nt = cm.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    out.location = (300, 0)
    emit = nt.nodes.new("ShaderNodeEmission")
    emit.location = (0, 0)
    emit.inputs["Color"].default_value = (1.0, 0.20, 0.09, 1.0)  # coral-500 #f96b52
    emit.inputs["Strength"].default_value = 7.0  # not 90: see the docstring
    nt.links.new(emit.outputs["Emission"], out.inputs["Surface"])
    node.data.materials.append(cm)

    # A faint coral scatter shell, so the node sits IN the water rather than on top
    # of it. NOT a decorative glow, which the design system reserves for live agent
    # presence: this is an emissive body in a scattering medium, the one thing here
    # that is physically true. Density is low enough that the sphere's boundary
    # cannot be found; at 0.10 the whole thing read as a coral bubble.
    bpy.ops.mesh.primitive_uv_sphere_add(
        radius=3.2, location=(25.2, 8, 5.2), segments=24, ring_count=12
    )
    halo = bpy.context.active_object
    halo.name = "NodeHalo"
    halo.scale = (0.52, 0.52, 0.52)
    halo.data.materials.append(
        _volume_emitter("NodeHaloVol", (0.30, 0.06, 0.03), 0.035, (0.95, 0.25, 0.12), 0.45)
    )


# ---------------------------------------------------------------- measurement


def srgb_luminance(hex_colour):
    c = [int(hex_colour[i : i + 2], 16) / 255 for i in (1, 3, 5)]
    c = [(v / 12.92) if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4 for v in c]
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]


def measure_contrast(path):
    """
    Worst case, not average. Text over a gradient does not have a contrast value,
    it has a range, and only the lightest part of the field under the copy matters.
    """
    img = bpy.data.images.load(path, check_existing=False)
    width, height = img.size
    px = list(img.pixels)  # linear float, which is already WCAG's linearised space

    brightest = 0.0
    for y in range(int(0.28 * height), int(0.82 * height), 2):
        row = (height - 1 - y) * width * 4
        for x in range(int(0.15 * width), int(0.85 * width), 2):
            i = row + x * 4
            lum = 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]
            brightest = max(brightest, lum)
    bpy.data.images.remove(img)

    print(f"\nworst-case background luminance under the copy: {brightest:.4f}")
    for label, colour in (
        ("h1      ", "#ffffff"),
        ("lede    ", "#c6d4d4"),
        ("eyebrow ", "#5fe3d4"),
        ("quiet   ", "#b3c4c4"),
    ):
        lt = srgb_luminance(colour)
        hi, lo = max(lt, brightest), min(lt, brightest)
        ratio = (hi + 0.05) / (lo + 0.05)
        print(f"  {label} {colour}  {ratio:5.2f}  {'PASS' if ratio >= 4.5 else 'FAIL'}")
    return brightest



def write_web_derivatives(scene, master_path, widths, dest_dir=None):
    """
    Sized WebP next to the master, so `--webp` produces everything the page ships
    and the pipeline stays one command.

    `save_render` applies the scene's view transform. The master is ALREADY
    display-referred, so leaving AgX and the exposure on re-applies both and writes
    a black file. That happened, twice. Reset colour management, then restore it.
    """
    view = scene.view_settings
    keep = (view.view_transform, view.look, view.exposure, view.gamma)
    view.view_transform, view.look, view.exposure, view.gamma = "Standard", "None", 0.0, 1.0

    settings = scene.render.image_settings
    written = []
    try:
        for width in widths:
            image = bpy.data.images.load(master_path, check_existing=False)
            height = round(width * image.size[1] / image.size[0])
            image.scale(width, height)
            settings.file_format = "WEBP"
            settings.color_depth = "8"
            settings.quality = 90
            stem = os.path.splitext(os.path.basename(master_path))[0]
            folder = dest_dir or os.path.dirname(master_path)
            os.makedirs(folder, exist_ok=True)
            out = os.path.join(folder, f"{stem}-{width}.webp")
            image.save_render(filepath=out, scene=scene)
            written.append((os.path.basename(out), os.path.getsize(out)))
            bpy.data.images.remove(image)
    finally:
        view.view_transform, view.look, view.exposure, view.gamma = keep
    return written


def main():
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    ap = argparse.ArgumentParser()
    ap.add_argument("--shot", choices=("hero", "reach"), default="hero")
    ap.add_argument("--out", default="hero-deep.png")
    ap.add_argument("--width", type=int, default=2560)
    ap.add_argument("--height", type=int, default=None, help="default: 1440 hero, 1000 reach")
    ap.add_argument("--samples", type=int, default=96)
    ap.add_argument("--measure", action="store_true", help="report contrast after rendering")
    # 16 is the archival master. Use 8 when the output is going to be measured
    # against a shipped file: Blender loads 16-bit PNGs as float and their pixel
    # values are NOT comparable with an 8-bit file's, which cost an hour once.
    ap.add_argument("--depth", choices=("8", "16"), default="16")
    ap.add_argument("--webp", action="store_true", help="also write sized WebP derivatives")
    # The 16-bit master must NOT land in apps/web/public: everything in there is
    # served, and a 9MB PNG beside a 22KB WebP is a 9MB PNG somebody will link to.
    ap.add_argument("--webp-dir", default=None, help="where derivatives go (default: beside the master)")
    args = ap.parse_args(argv)

    height = args.height or (1000 if args.shot == "reach" else 1440)
    exposure = REACH_EXPOSURE if args.shot == "reach" else HERO_EXPOSURE

    scene = bpy.context.scene
    clear_scene()
    setup_render(scene, args.width, height, args.samples, exposure)
    build_camera(scene)
    build_water(scene)
    build_surface_light(scene)
    build_gobo(scene)
    if args.shot == "reach":
        build_reach(scene)
    else:
        build_bloom(scene)

    out = os.path.abspath(args.out)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_depth = args.depth
    scene.render.filepath = out
    bpy.ops.render.render(write_still=True)
    print(f"wrote {out}")

    if args.webp:
        for name, size in write_web_derivatives(scene, out, (2560, 1600, 1024), args.webp_dir):
            print(f"  {name}  {size / 1024:.1f} KB")

    if args.measure:
        measure_contrast(out)


if __name__ == "__main__":
    main()
