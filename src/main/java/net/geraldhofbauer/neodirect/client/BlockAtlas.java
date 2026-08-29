package net.geraldhofbauer.neodirect.client;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.mojang.blaze3d.platform.NativeImage;
import net.geraldhofbauer.neodirect.NeoDirect;
import net.minecraft.client.Minecraft;
import net.minecraft.client.renderer.block.model.BakedQuad;
import net.minecraft.client.renderer.texture.TextureAtlasSprite;
import net.minecraft.client.resources.model.BakedModel;
import net.minecraft.core.Direction;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.resources.ResourceLocation;
import net.minecraft.util.RandomSource;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.state.BlockState;
import net.neoforged.neoforge.client.model.data.ModelData;

import java.io.IOException;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Cuts the blocks a schematic uses out of the game's own texture atlas.
 *
 * <p>Three faces per block — top, side, bottom — packed into a small atlas of 16-pixel tiles with
 * an index saying where each block's faces landed. The studio draws voxels, so three faces is
 * exactly what a cube needs and no more; the shape of a model is not represented and is not meant
 * to be. A drill in the viewport is a drill-coloured cube, which is the difference between
 * recognising a machine and merely seeing that something is there.
 *
 * <p>Two deliberate simplifications, both worth knowing before trusting a picture from this:
 *
 * <ul>
 *   <li><b>One state per block.</b> The default state, the same approximation the map colours in
 *       {@code /blockcolors} already make. A piston's face does not follow where it points.</li>
 *   <li><b>Frame one of an animation.</b> Water and fire stack their frames vertically in one
 *       image; the first is taken and the rest ignored.</li>
 * </ul>
 *
 * <p>Sprites are shared aggressively — a hundred blocks whose sides are the same oak plank produce
 * one tile — so the atlas for a nine-hundred-block contraption comes out a few tens of kilobytes,
 * small enough to travel inside the JSON that describes it.
 */
public final class BlockAtlas {

    private BlockAtlas() {
    }

    /** Edge of one tile in the packed atlas. Sprites of other sizes are sampled down to it. */
    private static final int TILE = 16;

    /** Tiles per row. Square-ish atlases are friendlier to a texture unit than long strips. */
    private static final int COLUMNS = 16;

    /** No tint. Kept as a name because {@code -1} appears in three places and means this. */
    private static final int NO_TINT = 0xffffff;

    /**
     * "This block has no picture", which the viewport paints as its map colour instead.
     *
     * <p>Some blocks are deliberately invisible — Create's crushing wheel controller is a block of
     * behaviour with no model at all — and Minecraft hands those the magenta chequerboard it uses
     * for a texture that failed to load. Passing that through would put a loud missing-texture
     * marker in the middle of a working contraption and make it look broken. It is reported in the
     * answer instead, where it is information rather than an alarm.
     */
    private static final int NO_TILE = -1;

    /** The sprite Minecraft substitutes when a model asks for a texture that is not there. */
    private static final String MISSING_SPRITE = "minecraft:missingno";

    /**
     * Serves one queued request. Called from the client tick, which is the render thread — the only
     * thread allowed to ask a model for its quads.
     */
    public static void serve(BlockTextures.Request request) {
        try {
            request.answer().complete(build(request.ids()));
        } catch (RuntimeException | IOException e) {
            NeoDirect.LOGGER.error("could not export block textures", e);
            request.answer().completeExceptionally(e);
        }
    }

    private static String build(List<String> ids) throws IOException {
        Minecraft mc = Minecraft.getInstance();
        RandomSource random = RandomSource.create();

        // Tile pixels, in the order they will be packed, and a key to reuse one we already cut.
        List<int[]> tiles = new ArrayList<>();
        Map<String, Integer> tileOf = new HashMap<>();

        JsonObject blocks = new JsonObject();
        JsonArray missing = new JsonArray();
        JsonArray untextured = new JsonArray();

        for (String id : ids) {
            ResourceLocation key = ResourceLocation.tryParse(id);
            Block block = key == null ? null : BuiltInRegistries.BLOCK.getOptional(key).orElse(null);
            if (block == null) {
                missing.add(id);
                continue;
            }
            BlockState state = block.defaultBlockState();
            BakedModel model = mc.getBlockRenderer().getBlockModel(state);

            JsonObject faces = new JsonObject();
            faces.addProperty("top", tileFor(mc, state, model, Direction.UP, random, tiles, tileOf));
            faces.addProperty("side", tileFor(mc, state, model, Direction.NORTH, random, tiles, tileOf));
            faces.addProperty("bottom", tileFor(mc, state, model, Direction.DOWN, random, tiles, tileOf));
            blocks.add(id, faces);
            if (faces.get("side").getAsInt() == NO_TILE) {
                untextured.add(id);
            }
        }

        int rows = Math.max(1, (tiles.size() + COLUMNS - 1) / COLUMNS);
        String png;
        try (NativeImage image = new NativeImage(COLUMNS * TILE, rows * TILE, false)) {
            for (int tile = 0; tile < tiles.size(); tile++) {
                int originX = (tile % COLUMNS) * TILE;
                int originY = (tile / COLUMNS) * TILE;
                int[] pixels = tiles.get(tile);
                for (int y = 0; y < TILE; y++) {
                    for (int x = 0; x < TILE; x++) {
                        image.setPixelRGBA(originX + x, originY + y, pixels[y * TILE + x]);
                    }
                }
            }
            png = Base64.getEncoder().encodeToString(image.asByteArray());
        }

        JsonObject out = new JsonObject();
        out.addProperty("tile", TILE);
        out.addProperty("columns", COLUMNS);
        out.addProperty("rows", rows);
        out.addProperty("tiles", tiles.size());
        out.addProperty("png", png);
        out.add("blocks", blocks);
        out.add("missing", missing);
        out.add("untextured", untextured);
        return out.toString();
    }

    /**
     * The tile index for one face of one block, cutting a new tile only if that sprite and tint
     * have not been seen.
     */
    private static int tileFor(Minecraft mc, BlockState state, BakedModel model, Direction face,
                               RandomSource random, List<int[]> tiles, Map<String, Integer> tileOf) {
        BakedQuad quad = quadFor(state, model, face, random);
        TextureAtlasSprite sprite = quad != null ? quad.getSprite() : model.getParticleIcon(ModelData.EMPTY);
        int tint = quad != null && quad.isTinted() ? tintOf(mc, state, quad.getTintIndex()) : NO_TINT;

        String name = sprite.contents().name().toString();
        if (MISSING_SPRITE.equals(name)) {
            return NO_TILE;
        }

        String key = name + "#" + tint;
        Integer known = tileOf.get(key);
        if (known != null) {
            return known;
        }
        int index = tiles.size();
        tiles.add(cut(sprite, tint));
        tileOf.put(key, index);
        return index;
    }

    /**
     * The quad that covers a face.
     *
     * <p>Culled quads come back from {@code getQuads(state, face, …)}, which is where a full cube
     * keeps its six sides. Models that are not cubes — a cross-shaped plant, most of Create —
     * carry theirs on the null direction instead, so those are searched for one pointing the right
     * way before giving up and letting the caller fall back to the particle icon.
     */
    private static BakedQuad quadFor(BlockState state, BakedModel model, Direction face, RandomSource random) {
        random.setSeed(42L);
        List<BakedQuad> culled = model.getQuads(state, face, random, ModelData.EMPTY, null);
        if (!culled.isEmpty()) {
            return culled.get(0);
        }
        random.setSeed(42L);
        for (BakedQuad quad : model.getQuads(state, null, random, ModelData.EMPTY, null)) {
            if (quad.getDirection() == face) {
                return quad;
            }
        }
        return null;
    }

    /**
     * The tint a block's colour handler would multiply over the texture.
     *
     * <p>Without it grass, leaves and water are the grey and colourless images they are stored as —
     * the green is a biome tint applied at render time, not a texture. Asked with no level and no
     * position, which vanilla handlers answer with their default colour; a modded one that does not
     * expect that is caught rather than allowed to take the whole export down.
     */
    private static int tintOf(Minecraft mc, BlockState state, int tintIndex) {
        try {
            int colour = mc.getBlockColors().getColor(state, null, null, tintIndex);
            return colour == -1 ? NO_TINT : colour & 0xffffff;
        } catch (RuntimeException e) {
            return NO_TINT;
        }
    }

    /**
     * One sprite as 16×16 pixels, tinted.
     *
     * <p>Nearest-neighbour, because a resource pack at 32 or 64 pixels should still land on the
     * grid the studio draws with, and because blurring Minecraft's pixels would be a strange thing
     * to do on purpose.
     */
    private static int[] cut(TextureAtlasSprite sprite, int tint) {
        var contents = sprite.contents();
        // The whole strip for an animated sprite; only the first frame is inside these bounds.
        NativeImage source = contents.originalImage;
        int width = contents.width();
        int height = contents.height();

        int[] pixels = new int[TILE * TILE];
        for (int y = 0; y < TILE; y++) {
            for (int x = 0; x < TILE; x++) {
                int sx = Math.min(width - 1, x * width / TILE);
                int sy = Math.min(height - 1, y * height / TILE);
                pixels[y * TILE + x] = tinted(source.getPixelRGBA(sx, sy), tint);
            }
        }
        return pixels;
    }

    /**
     * @param pixel a NativeImage pixel, which packs as {@code 0xAABBGGRR} — the bytes are RGBA in
     *              memory and the int is read back little-endian, so red is the low byte
     * @param tint  {@code 0xRRGGBB}, the way a block colour handler reports one
     */
    private static int tinted(int pixel, int tint) {
        if (tint == NO_TINT) {
            return pixel;
        }
        int r = (pixel & 0xff) * ((tint >> 16) & 0xff) / 255;
        int g = ((pixel >> 8) & 0xff) * ((tint >> 8) & 0xff) / 255;
        int b = ((pixel >> 16) & 0xff) * (tint & 0xff) / 255;
        return (pixel & 0xff000000) | (b << 16) | (g << 8) | r;
    }
}
