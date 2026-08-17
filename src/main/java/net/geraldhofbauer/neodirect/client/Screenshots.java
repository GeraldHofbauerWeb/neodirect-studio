package net.geraldhofbauer.neodirect.client;

import java.util.concurrent.CompletableFuture;
import java.util.concurrent.atomic.AtomicReference;

/**
 * A screenshot request queued from the control server and served on the render thread.
 *
 * <p>Grabbing the game's own framebuffer beats screen-scraping the window: it needs no X11 or
 * PipeWire capture, it cannot catch another window on top, and it yields exactly the frame the
 * viewer would see. Used to check camera framing while iterating on a shot, without having to
 * start OBS for every attempt.
 *
 * <p>Lives in the common half (no client-only types) so {@code ControlServer} can queue a request
 * from the HTTP thread.
 */
public final class Screenshots {

    private Screenshots() {
    }

    private static final AtomicReference<CompletableFuture<String>> PENDING = new AtomicReference<>();

    /** Returns a future that completes with the written file path, or null if one is already queued. */
    public static CompletableFuture<String> request() {
        CompletableFuture<String> future = new CompletableFuture<>();
        return PENDING.compareAndSet(null, future) ? future : null;
    }

    /** Taken by the render thread; null when nothing is queued. */
    public static CompletableFuture<String> take() {
        return PENDING.getAndSet(null);
    }
}
