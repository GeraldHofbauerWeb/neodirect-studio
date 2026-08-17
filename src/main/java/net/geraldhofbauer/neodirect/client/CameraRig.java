package net.geraldhofbauer.neodirect.client;

import net.geraldhofbauer.neodirect.timeline.CameraPath;
import net.geraldhofbauer.neodirect.timeline.Cue;
import net.minecraft.util.Mth;

import java.util.List;

/**
 * A camera move in progress: keyframes plus a wall clock.
 *
 * <p>The curve itself lives in {@link CameraPath}, shared with the clearance check, so a shot
 * cannot pass verification and then fly a different path on screen.
 */
final class CameraRig {

    private final List<Cue.Keyframe> keyframes;
    private final long durationMs;
    private final long startNanos;

    CameraRig(List<Cue.Keyframe> keyframes, long durationMs) {
        this.keyframes = keyframes;
        this.durationMs = Math.max(1, durationMs);
        this.startNanos = System.nanoTime();
    }

    CameraPath.Pose sample() {
        long elapsedMs = (System.nanoTime() - startNanos) / 1_000_000L;
        double progress = Mth.clamp((double) elapsedMs / durationMs, 0.0, 1.0);
        return CameraPath.sample(keyframes, CameraPath.easeInOut(progress));
    }
}
