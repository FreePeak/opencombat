#!/usr/bin/env python3
"""Mixamo FBX pack -> single game-ready GLB for opengame.

Takes a "base" Mixamo FBX (mesh + rig + textures) plus any number of
animation-only Mixamo FBXs (same character, same rig) and produces ONE .glb
whose clips are named with the game's 'CharacterArmature|<Name>' convention
(see src/config.js CONFIG.characters[].anims).

Pipeline (Blender headless):
  1. import base FBX -> keep mesh/armature/materials/textures
  2. import each anim FBX -> steal its action, rename, drop the duplicate
     mesh/armature (Mixamo re-ships the whole model in every file)
  3. strip non-base-color texture sockets; resize kept images to <=1024px,
     re-encode JPEG (embedded 2048 PNGs would blow the 2MB budget)
  4. one muted NLA track per action on the base armature, no active action
  5. export GLB with export_animation_mode='ACTIONS'

Usage:
  blender --background --python mixamo_to_glb.py -- \
      --base "Run With Sword.fbx" \
      --idle "Withdrawing Sword.fbx" \
      --run  "Run With Sword.fbx" \
      --attack "Stable Sword Inward Slash.fbx" \
      --extra Spin="Standing Melee Attack 360 Low.fbx" \
      --out assets/characters/knight_mixamo.glb
"""
import os, sys, tempfile
import bpy  # provided by Blender's embedded interpreter

def parse_args(argv):
    """-- after blender's --python is the script's own argv."""
    opts = {'base': None, 'out': None, 'anims': {}, 'trims': {}}
    mapping = {'--idle': 'Idle', '--run': 'Run', '--attack': 'Attack',
               '--hit': 'HitReact', '--walk': 'Walk', '--die': 'Death'}
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == '--base': opts['base'] = argv[i+1]; i += 2
        elif a == '--out': opts['out'] = argv[i+1]; i += 2
        elif a in mapping: opts['anims'][argv[i+1]] = mapping[a]; i += 2
        elif a == '--extra':  # --extra Spin=file.fbx
            name, path = argv[i+1].split('=', 1); opts['anims'][path] = name; i += 2
        elif a == '--trim':  # --trim Attack=67-81 (1-based frames, inclusive)
            name, rng = argv[i+1].split('=', 1)
            s, e = rng.split('-'); opts['trims'][name] = (int(s), int(e)); i += 2
        else: i += 1
    return opts

def steal_action_and_delete_import(pre_objs, pre_actions):
    """Return the (action, [imported objects]) created by the last import."""
    new_objs = [o for o in bpy.data.objects if o.name not in pre_objs]
    new_actions = [a for a in bpy.data.actions if a.name not in pre_actions]
    assert len(new_actions) == 1, f'expected 1 new action, got {len(new_actions)}'
    return new_actions[0], new_objs

def trim_action(action, f_start, f_end):
    """Hard-trim an action to [f_start, f_end] (1-based Mixamo frames).
    Blender 4.4+ slotted actions expose keyframes via layers/slots; touch
    them all so the trim actually shrinks the exported clip."""
    for layer in getattr(action, 'layers', []):
        for strip in layer.strips:
            for channelbag in strip.channelbags:
                for fc in channelbag.fcurves:
                    pts = fc.keyframe_points
                    keep = [p for p in pts if f_start <= p.co[0] <= f_end]
                    if not keep: continue
                    for p in pts:
                        if p.co[0] < f_start or p.co[0] > f_end:
                            p.co[0] = min(max(p.co[0], f_start), f_end)
                    # re-sort handles by time after clamping
                    pts.sort()
    action.frame_start = f_start
    action.frame_end = f_end
    return action

def push_down(arm_obj, action, name):
    """One NLA track per action so glTF 'ACTIONS' mode exports each clip.
    Strips.new signature changed in Blender 4.4 — try both."""
    track = arm_obj.animation_data.nla_tracks.new()
    track.name = name
    try:
        strip = track.strips.new(name, int(action.frame_start), action)
    except TypeError:
        strip = track.strips.new(action)
    strip.name = name
    return track

def shrink_textures(max_px=1024):
    """Keep base-color + normal maps, resize, re-encode as JPEG files on disk
    so the exporter embeds image/jpeg instead of giant embedded PNGs.
    (Mixamo 'specular' maps are near-black gloss masks — dropped later.)"""
    kept = set()
    for mat in bpy.data.materials:
        if not mat.use_nodes: continue
        pbsdf = next((n for n in mat.node_tree.nodes
                      if n.type == 'BSDF_PRINCIPLED'), None)
        if not pbsdf: continue
        base = pbsdf.inputs.get('Base Color')
        normal = pbsdf.inputs.get('Normal')
        for sock in (base, normal):
            if sock and sock.is_linked and sock.links[0].from_node.type == 'TEX_IMAGE':
                img = sock.links[0].from_node.image
                if img:
                    img.colorspace_settings.name = ('sRGB' if sock is base
                                                    else 'Non-Color')
                    kept.add(img)
        # drop every other texture socket (specular etc.)
        for link in list(mat.node_tree.links):
            if link.to_node == pbsdf and link.to_socket != base:
                mat.node_tree.links.remove(link)
    tmp = tempfile.mkdtemp(prefix='mixamo_tex_')
    paths = []
    for img in kept:
        if max(img.size) > max_px:
            img.scale(*[max_px if s > max_px else s for s in img.size])
        img.file_format = 'JPEG'
        p = os.path.join(tmp, img.name + '.jpg')
        # Mixamo FBX ships textures EMBEDDED (packed_file). pack() forces a
        # fresh pack of the (resized) pixels, then unpack writes that exact
        # buffer to disk; without it save() can write a stale/blank file.
        if img.packed_file:
            img.pack()
            img.unpack(method='WRITE_LOCAL')
            import shutil
            src = bpy.path.abspath(img.filepath)
            if os.path.exists(src) and src != p:
                shutil.copy(src, p)
        else:
            img.filepath_raw = p
            img.save()
        img.filepath = p  # exporter now embeds this JPEG
        paths.append((img.name, os.path.getsize(p)))
    for mat in bpy.data.materials:
        if not mat.use_nodes: continue
        nt = mat.node_tree
        pbsdf = next((n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED'), None)
        if pbsdf and pbsdf.inputs['Normal'].is_linked:
            # Re-wire: bake the (resized) normal image straight into the
            # Principled socket, bypassing the Normal Map node so the
            # exporter embeds the JPEG instead of decoding to tangent data.
            texn = pbsdf.inputs['Normal'].links[0].from_node
            if texn.type == 'NORMAL_MAP':
                src = texn.inputs['Color'].links[0].from_node if texn.inputs['Color'].is_linked else None
                if src and src.type == 'TEX_IMAGE':
                    nt.links.new(src.outputs['Color'], pbsdf.inputs['Normal'])
                    nt.nodes.remove(texn)
    return paths

def world_height(objs):
    from mathutils import Vector
    mn, mx = Vector((1e9,)*3), Vector((-1e9,)*3)
    for o in objs:
        for c in o.bound_box:
            w = o.matrix_world @ Vector(c)
            mn.x = min(mn.x, w.x); mn.y = min(mn.y, w.y); mn.z = min(mn.z, w.z)
            mx.x = max(mx.x, w.x); mx.y = max(mx.y, w.y); mx.z = max(mx.z, w.z)
    return (mx - mn).z

def main():
    import bpy, bpy.ops
    opts = parse_args(sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else [])
    assert opts['base'] and opts['out'], 'need --base and --out'
    print('BLENDER:', bpy.app.version_string)

    bpy.ops.wm.read_factory_settings(use_empty=True)
    pre_actions = set()  # snapshot BEFORE import so the base clip is included
    bpy.ops.import_scene.fbx(filepath=opts['base'])
    arm_objs = [o for o in bpy.data.objects if o.type == 'ARMATURE']
    assert len(arm_objs) == 1, f'expected 1 armature, got {len(arm_objs)}'
    arm = arm_objs[0]
    base_meshes = [o for o in bpy.data.objects if o.type == 'MESH']
    arm.animation_data_create()

    tex_report = shrink_textures()
    _base_images = {i.name for i in bpy.data.images}

    # Base file's own action = the anim mapped to the same basename, or 'Run'.
    clip_files = dict(opts['anims'])
    base_clip = None
    for f, name in clip_files.items():
        if os.path.basename(f) == os.path.basename(opts['base']): base_clip = name
    if not base_clip: base_clip = 'Run'
    for a in bpy.data.actions:
        a.name = f'CharacterArmature|{base_clip}'
        if base_clip in opts['trims']:
            trim_action(a, *opts['trims'][base_clip])
        push_down(arm, a, a.name)
    arm.animation_data.action = None

    # Each remaining anim FBX: steal action, delete its duplicate mesh+armature.
    for f, name in clip_files.items():
        if os.path.basename(f) == os.path.basename(opts['base']): continue
        pre_objs = {o.name for o in bpy.data.objects}
        pre_acts = {a.name for a in bpy.data.actions}
        bpy.ops.import_scene.fbx(filepath=f)
        action, new_objs = steal_action_and_delete_import(pre_objs, pre_acts)
        action.name = f'CharacterArmature|{name}'
        if name in opts['trims']:
            trim_action(action, *opts['trims'][name])
        push_down(arm, action, action.name)
        for o in new_objs:
            if o.type == 'ARMATURE' and o != arm: o.animation_data_clear()
            bpy.data.objects.remove(o, do_unlink=True)
        # Kill the duplicate textures the anim FBX re-embedded (users>0 via
        # their material until we purge; dropped here so they never export).
        for img in list(bpy.data.images):
            if img.name not in {i.name for i in []} and img not in _base_images:
                if img.users == 0: bpy.data.images.remove(img)
        for block in (bpy.data.meshes, bpy.data.armatures, bpy.data.materials):
            for item in list(block):
                if item.users == 0: block.remove(item)
    arm.animation_data.action = None

    h = world_height(base_meshes)
    os.makedirs(os.path.dirname(opts['out']), exist_ok=True)
    export_kw = dict(filepath=opts['out'], export_format='GLB',
                     export_animations=True, export_skins=True,
                     export_apply=False, export_yup=True, export_extras=False)
    try:
        bpy.ops.export_scene.gltf(**export_kw, export_animation_mode='ACTIONS')
    except TypeError:  # older exporter without the mode enum
        bpy.ops.export_scene.gltf(**export_kw)
    bpy.ops.outliner.orphans_purge(do_local_ids=True, do_recursive=True)

    size = os.path.getsize(opts['out'])
    clips = [a.name for a in bpy.data.actions]
    print('CLIPS:', clips)
    print('HEIGHT_WORLD:', round(h, 4))
    print('SCALE_FOR_155:', round(1.55 / h, 4))
    print('TEXTURES_JPEG:', tex_report)
    print('OUT_SIZE_MB:', round(size / 1048576, 2))
    print('WROTE:', opts['out'])

main()
