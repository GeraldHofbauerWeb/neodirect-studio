package net.geraldhofbauer.neodirect;

import com.mojang.logging.LogUtils;
import net.neoforged.bus.api.IEventBus;
import net.neoforged.fml.ModContainer;
import net.neoforged.fml.common.Mod;
import org.slf4j.Logger;

/**
 * NeoDirect — a director for scripted Minecraft tutorial recordings.
 *
 * <p>The mod plays back a timeline: it places blocks from a Create schematic in a didactic order,
 * flies the camera along keyframes, and fires presentation cues (held item, arm swing, sound,
 * particles) — all on a wall-clock schedule derived from pre-rendered narration durations.
 *
 * <p>Scope note: this is a recording tool for a local single-player instance. It is deliberately
 * not written for dedicated servers — the client and server halves talk through a shared in-JVM
 * queue ({@link net.geraldhofbauer.neodirect.client.ClientBridge}) rather than network payloads.
 */
@Mod(NeoDirect.MOD_ID)
public class NeoDirect {
    public static final String MOD_ID = "neodirect";
    public static final Logger LOGGER = LogUtils.getLogger();

    public NeoDirect(IEventBus modEventBus, ModContainer modContainer) {
        LOGGER.info("NeoDirect {} standing by.", modContainer.getModInfo().getVersion());
    }
}
