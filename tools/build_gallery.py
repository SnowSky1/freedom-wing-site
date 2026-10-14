from __future__ import annotations

import hashlib
import json
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "assets"
GALLERY = ASSETS / "gallery"
GALLERY.mkdir(parents=True, exist_ok=True)
FX_ROOT = GALLERY / "effects"
FX_ROOT.mkdir(parents=True, exist_ok=True)
FAMILIES = ["机械巨龙", "龙腾", "祥龙", "黑龙遗愿"]
IDS = {"base": "machine", "v2": "jinglong", "gold": "gold", "longteng": "longteng",
       "lingshi": "lingshi", "longyin": "longyin", "xianglong": "xianglong",
       "heroblt": "heroblt", "w383": "w383"}
LABELS = {"base": "机械巨龙", "v2": "惊龙", "gold": "黄金圣龙", "longteng": "AK47 · 龙腾",
          "lingshi": "龙腾 · 零式", "longyin": "M4A1 · 龙吟", "xianglong": "巴雷特 · 祥龙",
          "heroblt": "黑龙遗愿", "w383": "魔龙 · 梦魇"}
LATIN = {"base": "MACHINE DRAGON", "v2": "JINGLONG", "gold": "GOLDEN DRAGON", "longteng": "AK47 / LONGTENG",
         "lingshi": "LONGTENG / ZERO", "longyin": "M4A1 / LONGYIN", "xianglong": "BARRETT / XIANGLONG",
         "heroblt": "BLACK DRAGON", "w383": "M4A4 / NIGHTMARE"}
ORDER = ["freedom", "gold", "machine", "jinglong", "longteng", "lingshi", "longyin", "xianglong", "heroblt", "w383"]


def read(path):
    return json.loads(path.read_text(encoding="utf-8"))


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def inspection_runtime(source, source_path):
    mesh = source["mesh"]
    n = len(mesh["positions"]) // 3
    assert len(mesh["skinIndices"]) == len(mesh["skinWeights"]) == n * 4
    assert len(mesh["uvs"]) == n * 2
    # Source bone transforms are GLOBAL bind transforms. Animation frames are
    # LOCAL hierarchical transforms; use the native idle frame, never global
    # bind values as a local pose (which turns and separates the gun's parts).
    frame = source["clips"]["idle"]["frames"][0]
    bones = [{"name": b["name"], "parent": b["parent"], "bind_position": b["position"],
              "bind_quaternion": b["quaternion"]} for b in mesh["bones"]]
    assert len(frame["translations"]) == len(bones) * 3
    assert len(frame["rotations"]) == len(bones) * 4
    weighted = sum(any(abs(w) > 1e-6 for w in mesh["skinWeights"][i * 4 + 1:i * 4 + 4]) for i in range(n))
    payload = {"source_file": source_path.name, "vertex_count": n,
               "triangle_count": len(mesh["indices"]) // 3, "submesh_count": 1,
               "single_weight_only": weighted == 0, "bones": bones,
               "positions": mesh["positions"], "uvs": mesh["uvs"], "indices": mesh["indices"],
               "joint_indices": mesh["skinIndices"][::4]}
    if weighted:
        payload["skin_indices"] = mesh["skinIndices"]
        payload["skin_weights"] = mesh["skinWeights"]
    return {"version": 2, "note": "Native weapon geometry in source idle frame 0, with original skin weights.",
            "poses": {"fp": {"s1": {"clip": "inspection_idle", "frame": 0}, "s2": {"clip": "inspection_idle", "frame": 0}}},
            "meshes": {"fp": payload}, "animations": {"fp": {"inspection_idle": {
                "source_file": source_path.name, "frame_rate": source["clips"]["idle"]["rate"],
                "frame_count": 1, "joint_count": len(bones), "frames": [frame]}}}}


manifest = [{"id": "freedom", "label": "自由之翼", "latin": "FREEDOM WING",
             "runtime": "./assets/weapon.json", "skin": "./assets/skin.png", "light": "./assets/light.png",
             "flipY": True, "overlay": {"scroll": .41, "scaleV": 1.85, "gate": 1, "gateValue": .9,
                                        "color": [-.27, -.29, -.3], "intensity": .7}}]
sources = []
for family in FAMILIES:
    viewer = ROOT.parent / family / "viewer"
    config = read(viewer / "data/weapon_config.json")
    for weapon in config["weapons"]:
        slug = weapon["slug"]
        item_id = IDS[slug]
        surface = weapon["views"]["fp"]
        source_file = viewer / surface["runtime"]
        data = inspection_runtime(read(source_file), source_file)
        output_file = GALLERY / f"{item_id}.json"
        output_file.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        for key in ("skin", "light"):
            if surface.get(key):
                shutil.copy2(viewer / surface[key], GALLERY / f"{item_id}-{key}.png")
        overlay = surface.get("overlay") if surface.get("light") else {"scroll": 0, "scaleV": 1, "gate": 1, "gateValue": 1, "color": [0, 0, 0], "intensity": 0}
        manifest.append({"id": item_id, "label": LABELS[slug], "latin": LATIN[slug],
                         "runtime": f"./assets/gallery/{item_id}.json", "skin": f"./assets/gallery/{item_id}-skin.png",
                         "light": f"./assets/gallery/{item_id}-light.png" if surface.get("light") else None,
                         "overlay": overlay, "flipY": False,
                         "decorations": []})
        # Fixed inspection profile shows the complete cosmetic configuration;
        # source gameplay conditions remain recorded, never replaced by invented FX.
        profile = {"view": "fp", "kills": 2000, "companions": [331]}
        manifest[-1]["appearanceProfile"] = profile
        for decoration in weapon.get("decorations", []):
            if decoration.get("onlyTp") or decoration.get("kills", 0) > profile["kills"]:
                continue
            required = decoration.get("requiresWeapon", 0)
            if required and required not in profile["companions"]:
                continue
            pack = config["effects"][decoration["source"]]
            effect_file = viewer / pack["url"]
            destination = FX_ROOT / effect_file.parent.name
            destination.mkdir(parents=True, exist_ok=True)
            effect_graph = read(effect_file)
            # Include only the exact referenced graph and its texture/shape assets.
            dependencies = {effect_file.name}
            for emitter in effect_graph["emitters"]:
                dependencies.add(emitter["texture"])
                if emitter["shape"].get("file"):
                    dependencies.add(emitter["shape"]["file"])
            for relative in dependencies:
                source_asset = effect_file.parent / relative
                target_asset = destination / relative
                target_asset.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(source_asset, target_asset)
            manifest[-1]["decorations"].append({**decoration,
                "url": "./assets/gallery/effects/" + effect_file.parent.name + "/" + effect_file.name,
                "sha256": sha256(effect_file),
                "particles": effect_graph["particleCount"]})
        manifest[-1]["appearanceLabel"] = "完整外观" if any(d.get("requiresWeapon") or d.get("kills") for d in manifest[-1]["decorations"]) else ""
        sources.append({"id": item_id, "label": LABELS[slug], "gameWeaponId": weapon["id"],
                        "source": str(source_file), "sourceSha256": sha256(source_file),
                        "outputSha256": sha256(output_file), "sourcePose": "clips.idle.frames[0]",
                        "vertices": data["meshes"]["fp"]["vertex_count"],
                        "triangles": data["meshes"]["fp"]["triangle_count"],
                        "weightedVertices": 0})
manifest.sort(key=lambda item: ORDER.index(item["id"]))
(ASSETS / "gallery.json").write_text(json.dumps({"version": 2, "default": "freedom", "weapons": manifest}, ensure_ascii=False, indent=2), encoding="utf-8")
for item in sources:
    mesh = read(GALLERY / f"{item['id']}.json")["meshes"]["fp"]
    weights = mesh.get("skin_weights", [])
    item["weightedVertices"] = sum(any(w > 1e-6 for w in weights[i+1:i+4]) for i in range(0, len(weights), 4))
(ROOT / "output/gallery-sources.json").write_text(json.dumps({"date": "2026-10-15", "sources": sources}, ensure_ascii=False, indent=2), encoding="utf-8")
print(f"Built {len(manifest)} weapons from {len(FAMILIES)} existing viewer families + Freedom Wing")
