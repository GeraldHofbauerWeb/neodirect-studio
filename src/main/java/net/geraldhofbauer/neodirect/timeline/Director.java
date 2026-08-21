package net.geraldhofbauer.neodirect.timeline;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import net.geraldhofbauer.neodirect.NeoDirect;
import net.geraldhofbauer.neodirect.client.ClientBridge;
import net.geraldhofbauer.neodirect.schematic.BillOfMaterials;
import net.geraldhofbauer.neodirect.schematic.SchematicSource;
import net.minecraft.commands.arguments.blocks.BlockStateParser;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.nbt.Tag;
import net.minecraft.nbt.DoubleTag;
import net.minecraft.nbt.ListTag;
import net.minecraft.core.particles.BlockParticleOption;
import net.minecraft.core.particles.ParticleTypes;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.core.registries.Registries;
import net.minecraft.resources.ResourceLocation;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.sounds.SoundSource;
import net.minecraft.util.GsonHelper;
import net.minecraft.world.Clearable;
import net.minecraft.world.Container;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.MenuProvider;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.EntityType;
import net.minecraft.world.entity.item.ItemEntity;
import net.minecraft.world.level.block.SoundType;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.ChestBlock;
import net.minecraft.world.level.block.state.properties.ChestType;
import net.minecraft.world.level.block.entity.BlockEntity;
import net.minecraft.world.level.GameRules;
import net.minecraft.world.level.GameType;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.Vec3;
import net.neoforged.bus.api.SubscribeEvent;
import net.neoforged.fml.common.EventBusSubscriber;
import net.neoforged.fml.loading.FMLPaths;
import net.neoforged.neoforge.event.tick.ServerTickEvent;

import com.mojang.brigadier.StringReader;
import com.mojang.brigadier.exceptions.CommandSyntaxException;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Supplier;
import java.util.stream.Collectors;

/**
 * Plays a {@link Timeline} back against the wall clock.
 *
 * <p>Only one take runs at a time — the whole point is a reproducible single pass that OBS records
 * start to finish.
 */
@EventBusSubscriber(modid = NeoDirect.MOD_ID)
public final class Director {

    /**
     * How far ahead of a placement the block goes into the player's hand. Inventory changes reach
     * the client through the usual container sync, so the item needs a moment to actually be
     * visible before the arm swings.
     */
    private static final long EQUIP_LEAD_MS = 700;

    /**
     * How far ahead of a placement the arm swings. A real player's block appears at roughly the
     * bottom of the swing, not at its start.
     */
    private static final long SWING_LEAD_MS = 120;

    private Director() {
    }

    private static final AtomicReference<Run> ACTIVE = new AtomicReference<>();

    /**
     * A single scheduled action, already resolved down from the script's cues.
     *
     * <p>{@code detail} is a supplier rather than a string because some steps only know what they
     * did once they have done it — how many stray items they swept up, for instance.
     */
    private record Step(long atMs, String kind, Runnable action, Supplier<String> detail) {

        Step(long atMs, String kind, Runnable action, String detail) {
            this(atMs, kind, action, () -> detail);
        }
    }

    private static final class Run {
        final Timeline timeline;
        final List<Step> steps;
        final JsonArray log = new JsonArray();
        final CompletableFuture<JsonObject> result = new CompletableFuture<>();
        long startNanos;
        int next;

        Run(Timeline timeline, List<Step> steps) {
            this.timeline = timeline;
            this.steps = steps;
        }
    }

    public static boolean isRunning() {
        return ACTIVE.get() != null;
    }

    /**
     * Queues a take. Returns a future that completes with the take log once the last step has run,
     * or completes exceptionally if the take cannot be prepared.
     */
    public static CompletableFuture<JsonObject> submit(Timeline timeline, MinecraftServer server) {
        CompletableFuture<JsonObject> failure = new CompletableFuture<>();

        ServerPlayer player = server.getPlayerList().getPlayers().stream().findFirst().orElse(null);
        if (player == null) {
            failure.completeExceptionally(new IllegalStateException(
                    "no player in the world — load a world in the client before starting a take"));
            return failure;
        }

        SchematicSource.Schematic schematic;
        try {
            schematic = loadSchematic(server, timeline);
        } catch (IOException | RuntimeException e) {
            failure.completeExceptionally(e);
            return failure;
        }

        List<Step> steps;
        try {
            steps = expand(timeline, schematic, loadParts(timeline, schematic.blocks()),
                    player.serverLevel(), player);
        } catch (IOException | RuntimeException e) {
            failure.completeExceptionally(e);
            return failure;
        }

        Run run = new Run(timeline, steps);
        if (!ACTIVE.compareAndSet(null, run)) {
            failure.completeExceptionally(new IllegalStateException("a take is already running"));
            return failure;
        }

        // Hand the client its opening pose before the clock starts, so frame one is already right.
        Cue.Keyframe opening = openingKeyframe(timeline);
        ClientBridge.clear();
        if (opening != null) {
            ClientBridge.send(new ClientBridge.Command.BeginRun(
                    opening.x(), opening.y(), opening.z(), opening.yaw(), opening.pitch()));
        }

        // The clock deliberately starts on the first server tick, not here. A single-player
        // integrated server does not tick while the client is still loading terrain or while the
        // game is paused, and starting the clock at submit time makes every cue in such a take
        // come due at once the moment ticking resumes.
        run.startNanos = 0;
        NeoDirect.LOGGER.info("Take '{}' armed — {} steps over {} ms.",
                timeline.take(), steps.size(), timeline.durationMs());
        return run.result;
    }

    @SubscribeEvent
    public static void onServerTick(ServerTickEvent.Post event) {
        Run run = ACTIVE.get();
        if (run == null) {
            return;
        }
        if (run.startNanos == 0) {
            run.startNanos = System.nanoTime();
            NeoDirect.LOGGER.info("Take '{}' rolling.", run.timeline.take());
            return;
        }

        long elapsedMs = (System.nanoTime() - run.startNanos) / 1_000_000L;

        while (run.next < run.steps.size() && run.steps.get(run.next).atMs() <= elapsedMs) {
            Step step = run.steps.get(run.next++);
            try {
                step.action().run();
            } catch (RuntimeException e) {
                NeoDirect.LOGGER.error("Step '{}' at {} ms failed", step.kind(), step.atMs(), e);
            }
            JsonObject entry = new JsonObject();
            entry.addProperty("kind", step.kind());
            entry.addProperty("plannedMs", step.atMs());
            entry.addProperty("actualMs", elapsedMs);
            entry.addProperty("detail", step.detail().get());
            run.log.add(entry);
        }

        boolean stepsDone = run.next >= run.steps.size();
        if (stepsDone && elapsedMs >= run.timeline.durationMs()) {
            finish(run, elapsedMs);
        }
    }

    private static void finish(Run run, long elapsedMs) {
        ACTIVE.set(null);
        restoreGameMode();
        ClientBridge.send(new ClientBridge.Command.EndRun());

        JsonObject result = new JsonObject();
        result.addProperty("take", run.timeline.take());
        result.addProperty("plannedDurationMs", run.timeline.durationMs());
        result.addProperty("actualDurationMs", elapsedMs);
        result.add("events", run.log);
        run.result.complete(result);

        NeoDirect.LOGGER.info("Take '{}' finished after {} ms.", run.timeline.take(), elapsedMs);
    }

    /** Aborts whatever is running — used when the server shuts down mid-take. */
    public static void abort(String reason) {
        Run run = ACTIVE.getAndSet(null);
        restoreGameMode();
        if (run != null) {
            ClientBridge.send(new ClientBridge.Command.EndRun());
            run.result.completeExceptionally(new IllegalStateException(reason));
        }
    }

    /**
     * Compares the world against what this timeline claims to build. Runs on the server thread, so
     * the caller must hand it over rather than calling from an HTTP worker.
     *
     * <p>Deliberately scoped to the timeline rather than to the whole schematic. A pilot beat that
     * places five blocks and no glue is not wrong for lacking the other 266 — checking it against
     * the full schematic would report a failure on every partial take and make the check useless
     * exactly where it is most needed.
     */
    public static JsonObject verify(Timeline timeline, MinecraftServer server) throws IOException {
        ServerPlayer player = server.getPlayerList().getPlayers().stream().findFirst().orElse(null);
        if (player == null) {
            throw new IllegalStateException("no player in the world");
        }
        SchematicSource.Schematic full = loadSchematic(server, timeline);

        // Whatever a setBlocks cue put down is not in the schematic and must not be compared
        // against it: the creative motor that drives the finished machine would otherwise read as
        // a block in the wrong state, every single take.
        Set<BlockPos> extras = new LinkedHashSet<>();
        boolean running = false;
        for (Cue cue : timeline.cues()) {
            if (cue instanceof Cue.SetBlocks setBlocks) {
                running = true;
                for (Cue.BlockSpec spec : setBlocks.blocks()) {
                    extras.add(timeline.origin().offset(spec.x(), spec.y(), spec.z()));
                }
            }
        }

        JsonObject report = Verifier.verify(player.serverLevel(), timeline.origin(),
                scopeToTimeline(timeline, full), extras, running);
        report.add("cameraClearance", Verifier.checkCameraClearance(player.serverLevel(), timeline, 240));
        return report;
    }

    /** Narrows a schematic to just the blocks and entities a given timeline actually places. */
    private static SchematicSource.Schematic scopeToTimeline(Timeline timeline,
                                                             SchematicSource.Schematic full)
            throws IOException {
        Map<String, List<Integer>> parts = loadParts(timeline, full.blocks());
        Set<Integer> claimed = new LinkedHashSet<>();
        for (Cue cue : timeline.cues()) {
            if (cue instanceof Cue.Place place) {
                resolve(place, full.blocks(), parts, claimed);
            }
        }
        List<SchematicSource.SchematicBlock> blocks = claimed.stream()
                .filter(index -> index >= 0 && index < full.blocks().size())
                .map(full.blocks()::get)
                .toList();

        List<String> filters = timeline.cues().stream()
                .filter(Cue.Entities.class::isInstance)
                .map(cue -> ((Cue.Entities) cue).filter())
                .toList();
        List<SchematicSource.SchematicEntity> entities = full.entities().stream()
                .filter(entity -> filters.stream().anyMatch(f -> f.isEmpty() || entity.id().contains(f)))
                .toList();

        return new SchematicSource.Schematic(blocks, entities, full.unknownBlocks());
    }

    /**
     * Turns a cue's block selector into concrete schematic indices.
     *
     * @param alreadyPlaced indices earlier cues in this timeline claimed; consumed by {@code rest}
     *                      and extended in place
     */
    private static List<Integer> resolve(Cue.Place place,
                                         List<SchematicSource.SchematicBlock> schematic,
                                         Map<String, List<Integer>> parts,
                                         Set<Integer> alreadyPlaced) {
        List<Integer> resolved = new ArrayList<>();

        switch (place.selector()) {
            case Cue.Place.Indices indices -> resolved.addAll(indices.values());
            case Cue.Place.Range range -> {
                for (int i = Math.max(0, range.from()); i <= Math.min(schematic.size() - 1, range.to()); i++) {
                    resolved.add(i);
                }
            }
            case Cue.Place.OfType ofType -> {
                Set<String> wanted = Set.copyOf(ofType.blockIds());
                for (int i = 0; i < schematic.size(); i++) {
                    String id = BuiltInRegistries.BLOCK.getKey(schematic.get(i).state().getBlock()).toString();
                    if (wanted.contains(id)) {
                        resolved.add(i);
                    }
                }
                if (resolved.isEmpty()) {
                    throw new IllegalArgumentException("no blocks of type " + ofType.blockIds() + " in the schematic");
                }
            }
            case Cue.Place.Part part -> {
                for (String name : part.names()) {
                    List<Integer> indices = parts.get(name);
                    if (indices == null) {
                        throw new IllegalArgumentException(
                                "no part named \"" + name + "\" — the manifest has " + parts.keySet());
                    }
                    resolved.addAll(indices);
                }
            }
            case Cue.Place.Rest rest -> {
                Set<String> held = Set.copyOf(rest.exceptTypes());
                for (int i = 0; i < schematic.size(); i++) {
                    if (alreadyPlaced.contains(i)) {
                        continue;
                    }
                    String id = BuiltInRegistries.BLOCK.getKey(schematic.get(i).state().getBlock()).toString();
                    if (!held.contains(id)) {
                        resolved.add(i);
                    }
                }
            }
        }

        alreadyPlaced.addAll(resolved);
        return resolved;
    }

    /**
     * Named assemblies out of the file tools/parts.py writes, mapped onto schematic indices.
     *
     * <p>The file lists positions rather than indices on purpose. An index is only meaningful for
     * one particular cut of the schematic, and this one has already been re-cut three times as the
     * box moved; a position that no longer exists is a loud failure, while an index that has
     * quietly come to mean a different block is not a failure at all until somebody watches the
     * video.
     */
    private static Map<String, List<Integer>> loadParts(Timeline timeline,
                                                        List<SchematicSource.SchematicBlock> schematic)
            throws IOException {
        if (timeline.parts() == null) {
            return Map.of();
        }
        Path file = schematicDir().resolve(timeline.parts());
        if (!Files.isRegularFile(file)) {
            throw new IllegalArgumentException("parts file not found: " + file.toAbsolutePath());
        }

        Map<BlockPos, Integer> byPos = new LinkedHashMap<>();
        for (int i = 0; i < schematic.size(); i++) {
            byPos.put(schematic.get(i).relPos(), i);
        }

        JsonObject root = JsonParser.parseString(Files.readString(file)).getAsJsonObject();
        JsonObject parts = GsonHelper.getAsJsonObject(root, "parts");
        Map<String, List<Integer>> out = new LinkedHashMap<>();
        for (String name : parts.keySet()) {
            List<Integer> indices = new ArrayList<>();
            for (JsonElement el : parts.getAsJsonArray(name)) {
                JsonArray pos = el.getAsJsonArray();
                BlockPos at = new BlockPos(pos.get(0).getAsInt(), pos.get(1).getAsInt(), pos.get(2).getAsInt());
                Integer index = byPos.get(at);
                if (index == null) {
                    throw new IllegalArgumentException("part \"" + name + "\" names " + at
                            + ", which is not in " + timeline.schematic()
                            + " — re-run tools/parts.py after re-cutting the schematic");
                }
                indices.add(index);
            }
            out.put(name, List.copyOf(indices));
        }
        return Map.copyOf(out);
    }

    private static SchematicSource.Schematic loadSchematic(MinecraftServer server, Timeline timeline)
            throws IOException {
        if (timeline.schematic() == null) {
            return new SchematicSource.Schematic(List.of(), List.of(), List.of());
        }
        Path file = schematicDir().resolve(timeline.schematic());
        if (!Files.isRegularFile(file)) {
            throw new IllegalArgumentException("schematic not found: " + file.toAbsolutePath());
        }
        return SchematicSource.load(file, server.registryAccess().lookupOrThrow(Registries.BLOCK));
    }

    /**
     * The same folder Create itself uses. Taken from FML rather than from
     * {@code MinecraftServer#getServerDirectory()}, which is a bare {@code Path.of("")} and so
     * depends on the process working directory.
     */
    private static Path schematicDir() {
        return FMLPaths.GAMEDIR.get().resolve("schematics");
    }

    private static Cue.Keyframe openingKeyframe(Timeline timeline) {
        return timeline.cues().stream()
                .filter(Cue.Camera.class::isInstance)
                .map(Cue.Camera.class::cast)
                .findFirst()
                .map(camera -> camera.keyframes().get(0))
                .orElse(null);
    }

    /**
     * Turns cues into a flat, time-ordered list of steps. A single {@code place} cue becomes up to
     * three steps — equip, swing, set — because that is the sequence a human hand performs and the
     * illusion lives entirely in that ordering.
     */
    private static List<Step> expand(Timeline timeline,
                                     SchematicSource.Schematic schematicData,
                                     Map<String, List<Integer>> parts,
                                     ServerLevel level,
                                     ServerPlayer player) {
        List<SchematicSource.SchematicBlock> schematic = schematicData.blocks();
        Timeline.Presentation presentation = timeline.presentation();
        List<Step> steps = new ArrayList<>();

        // How far this build has moved from where it was cut. Block entity NBT is full of absolute
        // world positions — a display link points at the container it counts — and they have to
        // move with it or the machine arrives pointing at the coordinates it used to occupy.
        BlockPos sourceOrigin = schematicData.sourceOrigin();
        BlockPos shift = sourceOrigin == null ? null : timeline.origin().subtract(sourceOrigin);
        net.minecraft.core.Vec3i sourceSize = schematicData.sourceSize();

        // Every take starts from bare ground. Without this, take B would be shot on top of take A's
        // leftovers and the two would not be comparable — and comparing them is the entire point.
        // With clearStage on (the default) the whole schematic footprint is wiped, not just the
        // positions this take fills. Otherwise a five-block pilot shot after a full build would be
        // filmed with the entire contraption standing behind it, and what the take looks like
        // would depend on what happened to run before it.
        // Selectors are resolved once, up front, because "rest" depends on what earlier cues took.
        // The same resolution then drives both the clear step and the placements.
        Map<Cue.Place, List<Integer>> placements = new LinkedHashMap<>();
        Set<Integer> claimed = new LinkedHashSet<>();
        for (Cue cue : timeline.cues()) {
            if (cue instanceof Cue.Place place) {
                placements.put(place, resolve(place, schematic, parts, claimed));
            }
        }
        warnAboutUnplaced(schematic, claimed);

        // clearStage wipes the schematic's whole bounding box, not merely the positions it fills.
        // Occupied positions alone are not enough: delete a block from the schematic and the old
        // one keeps standing in the world for every later take, because nothing claims that spot
        // any more. A removed wall torch survived exactly that way.
        List<BlockPos> footprint = timeline.clearStage()
                ? boundingBox(timeline.origin(), schematic)
                : claimed.stream()
                        .filter(index -> index >= 0 && index < schematic.size())
                        .map(index -> timeline.origin().offset(schematic.get(index).relPos()))
                        .distinct()
                        .toList();
        if (!footprint.isEmpty()) {
            steps.add(new Step(0, "clear",
                    () -> footprint.forEach(pos -> clearBlock(level, pos)),
                    footprint.size() + " positions"));
        }

        // Sweep loose items out of the set. Re-running a take used to leave the previous take's
        // deployer filters lying on the grass: clearing a Create block entity by setting it to air
        // makes it spit its inventory out as item entities. clearBlock() stops new litter appearing,
        // and this removes whatever earlier runs already dropped.
        AABB stage = stageBounds(timeline, schematic);
        if (stage != null) {
            AtomicInteger swept = new AtomicInteger();
            steps.add(new Step(0, "stage",
                    () -> {
                        // Pin the light. The gamerule stops time advancing but says nothing about
                        // where it stopped, so a world created in the evening films every take at
                        // dusk — which is how one shot came out dark while an earlier one was
                        // bright. Midday, every time.
                        level.setDayTime(6000L);
                        level.setWeatherParameters(0, 0, false, false);
                        // Nothing a take destroys should leave an item behind. It matters more
                        // than it sounds now that placements are staggered: a Create belt segment
                        // with no neighbours yet is not a valid belt, removes itself, and drops as
                        // an item — thirty of them on the floor after one build, all of them
                        // blocks that are standing again by the end of the cue.
                        level.getGameRules().getRule(GameRules.RULE_DOBLOCKDROPS).set(false, level.getServer());
                        swept.set(sweepStage(level, stage, schematicData));
                    },
                    () -> "noon, clear, " + swept.get() + " stale entities removed"));
        }

        for (Cue cue : timeline.cues()) {
            if (cue instanceof Cue.Camera camera) {
                steps.add(new Step(camera.atMs(), "camera",
                        () -> ClientBridge.send(new ClientBridge.Command.MoveCamera(
                                camera.keyframes(), camera.durationMs())),
                        camera.keyframes().size() + " keyframes over " + camera.durationMs() + " ms"));

            } else if (cue instanceof Cue.Entities entities) {
                AtomicInteger placed = new AtomicInteger();
                steps.add(new Step(entities.atMs(), "entities",
                        () -> placed.set(spawnEntities(level, timeline.origin(), schematicData, entities.filter())),
                        () -> placed.get() + " entities (" + entities.filter() + ")"));

            } else if (cue instanceof Cue.MaterialsChest chest) {
                AtomicInteger stacked = new AtomicInteger();
                steps.add(new Step(chest.atMs(), "materialsChest",
                        () -> stacked.set(placeMaterialsChest(level, timeline.origin(), chest, schematicData)),
                        () -> stacked.get() + " stacks"));

            } else if (cue instanceof Cue.Fill fill) {
                AtomicInteger stored = new AtomicInteger();
                steps.add(new Step(fill.atMs(), "fill",
                        () -> stored.set(fillContainer(level, timeline.origin(), fill)),
                        () -> stored.get() + " stacks into " + fill.x() + "," + fill.y() + "," + fill.z()));

            } else if (cue instanceof Cue.ShowFilter showFilter) {
                SchematicSource.SchematicBlock source;
                if (showFilter.relPos() != null) {
                    source = schematic.stream()
                            .filter(block -> block.relPos().equals(showFilter.relPos()))
                            .findFirst()
                            .orElseThrow(() -> new IllegalArgumentException(
                                    "showFilter: no schematic block at " + showFilter.relPos()));
                } else {
                    if (showFilter.blockIndex() < 0 || showFilter.blockIndex() >= schematic.size()) {
                        throw new IllegalArgumentException(
                                "showFilter block index out of range: " + showFilter.blockIndex());
                    }
                    source = schematic.get(showFilter.blockIndex());
                }
                steps.add(new Step(showFilter.atMs(), "showFilter",
                        () -> showFilter(level, player, source),
                        itemName(source.state())));

            } else if (cue instanceof Cue.Screen screen) {
                steps.add(new Step(screen.atMs(), "screen",
                        () -> toggleScreen(level, player, timeline.origin(), screen),
                        screen.action()));

            } else if (cue instanceof Cue.SetBlocks setBlocks) {
                BlockPos origin = timeline.origin();
                steps.add(new Step(setBlocks.atMs(), "setBlocks",
                        () -> setBlocks.blocks().forEach(spec -> setBlock(level, origin, spec)),
                        setBlocks.blocks().size() + " blocks"));

            } else if (cue instanceof Cue.Reseat reseat) {
                Set<String> wanted = Set.copyOf(reseat.blockIds());
                List<SchematicSource.SchematicBlock> targets = schematic.stream()
                        .filter(block -> wanted.contains(
                                BuiltInRegistries.BLOCK.getKey(block.state().getBlock()).toString()))
                        .toList();
                if (targets.isEmpty()) {
                    throw new IllegalArgumentException("reseat: no blocks of type " + reseat.blockIds());
                }
                BlockPos origin = timeline.origin();
                steps.add(new Step(reseat.atMs(), "reseat",
                        () -> {
                            for (SchematicSource.SchematicBlock block : targets) {
                                BlockPos pos = origin.offset(block.relPos());
                                Clearable.tryClear(level.getBlockEntity(pos));
                                level.setBlock(pos, Blocks.AIR.defaultBlockState(), Block.UPDATE_ALL);
                            }
                            for (SchematicSource.SchematicBlock block : targets) {
                                // Bare, with none of the saved block entity data put back. That is
                                // the difference between this and placing the block again: a player
                                // who breaks one and sets it down gets a block entity that has
                                // never heard of the machine it came from, and goes looking for the
                                // shafts around it. Hand it the old data and it already believes it
                                // has an answer.
                                level.setBlock(origin.offset(block.relPos()), block.state(),
                                        Block.UPDATE_ALL);
                            }
                        },
                        targets.size() + " x " + reseat.blockIds()));

            } else if (cue instanceof Cue.Use use) {
                BlockPos at = timeline.origin().offset(use.x(), use.y(), use.z());
                steps.add(new Step(use.atMs(), "use",
                        () -> {
                            BlockState state = level.getBlockState(at);
                            if (presentation.swing()) {
                                ClientBridge.send(new ClientBridge.Command.Swing());
                            }
                            state.useWithoutItem(level, player, new net.minecraft.world.phys.BlockHitResult(
                                    Vec3.atCenterOf(at), Direction.UP, at, false));
                        },
                        () -> itemName(level.getBlockState(at))));

            } else if (cue instanceof Cue.GameMode mode) {
                GameType wanted = gameType(mode.mode());
                steps.add(new Step(mode.atMs(), "gameMode",
                        () -> {
                            if (restoreGameMode == null) {
                                GameType before = player.gameMode.getGameModeForPlayer();
                                restoreGameMode = () -> player.setGameMode(before);
                            }
                            player.setGameMode(wanted);
                        },
                        mode.mode()));

            } else if (cue instanceof Cue.Marker marker) {
                steps.add(new Step(marker.atMs(), "marker", () -> {
                }, marker.label()));

            } else if (cue instanceof Cue.Place place) {
                List<SchematicSource.SchematicBlock> targets = new ArrayList<>();
                for (int index : placements.getOrDefault(place, List.of())) {
                    if (index < 0 || index >= schematic.size()) {
                        throw new IllegalArgumentException(
                                "block index " + index + " out of range — schematic has " + schematic.size() + " blocks");
                    }
                    targets.add(schematic.get(index));
                }
                if (targets.isEmpty()) {
                    continue;
                }

                BlockPos origin = timeline.origin();

                // How far apart the blocks of this cue land. All in one tick reads as a magic
                // trick — the machine simply appears — and the presentation layer exists to make
                // it read as somebody building instead. spanMs spreads the cue over a fixed
                // stretch, which is what a script wants when the stretch is a beat of narration;
                // staggerMs sets the interval directly.
                //
                // Evenly, unless the cue says otherwise. An even spread gives a floor slab the
                // same beat as a crushing wheel, and a viewer learns nothing from watching four
                // hundred stones go down at the speed of the one block that mattered. `pace`
                // weights the blocks against each other; the cue still ends when it said it would.
                double[] weights = new double[targets.size()];
                double totalWeight = 0;
                for (int i = 0; i < targets.size(); i++) {
                    weights[i] = weightOf(place.pace(), targets.get(i).state());
                    totalWeight += weights[i];
                }
                boolean spreadOut = place.spanMs() > 0 && targets.size() > 1;
                long spread = spreadOut
                        ? place.spanMs()
                        : place.staggerMs() * Math.max(0, targets.size() - 1);
                long step = spreadOut ? spread : place.staggerMs();

                // The offset of each block from the start of the cue, in cue order. The last block
                // lands at the end of the spread, exactly as it did when every step was the same
                // size — the weights redistribute the time inside the cue and never lengthen it.
                // The extra slot on the end is when the settle step runs: one more block's worth
                // of time after the last one, so it never lands in the same tick as a placement.
                long[] offsets = new long[targets.size() + 1];
                double leading = totalWeight - weights[targets.size() - 1];
                double running = 0;
                for (int i = 0; i < targets.size(); i++) {
                    offsets[i] = leading > 0 ? Math.round(spread * (running / leading)) : 0;
                    running += weights[i];
                }
                offsets[targets.size()] = offsets[targets.size() - 1] + (leading > 0
                        ? Math.round(spread * weights[targets.size() - 1] / leading)
                        : Math.max(step, 1));

                if (step <= 0) {
                    BlockState first = targets.get(0).state();
                    if (presentation.heldItem()) {
                        steps.add(new Step(Math.max(0, place.atMs() - EQUIP_LEAD_MS), "equip",
                                () -> equip(player, first), itemName(first)));
                    }
                    if (presentation.swing()) {
                        steps.add(new Step(Math.max(0, place.atMs() - SWING_LEAD_MS), "swing",
                                () -> ClientBridge.send(new ClientBridge.Command.Swing()), itemName(first)));
                    }
                    steps.add(new Step(place.atMs(), "place",
                            () -> {
                                for (SchematicSource.SchematicBlock block : targets) {
                                    placeBlock(level, origin.offset(block.relPos()), block,
                                            presentation, shift, sourceOrigin, sourceSize);
                                }
                            },
                            describePlacement(targets)));
                } else {
                    Item held = null;
                    for (int i = 0; i < targets.size(); i++) {
                        SchematicSource.SchematicBlock block = targets.get(i);
                        long at = place.atMs() + offsets[i];
                        // Only when the item actually changes. Handing the player the same block
                        // thirty times in a row is thirty item-name labels flashing across the
                        // bottom of the shot.
                        Item want = block.state().getBlock().asItem();
                        if (presentation.heldItem() && want != held) {
                            held = want;
                            steps.add(new Step(Math.max(0, at - EQUIP_LEAD_MS), "equip",
                                    () -> equip(player, block.state()), itemName(block.state())));
                        }
                        if (presentation.swing()) {
                            steps.add(new Step(Math.max(0, at - SWING_LEAD_MS), "swing",
                                    () -> ClientBridge.send(new ClientBridge.Command.Swing()),
                                    itemName(block.state())));
                        }
                        steps.add(new Step(at, "place",
                                () -> placeBlock(level, origin.offset(block.relPos()), block,
                                        presentation, shift, sourceOrigin, sourceSize),
                                itemName(block.state())));
                    }

                    // And then assert the whole lot again, in one tick, at the end of the cue.
                    //
                    // A Create belt is a multiblock: a segment placed on its own is not a valid
                    // belt and removes itself, so laying a run down one block at a time leaves
                    // nothing behind — and the brass belt funnel that was supposed to sit on it
                    // quietly becomes a plain brass funnel, which is a different block that does a
                    // different thing. Re-placing every block of the cue once they are all present
                    // fixes that without the director needing to know what a belt is.
                    long settleAt = place.atMs() + offsets[targets.size()];
                    steps.add(new Step(settleAt, "settle",
                            () -> {
                                for (SchematicSource.SchematicBlock block : targets) {
                                    BlockPos pos = origin.offset(block.relPos());
                                    // State mismatches, and every block entity whether it matches
                                    // or not. A Create display link is written once, at the moment
                                    // its own block goes down, and if the board it points at is
                                    // still four seconds away from existing then the link comes up
                                    // pointing at nothing. Re-applying the saved NBT once the whole
                                    // cue is present fixes that. It is safe to do wholesale because
                                    // placeBlock empties a block entity before replacing it and
                                    // doTileDrops is off for the take, so nothing spills.
                                    if (block.hasBlockEntity()
                                            || !level.getBlockState(pos).equals(block.state())) {
                                        placeBlock(level, pos, block, Timeline.Presentation.NONE,
                                                shift, sourceOrigin, sourceSize);
                                    }
                                }
                            },
                            targets.size() + " blocks re-asserted"));
                }
            }
        }

        steps.sort(Comparator.comparingLong(Step::atMs));
        return List.copyOf(steps);
    }

    /**
     * Says so when the script leaves part of the schematic on the ground.
     *
     * <p>The counterpart to holding types back from a sweep-up cue: excluding a type is only safe
     * if some later cue actually places it, and nothing else would notice if that cue were missing
     * or misspelled. A partial take is legitimate — the pilot beats place five blocks on purpose —
     * so this warns rather than refuses.
     */
    private static void warnAboutUnplaced(List<SchematicSource.SchematicBlock> schematic, Set<Integer> claimed) {
        Map<String, Integer> missed = new LinkedHashMap<>();
        for (int i = 0; i < schematic.size(); i++) {
            if (!claimed.contains(i)) {
                missed.merge(itemName(schematic.get(i).state()), 1, Integer::sum);
            }
        }
        if (!missed.isEmpty()) {
            NeoDirect.LOGGER.warn("{} schematic block(s) no cue places: {}",
                    schematic.size() - claimed.size(), missed);
        }
    }

    /**
     * Puts down a block the schematic does not contain, spelled the way {@code /setblock} spells it.
     *
     * <p>Parsed with the game's own {@link BlockStateParser}, so properties and NBT come for free
     * and the syntax is one a Minecraft player already knows. Clearable first for the same reason
     * every other placement does it: replacing a block entity without emptying it scatters its
     * contents across the floor.
     */
    /**
     * How to undo a {@code gameMode} cue once the take is over — set by the first one to fire.
     *
     * <p>Static rather than a field on the run because the restore has to happen from
     * {@link #finish} and {@link #abort} alike: a take aborted halfway through must not leave the
     * studio in spectator, where the next take's blocks would go down with no hand to place them.
     */
    private static Runnable restoreGameMode;

    private static void restoreGameMode() {
        Runnable restore = restoreGameMode;
        restoreGameMode = null;
        if (restore != null) {
            restore.run();
        }
    }

    /**
     * A block's share of its cue: its own entry in the pace map, else {@code default}, else one.
     */
    private static double weightOf(java.util.Map<String, Double> pace, BlockState state) {
        if (pace.isEmpty()) {
            return 1.0;
        }
        String id = BuiltInRegistries.BLOCK.getKey(state.getBlock()).toString();
        Double own = pace.get(id);
        if (own != null) {
            return own;
        }
        return pace.getOrDefault("default", 1.0);
    }

    /** Spelled out, so an unknown name is a loud failure rather than a quiet survival mode. */
    private static GameType gameType(String name) {
        return switch (name) {
            case "creative" -> GameType.CREATIVE;
            case "spectator" -> GameType.SPECTATOR;
            case "survival" -> GameType.SURVIVAL;
            case "adventure" -> GameType.ADVENTURE;
            default -> throw new IllegalArgumentException("unknown game mode: " + name);
        };
    }

    private static void setBlock(ServerLevel level, BlockPos origin, Cue.BlockSpec spec) {
        BlockPos pos = origin.offset(spec.x(), spec.y(), spec.z());
        BlockStateParser.BlockResult parsed;
        try {
            parsed = BlockStateParser.parseForBlock(
                    level.holderLookup(Registries.BLOCK), new StringReader(spec.block()), true);
        } catch (CommandSyntaxException e) {
            throw new IllegalArgumentException("setBlocks: cannot parse \"" + spec.block() + "\": " + e.getMessage());
        }

        Clearable.tryClear(level.getBlockEntity(pos));
        level.setBlock(pos, parsed.blockState(), Block.UPDATE_ALL);
        CompoundTag nbt = parsed.nbt();
        if (nbt != null) {
            BlockEntity entity = level.getBlockEntity(pos);
            if (entity != null) {
                CompoundTag merged = entity.saveWithId(level.registryAccess());
                merged.merge(nbt);
                entity.loadWithComponents(merged, level.registryAccess());
                entity.setChanged();
            }
        }
    }

    /**
     * Empties whatever block entity sits at a position, then removes the block.
     *
     * <p>The emptying is the whole point. A Create deployer holds a filter item and a held item; a
     * vault holds a stack. Replacing such a block makes its {@code onRemove} scatter that inventory
     * across the grass as item entities — which is exactly the litter that showed up after the
     * second take. {@link Clearable#tryClear} is what vanilla's own structure placement uses to
     * avoid it.
     */
    private static void clearBlock(ServerLevel level, BlockPos pos) {
        Clearable.tryClear(level.getBlockEntity(pos));
        level.setBlock(pos, Blocks.AIR.defaultBlockState(), Block.UPDATE_ALL);
    }

    /** Every position inside the schematic's extent, occupied or not. */
    private static List<BlockPos> boundingBox(BlockPos origin, List<SchematicSource.SchematicBlock> schematic) {
        if (schematic.isEmpty()) {
            return List.of();
        }
        int minX = Integer.MAX_VALUE, minY = Integer.MAX_VALUE, minZ = Integer.MAX_VALUE;
        int maxX = Integer.MIN_VALUE, maxY = Integer.MIN_VALUE, maxZ = Integer.MIN_VALUE;
        for (SchematicSource.SchematicBlock block : schematic) {
            BlockPos p = block.relPos();
            minX = Math.min(minX, p.getX()); maxX = Math.max(maxX, p.getX());
            minY = Math.min(minY, p.getY()); maxY = Math.max(maxY, p.getY());
            minZ = Math.min(minZ, p.getZ()); maxZ = Math.max(maxZ, p.getZ());
        }
        List<BlockPos> out = new ArrayList<>();
        for (int y = minY; y <= maxY; y++) {
            for (int z = minZ; z <= maxZ; z++) {
                for (int x = minX; x <= maxX; x++) {
                    out.add(origin.offset(x, y, z));
                }
            }
        }
        return out;
    }

    /** The area a take touches, widened so items that bounced off the build are caught too. */
    private static AABB stageBounds(Timeline timeline, List<SchematicSource.SchematicBlock> schematic) {
        if (schematic.isEmpty()) {
            return null;
        }
        BlockPos origin = timeline.origin();
        int minX = Integer.MAX_VALUE;
        int minY = Integer.MAX_VALUE;
        int minZ = Integer.MAX_VALUE;
        int maxX = Integer.MIN_VALUE;
        int maxY = Integer.MIN_VALUE;
        int maxZ = Integer.MIN_VALUE;
        for (SchematicSource.SchematicBlock block : schematic) {
            BlockPos p = origin.offset(block.relPos());
            minX = Math.min(minX, p.getX());
            minY = Math.min(minY, p.getY());
            minZ = Math.min(minZ, p.getZ());
            maxX = Math.max(maxX, p.getX());
            maxY = Math.max(maxY, p.getY());
            maxZ = Math.max(maxZ, p.getZ());
        }
        return new AABB(minX, minY, minZ, maxX + 1, maxY + 1, maxZ + 1).inflate(8.0, 6.0, 8.0);
    }

    /**
     * Puts the stage back to bare ground: loose items, plus any entity of a type this schematic
     * places.
     *
     * <p>The second part is what makes a re-run idempotent. Super glue is an entity, not a block,
     * so the block-level clear never touched it and each take stacked another 14 bonds on top of
     * the last — the verifier read 28 of 14 after two runs. A take has to be repeatable to be
     * worth anything, so it cleans up after its predecessor rather than adding to it.
     */
    private static int sweepStage(ServerLevel level, AABB area, SchematicSource.Schematic schematic) {
        Set<String> placedTypes = schematic.entities().stream()
                .map(SchematicSource.SchematicEntity::id)
                .collect(Collectors.toSet());

        int removed = 0;
        for (Entity entity : level.getEntitiesOfClass(Entity.class, area)) {
            boolean litter = entity instanceof ItemEntity;
            boolean ours = placedTypes.contains(
                    BuiltInRegistries.ENTITY_TYPE.getKey(entity.getType()).toString());
            if (litter || ours) {
                entity.discard();
                removed++;
            }
        }
        return removed;
    }

    /**
     * Moves the absolute world positions that live inside block entity NBT.
     *
     * <p>A Create display link remembers the block it counts as a world position, and a flap
     * display remembers the link that feeds it the same way. Clone the machine into a studio world
     * and those coordinates still name the server, where in the studio there is nothing at all —
     * so the boards come up blank while every block sits exactly where the verifier expects it.
     * Nothing about that failure is visible until somebody looks at the screen.
     *
     * <p>Found by bounds rather than by name: three ints that land inside the box this schematic
     * was cut from are a reference into it, and anything outside is left alone. Keying off known
     * field names instead would work for the two fields we know about today and quietly fail for
     * whatever the next mod stores.
     */
    private static void translatePositions(CompoundTag tag, BlockPos delta,
                                           BlockPos from, net.minecraft.core.Vec3i size) {
        for (String key : tag.getAllKeys()) {
            Tag value = tag.get(key);
            if (value instanceof CompoundTag nested) {
                translatePositions(nested, delta, from, size);
            } else if (value instanceof ListTag list) {
                if (looksLikePos(list, from, size)) {
                    tag.put(key, intList(list.getInt(0) + delta.getX(),
                            list.getInt(1) + delta.getY(), list.getInt(2) + delta.getZ()));
                    continue;
                }
                for (int i = 0; i < list.size(); i++) {
                    if (list.get(i) instanceof CompoundTag nested) {
                        translatePositions(nested, delta, from, size);
                    }
                }
            } else if (value instanceof net.minecraft.nbt.IntArrayTag array && array.size() == 3) {
                int[] xyz = array.getAsIntArray();
                if (inside(xyz[0], xyz[1], xyz[2], from, size)) {
                    tag.put(key, new net.minecraft.nbt.IntArrayTag(new int[]{
                            xyz[0] + delta.getX(), xyz[1] + delta.getY(), xyz[2] + delta.getZ()}));
                }
            }
        }
    }

    private static boolean looksLikePos(ListTag list, BlockPos from, net.minecraft.core.Vec3i size) {
        if (list.size() != 3 || list.getElementType() != Tag.TAG_INT) {
            return false;
        }
        return inside(list.getInt(0), list.getInt(1), list.getInt(2), from, size);
    }

    /** Generous by one block on every side: a link may well point at a block just outside the cut. */
    private static boolean inside(int x, int y, int z, BlockPos from, net.minecraft.core.Vec3i size) {
        return x >= from.getX() - 1 && x <= from.getX() + size.getX()
                && y >= from.getY() - 1 && y <= from.getY() + size.getY()
                && z >= from.getZ() - 1 && z <= from.getZ() + size.getZ();
    }

    private static ListTag intList(int x, int y, int z) {
        ListTag out = new ListTag();
        out.add(net.minecraft.nbt.IntTag.valueOf(x));
        out.add(net.minecraft.nbt.IntTag.valueOf(y));
        out.add(net.minecraft.nbt.IntTag.valueOf(z));
        return out;
    }

    private static void placeBlock(ServerLevel level,
                                   BlockPos target,
                                   SchematicSource.SchematicBlock block,
                                   Timeline.Presentation presentation) {
        placeBlock(level, target, block, presentation, null, null, null);
    }

    private static void placeBlock(ServerLevel level,
                                   BlockPos target,
                                   SchematicSource.SchematicBlock block,
                                   Timeline.Presentation presentation,
                                   BlockPos delta,
                                   BlockPos sourceOrigin,
                                   net.minecraft.core.Vec3i sourceSize) {
        BlockState state = block.state();
        // Same reasoning as clearBlock: whatever is already here must not drop its inventory.
        Clearable.tryClear(level.getBlockEntity(target));
        level.setBlock(target, state, Block.UPDATE_ALL);

        if (block.hasBlockEntity()) {
            BlockEntity be = level.getBlockEntity(target);
            if (be != null) {
                var tag = block.blockEntityNbt().copy();
                if (delta != null && sourceOrigin != null) {
                    translatePositions(tag, delta, sourceOrigin, sourceSize);
                }
                tag.putInt("x", target.getX());
                tag.putInt("y", target.getY());
                tag.putInt("z", target.getZ());
                be.loadWithComponents(tag, level.registryAccess());
                be.setChanged();
            }
        }

        if (presentation.sound()) {
            // Position-aware variant, so a block whose sound depends on where it sits (Create has a
            // few) is asked in context rather than in the abstract.
            SoundType soundType = state.getSoundType(level, target, null);
            level.playSound(null, target, soundType.getPlaceSound(), SoundSource.BLOCKS,
                    1.0F, soundType.getPitch() * 0.9F);
        }
        if (presentation.particles()) {
            // The block's own texture, puffed outward a little — reads as "something was just set
            // down here" without the violence of break particles.
            level.sendParticles(new BlockParticleOption(ParticleTypes.BLOCK, state),
                    target.getX() + 0.5, target.getY() + 0.5, target.getZ() + 0.5,
                    12, 0.3, 0.3, 0.3, 0.05);
        }
    }

    /**
     * Spawns the schematic's entities. For this contraption that means the 14 super-glue bonds
     * without which the assembler has nothing to pick up, plus the furnace minecart.
     *
     * <p>Two details matter. The entity's position comes from the schematic entry's own relative
     * {@code pos}, not from the {@code Pos} inside its NBT — that one still points at the world the
     * schematic was copied from. And the UUID has to go, or re-running a take tries to spawn
     * entities that already exist and silently places nothing.
     *
     * @param filter substring matched against the entity id, or empty for all
     */
    private static int spawnEntities(ServerLevel level,
                                     BlockPos origin,
                                     SchematicSource.Schematic schematic,
                                     String filter) {
        int placed = 0;
        for (SchematicSource.SchematicEntity entity : schematic.entities()) {
            if (!filter.isEmpty() && !entity.id().contains(filter)) {
                continue;
            }
            Vec3 pos = new Vec3(
                    origin.getX() + entity.relPos().x,
                    origin.getY() + entity.relPos().y,
                    origin.getZ() + entity.relPos().z);

            CompoundTag tag = entity.nbt().copy();
            tag.remove("UUID");
            tag.put("Pos", newDoubleList(pos.x, pos.y, pos.z));

            var created = EntityType.create(tag, level);
            if (created.isEmpty()) {
                NeoDirect.LOGGER.warn("could not create entity {}", entity.id());
                continue;
            }
            Entity spawned = created.get();
            spawned.moveTo(pos.x, pos.y, pos.z, spawned.getYRot(), spawned.getXRot());
            if (level.addFreshEntity(spawned)) {
                placed++;
            }
        }
        return placed;
    }

    /**
     * Sets down a double chest holding the contraption's whole bill of materials.
     *
     * <p>A double chest in Minecraft is two adjacent single chests that agree they are a pair, so
     * this places both halves and lets each hold its own 27 slots. Returns how many stacks were
     * actually stored, which will be short of the bill if a build ever outgrows 54 slots — the log
     * says so rather than silently dropping the remainder.
     */
    private static int placeMaterialsChest(ServerLevel level,
                                           BlockPos origin,
                                           Cue.MaterialsChest cue,
                                           SchematicSource.Schematic schematic) {
        Direction facing = Direction.byName(cue.facing());
        if (facing == null || facing.getAxis().isVertical()) {
            throw new IllegalArgumentException("materialsChest facing must be north, south, east or west");
        }

        BlockPos left = origin.offset(cue.x(), cue.y(), cue.z());
        BlockPos right = left.relative(facing.getClockWise());

        for (BlockPos pos : List.of(left, right)) {
            Clearable.tryClear(level.getBlockEntity(pos));
        }
        if (cue.large()) {
            level.setBlock(left, Blocks.CHEST.defaultBlockState()
                    .setValue(ChestBlock.FACING, facing)
                    .setValue(ChestBlock.TYPE, ChestType.LEFT), Block.UPDATE_ALL);
            level.setBlock(right, Blocks.CHEST.defaultBlockState()
                    .setValue(ChestBlock.FACING, facing)
                    .setValue(ChestBlock.TYPE, ChestType.RIGHT), Block.UPDATE_ALL);
        } else {
            // A single chest is 27 slots and the whole bill is 13 stacks, so a double chest was
            // only ever half full — and "it all fits in one chest" is a better thing for a viewer
            // to take away than a half-empty screen.
            level.setBlock(left, Blocks.CHEST.defaultBlockState()
                    .setValue(ChestBlock.FACING, facing)
                    .setValue(ChestBlock.TYPE, ChestType.SINGLE), Block.UPDATE_ALL);
            level.setBlock(right, Blocks.AIR.defaultBlockState(), Block.UPDATE_ALL);
        }

        List<ItemStack> bill = BillOfMaterials.stacks(schematic, level.registryAccess(),
                Set.copyOf(cue.ignoreContentsOf()));
        int stored = 0;
        // Right half first: ChestBlock.getBlockType maps ChestType.RIGHT to BlockType.FIRST, so the
        // right chest's slots are the ones the combined screen shows at the top. Filling left-first
        // left the visible top three rows empty and pushed every stack into the bottom half.
        for (BlockPos pos : cue.large() ? List.of(right, left) : List.of(left)) {
            if (!(level.getBlockEntity(pos) instanceof Container container)) {
                continue;
            }
            for (int slot = 0; slot < container.getContainerSize() && stored < bill.size(); slot++) {
                container.setItem(slot, bill.get(stored++));
            }
            container.setChanged();
        }

        if (stored < bill.size()) {
            NeoDirect.LOGGER.warn("materials chest holds {} of {} stacks — the rest did not fit",
                    stored, bill.size());
        }
        return stored;
    }

    /** Drops specific items into a container that is part of the build. */
    private static int fillContainer(ServerLevel level, BlockPos origin, Cue.Fill cue) {
        BlockPos pos = origin.offset(cue.x(), cue.y(), cue.z());
        if (!(level.getBlockEntity(pos) instanceof Container container)) {
            throw new IllegalStateException("no container at " + pos.toShortString());
        }

        int slot = 0;
        int stored = 0;
        for (Cue.ItemSpec spec : cue.items()) {
            Item item = BuiltInRegistries.ITEM.getOptional(ResourceLocation.parse(spec.id()))
                    .orElseThrow(() -> new IllegalArgumentException("unknown item: " + spec.id()));
            int remaining = spec.count();
            int limit = new ItemStack(item).getMaxStackSize();
            while (remaining > 0 && slot < container.getContainerSize()) {
                int take = Math.min(remaining, limit);
                container.setItem(slot++, new ItemStack(item, take));
                remaining -= take;
                stored++;
            }
        }
        container.setChanged();
        return stored;
    }

    /**
     * Holds up a block's filter and opens it.
     *
     * <p>A Create deployer has no screen of its own — the filter is a separate item in a slot on
     * the block, and it is that item which opens a menu. So the filter is copied out of the
     * block's saved data, put in the player's hand, and used, exactly as a player right-clicking
     * the filter would.
     */
    private static void showFilter(ServerLevel level, ServerPlayer player, SchematicSource.SchematicBlock source) {
        if (!source.hasBlockEntity() || !source.blockEntityNbt().contains("Filter")) {
            throw new IllegalStateException(itemName(source.state()) + " has no filter to show");
        }
        ItemStack filter = ItemStack.parse(level.registryAccess(), source.blockEntityNbt().getCompound("Filter"))
                .orElseThrow(() -> new IllegalStateException("could not read the filter item"));

        player.getInventory().selected = 0;
        player.getInventory().setItem(0, filter);
        player.inventoryMenu.broadcastChanges();
        filter.use(level, player, InteractionHand.MAIN_HAND);
    }

    /**
     * Opens a container on camera, or closes whatever is open.
     *
     * <p>Opening goes through the block's own {@code MenuProvider}, so a double chest opens as the
     * 54-slot screen the player would see, not as two halves.
     */
    private static void toggleScreen(ServerLevel level, ServerPlayer player, BlockPos origin, Cue.Screen cue) {
        if (cue.action().equals("close")) {
            player.closeContainer();
            return;
        }

        BlockPos pos = origin.offset(cue.x(), cue.y(), cue.z());
        MenuProvider provider = level.getBlockState(pos).getMenuProvider(level, pos);
        if (provider == null) {
            throw new IllegalStateException("nothing with a screen at " + pos.toShortString());
        }
        // A container menu closes itself once the player is more than eight blocks off, so a shot
        // that opens one has to keep the camera close.
        double distance = Math.sqrt(player.distanceToSqr(pos.getX() + 0.5, pos.getY() + 0.5, pos.getZ() + 0.5));
        if (distance > 8.0) {
            NeoDirect.LOGGER.warn("camera is {} blocks from the container at {} — the screen will close itself",
                    Math.round(distance), pos.toShortString());
        }
        player.openMenu(provider);
    }

    private static ListTag newDoubleList(double... values) {
        ListTag list = new ListTag();
        for (double value : values) {
            list.add(DoubleTag.valueOf(value));
        }
        return list;
    }

    private static void equip(ServerPlayer player, BlockState state) {
        Item item = state.getBlock().asItem();
        if (item == Items.AIR) {
            return;
        }
        player.getInventory().selected = 0;
        player.getInventory().setItem(0, new ItemStack(item));
        player.inventoryMenu.broadcastChanges();
    }

    /** Readable summary for the take log: counts per type, not a list of 108 identical names. */
    private static String describePlacement(List<SchematicSource.SchematicBlock> targets) {
        Map<String, Integer> counts = new LinkedHashMap<>();
        for (SchematicSource.SchematicBlock block : targets) {
            counts.merge(itemName(block.state()), 1, Integer::sum);
        }
        return counts.entrySet().stream()
                .map(e -> e.getValue() == 1 ? e.getKey() : e.getKey() + " x" + e.getValue())
                .collect(Collectors.joining(", "));
    }

    private static String itemName(BlockState state) {
        return net.minecraft.core.registries.BuiltInRegistries.BLOCK.getKey(state.getBlock()).toString();
    }
}
