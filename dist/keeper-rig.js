import * as THREE from 'three';

export const DIVE_DURATION = 1.1;
const smooth = x => { x = THREE.MathUtils.clamp(x, 0, 1); return x * x * (3 - 2 * x); };
const poses = {
  ready: { crouch: .14, roll: 0, x: 0, lift: 0, reach: 0, tuck: 0 },
  load: { crouch: .24, roll: .12, x: .03, lift: -.04, reach: .18, tuck: .05 },
  launch: { crouch: .07, roll: .46, x: .48, lift: .18, reach: .65, tuck: .1 },
  flight: { crouch: .02, roll: 1.08, x: 1.43, lift: .16, reach: 1, tuck: .25 },
  landing: { crouch: .02, roll: 1.46, x: 1.98, lift: -.61, reach: .96, tuck: .56 },
  settle: { crouch: .02, roll: 1.49, x: 2.04, lift: -.67, reach: .86, tuck: .7 },
};
const keys = [[0, 'ready'], [.10, 'load'], [.25, 'launch'], [.50, 'flight'], [.83, 'landing'], [DIVE_DURATION, 'settle']];

export function diveSample(time) {
  const t = THREE.MathUtils.clamp(time, 0, DIVE_DURATION);
  const index = keys.findIndex(([end]) => end >= t);
  if (index <= 0) return { ...poses.ready };
  const [start, from] = keys[index - 1];
  const [end, to] = keys[index];
  const weight = smooth((t - start) / (end - start));
  return Object.fromEntries(Object.keys(poses.ready).map(key => [key, THREE.MathUtils.lerp(poses[from][key], poses[to][key], weight)]));
}

/** Pose the supplied skin in place. Bones retain their original lengths and weights. */
export class KeeperRig {
  constructor(model) {
    this.model = model;
    this.bones = new Map();
    this.rest = new Map();
    this.meshes = [];
    model.traverse(object => {
      if (object.isBone) {
        const name = object.name.replace(/^mixamorig[:_]?/, '');
        this.bones.set(name, object);
        this.rest.set(object, { position: object.position.clone(), quaternion: object.quaternion.clone(), scale: object.scale.clone() });
      }
      if (object.isSkinnedMesh) this.meshes.push(object);
    });
    const missing = ['Hips', 'Spine', 'Spine1', 'Spine2', 'Head', 'LeftArm', 'RightArm', 'LeftForeArm', 'RightForeArm', 'LeftHand', 'RightHand', 'LeftUpLeg', 'RightUpLeg', 'LeftLeg', 'RightLeg', 'LeftFoot', 'RightFoot'].filter(name => !this.bones.has(name));
    if (missing.length || !this.meshes.length) throw new Error(`The keeper needs a skinned humanoid rig. Missing: ${missing.join(', ') || 'skinned mesh'}.`);

    model.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(model);
    const size = box.getSize(new THREE.Vector3());
    this.scale = 1.86 / size.y;
    const hip = this.bones.get('Hips').getWorldPosition(new THREE.Vector3());
    this.hipHeight = (hip.y - box.min.y) * this.scale;
    this.root = new THREE.Group();
    this.root.name = 'KeeperMotion';
    model.scale.multiplyScalar(this.scale);
    model.position.set(-hip.x * this.scale, -hip.y * this.scale, -hip.z * this.scale);
    this.root.add(model);
    this.root.position.y = this.hipHeight;
    this.root.updateMatrixWorld(true);
  }

  restore() {
    for (const [bone, rest] of this.rest) {
      bone.position.copy(rest.position);
      bone.quaternion.copy(rest.quaternion);
      bone.scale.copy(rest.scale);
    }
    this.root.position.set(0, this.hipHeight, 0);
    this.root.quaternion.identity();
    this.root.updateMatrixWorld(true);
  }

  // Aim a bone's existing child axis, preserving its bind-pose twist rather
  // than assuming all exported Mixamo bones share the same local axes.
  aim(name, childName, direction) {
    const bone = this.bones.get(name);
    const child = this.bones.get(childName);
    if (!bone || !child) return;
    bone.updateWorldMatrix(true, true);
    const from = child.getWorldPosition(new THREE.Vector3()).sub(bone.getWorldPosition(new THREE.Vector3())).normalize();
    const target = new THREE.Vector3(...direction).normalize();
    const delta = new THREE.Quaternion().setFromUnitVectors(from, target);
    const world = bone.getWorldQuaternion(new THREE.Quaternion()).premultiply(delta);
    const parent = bone.parent.getWorldQuaternion(new THREE.Quaternion()).invert();
    bone.quaternion.copy(parent.multiply(world));
    bone.updateWorldMatrix(false, true);
  }

  bodyPose({ reach = 0, tuck = 0, crouch = .14 }, direction = 1) {
    const lerp = THREE.MathUtils.lerp;
    this.aim('Spine', 'Spine1', [0, 1, lerp(.12, .015, reach)]);
    this.aim('Spine1', 'Spine2', [0, 1, lerp(.07, .015, reach)]);
    this.aim('Spine2', 'Neck', [0, 1, lerp(.06, .02, reach)]);
    this.aim('Neck', 'Head', [0, 1, -.02]);
    for (const [side, sign] of [['Left', 1], ['Right', -1]]) {
      const trailing = sign === direction ? .6 : 1;
      this.aim(`${side}UpLeg`, `${side}Leg`, [
        sign * lerp(.28, .12, reach), -1, lerp(crouch * 2.5, -.10 + tuck * trailing, reach),
      ]);
      this.aim(`${side}Leg`, `${side}Foot`, [
        -sign * .08, -1, lerp(-crouch * 2.5, -.08 - tuck * trailing * .9, reach),
      ]);
      this.aim(`${side}Foot`, `${side}ToeBase`, [sign * .06, -.03, 1]);
      // Arms move from a low open stance into an overhead reach in body space.
      // Rolling the body then puts BOTH gloves out toward the chosen goal zone.
      this.aim(`${side}Arm`, `${side}ForeArm`, [
        sign * lerp(.78, -.22, reach), lerp(-.65, .96, reach), lerp(.24, .12, reach),
      ]);
      this.aim(`${side}ForeArm`, `${side}Hand`, [
        sign * lerp(.12, -.2, reach), lerp(.32, 1, reach), lerp(.94, .14, reach),
      ]);
      this.aim(`${side}Hand`, `${side}HandMiddle1`, [sign * .06, lerp(.65, 1, reach), lerp(.76, .12, reach)]);
    }
    this.root.updateMatrixWorld(true);
  }

  floorClearance() {
    const radii = { Hips: .14, Spine: .14, Spine1: .15, Spine2: .17, Head: .13,
      LeftHand: .055, RightHand: .055, LeftLeg: .07, RightLeg: .07,
      LeftFoot: .065, RightFoot: .065, LeftToeBase: .035, RightToeBase: .035 };
    let bottom = Infinity;
    for (const [name, radius] of Object.entries(radii)) {
      const bone = this.bones.get(name);
      if (bone) bottom = Math.min(bottom, bone.getWorldPosition(new THREE.Vector3()).y - radius);
    }
    return bottom;
  }

  ground() {
    const bottom = this.floorClearance();
    if (bottom < .06) this.root.position.y += .06 - bottom;
    this.root.updateMatrixWorld(true);
  }

  ready(time = 0) {
    this.restore();
    this.bodyPose(poses.ready);
    this.root.position.y -= .09 + Math.sin(time * 2.4) * .005;
    this.ground();
  }

  dive(direction, time) {
    this.restore();
    const sign = direction === 'left' ? -1 : 1;
    const pose = diveSample(time);
    this.bodyPose(pose, sign);
    this.root.rotation.z = -sign * pose.roll;
    this.root.rotation.y = sign * smooth(time / .7) * .035;
    this.root.position.set(sign * pose.x, this.hipHeight - .09 + pose.lift, .10 + .12 * smooth(time / .8));
    this.root.updateMatrixWorld(true);
    this.ground();
  }

  center(time) {
    this.restore();
    const gather = smooth(time / .26);
    const release = smooth((time - .65) / .45);
    const weight = gather * (1 - release);
    this.bodyPose({ reach: weight * .18, crouch: .14 + weight * .16, tuck: 0 });
    // Bring both forearms inward to gather a shot at chest height.
    if (weight > 0) {
      for (const [side, sign] of [['Left', 1], ['Right', -1]]) {
        this.aim(`${side}Arm`, `${side}ForeArm`, [sign * THREE.MathUtils.lerp(.78, .32, weight), -.8, .3]);
        this.aim(`${side}ForeArm`, `${side}Hand`, [-sign * .25 * weight, .55, .9]);
      }
    }
    this.root.position.y -= .09 + weight * .13;
    this.ground();
  }

  sourceClip(mixer, action, time) {
    // AnimationMixer caches unchanged track values. Keep its last bone pose
    // intact while scrubbing a held frame; resetting the bones here would
    // overwrite constant/cached tracks with the bind pose.
    this.root.position.set(0, this.hipHeight, 0);
    this.root.quaternion.identity();
    action.paused = false;
    action.time = time;
    mixer.update(0);
    this.root.updateMatrixWorld(true);
    this.ground();
  }
}
