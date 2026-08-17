package net.geraldhofbauer.neodirect.client;

import net.geraldhofbauer.neodirect.NeoDirect;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.screens.TitleScreen;
import net.minecraft.core.RegistryAccess;
import net.minecraft.core.registries.Registries;
import net.minecraft.world.Difficulty;
import net.minecraft.world.level.GameRules;
import net.minecraft.world.level.GameType;
import net.minecraft.world.level.LevelSettings;
import net.minecraft.world.level.WorldDataConfiguration;
import net.minecraft.world.level.levelgen.WorldDimensions;
import net.minecraft.world.level.levelgen.WorldOptions;
import net.minecraft.world.level.levelgen.presets.WorldPreset;
import net.minecraft.world.level.levelgen.presets.WorldPresets;
import net.neoforged.api.distmarker.Dist;
import net.neoforged.bus.api.SubscribeEvent;
import net.neoforged.fml.common.EventBusSubscriber;
import net.neoforged.neoforge.client.event.ClientTickEvent;


/**
 * Creates and opens the recording world on startup, when launched with
 * {@code -Dneodirect.autoworld=true}.
 *
 * <p>Two reasons this exists rather than being a manual click-through. Reproducibility: every
 * episode should be shot in an identical world — flat, creative, peaceful, midday, no weather, no
 * mobs, no daylight cycle — and "identical" is not something a human clicking World Creation
 * reliably produces. And practicality: it makes the whole recording pipeline runnable from a
 * script, which is the point of the pipeline.
 *
 * <p>The world is created once and reopened on every later launch, so a take can build on the
 * previous one, and a botched world can simply be deleted from {@code run/saves/}.
 */
@EventBusSubscriber(modid = NeoDirect.MOD_ID, value = Dist.CLIENT)
public final class StudioWorld {

    public static final String LEVEL_ID = "neodirect-studio";

    private StudioWorld() {
    }

    private static boolean done;

    @SubscribeEvent
    public static void onClientTick(ClientTickEvent.Post event) {
        if (done || !Boolean.getBoolean("neodirect.autoworld")) {
            return;
        }
        Minecraft mc = Minecraft.getInstance();
        // Wait for the title screen: before that the level storage source and pack repository are
        // not necessarily ready.
        if (!(mc.screen instanceof TitleScreen)) {
            return;
        }
        done = true;

        // A single-player integrated server stops ticking whenever a pause screen is up, and by
        // default losing window focus opens one. During a take that silently freezes the timeline
        // — the first run of this prototype lost 32 seconds to exactly that.
        mc.options.pauseOnLostFocus = false;

        try {
            if (levelExists(mc)) {
                NeoDirect.LOGGER.info("Opening existing studio world '{}'.", LEVEL_ID);
                mc.createWorldOpenFlows().openWorld(LEVEL_ID,
                        () -> NeoDirect.LOGGER.error("Could not open studio world '{}'.", LEVEL_ID));
            } else {
                NeoDirect.LOGGER.info("Creating studio world '{}'.", LEVEL_ID);
                mc.createWorldOpenFlows().createFreshLevel(
                        LEVEL_ID, settings(), new WorldOptions(0L, false, false),
                        StudioWorld::flatDimensions, mc.screen);
            }
        } catch (RuntimeException e) {
            NeoDirect.LOGGER.error("Studio world setup failed", e);
        }
    }

    private static boolean levelExists(Minecraft mc) {
        return mc.getLevelSource().levelExists(LEVEL_ID);
    }

    private static WorldDimensions flatDimensions(RegistryAccess registries) {
        WorldPreset flat = registries.registryOrThrow(Registries.WORLD_PRESET)
                .getHolderOrThrow(WorldPresets.FLAT)
                .value();
        return flat.createWorldDimensions();
    }

    /**
     * Deliberately boring: nothing in this world may move on its own, or two takes of the same
     * scene would not be comparable.
     */
    private static LevelSettings settings() {
        GameRules rules = new GameRules();
        rules.getRule(GameRules.RULE_DAYLIGHT).set(false, null);
        rules.getRule(GameRules.RULE_WEATHER_CYCLE).set(false, null);
        rules.getRule(GameRules.RULE_DOMOBSPAWNING).set(false, null);
        rules.getRule(GameRules.RULE_DO_TRADER_SPAWNING).set(false, null);
        rules.getRule(GameRules.RULE_DOFIRETICK).set(false, null);
        rules.getRule(GameRules.RULE_MOBGRIEFING).set(false, null);
        rules.getRule(GameRules.RULE_DOENTITYDROPS).set(false, null);
        rules.getRule(GameRules.RULE_SHOWDEATHMESSAGES).set(false, null);
        rules.getRule(GameRules.RULE_SENDCOMMANDFEEDBACK).set(false, null);
        rules.getRule(GameRules.RULE_LOGADMINCOMMANDS).set(false, null);

        return new LevelSettings(
                LEVEL_ID,
                GameType.CREATIVE,
                false,
                Difficulty.PEACEFUL,
                true,
                rules,
                WorldDataConfiguration.DEFAULT);
    }
}
