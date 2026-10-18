import { MathUtils, PropertyBinding } from 'three';
import { DIVE_DURATION } from './keeper-rig.js';

// Short gestures from the supplied clips, in seconds. Original clips are intact.
export const GREETING_SECONDS = 1.15;
export const COMPLAINT_SECONDS = .78;
const segments = {
  greet: { clip: 'greet_01', start: 1.05, end: 2.70, duration: GREETING_SECONDS },
  complain: { clip: 'complain_01', start: 2.15, end: 3.15, duration: COMPLAINT_SECONDS },
};
const ease = value => { const x = MathUtils.clamp(value, 0, 1); return x * x * (3 - 2 * x); };

/** One owner for source clips and procedural dives: a late clip cannot override a dive. */
export class KeeperMotion {
  constructor(rig, clips) {
    this.rig = rig;
    this.clips = new Map(clips.map(clip => [clip.name.replace(/\.\d+$/, ''), clip]));
    for (const name of ['warm_up', 'greet_01', 'complain_01']) {
      if (!this.clips.has(name)) throw new Error(`Missing goalkeeper animation: ${name}`);
    }
    this.sources = new Map([...this.clips].map(([name, clip]) => [name, clip.tracks.map(track => ({
      interpolant: track.createInterpolant(), binding: PropertyBinding.create(rig.model, track.name),
    }))]));
    this.mode = 'warmup'; this.startedAt = 0; this.offset = 0;
    this.source = null; this.blend = null; this.heldAt = null; this.sideX = 0;
    this.rig.ready(0);
    this.switchTo('warmup', 0, { blendSeconds: 0 });
  }

  capture() {
    return {
      root: { position: this.rig.root.position.clone(), quaternion: this.rig.root.quaternion.clone() },
      bones: [...this.rig.bones.values()].map(bone => ({ bone, position: bone.position.clone(), quaternion: bone.quaternion.clone(), scale: bone.scale.clone() })),
    };
  }

  switchTo(mode, now, { offset = 0, blendSeconds = .16, preserveSide = false } = {}) {
    const from = this.capture();
    this.source = null; this.rig.restore();
    this.mode = mode; this.startedAt = now; this.offset = offset; this.heldAt = null;
    this.sideX = preserveSide ? from.root.position.x : 0;
    this.blend = blendSeconds ? { from, duration: blendSeconds } : null;
    const name = mode === 'warmup' ? 'warm_up' : segments[mode]?.clip;
    if (name) this.source = this.sources.get(name);
    this.update(now);
  }

  warmUp(now = 0) { this.switchTo('warmup', now); }
  greet(now = 0) { this.switchTo('greet', now); return GREETING_SECONDS; }
  complain(now = 0) { this.switchTo('complain', now, { blendSeconds: .24, preserveSide: true }); return COMPLAINT_SECONDS; }
  react(direction, now = 0, offset = 0) {
    if (!['left', 'center', 'right'].includes(direction)) throw new RangeError('Unknown goalkeeper reaction.');
    if (!Number.isFinite(offset) || offset < 0) throw new RangeError('Invalid reaction offset.');
    this.switchTo(direction, now, { offset: Math.min(offset, DIVE_DURATION), blendSeconds: .08 });
  }
  stop(now) { this.update(now); this.heldAt = now; }

  update(now) {
    const clock = this.heldAt ?? now;
    const elapsed = Math.max(0, clock - this.startedAt) / 1000;
    if (this.source) {
      let time;
      if (this.mode === 'warmup') {
        // A reversible, gentle torso-loosening section, avoiding the long deep bend.
        time = .7 * (1 - Math.cos(elapsed * Math.PI * 2 / 2.8));
      } else {
        const segment = segments[this.mode];
        time = MathUtils.lerp(segment.start, segment.end, Math.min(1, elapsed / segment.duration));
      }
      // Reapply every source track before blending. No mixer cache can restore
      // stale values after the procedural rig or a held gesture changes a bone.
      this.rig.restore();
      for (const { binding, interpolant } of this.source) binding.setValue(interpolant.evaluate(time), 0);
      this.rig.root.position.x = this.sideX;
    } else {
      const time = Math.min(DIVE_DURATION, elapsed + this.offset);
      if (this.mode === 'center') this.rig.center(time);
      else this.rig.dive(this.mode, time);
    }
    if (this.blend) {
      const weight = ease(elapsed / this.blend.duration);
      const { from } = this.blend;
      this.rig.root.position.lerpVectors(from.root.position, this.rig.root.position, weight);
      this.rig.root.quaternion.slerp(from.root.quaternion, 1 - weight);
      for (const { bone, position, quaternion, scale } of from.bones) {
        bone.position.lerpVectors(position, bone.position, weight);
        bone.quaternion.slerp(quaternion, 1 - weight);
        bone.scale.lerpVectors(scale, bone.scale, weight);
      }
      if (weight >= 1) this.blend = null;
    }
    this.rig.root.updateMatrixWorld(true); this.rig.ground();
  }

  dispose() { for (const samplers of this.sources.values()) for (const { binding } of samplers) binding.unbind(); }
}
