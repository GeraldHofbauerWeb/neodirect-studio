package net.geraldhofbauer.neodirect.timeline;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import net.geraldhofbauer.neodirect.NeoDirect;
import net.geraldhofbauer.neodirect.client.ClientBridge;
import net.geraldhofbauer.neodirect.schematic.BillOfMaterials;
import net.geraldhofbauer.neodirect.schematic.SchematicSource;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.nbt.CompoundTag;
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
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.Vec3;
import net.neoforged.bus.api.SubscribeEvent;
import net.neoforged.fml.common.EventBusSubscriber;
import net.neoforged.fml.loading.FMLPaths;
import net.neoforged.neoforge.event.tick.ServerTickEvent;

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
            steps = expand(timeline, schematic, player.serverLevel(), player);
        } catch (RuntimeException e) {
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
        JsonObject report = Verifier.verify(player.serverLevel(), timeline.origin(), scopeToTimeline(timeline, full));
        report.add("cameraClearance", Verifier.checkCameraClearance(player.serverLevel(), timeline, 240));
        return report;
    }

    /** Narrows a schematic to just the blocks and entities a given timeline actually places. */
    private static SchematicSource.Schematic scopeToTimeline(Timeline timeline,
                                                             SchematicSource.Schematic full) {
        Set<Integer> claimed = new LinkedHashSet<>();
        for (Cue cue : timeline.cues()) {
            if (cue instanceof Cue.Place place) {
                resolve(place, full.blocks(), claimed);
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
                                     ServerLevel level,
                                     ServerPlayer player) {
        List<SchematicSource.SchematicBlock> schematic = schematicData.blocks();
        Timeline.Presentation presentation = timeline.presentation();
        List<Step> steps = new ArrayList<>();

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
                placements.put(place, resolve(place, schematic, claimed));
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
                if (showFilter.blockIndex() < 0 || showFilter.blockIndex() >= schematic.size()) {
                    throw new IllegalArgumentException("showFilter block index out of range: " + showFilter.blockIndex());
                }
                SchematicSource.SchematicBlock source = schematic.get(showFilter.blockIndex());
                steps.add(new Step(showFilter.atMs(), "showFilter",
                        () -> showFilter(level, player, source),
                        itemName(source.state())));

            } else if (cue instanceof Cue.Screen screen) {
                steps.add(new Step(screen.atMs(), "screen",
                        () -> toggleScreen(level, player, timeline.origin(), screen),
                        screen.action()));

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

                BlockState first = targets.get(0).state();
                if (presentation.heldItem()) {
                    steps.add(new Step(Math.max(0, place.atMs() - EQUIP_LEAD_MS), "equip",
                            () -> equip(player, first), itemName(first)));
                }
                if (presentation.swing()) {
                    steps.add(new Step(Math.max(0, place.atMs() - SWING_LEAD_MS), "swing",
                            () -> ClientBridge.send(new ClientBridge.Command.Swing()), itemName(first)));
                }

                BlockPos origin = timeline.origin();
                steps.add(new Step(place.atMs(), "place",
                        () -> {
                            for (SchematicSource.SchematicBlock block : targets) {
                                placeBlock(level, origin.offset(block.relPos()), block, presentation);
                            }
                        },
                        describePlacement(targets)));
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

    private static void placeBlock(ServerLevel level,
                                   BlockPos target,
                                   SchematicSource.SchematicBlock block,
                                   Timeline.Presentation presentation) {
        BlockState state = block.state();
        // Same reasoning as clearBlock: whatever is already here must not drop its inventory.
        Clearable.tryClear(level.getBlockEntity(target));
        level.setBlock(target, state, Block.UPDATE_ALL);

        if (block.hasBlockEntity()) {
            BlockEntity be = level.getBlockEntity(target);
            if (be != null) {
                var tag = block.blockEntityNbt().copy();
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

        List<ItemStack> bill = BillOfMaterials.stacks(schematic, level.registryAccess());
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

    /**
     * Opens a container on camera, or closes whatever is open.
     *
     * <p>Opening goes through the block's own {@code MenuProvider}, so a double chest opens as the
     * 54-slot screen the player would see, not as two halves.
     */
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
