package net.geraldhofbauer.neodirect.timeline;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import net.geraldhofbauer.neodirect.schematic.SchematicSource;
import net.minecraft.core.BlockPos;
import net.minecraft.world.phys.Vec3;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.item.ItemEntity;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.AABB;

import java.util.List;
import java.util.Map;
import java.util.Set;
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

    /**
     * @param extras  positions a {@code setBlocks} cue filled that the schematic knows nothing
     *                about — a creative motor on the open end of the drive, say. They are excluded
     *                from the comparison rather than counted as wrong.
     * @param running true when the take ends with the machine working. A machine that works puts
     *                items on belts and drops some of them, and the litter count stops being a
     *                signal that something was destroyed.
     */
    public static JsonObject verify(ServerLevel level,
                                    BlockPos origin,
                                    SchematicSource.Schematic schematic,
                                    Set<BlockPos> extras,
                                    boolean running) {
        JsonArray mismatches = new JsonArray();
        int matched = 0;
        int missing = 0;
        int wrongState = 0;

        for (SchematicSource.SchematicBlock block : schematic.blocks()) {
            BlockPos pos = origin.offset(block.relPos());
            if (extras.contains(pos)) {
                continue;
            }
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

        if (!extras.isEmpty()) {
            result.addProperty("extraBlocks", extras.size());
        }

        AABB area = bounds(origin, schematic);
        if (area != null) {
            result.add("entities", entityReport(level, area, schematic));
            int loose = level.getEntitiesOfClass(ItemEntity.class, area).size();
            result.addProperty("looseItems", loose);
            // Litter normally means a block entity was destroyed and spilled. It stops meaning
            // that the moment the machine is running: a belt carrying ore is a belt with items on
            // it, and some of them fall off the end. Reported either way, judged only when still.
            result.addProperty("looseItemsExpected", running);
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
     *
     * <p>Nor is the camera point enough. It used to test the single block containing the eye,
     * which is not what collides: the body hangs below it, and a shot composed to sit in a gap
     * inside a machine passed this check with its feet in the stone. Everything the camera's box
     * overlaps is tested now.
     */
    /**
     * The camera's own body, as a box around the point a script calls the camera.
     *
     * <p>Matches the pose the director films in — a crawl-sized 0.6 cube with the eye 0.4 up it,
     * rather than the 1.8-tall standing box a player normally carries. Keep the two in step: this
     * is a check on what the take will actually do, and a check measuring a different body than
     * the one that flies is worse than no check, because it reads as a pass.
     */
    private static AABB cameraBox(Vec3 eye) {
        return new AABB(eye.x - 0.3, eye.y - 0.4, eye.z - 0.3,
                eye.x + 0.3, eye.y + 0.2, eye.z + 0.3);
    }

    private static BlockPos firstBlockIn(ServerLevel level, AABB box) {
        for (BlockPos pos : BlockPos.betweenClosed(BlockPos.containing(box.minX, box.minY, box.minZ),
                BlockPos.containing(box.maxX, box.maxY, box.maxZ))) {
            if (!level.getBlockState(pos).isAir()) {
                return pos.immutable();
            }
        }
        return null;
    }

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
                var pose = CameraPath.sample(camera.keyframes(),
                        camera.linear() ? t : CameraPath.easeInOut(t));
                BlockPos hit = firstBlockIn(level, cameraBox(pose.position()));
                if (hit != null) {
                    blocked++;
                    if (firstBlocked == null) {
                        firstBlocked = hit;
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
