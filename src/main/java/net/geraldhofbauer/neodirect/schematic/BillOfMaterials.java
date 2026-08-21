package net.geraldhofbauer.neodirect.schematic;

import net.minecraft.core.HolderLookup;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.nbt.ListTag;
import net.minecraft.nbt.Tag;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * What a contraption is made of, counted from the schematic.
 *
 * <p>Counting beats listing. A materials chest written by hand in the script would drift out of
 * step the first time the build changes, and the drift would be invisible until somebody paused
 * the video and counted vaults.
 *
 * <p>Blocks alone are not the bill. Every deployer here carries a filter item in a slot of its
 * own — 84 configured for stone, one for rail — and a chest that omits those is everything except
 * the part that makes the machine do its job.
 */
public final class BillOfMaterials {

    /** A double chest is 54 slots, a single one 27. */
    public static final int SINGLE_CHEST_SLOTS = 27;
    public static final int DOUBLE_CHEST_SLOTS = 54;

    private BillOfMaterials() {
    }

    /**
     * Item stacks for the whole schematic, most numerous first, split at each item's stack limit.
     *
     * <p>Ordering matters for a tutorial shot: the viewer should see the bulk components first,
     * not a lone lever in the top-left corner.
     *
     * <p>Items are grouped by their {@link Item}, but each group keeps the first stack it saw as
     * its template, so a configured Create filter goes into the chest configured rather than
     * blank.
     */
    public static List<ItemStack> stacks(SchematicSource.Schematic schematic, HolderLookup.Provider registries) {
        return stacks(schematic, registries, java.util.Set.of());
    }

    /**
     * @param ignoreContentsOf block ids whose inventories are stock rather than building material.
     *                         A machine cloned off a running server arrives with its output still
     *                         in it, and a chest holding 1365 quartz would otherwise put the whole
     *                         warehouse in the materials chest and call it a building cost. Filters
     *                         and held items are unaffected — those are configuration, and a
     *                         deployer without its filter is not the same deployer.
     */
    public static List<ItemStack> stacks(SchematicSource.Schematic schematic,
                                         HolderLookup.Provider registries,
                                         java.util.Set<String> ignoreContentsOf) {
        Map<Item, Integer> counts = new LinkedHashMap<>();
        Map<Item, ItemStack> templates = new LinkedHashMap<>();

        for (SchematicSource.SchematicBlock block : schematic.blocks()) {
            Item item = block.state().getBlock().asItem();
            if (item != Items.AIR) {
                counts.merge(item, 1, Integer::sum);
                templates.putIfAbsent(item, new ItemStack(item));
            }
            String blockId = net.minecraft.core.registries.BuiltInRegistries.BLOCK
                    .getKey(block.state().getBlock()).toString();
            if (ignoreContentsOf.contains(blockId)) {
                continue;
            }
            for (ItemStack held : heldItems(block, registries)) {
                counts.merge(held.getItem(), held.getCount(), Integer::sum);
                templates.putIfAbsent(held.getItem(), held);
            }
        }

        List<Map.Entry<Item, Integer>> ordered = new ArrayList<>(counts.entrySet());
        ordered.sort(Comparator.<Map.Entry<Item, Integer>>comparingInt(Map.Entry::getValue).reversed());

        List<ItemStack> stacks = new ArrayList<>();
        for (Map.Entry<Item, Integer> entry : ordered) {
            ItemStack template = templates.get(entry.getKey());
            int remaining = entry.getValue();
            int limit = template.getMaxStackSize();
            while (remaining > 0) {
                int take = Math.min(remaining, limit);
                stacks.add(template.copyWithCount(take));
                remaining -= take;
            }
        }
        return stacks;
    }

    /**
     * Items a block entity holds in slots of its own.
     *
     * <p>Read structurally rather than from a list of known keys: anything that parses as an item
     * stack counts, and an {@code Items} list is walked. That way a schematic containing a block
     * this code has never heard of still contributes its contents.
     */
    private static List<ItemStack> heldItems(SchematicSource.SchematicBlock block, HolderLookup.Provider registries) {
        if (!block.hasBlockEntity()) {
            return List.of();
        }
        CompoundTag nbt = block.blockEntityNbt();
        List<ItemStack> out = new ArrayList<>();

        for (String key : nbt.getAllKeys()) {
            if (nbt.contains(key, Tag.TAG_COMPOUND)) {
                ItemStack.parse(registries, nbt.getCompound(key))
                        .filter(stack -> !stack.isEmpty())
                        .ifPresent(out::add);
            } else if (nbt.contains(key, Tag.TAG_LIST)) {
                ListTag list = nbt.getList(key, Tag.TAG_COMPOUND);
                for (int i = 0; i < list.size(); i++) {
                    ItemStack.parse(registries, list.getCompound(i))
                            .filter(stack -> !stack.isEmpty())
                            .ifPresent(out::add);
                }
            }
        }
        return out;
    }
}
