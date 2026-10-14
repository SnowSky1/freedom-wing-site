import * as THREE from './lib/three.module.js';

const clamp = THREE.MathUtils.clamp;
const asset = name => new URL(`./assets/${name}`, import.meta.url).href;
// Presentation offsets in the recovered model's canonical coordinates.
// Every triangle belongs to one bone, so moving each bone's geometry as a rigid
// unit exposes the real parts without cutting the mesh or stretching triangles.
const PART_MOTION = {
  GunOrigin:          { offset: [0, 0, -13], turn: [0, 0, 0], delay: 0 },
  Bone001:           { offset: [0, 0, 16], turn: [0, 0, 0], delay: .02 },
  Bone002:           { offset: [0, 5, 51], turn: [0, 0, 0], delay: 0 },
  Bone022:           { offset: [0, -18, 62], turn: [.04, .08, 0], delay: .06 },
  Bone003:           { offset: [0, 24, 15], turn: [-.08, 0, 0], delay: .08 },
  Bone004:           { offset: [0, -23, 16], turn: [.08, 0, 0], delay: .10 },
  Bone013:           { offset: [0, 25, -13], turn: [-.05, 0, 0], delay: .04 },
  Bone015:           { offset: [0, -28, -9], turn: [.1, 0, 0], delay: .08 },
  Bone023:           { offset: [-24, 4, -9], turn: [0, .13, -.08], delay: .10 },
  Bone005:           { offset: [0, 37, -13], turn: [-.1, 0, 0], delay: .12 },
  Bone025:           { offset: [0, 48, -15], turn: [-.12, 0, 0], delay: .14 },
  Bone014:           { offset: [0, 58, -15], turn: [-.12, 0, 0], delay: .18 },
  Bone016:           { offset: [-8, 36, 22], turn: [-.1, 0, -.1], delay: .12 },
  Bone017:           { offset: [0, 41, 11], turn: [-.12, 0, 0], delay: .16 },
  Bone018:           { offset: [8, 36, 0], turn: [-.1, 0, .1], delay: .20 },
  GunFlashHold:      { offset: [0, 5, 51], turn: [0, 0, 0], delay: 0 },
};
const ease = value => { const p = clamp(value, 0, 1); return p * p * (3 - 2 * p); };
let resourcePromise;
export function loadResources() {
  if (!resourcePromise) {
    const loader = new THREE.TextureLoader();
    resourcePromise = Promise.all([
      fetch(asset('weapon.json')).then(response => {
        if (!response.ok) throw new Error(`模型加载失败：${response.status}`);
        return response.json();
      }),
      loader.loadAsync(asset('skin.png')),
      loader.loadAsync(asset('light.png')),
    ]).then(([runtime, skin, light]) => {
      skin.colorSpace = THREE.SRGBColorSpace;
      light.colorSpace = THREE.SRGBColorSpace;
      skin.anisotropy = 4;
      light.wrapS = light.wrapT = THREE.RepeatWrapping;
      return { runtime, skin, light };
    }).catch(error => { resourcePromise = null; throw error; });
  }
  return resourcePromise;
}

function surfaceMaterial(resources, dark) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uSkin: { value: resources.skin }, uLight: { value: resources.light },
      uTime: { value: 0 }, uOpacity: { value: 1 }, uPulse: { value: 0 },
      uAmbient: { value: dark ? 0.53 : 0.49 },
    },
    vertexShader: `
      varying vec2 vUv;
      varying vec3 vNormal;
      varying vec3 vView;
      void main(){
        vUv = uv;
        vNormal = normalize(normalMatrix * normal);
        vec4 mv = modelViewMatrix * vec4(position, 1.);
        vView = -mv.xyz;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      uniform sampler2D uSkin;
      uniform sampler2D uLight;
      uniform float uTime, uOpacity, uPulse, uAmbient;
      varying vec2 vUv;
      varying vec3 vNormal;
      varying vec3 vView;
      void main(){
        vec3 base = texture2D(uSkin, vUv).rgb;
        vec3 overlay = texture2D(uLight, vec2(vUv.x - uTime * .41, vUv.y * 1.85)).rgb;
        overlay = max(overlay + vec3(-.27, -.29, -.30), vec3(0.));
        overlay *= max(.9 - step(1., vUv.y), 0.) * .7;
        vec3 n = normalize(vNormal);
        vec3 view = normalize(vView);
        vec3 key = normalize(vec3(-.3, .8, 1.));
        vec3 rim = normalize(vec3(.6, -.2, .6));
        float diffuse = max(dot(n, key), 0.) * .62 + max(dot(n, rim), 0.) * .24;
        float specular = pow(max(dot(n, normalize(key + view)), 0.), 54.) * .30;
        float cyan = clamp(min(base.g, base.b) - base.r * .58 - .08, 0., 1.);
        vec3 color = (base + overlay) * (uAmbient + diffuse) + vec3(specular);
        color += vec3(.22, .62, .8) * (cyan * .16 + uPulse * cyan * .55);
        gl_FragColor = vec4(color, uOpacity);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    transparent: true,
    side: THREE.DoubleSide,
  });
}

// The recovered model uses one bone per vertex. Keep the original bind matrices
// and interpolate the recovered per-frame translations and quaternions directly.
class WeaponRig {
  constructor(resources, kind, dark) {
    this.runtime = resources.runtime;
    this.kind = kind;
    this.payload = this.runtime.meshes[kind];
    this.group = new THREE.Group();
    this.unit = new THREE.Vector3(1, 1, 1);
    this.v = new THREE.Vector3();
    this.v2 = new THREE.Vector3();
    this.q = new THREE.Quaternion();
    this.q2 = new THREE.Quaternion();
    this.local = new THREE.Matrix4();
    this.rotation = new THREE.Matrix4();
    this.center = new THREE.Vector3();
    this.poseOffset = new THREE.Vector3();
    this.explosionShift = new THREE.Vector3();
    this.posedBounds = new THREE.Box3();
    this.expandedBounds = new THREE.Box3();
    this.base = Float32Array.from(this.payload.positions);
    this.positions = new Float32Array(this.base.length);
    this.posedPositions = new Float32Array(this.base.length);
    this.explosion = 0;
    this.formProgress = 0;
    this.centroids = this.payload.bones.map(() => new THREE.Vector3());
    this.partCounts = this.payload.bones.map(() => 0);
    this.partMatrices = this.payload.bones.map(() => new THREE.Matrix4());
    this.partOffsets = this.payload.bones.map(() => new THREE.Vector3());
    this.partEuler = new THREE.Euler();
    this.partMotion = this.payload.bones.map(bone => PART_MOTION[bone.name] || { offset: [0, 0, 0], turn: [0, 0, 0], delay: 0 });
    this.payload.joint_indices.forEach(joint => this.partCounts[joint]++);
    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setAttribute('uv', new THREE.Float32BufferAttribute(this.payload.uvs, 2));
    this.geometry.setIndex(this.payload.indices);
    this.material = surfaceMaterial(resources, dark);
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.group.add(this.mesh);
    this.world = this.payload.bones.map(() => new THREE.Matrix4());
    this.skin = this.payload.bones.map(() => new THREE.Matrix4());
    this.inverse = this.payload.bones.map(bone => new THREE.Matrix4().compose(
      new THREE.Vector3(...bone.bind_position),
      new THREE.Quaternion(...bone.bind_quaternion).normalize(),
      this.unit,
    ).invert());
    this.originIndex = this.payload.bones.findIndex(b => b.name === 'GunOrigin');
    this.flashIndex = this.payload.bones.findIndex(b => b.name === 'GunFlashHold');
    this.bonePositions = new Float32Array(this.payload.bones.length * 3);
    this.posedBones = new Float32Array(this.bonePositions.length);
    this.boneGeometry = new THREE.BufferGeometry();
    this.boneGeometry.setAttribute('position', new THREE.BufferAttribute(this.bonePositions, 3));
    this.boneMaterial = new THREE.PointsMaterial({ color: dark ? 0xb7f1fc : 0x324c55, size: 4, sizeAttenuation: false, depthTest: false, transparent: true });
    this.bonePoints = new THREE.Points(this.boneGeometry, this.boneMaterial);
    this.bonePoints.frustumCulled = false;
    this.bonePoints.renderOrder = 5;
    this.linePositions = new Float32Array((this.payload.bones.length - 1) * 6);
    this.lineGeometry = new THREE.BufferGeometry();
    this.lineGeometry.setAttribute('position', new THREE.BufferAttribute(this.linePositions, 3));
    this.lineMaterial = new THREE.LineBasicMaterial({ color: dark ? 0x86d3e5 : 0x496672, depthTest: false, transparent: true, opacity: .8 });
    this.lines = new THREE.LineSegments(this.lineGeometry, this.lineMaterial);
    this.lines.frustumCulled = false;
    this.lines.renderOrder = 4;
    this.group.add(this.lines, this.bonePoints);
    this.lines.visible = this.bonePoints.visible = false;
    this.lastPose = '';
    this.pose('switchsub_s1_to_s2', 0);
    const envelope = new THREE.Box3().setFromBufferAttribute(this.geometry.attributes.position);
    this.formCenters = { s1: envelope.getCenter(new THREE.Vector3()) };
    this.pose('switchsub_s1_to_s2', 50);
    const expandedBox = new THREE.Box3().setFromBufferAttribute(this.geometry.attributes.position);
    this.formCenters.s2 = expandedBox.getCenter(new THREE.Vector3());
    envelope.union(expandedBox);
    envelope.getCenter(this.center);
    this.size = envelope.getSize(new THREE.Vector3());
    this.length = Math.max(this.size.x, this.size.y, this.size.z);
    this.lastPose = '';
    this.pose('switchsub_s1_to_s2', 0);
  }

  pose(clipName, frame) {
    const clip = this.runtime.animations[this.kind][clipName];
    frame = clamp(frame, 0, clip.frame_count - 1);
    const key = `${clipName}:${frame.toFixed(3)}`;
    if (key === this.lastPose) return;
    this.lastPose = key;
    const index = Math.floor(frame), alpha = frame - index;
    const a = clip.frames[index], b = clip.frames[Math.min(index + 1, clip.frame_count - 1)];
    this.payload.bones.forEach((bone, i) => {
      this.v.fromArray(a.translations, i * 3);
      this.v2.fromArray(b.translations, i * 3);
      this.v.lerp(this.v2, alpha);
      this.q.fromArray(a.rotations, i * 4).normalize();
      this.q2.fromArray(b.rotations, i * 4).normalize();
      this.q.slerp(this.q2, alpha);
      this.local.compose(this.v, this.q, this.unit);
      if (bone.parent >= 0) this.world[i].multiplyMatrices(this.world[bone.parent], this.local);
      else this.world[i].copy(this.local);
      this.skin[i].multiplyMatrices(this.world[i], this.inverse[i]);
    });
    // Cancel the animation's global heading, preserving the component motion.
    this.v.setFromMatrixPosition(this.world[this.originIndex]);
    this.v2.setFromMatrixPosition(this.world[this.flashIndex]).sub(this.v);
    this.rotation.makeRotationY(-Math.atan2(this.v2.x, this.v2.z));
    const joints = this.payload.joint_indices;
    this.centroids.forEach(center => center.set(0, 0, 0));
    for (let i = 0; i < joints.length; i++) {
      this.v.fromArray(this.base, i * 3).applyMatrix4(this.skin[joints[i]]).applyMatrix4(this.rotation).sub(this.center);
      this.v.toArray(this.posedPositions, i * 3);
      this.centroids[joints[i]].add(this.v);
    }
    this.payload.bones.forEach((bone, i) => {
      this.v.setFromMatrixPosition(this.world[i]).applyMatrix4(this.rotation).sub(this.center);
      this.v.toArray(this.posedBones, i * 3);
      if (this.partCounts[i]) this.centroids[i].divideScalar(this.partCounts[i]);
      else this.centroids[i].copy(this.v);
    });
    this.formProgress = clipName === 'switchsub_s1_to_s2' ? frame / (clip.frame_count - 1)
      : clipName === 'switchsub_s2_to_s1' ? 1 - frame / (clip.frame_count - 1)
      : clipName === 'reload_s2' ? 1 : 0;
    if (this.formCenters?.s2) {
      this.v.lerpVectors(this.formCenters.s1, this.formCenters.s2, this.formProgress);
      this.poseOffset.copy(this.center).sub(this.v);
    }
    this.applyExplosion();
  }

  setExplosion(amount) {
    const next = clamp(amount, 0, 1);
    if (next === this.explosion || (next > 0 && next < 1 && Math.abs(next - this.explosion) < .00001)) return;
    this.explosion = next;
    this.applyExplosion();
  }

  applyExplosion() {
    this.partMotion.forEach((motion, i) => {
      const p = ease((this.explosion - motion.delay) / (1 - motion.delay));
      const center = this.centroids[i];
      this.partOffsets[i].fromArray(motion.offset).multiplyScalar(p);
      this.v.copy(center).add(this.partOffsets[i]);
      this.partEuler.set(motion.turn[0] * p, motion.turn[1] * p, motion.turn[2] * p);
      this.q.setFromEuler(this.partEuler);
      this.partMatrices[i].compose(this.v, this.q, this.unit);
      this.local.makeTranslation(-center.x, -center.y, -center.z);
      this.partMatrices[i].multiply(this.local);
      this.v.fromArray(this.posedBones, i * 3).applyMatrix4(this.partMatrices[i]).toArray(this.bonePositions, i * 3);
    });
    for (let i = 0; i < this.payload.joint_indices.length; i++) {
      this.v.fromArray(this.posedPositions, i * 3)
        .applyMatrix4(this.partMatrices[this.payload.joint_indices[i]])
        .toArray(this.positions, i * 3);
    }
    // Recenter only the added presentation spread, leaving the native animation
    // intact. A long barrel should not move outside the viewport as it separates.
    this.posedBounds.setFromArray(this.posedPositions).getCenter(this.v);
    this.expandedBounds.setFromArray(this.positions).getCenter(this.explosionShift);
    this.explosionShift.sub(this.v);
    this.group.position.copy(this.poseOffset).sub(this.explosionShift);
    let cursor = 0;
    this.payload.bones.forEach((bone, i) => {
      if (bone.parent < 0) return;
      for (const joint of [bone.parent, i]) {
        this.linePositions[cursor++] = this.bonePositions[joint * 3];
        this.linePositions[cursor++] = this.bonePositions[joint * 3 + 1];
        this.linePositions[cursor++] = this.bonePositions[joint * 3 + 2];
      }
    });
    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.computeVertexNormals();
    this.geometry.computeBoundingSphere();
    this.boneGeometry.attributes.position.needsUpdate = true;
    this.lineGeometry.attributes.position.needsUpdate = true;
  }

  setStructure(mode, amount = 1) {
    this.lines.visible = this.bonePoints.visible = mode !== 'solid' && amount > .005;
    this.lineMaterial.opacity = .9 * amount;
    this.boneMaterial.opacity = amount;
    this.material.uniforms.uOpacity.value = mode === 'bones' ? 1 - amount : mode === 'xray' ? 1 - amount * .76 : 1;
    this.material.depthWrite = mode === 'solid' || amount < .05;
    this.mesh.visible = this.material.uniforms.uOpacity.value > .001;
  }
}

export class WeaponScene {
  constructor(element, resources, { dark = false, interactive = false, reducedMotion = false } = {}) {
    this.element = element;
    this.resources = resources;
    this.dark = dark;
    this.reducedMotion = reducedMotion;
    this.renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = dark ? 1.07 : .97;
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.domElement.setAttribute('aria-hidden', 'true');
    element.append(this.renderer.domElement);
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(30, 1, .1, 3000);
    this.pivot = new THREE.Group();
    this.scene.add(this.pivot);
    this.rigs = {};
    this.kind = 'fp';
    this.rig = this.getRig('fp');
    this.yaw = Math.PI / 2 - .32;
    this.pitch = -.1;
    this.roll = -.12;
    this.zoom = 1;
    this.autoRotate = false;
    this.dragYaw = this.dragPitch = 0;
    this.structure = 'solid';
    this.contextLost = false;
    this.renderer.domElement.addEventListener('webglcontextlost', event => {
      event.preventDefault();
      this.contextLost = true;
      this.element.dispatchEvent(new CustomEvent('modelerror', { detail: '三维显示已中断，刷新页面可重新载入。' }));
    });
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(element);
    this.resize();
    if (interactive) this.bindPointer();
  }

  getRig(kind) {
    if (!this.rigs[kind]) {
      const rig = new WeaponRig(this.resources, kind, this.dark);
      this.pivot.add(rig.group);
      this.rigs[kind] = rig;
    }
    return this.rigs[kind];
  }

  setKind(kind) {
    this.kind = kind;
    this.rig = this.getRig(kind);
    Object.entries(this.rigs).forEach(([key, rig]) => { rig.group.visible = key === kind; });
    this.resize();
  }

  resize() {
    const { width, height } = this.element.getBoundingClientRect();
    if (!width || !height) return;
    this.width = width; this.height = height;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    // Fit both a side view and a turn through depth in the same stable framing.
    const halfLength = this.rig.length * .52;
    const distance = halfLength / Math.tan(THREE.MathUtils.degToRad(15)) / Math.min(this.camera.aspect, 1.6);
    this.camera.position.set(0, 4, distance * 1.04);
    this.camera.lookAt(0, 0, 0);
  }

  setPose(clip, frame) { this.rig.pose(clip, frame); }
  setExplosion(amount) { this.rig.setExplosion(amount); }
  setForm(form) {
    const pose = this.resources.runtime.poses[this.kind][form];
    this.rig.pose(pose.clip, pose.frame);
  }
  setStructure(mode, amount = 1) {
    this.structure = mode;
    this.rig.setStructure(mode, amount);
  }

  bindPointer() {
    const el = this.element;
    let pointer = null;
    el.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      pointer = { id: event.pointerId, x: event.clientX, y: event.clientY, yaw: this.dragYaw, pitch: this.dragPitch };
      el.setPointerCapture(event.pointerId);
      el.classList.add('dragging');
    });
    el.addEventListener('pointermove', event => {
      if (!pointer || pointer.id !== event.pointerId) return;
      this.dragYaw = pointer.yaw + (event.clientX - pointer.x) * .008;
      this.dragPitch = clamp(pointer.pitch + (event.clientY - pointer.y) * .005, -.75, .75);
    });
    const release = () => { pointer = null; el.classList.remove('dragging'); };
    el.addEventListener('pointerup', release);
    el.addEventListener('pointercancel', release);
    el.addEventListener('lostpointercapture', release);
    el.addEventListener('dblclick', () => this.resetView());
  }

  resetView() { this.dragYaw = this.dragPitch = 0; this.yaw = Math.PI / 2 - .32; this.pitch = -.1; this.roll = -.12; }

  render(time, delta, pulse = 0) {
    if (this.contextLost) return;
    if (this.autoRotate && !this.reducedMotion) this.yaw += delta * .32;
    this.pivot.rotation.set(this.pitch + this.dragPitch, this.yaw + this.dragYaw, this.roll, 'YXZ');
    const mobileScale = this.width < 600 ? .84 + this.rig.explosion * .25 : 1;
    const expansionScale = (1 - this.rig.explosion * .32) * (1 - this.rig.explosion * this.rig.formProgress * .2);
    this.pivot.scale.setScalar(this.zoom * mobileScale * expansionScale);
    this.rig.material.uniforms.uTime.value = this.reducedMotion ? 0 : time;
    this.rig.material.uniforms.uPulse.value = pulse;
    this.renderer.render(this.scene, this.camera);
  }

  diagnostics() {
    const p = this.rig.positions;
    const screen = { left: Infinity, right: -Infinity, top: Infinity, bottom: -Infinity };
    const projected = new THREE.Vector3();
    for (let i = 0; i < p.length; i += 3) {
      projected.fromArray(p, i).applyMatrix4(this.rig.mesh.matrixWorld).project(this.camera);
      screen.left = Math.min(screen.left, projected.x);
      screen.right = Math.max(screen.right, projected.x);
      screen.top = Math.min(screen.top, projected.y);
      screen.bottom = Math.max(screen.bottom, projected.y);
    }
    let maxEdgeError = 0;
    const indices = this.rig.payload.indices, posed = this.rig.posedPositions;
    for (let i = 0; i < indices.length; i += 3) {
      for (let edge = 0; edge < 3; edge++) {
        const a = indices[i + edge] * 3, b = indices[i + (edge + 1) % 3] * 3;
        const before = Math.hypot(posed[a] - posed[b], posed[a + 1] - posed[b + 1], posed[a + 2] - posed[b + 2]);
        const after = Math.hypot(p[a] - p[b], p[a + 1] - p[b + 1], p[a + 2] - p[b + 2]);
        maxEdgeError = Math.max(maxEdgeError, Math.abs(after - before));
      }
    }
    return {
      kind: this.kind, pose: this.rig.lastPose, yaw: this.yaw, dragYaw: this.dragYaw,
      bones: this.rig.payload.bones.length, vertices: this.rig.payload.vertex_count,
      triangles: this.rig.payload.triangle_count, structure: this.structure,
      finite: p.every(Number.isFinite), sample: Array.from(p.slice(90, 99)),
      poseSignature: p.reduce((sum, value, index) => sum + value * ((index % 17) + 1), 0),
      screen,
      explosion: this.rig.explosion, maxEdgeError,
      parts: this.rig.payload.bones.map((bone, i) => ({ name: bone.name, vertices: this.rig.partCounts[i], offset: this.rig.partOffsets[i].toArray() })).filter(part => part.vertices),
      calls: this.renderer.info.render.calls, contextLost: this.contextLost,
    };
  }
}
