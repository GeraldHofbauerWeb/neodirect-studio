package net.geraldhofbauer.neodirect.timeline;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import net.minecraft.core.BlockPos;
import net.minecraft.util.GsonHelper;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;

/**
 * A take, parsed from JSON.
 *
 * <p>Parsed by hand off {@link JsonObject} rather than through Gson's reflective binding: mod
 * classes live in their own module layer, and reflective binding there is a class of failure this
 * prototype does not need to spend an afternoon on. The schema is small enough that explicit
 * reading is also the clearer documentation.
 */
public record Timeline(
        String take,
        String schematic,
        BlockPos origin,
        Presentation presentation,
        boolean clearStage,
        List<Cue> cues) {

    /** Which parts of the "someone is building this" illusion are switched on. */
    public record Presentation(boolean heldItem, boolean swing, boolean sound, boolean particles) {
        public static final Presentation NONE = new Presentation(false, false, false, false);
        public static final Presentation FULL = new Presentation(true, true, true, true);
    }

    public static Timeline parse(String json) {
        JsonObject root = JsonParser.parseString(json).getAsJsonObject();

        String take = GsonHelper.getAsString(root, "take", "untitled");
        String schematic = GsonHelper.getAsString(root, "schematic", null);
        BlockPos origin = readPos(root, "origin");

        Presentation presentation = Presentation.NONE;
        if (root.has("presentation")) {
            JsonObject p = GsonHelper.getAsJsonObject(root, "presentation");
            presentation = new Presentation(
                    GsonHelper.getAsBoolean(p, "heldItem", false),
                    GsonHelper.getAsBoolean(p, "swing", false),
                    GsonHelper.getAsBoolean(p, "sound", false),
                    GsonHelper.getAsBoolean(p, "particles", false));
        }

        // Default true: a take should not depend on what happened to run before it. A follow-on
        // beat that continues an earlier take's build sets this false.
        boolean clearStage = GsonHelper.getAsBoolean(root, "clearStage", true);

        List<Cue> cues = new ArrayList<>();
        JsonArray arr = GsonHelper.getAsJsonArray(root, "cues", new JsonArray());
        for (JsonElement el : arr) {
            cues.add(Cue.parse(el.getAsJsonObject()));
        }
        // The director walks cues in time order; do not make the script author responsible for that.
        cues.sort(Comparator.comparingLong(Cue::atMs));

        return new Timeline(take, schematic, origin, presentation, clearStage, List.copyOf(cues));
    }

    private static BlockPos readPos(JsonObject obj, String key) {
        if (!obj.has(key)) {
            return BlockPos.ZERO;
        }
        JsonArray a = GsonHelper.getAsJsonArray(obj, key);
        if (a.size() != 3) {
            throw new IllegalArgumentException("'" + key + "' must have exactly 3 entries, got " + a.size());
        }
        return new BlockPos(a.get(0).getAsInt(), a.get(1).getAsInt(), a.get(2).getAsInt());
    }

    /** Total length of the take, i.e. when the last cue is done. */
    public long durationMs() {
        long end = 0;
        for (Cue cue : cues) {
            end = Math.max(end, cue.endMs());
        }
        return end;
    }
}
