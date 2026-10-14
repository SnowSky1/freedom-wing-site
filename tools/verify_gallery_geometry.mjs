import * as THREE from '../lib/three.module.js';
import { WeaponRig } from '../weapon-scene.js';
import fs from 'node:fs';
const root = new URL('../', import.meta.url);
const read = path => JSON.parse(fs.readFileSync(path, 'utf8'));
const sources = read(new URL('output/gallery-sources.json', root)).sources;
const items = read(new URL('assets/gallery.json', root)).weapons;
const results = [];
for (const source of sources) {
  const data = read(source.source), m = data.mesh, item = items.find(entry => entry.id === source.id);
  const runtime = read(new URL(item.runtime, root));
  const rig = new WeaponRig({ runtime, skin: null, light: null, overlay: item.overlay }, 'fp', true);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(m.positions, 3));
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(m.skinIndices, 4));
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(m.skinWeights, 4));
  const bind = m.bones.map(b => new THREE.Matrix4().compose(new THREE.Vector3(...b.position), new THREE.Quaternion(...b.quaternion).normalize(), new THREE.Vector3(1, 1, 1)));
  const inverse = bind.map(matrix => matrix.clone().invert());
  const bones = m.bones.map((b, i) => {
    const bone = new THREE.Bone();
    const local = b.parent < 0 ? bind[i] : inverse[b.parent].clone().multiply(bind[i]);
    local.decompose(bone.position, bone.quaternion, bone.scale);
    return bone;
  });
  m.bones.forEach((b, i) => { if (b.parent >= 0) bones[b.parent].add(bones[i]); });
  const reference = new THREE.SkinnedMesh(geometry, new THREE.MeshBasicMaterial());
  reference.bind(new THREE.Skeleton(bones, inverse), new THREE.Matrix4());
  bones.forEach((bone, i) => { if (m.bones[i].parent < 0) reference.add(bone); });
  const frame = data.clips.idle.frames[0];
  bones.forEach((bone, i) => { bone.position.fromArray(frame.translations, i * 3); bone.quaternion.fromArray(frame.rotations, i * 4).normalize(); });
  reference.updateWorldMatrix(true, true); reference.skeleton.update();
  const expected = new THREE.Vector3(), actual = new THREE.Vector3();
  let maxVertexError = 0, maxJointError = 0;
  for (let i = 0; i < m.positions.length / 3; i++) {
    expected.fromBufferAttribute(reference.geometry.attributes.position, i);
    reference.applyBoneTransform(i, expected);
    expected.applyMatrix4(rig.rotation).sub(rig.center).add(rig.group.position);
    actual.fromArray(rig.positions, i * 3).add(rig.group.position);
    maxVertexError = Math.max(maxVertexError, actual.distanceTo(expected));
  }
  bones.forEach((bone, i) => {
    expected.setFromMatrixPosition(bone.matrixWorld).applyMatrix4(rig.rotation).sub(rig.center);
    actual.fromArray(rig.bonePositions, i * 3);
    maxJointError = Math.max(maxJointError, expected.distanceTo(actual));
  });
  const pass = maxVertexError < .0001 && maxJointError < .0001;
  results.push({ id: item.id, vertices: m.positions.length / 3, maxVertexError, maxJointError, pass });
  if (!pass) throw Error(JSON.stringify(results.at(-1)));
}
const report = { date: '2026-10-15', reference: 'Independent Three.js SkinnedMesh built from original viewer data, global bind inverses and full four-weight skinning', results };
fs.writeFileSync(new URL('output/gallery-geometry-reference.json', root), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
