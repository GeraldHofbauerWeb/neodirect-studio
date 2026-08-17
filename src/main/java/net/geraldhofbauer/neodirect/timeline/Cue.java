package net.geraldhofbauer.neodirect.timeline;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import net.minecraft.util.GsonHelper;

import java.util.ArrayList;
import java.util.List;

/**
 * One instruction on the timeline, fired when the take's wall clock passes {@link #atMs()}.
 *
 * <p>Wall clock, not tick count, on purpose: the timeline is derived from narration audio
 * durations, and OBS records against wall clock too. Counting ticks would drift the moment the
 * game stutters.
 */
public sealed interface Cue permits Cue.Place, Cue.Camera, Cue.Entities, Cue.MaterialsChest, Cue.Fill,
        Cue.ShowFilter, Cue.Screen, Cue.Marker {

    long atMs();

    /** When this cue is finished — instantaneous cues end where they start. */
    default long endMs() {
        return atMs();
    }

    /**
     * Place blocks from the schematic. Indices address the schematic's block list, so the didactic
     * order lives in the script and not in the code.
     *
     * <p>{@code blocks} may be an explicit list, the string {@code "all"}, or an object
     * {@code {"from": a, "to": b}}. The latter two exist so a whole-contraption build does not
     * need a couple of hundred hand-written indices — a script names the handful of blocks a beat
     * actually talks about, and sweeps up the rest in one cue.
     */
    record Place(long atMs, Selector selector) implements Cue {

        /**
         * How a cue names the blocks it places.
         *
         * <p>Indices are precise but unreadable past a handful, which is why the other forms
         * exist: a tutorial says "now the same drill across the whole face", not "blocks 118
         * through 171". {@code ofType} and {@code rest} let the script say that directly, and they
         * keep working when the contraption is edited.
         */
        sealed interface Selector permits Indices, Range, OfType, Rest {}

        record Indices(List<Integer> values) implements Selector {}

        record Range(int from, int to) implements Selector {
            public static final Range ALL = new Range(0, Integer.MAX_VALUE);
        }

        /** Every block of the named type(s), in the schematic's own order. */
        record OfType(List<String> blockIds) implements Selector {}

        /**
         * Everything earlier cues in this timeline have not already placed, minus the types named
         * in {@code exceptTypes}.
         *
         * <p>The exception list is what keeps a sweep-up cue from stealing blocks a later beat is
         * built around. "Everything else now" and "the storage goes on last" are both true
         * statements about the same script, and without a way to say the first while excluding the
         * second, the sweep silently wins — which is how the item vaults ended up going down during
         * the chest beat while the closing beat placed nothing at all.
         */
        record Rest(List<String> exceptTypes) implements Selector {}
    }

    /** Fly the camera along keyframes over {@code durationMs}. */
    record Camera(long atMs, long durationMs, List<Keyframe> keyframes) implements Cue {
        @Override
        public long endMs() {
            return atMs + durationMs;
        }
    }

    /**
     * Spawn the schematic's entities — for a Create contraption that is the super glue, without
     * which the assembler has nothing to pick up.
     *
     * @param filter substring matched against the entity id ("super_glue"), or empty for all
     */
    record Entities(long atMs, String filter) implements Cue {}

    /**
     * Put down a double chest stocked with everything the contraption is made of.
     *
     * <p>The contents are counted from the schematic rather than listed in the script, so the
     * chest can never drift out of step with the build it is supposed to supply.
     *
     * @param pos    where the chest goes, relative to the timeline's origin
     * @param facing which way it faces: north, south, east or west
     */
    record MaterialsChest(long atMs, int x, int y, int z, String facing, boolean large) implements Cue {}

    /**
     * Put specific items into a container that is already part of the build.
     *
     * <p>Used for the things the schematic cannot know: the rail and fuel a player has to load
     * before the train will actually drive anywhere.
     */
    record Fill(long atMs, int x, int y, int z, List<ItemSpec> items) implements Cue {}

    record ItemSpec(String id, int count) {}

    /**
     * Hold up a block's filter and open it, so the camera can read what the machine is set to
     * accept.
     *
     * <p>The deployer itself has no screen — in Create the filter is a separate item sitting in a
     * slot on the block, and it is that item which opens a menu. So this copies the filter out of
     * the block's saved data, puts it in the player's hand, and uses it.
     *
     * @param blockIndex which schematic block to take the filter from
     */
    record ShowFilter(long atMs, int blockIndex) implements Cue {}

    /**
     * Open or close a container's screen on camera.
     *
     * <p>The point is to show the actual stack counts rather than assert them in narration — the
     * viewer reads the numbers off the same inventory the build will consume.
     *
     * <p>A container menu closes itself if the player drifts more than eight blocks away, so the
     * camera has to stay near whatever it opened.
     *
     * @param action {@code open} or {@code close}
     */
    record Screen(long atMs, String action, int x, int y, int z) implements Cue {}

    /** A no-op that shows up in the take log — useful to line the video up with the narration. */
    record Marker(long atMs, String label) implements Cue {}

    record Keyframe(double x, double y, double z, float yaw, float pitch) {}

    static Cue parse(JsonObject obj) {
        long atMs = GsonHelper.getAsLong(obj, "atMs", 0L);
        String type = GsonHelper.getAsString(obj, "type");

        return switch (type) {
            case "place" -> parsePlace(atMs, obj);
            case "camera" -> {
                long durationMs = GsonHelper.getAsLong(obj, "durationMs", 3000L);
                List<Keyframe> keyframes = new ArrayList<>();
                for (JsonElement el : GsonHelper.getAsJsonArray(obj, "keyframes")) {
                    keyframes.add(parseKeyframe(el.getAsJsonObject()));
                }
                if (keyframes.size() < 2) {
                    throw new IllegalArgumentException("camera cue needs at least 2 keyframes, got " + keyframes.size());
                }
                yield new Camera(atMs, durationMs, List.copyOf(keyframes));
            }
            case "entities" -> new Entities(atMs, GsonHelper.getAsString(obj, "filter", ""));
            case "materialsChest" -> {
                JsonArray pos = GsonHelper.getAsJsonArray(obj, "pos");
                if (pos.size() != 3) {
                    throw new IllegalArgumentException("materialsChest 'pos' must have exactly 3 entries");
                }
                yield new MaterialsChest(atMs,
                        pos.get(0).getAsInt(), pos.get(1).getAsInt(), pos.get(2).getAsInt(),
                        GsonHelper.getAsString(obj, "facing", "south"),
                        GsonHelper.getAsBoolean(obj, "large", false));
            }
            case "fill" -> {
                JsonArray pos = GsonHelper.getAsJsonArray(obj, "pos");
                if (pos.size() != 3) {
                    throw new IllegalArgumentException("fill 'pos' must have exactly 3 entries");
                }
                List<ItemSpec> items = new ArrayList<>();
                for (JsonElement el : GsonHelper.getAsJsonArray(obj, "items")) {
                    JsonObject item = el.getAsJsonObject();
                    items.add(new ItemSpec(GsonHelper.getAsString(item, "id"),
                            GsonHelper.getAsInt(item, "count", 1)));
                }
                yield new Fill(atMs, pos.get(0).getAsInt(), pos.get(1).getAsInt(), pos.get(2).getAsInt(),
                        List.copyOf(items));
            }
            case "showFilter" -> new ShowFilter(atMs, GsonHelper.getAsInt(obj, "block"));
            case "screen" -> {
                String action = GsonHelper.getAsString(obj, "action");
                if (!action.equals("open") && !action.equals("close")) {
                    throw new IllegalArgumentException("screen action must be \"open\" or \"close\", got " + action);
                }
                int[] at = {0, 0, 0};
                if (obj.has("pos")) {
                    JsonArray pos = GsonHelper.getAsJsonArray(obj, "pos");
                    if (pos.size() != 3) {
                        throw new IllegalArgumentException("screen 'pos' must have exactly 3 entries");
                    }
                    for (int i = 0; i < 3; i++) {
                        at[i] = pos.get(i).getAsInt();
                    }
                } else if (action.equals("open")) {
                    throw new IllegalArgumentException("a screen cue with action \"open\" needs a 'pos'");
                }
                yield new Screen(atMs, action, at[0], at[1], at[2]);
            }
            case "marker" -> new Marker(atMs, GsonHelper.getAsString(obj, "label", ""));
            default -> throw new IllegalArgumentException("unknown cue type: " + type);
        };
    }

    /**
     * Reads the several shapes 'blocks' accepts:
     * {@code [1,2,3]}, {@code "all"}, {@code "rest"},
     * {@code {"from":a,"to":b}}, {@code {"ofType":"create:deployer"}} or a list of type ids,
     * and {@code {"rest":true,"except":["create:item_vault"]}}.
     */
    private static Place parsePlace(long atMs, JsonObject obj) {
        JsonElement spec = obj.get("blocks");
        if (spec == null) {
            throw new IllegalArgumentException("place cue needs 'blocks'");
        }

        if (spec.isJsonPrimitive() && spec.getAsJsonPrimitive().isString()) {
            return switch (spec.getAsString()) {
                case "all" -> new Place(atMs, Place.Range.ALL);
                case "rest" -> new Place(atMs, new Place.Rest(List.of()));
                default -> throw new IllegalArgumentException(
                        "'blocks' as a string must be \"all\" or \"rest\", got " + spec.getAsString());
            };
        }

        if (spec.isJsonObject()) {
            JsonObject o = spec.getAsJsonObject();
            if (o.has("ofType")) {
                return new Place(atMs, new Place.OfType(typeIds(o.get("ofType"))));
            }
            if (o.has("rest")) {
                return new Place(atMs, new Place.Rest(
                        o.has("except") ? typeIds(o.get("except")) : List.of()));
            }
            return new Place(atMs, new Place.Range(
                    GsonHelper.getAsInt(o, "from", 0),
                    GsonHelper.getAsInt(o, "to", Integer.MAX_VALUE)));
        }

        List<Integer> indices = new ArrayList<>();
        for (JsonElement el : spec.getAsJsonArray()) {
            indices.add(el.getAsInt());
        }
        return new Place(atMs, new Place.Indices(List.copyOf(indices)));
    }

    /** A block id or a list of them, both spellings accepted wherever types are named. */
    private static List<String> typeIds(JsonElement element) {
        if (!element.isJsonArray()) {
            return List.of(element.getAsString());
        }
        List<String> ids = new ArrayList<>();
        for (JsonElement el : element.getAsJsonArray()) {
            ids.add(el.getAsString());
        }
        return List.copyOf(ids);
    }

    private static Keyframe parseKeyframe(JsonObject obj) {
        JsonArray pos = GsonHelper.getAsJsonArray(obj, "pos");
        if (pos.size() != 3) {
            throw new IllegalArgumentException("keyframe 'pos' must have exactly 3 entries");
        }
        return new Keyframe(
                pos.get(0).getAsDouble(),
                pos.get(1).getAsDouble(),
                pos.get(2).getAsDouble(),
                GsonHelper.getAsFloat(obj, "yaw", 0.0F),
                GsonHelper.getAsFloat(obj, "pitch", 0.0F));
    }
}
