package net.geraldhofbauer.neodirect.timeline;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import net.geraldhofbauer.neodirect.schematic.SchematicSource;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.item.ItemEntity;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.AABB;

import java.util.List;
import java.util.Map;
import java.util.TreeMap;

/**
 * Checks that what stands in the world is what the schematic describes.
 *
 * <p>"It should look exactly like the schematic" is a property, not an impression, so it is
 * machine-checked rather than eyeballed. Block states are compared exactly — that catches a drill
 * facing the wrong way or a rail with the wrong shape, which are precisely the mistakes a viewer
 * would notice and a screenshot would not.
 *
 * <p>Loose item entities are counted too: litter on the grass means a block entity was destroyed
 * somewhere along the way and spilled its inventory.
 */
public final class Verifier {

    /** How many individual mismatches to name before the report just counts them. */
    private static final int MAX_REPORTED = 25;

    private Verifier() {
    }

    public static JsonObject verify(ServerLevel level,
                                    BlockPos origin,
                                    SchematicSource.Schematic schematic) {
        JsonArray mismatches = new JsonArray();
        int matched = 0;
        int missing = 0;
        int wrongState = 0;

        for (SchematicSource.SchematicBlock block : schematic.blocks()) {
            BlockPos pos = origin.offset(block.relPos());
            BlockState actual = level.getBlockState(pos);
            BlockState expected = block.state();

            if (actual.equals(expected)) {
                matched++;
                continue;
            }

            if (actual.isAir()) {
                missing++;
            } else {
                wrongState++;
            }

            if (mismatches.size() < MAX_REPORTED) {
                JsonObject entry = new JsonObject();
                entry.addProperty("pos", block.relPos().toShortString());
                entry.addProperty("expected", describe(expected));
                entry.addProperty("actual", describe(actual));
                mismatches.add(entry);
            }
        }

        JsonObject result = new JsonObject();
        // Blocks whose mod is missing never even reach the placement list, so without this the
        // report would cheerfully say "everything matches" about a contraption that lost a chest.
        JsonArray unknown = new JsonArray();
        schematic.unknownBlocks().forEach(unknown::add);
        result.add("unknownBlocks", unknown);
        result.addProperty("blocksInSchematic", schematic.blocks().size());
        result.addProperty("matched", matched);
        result.addProperty("missing", missing);
        result.addProperty("wrongState", wrongState);
        result.add("mismatches", mismatches);

        AABB area = bounds(origin, schematic);
        if (area != null) {
            result.add("entities", entityReport(level, area, schematic));
            result.addProperty("looseItems",
                    level.getEntitiesOfClass(ItemEntity.class, area).size());
        }

        result.addProperty("ok", missing == 0 && wrongState == 0 && schematic.unknownBlocks().isEmpty());
        return result;
    }

    /**
     * Walks every camera move and reports where it would pass through a block.
     *
     * <p>Checked against the finished build, which is the worst case: a path that is clear at the
     * end was clear all the way through, since the director only ever adds blocks.
     *
     * <p>Keyframes are not enough to check. Catmull-Rom passes through each keyframe but bows
     * outward between them, so a path whose every waypoint sits clear of the contraption can still
     * bulge into the drill face — which is exactly how one shot ended up glitching through it.
     */
    public static JsonArray checkCameraClearance(ServerLevel level, Timeline timeline, int samplesPerMove) {
        JsonArray problems = new JsonArray();

        for (Cue cue : timeline.cues()) {
            if (!(cue instanceof Cue.Camera camera)) {
                continue;
            }
            BlockPos firstBlocked = null;
            int blocked = 0;

            for (int i = 0; i <= samplesPerMove; i++) {
                double t = (double) i / samplesPerMove;
                // Ease the same way playback does, so samples cluster where the camera lingers.
                var pose = CameraPath.sample(camera.keyframes(), CameraPath.easeInOut(t));
                BlockPos pos = BlockPos.containing(pose.position());
                if (!level.getBlockState(pos).isAir()) {
                    blocked++;
                    if (firstBlocked == null) {
                        firstBlocked = pos;
                    }
                }
            }

            if (blocked > 0) {
                JsonObject entry = new JsonObject();
                entry.addProperty("atMs", camera.atMs());
                entry.addProperty("blockedSamples", blocked);
                entry.addProperty("ofSamples", samplesPerMove + 1);
                entry.addProperty("firstAt", firstBlocked.toShortString());
                entry.addProperty("insideBlock",
                        BuiltInRegistries.BLOCK.getKey(level.getBlockState(firstBlocked).getBlock()).toString());
                problems.add(entry);
            }
        }
        return problems;
    }

    /** Expected versus actual entity counts per type, so missing super glue is visible at a glance. */
    private static JsonObject entityReport(ServerLevel level, AABB area, SchematicSource.Schematic schematic) {
        Map<String, Integer> expected = new TreeMap<>();
        for (SchematicSource.SchematicEntity entity : schematic.entities()) {
            expected.merge(entity.id(), 1, Integer::sum);
        }

        Map<String, Integer> actual = new TreeMap<>();
        for (Entity entity : level.getEntitiesOfClass(Entity.class, area)) {
            String id = BuiltInRegistries.ENTITY_TYPE.getKey(entity.getType()).toString();
            if (expected.containsKey(id)) {
                actual.merge(id, 1, Integer::sum);
            }
        }

        JsonObject report = new JsonObject();
        for (Map.Entry<String, Integer> entry : expected.entrySet()) {
            JsonObject counts = new JsonObject();
            counts.addProperty("expected", entry.getValue());
            counts.addProperty("actual", actual.getOrDefault(entry.getKey(), 0));
            report.add(entry.getKey(), counts);
        }
        return report;
    }

    private static AABB bounds(BlockPos origin, SchematicSource.Schematic schematic) {
        List<SchematicSource.SchematicBlock> blocks = schematic.blocks();
        if (blocks.isEmpty()) {
            return null;
        }
        int minX = Integer.MAX_VALUE;
        int minY = Integer.MAX_VALUE;
        int minZ = Integer.MAX_VALUE;
        int maxX = Integer.MIN_VALUE;
        int maxY = Integer.MIN_VALUE;
        int maxZ = Integer.MIN_VALUE;
        for (SchematicSource.SchematicBlock block : blocks) {
            BlockPos p = origin.offset(block.relPos());
            minX = Math.min(minX, p.getX());
            minY = Math.min(minY, p.getY());
            minZ = Math.min(minZ, p.getZ());
            maxX = Math.max(maxX, p.getX());
            maxY = Math.max(maxY, p.getY());
            maxZ = Math.max(maxZ, p.getZ());
        }
        return new AABB(minX, minY, minZ, maxX + 1, maxY + 1, maxZ + 1).inflate(4.0);
    }

    /** Block id plus only the properties that differ from the block's default, to keep it readable. */
    private static String describe(BlockState state) {
        String id = BuiltInRegistries.BLOCK.getKey(state.getBlock()).toString();
        BlockState defaults = state.getBlock().defaultBlockState();
        StringBuilder properties = new StringBuilder();
        state.getProperties().forEach(property -> {
            if (!state.getValue(property).equals(defaults.getValue(property))) {
                properties.append(properties.isEmpty() ? "" : ",")
                        .append(property.getName()).append('=').append(state.getValue(property));
            }
        });
        return properties.isEmpty() ? id : id + "[" + properties + "]";
    }
}
