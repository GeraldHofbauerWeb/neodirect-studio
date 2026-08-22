package net.geraldhofbauer.neodirect.control;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import net.geraldhofbauer.neodirect.NeoDirect;
import net.geraldhofbauer.neodirect.client.ClientBridge;
import net.geraldhofbauer.neodirect.client.Screenshots;
import net.geraldhofbauer.neodirect.timeline.Cue;
import net.geraldhofbauer.neodirect.timeline.Director;
import net.geraldhofbauer.neodirect.timeline.Timeline;
import net.geraldhofbauer.neodirect.timeline.Verifier;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.resources.ResourceLocation;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.Pose;
import net.minecraft.world.level.ClipContext;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.HitResult;
import net.minecraft.world.phys.Vec3;
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
import java.util.List;
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
 *   <li>{@code GET  /screenshot}, {@code POST /verify}, {@code GET /block} — see below</li>
 * </ul>
 *
 * <p>The rest exist for the studio, which composes shots against a running game rather than
 * against a finished video:
 *
 * <ul>
 *   <li>{@code GET  /pose} — where the camera is and what it is looking at, so a stance can become
 *       a keyframe</li>
 *   <li>{@code GET  /look} — the block at the crosshair, so a target can be pointed at rather than
 *       typed</li>
 *   <li>{@code POST /camera} — stand the camera on a keyframe now, or fly it there</li>
 *   <li>{@code POST /scrub} — build the world as it stands at a given millisecond of a take</li>
 *   <li>{@code POST /path} — sample a camera move along the curve it will fly, with clearance</li>
 *   <li>{@code POST /abort} — stop the take that is running</li>
 *   <li>{@code GET  /blockcolors} — the colour the map would paint each block, for a viewport</li>
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
            server.createContext("/pose", ControlServer::handlePose);
            server.createContext("/look", ControlServer::handleLook);
            server.createContext("/camera", ControlServer::handleCamera);
            server.createContext("/scrub", ControlServer::handleScrub);
            server.createContext("/path", ControlServer::handlePath);
            server.createContext("/abort", ControlServer::handleAbort);
            server.createContext("/blockcolors", ControlServer::handleBlockColors);
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
        // Where the camera actually is, as opposed to where the timeline says it should be. Those
        // two came apart silently for a long time — the server was teleporting the player back out
        // of blocks without logging it — and the only way to tell was to ask mid-move and compare.
        // Read off the server thread on purpose: a diagnostic that has to queue behind a take is
        // no use during one, and a position read a tick stale still answers the question.
        MinecraftServer mc = minecraftServer;
        if (mc != null) {
            ServerPlayer player = mc.getPlayerList().getPlayers().stream().findFirst().orElse(null);
            if (player != null) {
                JsonArray pos = new JsonArray();
                pos.add(player.getX());
                pos.add(player.getEyeY());
                pos.add(player.getZ());
                body.add("eye", pos);
                body.addProperty("pose", player.getPose().name());
                body.addProperty("noPhysics", player.noPhysics);
            }
        }
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


    /**
     * Where the camera is, and what it is looking at.
     *
     * <p>{@code /health} already says where the eye is, because that is the question a drifting
     * take asks. This is the other half of it: the direction, so that standing somewhere in the
     * world and liking the view can become a keyframe without anybody doing trigonometry.
     */
    private static void handlePose(HttpExchange exchange) throws IOException {
        MinecraftServer mc = minecraftServer;
        if (mc == null) {
            respondError(exchange, 503, "no world loaded");
            return;
        }
        ServerPlayer player = mc.getPlayerList().getPlayers().stream().findFirst().orElse(null);
        if (player == null) {
            respondError(exchange, 503, "no player in the world");
            return;
        }
        // Read off the server thread on purpose, like /health: a pose that has to queue behind a
        // take is no use during one, and a tick-stale position still answers the question.
        JsonObject body = new JsonObject();
        JsonArray pos = new JsonArray();
        pos.add(player.getX());
        pos.add(player.getY());
        pos.add(player.getZ());
        body.add("pos", pos);
        JsonArray eye = new JsonArray();
        eye.add(player.getX());
        eye.add(player.getEyeY());
        eye.add(player.getZ());
        body.add("eye", eye);
        body.addProperty("yaw", player.getYRot());
        body.addProperty("pitch", player.getXRot());
        body.addProperty("gameMode", player.gameMode.getGameModeForPlayer().getName());
        body.addProperty("pose", player.getPose().name());
        body.addProperty("noPhysics", player.noPhysics);
        respond(exchange, 200, body.toString());
    }

    /**
     * The block at the crosshair.
     *
     * <p>Only what the game knows: where it is and what it is. Which block of the schematic that
     * happens to be, and which assembly it belongs to, the studio works out for itself — it has
     * the schematic and the origin, and putting that arithmetic here would be a second place for
     * it to be wrong.
     */
    private static void handleLook(HttpExchange exchange) throws IOException {
        MinecraftServer mc = minecraftServer;
        if (mc == null) {
            respondError(exchange, 503, "no world loaded");
            return;
        }
        double reach = 48;
        String query = exchange.getRequestURI().getQuery();
        if (query != null) {
            for (String part : query.split("&")) {
                if (part.startsWith("maxDistance=")) {
                    reach = Double.parseDouble(part.substring("maxDistance=".length()));
                }
            }
        }
        final double distance = reach;
        try {
            JsonObject body = mc.submit(() -> {
                ServerPlayer player = mc.getPlayerList().getPlayers().stream().findFirst().orElse(null);
                JsonObject out = new JsonObject();
                if (player == null) {
                    out.addProperty("hit", false);
                    return out;
                }
                Vec3 from = player.getEyePosition(1.0F);
                Vec3 to = from.add(player.getViewVector(1.0F).scale(distance));
                BlockHitResult hit = player.serverLevel().clip(new ClipContext(
                        from, to, ClipContext.Block.OUTLINE, ClipContext.Fluid.NONE, player));
                if (hit.getType() != HitResult.Type.BLOCK) {
                    out.addProperty("hit", false);
                    return out;
                }
                BlockPos pos = hit.getBlockPos();
                out.addProperty("hit", true);
                JsonArray where = new JsonArray();
                where.add(pos.getX());
                where.add(pos.getY());
                where.add(pos.getZ());
                out.add("pos", where);
                out.addProperty("face", hit.getDirection().getName());
                out.addProperty("state", player.serverLevel().getBlockState(pos).toString());
                out.addProperty("block", BuiltInRegistries.BLOCK
                        .getKey(player.serverLevel().getBlockState(pos).getBlock()).toString());
                var be = player.serverLevel().getBlockEntity(pos);
                if (be != null) {
                    out.addProperty("nbt", be.saveWithoutMetadata(mc.registryAccess()).toString());
                }
                return out;
            }).get(10, TimeUnit.SECONDS);
            respond(exchange, 200, body.toString());
        } catch (Exception e) {
            respondError(exchange, 500, String.valueOf(e.getMessage()));
        }
    }

    /**
     * Stands the camera on a keyframe, now, or flies it there.
     *
     * <p>Body is {@code {pos:[x,y,z], yaw, pitch, durationMs?, release?}}. Outside a take the
     * camera keeps the filming body — the small intangible box — because a standpoint inside a
     * machine is only worth looking at from inside the machine; {@code release} hands the player
     * back their own body.
     */
    private static void handleCamera(HttpExchange exchange) throws IOException {
        MinecraftServer mc = minecraftServer;
        if (mc == null) {
            respondError(exchange, 503, "no world loaded");
            return;
        }
        JsonObject request;
        try (InputStream in = exchange.getRequestBody()) {
            request = JsonParser.parseString(new String(in.readAllBytes(), StandardCharsets.UTF_8))
                    .getAsJsonObject();
        } catch (RuntimeException e) {
            respondError(exchange, 400, "could not read the camera pose: " + e.getMessage());
            return;
        }

        boolean release = request.has("release") && request.get("release").getAsBoolean();
        if (release) {
            ClientBridge.send(new ClientBridge.Command.SetPose(0, 0, 0, 0, 0, false));
            mc.submit(() -> {
                for (ServerPlayer player : mc.getPlayerList().getPlayers()) {
                    player.noPhysics = false;
                    player.setForcedPose(null);
                }
                return null;
            });
            JsonObject body = new JsonObject();
            body.addProperty("released", true);
            respond(exchange, 200, body.toString());
            return;
        }

        JsonArray pos = request.getAsJsonArray("pos");
        if (pos == null || pos.size() != 3) {
            respondError(exchange, 400, "pass pos as [x, y, z]");
            return;
        }
        double x = pos.get(0).getAsDouble();
        double y = pos.get(1).getAsDouble();
        double z = pos.get(2).getAsDouble();
        float yaw = request.has("yaw") ? request.get("yaw").getAsFloat() : 0;
        float pitch = request.has("pitch") ? request.get("pitch").getAsFloat() : 0;
        long durationMs = request.has("durationMs") ? request.get("durationMs").getAsLong() : 0;

        if (Director.isRunning()) {
            respondError(exchange, 409, "a take is running — it is flying the camera");
            return;
        }

        // The server half of holding the camera still: without noPhysics the server replays the
        // move, finds the box overlapping something, and teleports it back out of the shot.
        mc.submit(() -> {
            for (ServerPlayer player : mc.getPlayerList().getPlayers()) {
                player.noPhysics = true;
                player.setForcedPose(Pose.SWIMMING);
                player.teleportTo(x, y - (player.getEyeY() - player.getY()), z);
                player.setYRot(yaw);
                player.setXRot(pitch);
            }
            return null;
        });

        if (durationMs > 0) {
            Cue.Keyframe here = new Cue.Keyframe(x, y, z, yaw, pitch);
            ClientBridge.send(new ClientBridge.Command.MoveCamera(List.of(here, here), durationMs, false));
        } else {
            ClientBridge.send(new ClientBridge.Command.SetPose(x, y, z, yaw, pitch, true));
        }
        JsonObject body = new JsonObject();
        body.addProperty("ok", true);
        respond(exchange, 200, body.toString());
    }

    /**
     * Builds the world as it stands part-way through a take.
     *
     * <p>Body is a timeline with {@code scrubToMs}. A shot is composed for a moment in the build,
     * and judging it against the finished machine is judging a different picture.
     */
    private static void handleScrub(HttpExchange exchange) throws IOException {
        MinecraftServer mc = minecraftServer;
        if (mc == null) {
            respondError(exchange, 503, "no world loaded");
            return;
        }
        String requestBody;
        try (InputStream in = exchange.getRequestBody()) {
            requestBody = new String(in.readAllBytes(), StandardCharsets.UTF_8);
        }
        long ms;
        Timeline timeline;
        try {
            JsonObject root = JsonParser.parseString(requestBody).getAsJsonObject();
            ms = root.has("scrubToMs") ? root.get("scrubToMs").getAsLong() : 0;
            timeline = Timeline.parse(requestBody);
        } catch (RuntimeException e) {
            respondError(exchange, 400, "could not parse timeline: " + e.getMessage());
            return;
        }
        try {
            JsonObject report = mc.submit(() -> {
                try {
                    return Director.scrub(timeline, mc, ms);
                } catch (IOException e) {
                    throw new java.io.UncheckedIOException(e);
                }
            }).get(120, TimeUnit.SECONDS);
            respond(exchange, 200, report.toString());
        } catch (TimeoutException e) {
            respondError(exchange, 504, "the scrub did not finish in time");
        } catch (ExecutionException e) {
            Throwable cause = e.getCause() != null ? e.getCause() : e;
            respondError(exchange, 409, String.valueOf(cause.getMessage()));
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            respondError(exchange, 500, "interrupted");
        }
    }

    /**
     * Samples a camera move along the curve it will fly.
     *
     * <p>Body is {@code {keyframes, durationMs, ease, samples}}. Same curve, same easing and the
     * same body as the clearance check that can fail a take — the studio draws what it is told
     * here rather than keeping its own idea of the path, because two ideas of a path is how a shot
     * passes a check and clips a wall anyway.
     */
    private static void handlePath(HttpExchange exchange) throws IOException {
        MinecraftServer mc = minecraftServer;
        if (mc == null) {
            respondError(exchange, 503, "no world loaded");
            return;
        }
        JsonObject request;
        try (InputStream in = exchange.getRequestBody()) {
            request = JsonParser.parseString(new String(in.readAllBytes(), StandardCharsets.UTF_8))
                    .getAsJsonObject();
        } catch (RuntimeException e) {
            respondError(exchange, 400, "could not read the move: " + e.getMessage());
            return;
        }
        final Cue.Camera camera;
        try {
            JsonObject asCue = new JsonObject();
            asCue.addProperty("type", "camera");
            asCue.addProperty("atMs", 0);
            asCue.addProperty("durationMs", request.has("durationMs") ? request.get("durationMs").getAsLong() : 1000);
            asCue.add("keyframes", request.getAsJsonArray("keyframes"));
            if (request.has("ease")) {
                asCue.addProperty("ease", request.get("ease").getAsString());
            }
            camera = (Cue.Camera) Cue.parse(asCue);
        } catch (RuntimeException e) {
            respondError(exchange, 400, String.valueOf(e.getMessage()));
            return;
        }
        int samples = request.has("samples") ? request.get("samples").getAsInt() : 240;

        try {
            JsonObject body = mc.submit(() -> {
                ServerPlayer player = mc.getPlayerList().getPlayers().stream().findFirst().orElse(null);
                JsonObject out = new JsonObject();
                if (player == null) {
                    out.addProperty("error", "no player in the world");
                    return out;
                }
                JsonArray points = Verifier.sampleMove(player.serverLevel(), camera.keyframes(),
                        camera.linear(), samples);
                int blocked = 0;
                for (var element : points) {
                    if (element.getAsJsonObject().get("blocked").getAsBoolean()) {
                        blocked++;
                    }
                }
                out.add("samples", points);
                out.addProperty("blockedSamples", blocked);
                out.addProperty("clear", blocked == 0);
                out.addProperty("ease", camera.linear() ? "linear" : "inOut");
                return out;
            }).get(30, TimeUnit.SECONDS);
            respond(exchange, 200, body.toString());
        } catch (Exception e) {
            respondError(exchange, 500, String.valueOf(e.getMessage()));
        }
    }

    /** Stops the take that is running. */
    private static void handleAbort(HttpExchange exchange) throws IOException {
        boolean was = Director.isRunning();
        Director.abort("the studio asked");
        JsonObject body = new JsonObject();
        body.addProperty("aborted", was);
        respond(exchange, 200, body.toString());
    }

    /**
     * The colour the map would paint each block of a schematic.
     *
     * <p>A viewport has to draw a thousand blocks in something other than grey, and Minecraft
     * already has an opinion about what colour a block is — the one it uses on maps. Reading it
     * here costs a line and saves unpacking a texture atlas.
     *
     * <p>It doubles as the honest answer to "does this instance have the mods this build needs".
     * Every block the registry knows is in here, so a namespace that is missing from the reply is
     * a mod that is missing from the instance — which is the failure that otherwise shows up as
     * four hundred blocks quietly read as air.
     */
    private static void handleBlockColors(HttpExchange exchange) throws IOException {
        MinecraftServer mc = minecraftServer;
        if (mc == null) {
            respondError(exchange, 503, "no world loaded");
            return;
        }
        try {
            JsonObject body = mc.submit(() -> {
                ServerPlayer player = mc.getPlayerList().getPlayers().stream().findFirst().orElse(null);
                var level = player != null ? player.serverLevel() : mc.overworld();
                JsonObject out = new JsonObject();
                for (Block block : BuiltInRegistries.BLOCK) {
                    ResourceLocation id = BuiltInRegistries.BLOCK.getKey(block);
                    int colour = block.defaultBlockState().getMapColor(level, BlockPos.ZERO).col;
                    out.addProperty(id.toString(), String.format("#%06x", colour & 0xffffff));
                }
                return out;
            }).get(30, TimeUnit.SECONDS);
            respond(exchange, 200, body.toString());
        } catch (Exception e) {
            respondError(exchange, 500, String.valueOf(e.getMessage()));
        }
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
