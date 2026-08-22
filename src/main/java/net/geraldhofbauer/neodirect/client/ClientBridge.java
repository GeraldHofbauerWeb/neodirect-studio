package net.geraldhofbauer.neodirect.client;

import net.geraldhofbauer.neodirect.timeline.Cue;

import java.util.List;
import java.util.Queue;
import java.util.concurrent.ConcurrentLinkedQueue;

/**
 * Hand-off from the server thread to the client thread.
 *
 * <p>Most of a take happens server-side (setting blocks, equipping the player). Three things must
 * happen on the client instead: the camera pose, the first-person arm swing, and suppressing
 * keyboard input. The arm swing in particular <em>cannot</em> come from the server — the server
 * never sends an animate packet back to the player who triggered it, so a server-side
 * {@code swing()} animates the view of everyone except the one person we are filming.
 *
 * <p>A plain concurrent queue is enough because this only ever runs in a single-player recording
 * instance, where both sides live in one JVM. For a dedicated server this would have to become a
 * network payload.
 */
public final class ClientBridge {

    private ClientBridge() {
    }

    /** Something the client half has to do. */
    public sealed interface Command permits Command.BeginRun, Command.MoveCamera, Command.Swing,
            Command.SetPose, Command.EndRun {

        /** Take the wheel: freeze player input and put the camera where the first keyframe is. */
        record BeginRun(double x, double y, double z, float yaw, float pitch) implements Command {}

        /**
         * Stand the camera somewhere, outside a take.
         *
         * <p>What the studio uses to look through the lens while a shot is being composed: put the
         * camera on this keyframe, hold it there, and let a screenshot answer whether the framing
         * is any good. {@code hold} keeps the filming body — the small box, intangible — so a
         * standpoint inside a machine can be judged from inside the machine rather than from
         * wherever the server shoves a solid player next.
         */
        record SetPose(double x, double y, double z, float yaw, float pitch, boolean hold) implements Command {}

        record MoveCamera(List<Cue.Keyframe> keyframes, long durationMs, boolean linear) implements Command {}

        record Swing() implements Command {}

        /** Give control back to the human. */
        record EndRun() implements Command {}
    }

    private static final Queue<Command> QUEUE = new ConcurrentLinkedQueue<>();

    public static void send(Command command) {
        QUEUE.add(command);
    }

    public static Command poll() {
        return QUEUE.poll();
    }

    public static void clear() {
        QUEUE.clear();
    }
}
