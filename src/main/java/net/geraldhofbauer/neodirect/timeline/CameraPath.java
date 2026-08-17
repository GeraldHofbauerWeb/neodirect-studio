package net.geraldhofbauer.neodirect.timeline;

import net.minecraft.util.Mth;
import net.minecraft.world.phys.Vec3;

import java.util.List;

/**
 * The shape of a camera move, independent of who is playing it back.
 *
 * <p>Shared deliberately: the client flies this path and the verifier walks the same path looking
 * for blocks in the way. If the two had their own copies of the maths, a shot could pass the check
 * and still clip a wall.
 */
public final class CameraPath {

    private CameraPath() {
    }

    /** Smoothstep. A move that starts and stops abruptly reads as a teleport with extra steps. */
    public static double easeInOut(double t) {
        return t * t * (3.0 - 2.0 * t);
    }

    /**
     * Position and rotation at a point along the path, {@code t} running 0..1 <em>after</em>
     * easing.
     */
    public static Pose sample(List<Cue.Keyframe> keyframes, double t) {
        int segments = keyframes.size() - 1;
        double scaled = t * segments;
        int segment = Math.min((int) scaled, segments - 1);
        double local = scaled - segment;

        Cue.Keyframe p0 = keyframes.get(Math.max(segment - 1, 0));
        Cue.Keyframe p1 = keyframes.get(segment);
        Cue.Keyframe p2 = keyframes.get(segment + 1);
        Cue.Keyframe p3 = keyframes.get(Math.min(segment + 2, keyframes.size() - 1));

        Vec3 position = new Vec3(
                catmullRom(local, p0.x(), p1.x(), p2.x(), p3.x()),
                catmullRom(local, p0.y(), p1.y(), p2.y(), p3.y()),
                catmullRom(local, p0.z(), p1.z(), p2.z(), p3.z()));

        return new Pose(position,
                Mth.rotLerp((float) local, p1.yaw(), p2.yaw()),
                Mth.lerp((float) local, p1.pitch(), p2.pitch()));
    }

    public record Pose(Vec3 position, float yaw, float pitch) {}

    /**
     * Uniform Catmull-Rom, the standard form with tension 0.5.
     *
     * <p>Worth remembering that this <em>overshoots</em>: the curve passes through every keyframe
     * but can bulge outside the box they span. A path whose keyframes all sit clear of the build
     * can still bow into it between them, which is why the clearance check samples the curve
     * rather than the keyframes.
     */
    public static double catmullRom(double t, double p0, double p1, double p2, double p3) {
        double t2 = t * t;
        double t3 = t2 * t;
        return 0.5 * ((2.0 * p1)
                + (-p0 + p2) * t
                + (2.0 * p0 - 5.0 * p1 + 4.0 * p2 - p3) * t2
                + (-p0 + 3.0 * p1 - 3.0 * p2 + p3) * t3);
    }
}
