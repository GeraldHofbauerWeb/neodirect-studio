package net.geraldhofbauer.neodirect.schematic;

import net.minecraft.core.BlockPos;
import net.minecraft.core.Vec3i;
import net.minecraft.core.HolderGetter;
import net.minecraft.core.registries.Registries;
import net.minecraft.resources.ResourceKey;
import net.minecraft.resources.ResourceLocation;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.nbt.ListTag;
import net.minecraft.nbt.NbtAccounter;
import net.minecraft.nbt.NbtIo;
import net.minecraft.nbt.NbtUtils;
import net.minecraft.nbt.Tag;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.Vec3;

import java.io.IOException;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

/**
 * Reads a Create schematic.
 *
 * <p>Create writes plain <em>vanilla structure NBT</em> — verified against the pilot file: the same
 * {@code size} / {@code palette} / {@code blocks} / {@code entities} layout vanilla structure blocks
 * use. That is why this needs no Create API at all, and why block states and block-entity data
 * (rail shape, chassis axis, drill and deployer facing, deployer filters) come across for free
 * instead of having to be hand-maintained in the script.
 *
 * <p>We read the NBT ourselves rather than going through {@code StructureTemplate}, because the
 * director places blocks one at a time on a schedule — it needs an indexable list, not a
 * place-it-all-at-once call.
 */
public final class SchematicSource {

    private SchematicSource() {
    }

    /** The names a structure file uses for genuinely empty space. */
    private static final java.util.Set<String> AIR_NAMES =
            java.util.Set.of("minecraft:air", "minecraft:cave_air", "minecraft:void_air");

    /** One block of the schematic, in schematic-relative coordinates. */
    public record SchematicBlock(BlockPos relPos, BlockState state, CompoundTag blockEntityNbt) {
        public boolean hasBlockEntity() {
            return blockEntityNbt != null && !blockEntityNbt.isEmpty();
        }
    }

    /**
     * One entity of the schematic. {@code relPos} is schematic-relative; the {@code nbt}'s own
     * {@code Pos} is the world position it was copied from and must be overwritten on placement.
     *
     * <p>For this pilot the entities are the 14 {@code create:super_glue} bonds that make the
     * contraption assemblable, plus a furnace minecart. Super glue carries its bounding box as
     * {@code From}/{@code To} offsets relative to the entity itself, so those need no translating.
     */
    public record SchematicEntity(Vec3 relPos, CompoundTag nbt) {
        public String id() {
            return nbt.getString("id");
        }
    }

    /**
     * Everything a schematic holds: blocks in placement order, entities, and the names of any
     * blocks the running game does not know.
     *
     * <p>{@code unknownBlocks} exists because the failure it describes is otherwise invisible.
     * {@code NbtUtils.readBlockState} answers "air" for a block whose mod is missing, which is
     * indistinguishable from a genuinely empty palette entry — so a schematic built in the modpack
     * would quietly lose blocks in the recording instance and still report a perfect match.
     */
    public record Schematic(List<SchematicBlock> blocks,
                            List<SchematicEntity> entities,
                            List<String> unknownBlocks,
                            BlockPos sourceOrigin,
                            Vec3i sourceSize) {

        public Schematic(List<SchematicBlock> blocks,
                         List<SchematicEntity> entities,
                         List<String> unknownBlocks) {
            this(blocks, entities, unknownBlocks, null, Vec3i.ZERO);
        }
    }

    /**
     * Loads all blocks of a schematic, ordered bottom-up then by distance from the corner. That is
     * only a stable default — a script addresses blocks by index, so the didactic order is chosen
     * by whoever writes the timeline.
     */
    public static Schematic load(Path file, HolderGetter<Block> blockLookup) throws IOException {
        CompoundTag root = readNbt(file);

        ListTag palette = readPalette(root);
        List<BlockState> states = new ArrayList<>(palette.size());
        // Whether a palette entry is worth placing is decided by its *name*, not by whether the
        // state it resolves to reports itself as air. Create's crushing wheel controller — the
        // invisible block that sits between the two wheels and does the actual crushing — is
        // air-like, and dropping it leaves a crusher that looks perfect and grinds nothing. The
        // verifier would have agreed with it, because a block never loaded is a block never
        // compared. Genuine air in a structure file is named air; that is the thing to skip.
        boolean[] placeable = new boolean[palette.size()];
        List<String> unknown = new ArrayList<>();
        for (int i = 0; i < palette.size(); i++) {
            CompoundTag entry = palette.getCompound(i);
            String name = entry.getString("Name");
            placeable[i] = !AIR_NAMES.contains(name);
            // Ask the registry ourselves, because readBlockState cannot tell us it failed.
            ResourceLocation id = ResourceLocation.tryParse(name);
            if (id != null && placeable[i]
                    && blockLookup.get(ResourceKey.create(Registries.BLOCK, id)).isEmpty()) {
                unknown.add(name);
                // A block whose mod is absent resolves to air and would be placed as air. Nothing
                // useful comes of that; it is reported instead.
                placeable[i] = false;
            }
            states.add(NbtUtils.readBlockState(blockLookup, entry));
        }

        ListTag blocks = root.getList("blocks", Tag.TAG_COMPOUND);
        List<SchematicBlock> out = new ArrayList<>(blocks.size());
        for (int i = 0; i < blocks.size(); i++) {
            CompoundTag entry = blocks.getCompound(i);
            ListTag pos = entry.getList("pos", Tag.TAG_INT);
            if (pos.size() != 3) {
                continue;
            }
            int stateIndex = entry.getInt("state");
            if (stateIndex < 0 || stateIndex >= states.size()) {
                continue;
            }
            if (!placeable[stateIndex]) {
                continue;
            }
            BlockState state = states.get(stateIndex);
            CompoundTag beNbt = entry.contains("nbt", Tag.TAG_COMPOUND) ? entry.getCompound("nbt") : null;
            out.add(new SchematicBlock(new BlockPos(pos.getInt(0), pos.getInt(1), pos.getInt(2)), state, beNbt));
        }

        out.sort((a, b) -> {
            int byY = Integer.compare(a.relPos().getY(), b.relPos().getY());
            if (byY != 0) {
                return byY;
            }
            int byZ = Integer.compare(a.relPos().getZ(), b.relPos().getZ());
            return byZ != 0 ? byZ : Integer.compare(a.relPos().getX(), b.relPos().getX());
        });

        BlockPos sourceOrigin = null;
        if (root.contains("neodirect:sourceOrigin", Tag.TAG_LIST)) {
            ListTag origin = root.getList("neodirect:sourceOrigin", Tag.TAG_INT);
            if (origin.size() == 3) {
                sourceOrigin = new BlockPos(origin.getInt(0), origin.getInt(1), origin.getInt(2));
            }
        }
        ListTag sizeTag = root.getList("size", Tag.TAG_INT);
        Vec3i size = sizeTag.size() == 3
                ? new Vec3i(sizeTag.getInt(0), sizeTag.getInt(1), sizeTag.getInt(2))
                : Vec3i.ZERO;
        return new Schematic(List.copyOf(out), readEntities(root), List.copyOf(unknown), sourceOrigin, size);
    }

    private static List<SchematicEntity> readEntities(CompoundTag root) {
        ListTag entities = root.getList("entities", Tag.TAG_COMPOUND);
        List<SchematicEntity> out = new ArrayList<>(entities.size());
        for (int i = 0; i < entities.size(); i++) {
            CompoundTag entry = entities.getCompound(i);
            ListTag pos = entry.getList("pos", Tag.TAG_DOUBLE);
            if (pos.size() != 3 || !entry.contains("nbt", Tag.TAG_COMPOUND)) {
                continue;
            }
            out.add(new SchematicEntity(
                    new Vec3(pos.getDouble(0), pos.getDouble(1), pos.getDouble(2)),
                    entry.getCompound("nbt")));
        }
        return List.copyOf(out);
    }

    /**
     * Structure NBT has two palette spellings: a single {@code palette}, or {@code palettes} — a
     * list of alternative palettes — when the file was written with variants. Create writes the
     * singular form; we accept both so a hand-exported structure block file also works.
     */
    private static ListTag readPalette(CompoundTag root) {
        if (root.contains("palette", Tag.TAG_LIST)) {
            return root.getList("palette", Tag.TAG_COMPOUND);
        }
        if (root.contains("palettes", Tag.TAG_LIST)) {
            ListTag palettes = root.getList("palettes", Tag.TAG_LIST);
            if (!palettes.isEmpty()) {
                return (ListTag) palettes.get(0);
            }
        }
        throw new IllegalArgumentException("no 'palette' or 'palettes' in schematic — is this a structure NBT file?");
    }

    /** Create gzips its schematics, but a plain structure file may not be. Accept either. */
    private static CompoundTag readNbt(Path file) throws IOException {
        try {
            return NbtIo.readCompressed(file, NbtAccounter.unlimitedHeap());
        } catch (IOException gzipFailed) {
            try {
                return NbtIo.read(file);
            } catch (IOException plainFailed) {
                plainFailed.addSuppressed(gzipFailed);
                throw plainFailed;
            }
        }
    }
}
