package net.geraldhofbauer.neodirect.control;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import net.geraldhofbauer.neodirect.NeoDirect;
import net.geraldhofbauer.neodirect.client.Screenshots;
import net.geraldhofbauer.neodirect.timeline.Director;
import net.geraldhofbauer.neodirect.timeline.Timeline;
import net.minecraft.core.BlockPos;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerPlayer;
import net.neoforged.bus.api.SubscribeEvent;
import net.neoforged.fml.common.EventBusSubscriber;
import net.neoforged.neoforge.event.server.ServerStartedEvent;
import net.neoforged.neoforge.event.server.ServerStoppingEvent;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

/**
 * The outside world's handle on the director.
 *
 * <p>Uses the JDK's own {@code com.sun.net.httpserver}, which means the mod ships with zero
 * dependencies — no shading, no jar-in-jar, nothing that can collide inside the mod loader. That
 * matters more than elegance here.
 *
 * <p>Bound to loopback only. It is a recording tool on a local machine, not a service.
 *
 * <ul>
 *   <li>{@code GET  /health} — is the mod up, is a take running</li>
 *   <li>{@code POST /run} — body is a timeline JSON; responds when the take is done, with a log of
 *       every step's planned versus actual time. That log is what later lets ffmpeg line the
 *       narration up against the footage.</li>
 * </ul>
 */
@EventBusSubscriber(modid = NeoDirect.MOD_ID)
public final class ControlServer {

    private static final int DEFAULT_PORT = 8777;

    /** Longest a single take may take before we give up waiting on it. */
    private static final long RUN_TIMEOUT_SECONDS = 600;

    private ControlServer() {
    }

    private static HttpServer server;
    private static MinecraftServer minecraftServer;

    @SubscribeEvent
    public static void onServerStarted(ServerStartedEvent event) {
        minecraftServer = event.getServer();
        int port = Integer.getInteger("neodirect.control.port", DEFAULT_PORT);
        try {
            // Explicitly IPv4 loopback, not InetAddress.getLoopbackAddress(): on a dual-stack JVM
            // that resolves to ::1, and the server then silently refuses every client that dials
            // 127.0.0.1 — which is what every script in tools/ does.
            server = HttpServer.create(new InetSocketAddress(InetAddress.getByName("127.0.0.1"), port), 0);
            server.createContext("/health", ControlServer::handleHealth);
            server.createContext("/run", ControlServer::handleRun);
            server.createContext("/screenshot", ControlServer::handleScreenshot);
            server.createContext("/verify", ControlServer::handleVerify);
            server.createContext("/block", ControlServer::handleBlock);
            // A small pool: takes are serialised by the director anyway, this is only so a /health
            // probe is not stuck behind a running take.
            server.setExecutor(Executors.newFixedThreadPool(2));
            server.start();
            NeoDirect.LOGGER.info("ControlServer listening on 127.0.0.1:{}", port);
        } catch (IOException e) {
            NeoDirect.LOGGER.error("ControlServer could not bind 127.0.0.1:{} — is another instance running?", port, e);
        }
    }

    @SubscribeEvent
    public static void onServerStopping(ServerStoppingEvent event) {
        Director.abort("server is shutting down");
        if (server != null) {
            server.stop(0);
            server = null;
            NeoDirect.LOGGER.info("ControlServer stopped.");
        }
        minecraftServer = null;
    }

    private static void handleHealth(HttpExchange exchange) throws IOException {
        JsonObject body = new JsonObject();
        body.addProperty("status", "ok");
        body.addProperty("mod", NeoDirect.MOD_ID);
        body.addProperty("running", Director.isRunning());
        // The capture tool needs to find *this* client's window. Matching by window title is not
        // enough — any other Minecraft on the machine carries the same title, and picking the
        // wrong one silently records somebody else's game.
        body.addProperty("pid", ProcessHandle.current().pid());
        respond(exchange, 200, body.toString());
    }

    /** Grabs the game's own framebuffer — used to check a shot's framing without starting OBS. */
    private static void handleScreenshot(HttpExchange exchange) throws IOException {
        var pending = Screenshots.request();
        if (pending == null) {
            respondError(exchange, 409, "a screenshot is already queued");
            return;
        }
        try {
            String path = pending.get(15, TimeUnit.SECONDS);
            JsonObject body = new JsonObject();
            body.addProperty("path", path);
            respond(exchange, 200, body.toString());
        } catch (TimeoutException e) {
            respondError(exchange, 504, "render thread did not deliver a screenshot — is the game window open?");
        } catch (ExecutionException e) {
            respondError(exchange, 500, String.valueOf(e.getCause()));
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            respondError(exchange, 500, "interrupted");
        }
    }

    /**
     * Compares the built contraption against its schematic. Takes the same timeline body as
     * {@code /run} — the schematic and origin come from it, so a take and its check can never
     * disagree about what was supposed to be built.
     */
    private static void handleVerify(HttpExchange exchange) throws IOException {
        MinecraftServer mc = minecraftServer;
        if (mc == null) {
            respondError(exchange, 503, "no world loaded");
            return;
        }

        String requestBody;
        try (InputStream in = exchange.getRequestBody()) {
            requestBody = new String(in.readAllBytes(), StandardCharsets.UTF_8);
        }

        Timeline timeline;
        try {
            timeline = Timeline.parse(requestBody);
        } catch (RuntimeException e) {
            respondError(exchange, 400, "could not parse timeline: " + e.getMessage());
            return;
        }

        try {
            JsonObject report = mc.submit(() -> {
                try {
                    return Director.verify(timeline, mc);
                } catch (IOException e) {
                    throw new java.io.UncheckedIOException(e);
                }
            }).get(30, TimeUnit.SECONDS);
            respond(exchange, 200, report.toString());
        } catch (TimeoutException e) {
            respondError(exchange, 504, "verification did not finish in time");
        } catch (ExecutionException e) {
            Throwable cause = e.getCause() != null ? e.getCause() : e;
            respondError(exchange, 409, String.valueOf(cause.getMessage()));
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            respondError(exchange, 500, "interrupted");
        }
    }

    /**
     * What is actually at a position: block state and, if there is one, the block entity's NBT.
     *
     * <p>{@code GET /block?pos=1,2,3&pos=4,5,6}. Added after an afternoon of deducing the state of a
     * machine from screenshots — whether a wheel was turning, whether a clutch had engaged, whether
     * a boiler had any water in it. All three are one field in a block entity, and none of them is
     * legible in a still frame.
     */
    private static void handleBlock(HttpExchange exchange) throws IOException {
        MinecraftServer mc = minecraftServer;
        if (mc == null) {
            respondError(exchange, 503, "no world loaded");
            return;
        }
        String query = exchange.getRequestURI().getQuery();
        if (query == null || query.isBlank()) {
            respondError(exchange, 400, "pass one or more pos=x,y,z");
            return;
        }

        JsonArray out = new JsonArray();
        try {
            mc.submit(() -> {
                ServerPlayer player = mc.getPlayerList().getPlayers().stream().findFirst().orElse(null);
                if (player == null) {
                    return null;
                }
                var level = player.serverLevel();
                for (String part : query.split("&")) {
                    if (!part.startsWith("pos=")) {
                        continue;
                    }
                    String[] xyz = part.substring(4).split(",");
                    if (xyz.length != 3) {
                        continue;
                    }
                    BlockPos pos = new BlockPos(Integer.parseInt(xyz[0].trim()),
                            Integer.parseInt(xyz[1].trim()), Integer.parseInt(xyz[2].trim()));
                    JsonObject entry = new JsonObject();
                    entry.addProperty("pos", pos.toShortString());
                    entry.addProperty("state", level.getBlockState(pos).toString());
                    var be = level.getBlockEntity(pos);
                    if (be != null) {
                        entry.addProperty("nbt", be.saveWithoutMetadata(mc.registryAccess()).toString());
                    }
                    out.add(entry);
                }
                return null;
            }).get(10, TimeUnit.SECONDS);
        } catch (Exception e) {
            respondError(exchange, 500, String.valueOf(e.getMessage()));
            return;
        }

        JsonObject body = new JsonObject();
        body.add("blocks", out);
        respond(exchange, 200, body.toString());
    }

    private static void handleRun(HttpExchange exchange) throws IOException {
        if (!"POST".equalsIgnoreCase(exchange.getRequestMethod())) {
            respondError(exchange, 405, "POST a timeline JSON to /run");
            return;
        }

        MinecraftServer mc = minecraftServer;
        if (mc == null) {
            respondError(exchange, 503, "no world loaded");
            return;
        }

        String requestBody;
        try (InputStream in = exchange.getRequestBody()) {
            requestBody = new String(in.readAllBytes(), StandardCharsets.UTF_8);
        }

        Timeline timeline;
        try {
            timeline = Timeline.parse(requestBody);
        } catch (RuntimeException e) {
            respondError(exchange, 400, "could not parse timeline: " + e.getMessage());
            return;
        }

        // submit() touches the world, so it has to happen on the server thread — not on this
        // HTTP worker.
        var submission = mc.submit(() -> Director.submit(timeline, mc));

        try {
            JsonObject result = submission
                    .get(30, TimeUnit.SECONDS)
                    .get(RUN_TIMEOUT_SECONDS, TimeUnit.SECONDS);
            respond(exchange, 200, result.toString());
        } catch (TimeoutException e) {
            Director.abort("take timed out");
            respondError(exchange, 504, "take did not finish within " + RUN_TIMEOUT_SECONDS + " s");
        } catch (ExecutionException e) {
            Throwable cause = e.getCause() != null ? e.getCause() : e;
            respondError(exchange, 409, cause.getMessage() != null ? cause.getMessage() : cause.toString());
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            respondError(exchange, 500, "interrupted");
        }
    }

    private static void respondError(HttpExchange exchange, int status, String message) throws IOException {
        NeoDirect.LOGGER.warn("ControlServer {} — {}", status, message);
        JsonObject body = new JsonObject();
        body.addProperty("error", message);
        respond(exchange, status, body.toString());
    }

    private static void respond(HttpExchange exchange, int status, String body) throws IOException {
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().set("Content-Type", "application/json; charset=utf-8");
        exchange.sendResponseHeaders(status, bytes.length);
        try (OutputStream out = exchange.getResponseBody()) {
            out.write(bytes);
        }
    }
}
