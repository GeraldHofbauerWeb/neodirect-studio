package net.geraldhofbauer.neodirect.client;

import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.atomic.AtomicReference;

/**
 * A request for the textures of a set of blocks, queued from the control server and served on the
 * render thread.
 *
 * <p>The studio draws the build as voxels, and until now it painted them in the colour the map
 * would use — one average per block. That is enough to tell a floor from a drill and not enough to
 * recognise a machine. The client already has every texture stitched into an atlas in memory, so
 * the answer is to hand a slice of it over rather than to ship a copy of the resource packs
 * alongside the studio and hope the two stay in step.
 *
 * <p>Same shape as {@link Screenshots}, and for the same reason: the HTTP thread cannot touch a
 * sprite, so it leaves a request here and waits on the future while the client thread does the
 * work. Lives in the common half — no client-only types — so {@code ControlServer} can queue one.
 */
public final class BlockTextures {

    private BlockTextures() {
    }

    /**
     * @param ids    block ids, as {@code namespace:path}, to export
     * @param answer completed with the JSON body: the packed atlas and where each block sits in it
     */
    public record Request(List<String> ids, CompletableFuture<String> answer) {
    }

    private static final AtomicReference<Request> PENDING = new AtomicReference<>();

    /** Returns a future for the JSON body, or null if a request is already queued. */
    public static CompletableFuture<String> request(List<String> ids) {
        CompletableFuture<String> answer = new CompletableFuture<>();
        return PENDING.compareAndSet(null, new Request(List.copyOf(ids), answer)) ? answer : null;
    }

    /** Taken by the client thread; null when nothing is queued. */
    public static Request take() {
        return PENDING.getAndSet(null);
    }
}
