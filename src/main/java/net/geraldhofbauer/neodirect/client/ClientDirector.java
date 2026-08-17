package net.geraldhofbauer.neodirect.client;

import net.geraldhofbauer.neodirect.NeoDirect;
import net.geraldhofbauer.neodirect.timeline.CameraPath;
import net.minecraft.client.Minecraft;
import net.minecraft.client.Screenshot;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.phys.Vec3;
import net.neoforged.api.distmarker.Dist;
import net.neoforged.bus.api.SubscribeEvent;
import net.neoforged.fml.common.EventBusSubscriber;
import net.neoforged.neoforge.client.event.ClientTickEvent;
import net.neoforged.neoforge.client.event.MovementInputUpdateEvent;

import java.io.File;

/**
 * The client half of a take: camera pose, arm swing, and keeping the human's keyboard out of it.
 *
 * <p>The camera is the player, not a spectator and not a detached camera entity. That is a
 * deliberate choice and the reason the prototype can answer its question at all: in spectator mode
 * Minecraft renders neither the held item nor the hand, so the entire "someone is building this"
 * layer would be impossible to test. Driving the player in creative flight keeps the first-person
 * hand — and keeps it correctly aligned with the view, since the hand follows the same rotation
 * the camera reads.
 *
 * <p>Smoothness comes for free from vanilla: {@code Camera#setup} interpolates between
 * {@code entity.xo/yo/zo} and the current position by the frame's partial tick, and likewise for
 * rotation. So writing the previous pose into those fields before each tick's update is all it
 * takes for the motion to be smooth at any framerate — no per-frame event hook needed.
 */
@EventBusSubscriber(modid = NeoDirect.MOD_ID, value = Dist.CLIENT)
public final class ClientDirector {

    private ClientDirector() {
    }

    private static boolean running;
    private static CameraRig rig;

    /** What the player's flight/physics looked like before we took over, so we can hand it back. */
    private static boolean restoreNoPhysics;

    @SubscribeEvent
    public static void onClientTick(ClientTickEvent.Post event) {
        Minecraft mc = Minecraft.getInstance();
        LocalPlayer player = mc.player;
        if (player == null) {
            return;
        }

        ClientBridge.Command command;
        while ((command = ClientBridge.poll()) != null) {
            handle(command, player);
        }

        if (running) {
            // Handing the player a block unlocks its recipe, which pops a "New Recipes Unlocked!"
            // toast over the top-right of the shot. Nothing may overlay a take, so the toast queue
            // is emptied every tick while one is running.
            mc.getToasts().clear();
            if (rig != null) {
                applyPose(player, rig.sample());
            }
        }

        grabScreenshotIfRequested(mc);
    }

    private static void grabScreenshotIfRequested(Minecraft mc) {
        var pending = Screenshots.take();
        if (pending == null) {
            return;
        }
        try {
            String name = "neodirect-" + mc.level.getGameTime() + ".png";
            Screenshot.grab(mc.gameDirectory, name, mc.getMainRenderTarget(), message -> {
            });
            pending.complete(new File(new File(mc.gameDirectory, "screenshots"), name).getAbsolutePath());
        } catch (RuntimeException e) {
            pending.completeExceptionally(e);
        }
    }

    /** While the director has the camera, the keyboard must not fight it. */
    @SubscribeEvent
    public static void onMovementInput(MovementInputUpdateEvent event) {
        if (!running) {
            return;
        }
        var input = event.getInput();
        input.forwardImpulse = 0.0F;
        input.leftImpulse = 0.0F;
        input.up = false;
        input.down = false;
        input.left = false;
        input.right = false;
        input.jumping = false;
        input.shiftKeyDown = false;
    }

    private static void handle(ClientBridge.Command command, LocalPlayer player) {
        if (command instanceof ClientBridge.Command.BeginRun begin) {
            beginRun(player, begin);
        } else if (command instanceof ClientBridge.Command.MoveCamera move) {
            rig = new CameraRig(move.keyframes(), move.durationMs());
        } else if (command instanceof ClientBridge.Command.Swing) {
            // Has to happen here rather than server-side: the server never echoes an animate packet
            // back to the player who caused it, so a server-side swing would animate every view
            // except the one being filmed.
            player.swing(InteractionHand.MAIN_HAND);
        } else if (command instanceof ClientBridge.Command.EndRun) {
            endRun(player);
        }
    }

    private static void beginRun(LocalPlayer player, ClientBridge.Command.BeginRun begin) {
        running = true;
        rig = null;

        restoreNoPhysics = player.noPhysics;
        player.getAbilities().flying = true;
        player.noPhysics = true;

        applyPose(player, new CameraPath.Pose(
                new Vec3(begin.x(), begin.y(), begin.z()), begin.yaw(), begin.pitch()));
        // Frame one must already be in place, so the opening pose is not something we lerp into
        // from wherever the player happened to stand.
        player.xo = player.getX();
        player.yo = player.getY();
        player.zo = player.getZ();
        player.yRotO = player.getYRot();
        player.xRotO = player.getXRot();

        NeoDirect.LOGGER.info("Camera under director control.");
    }

    private static void endRun(LocalPlayer player) {
        running = false;
        rig = null;
        // Input control goes back to the human, but the camera keeps hovering where the take ended.
        // Restoring gravity here would drop the player to the ground during OBS's trailing seconds
        // and put a fall in the last frames of every recording.
        player.getAbilities().flying = true;
        player.noPhysics = restoreNoPhysics;
        player.setDeltaMovement(Vec3.ZERO);
        NeoDirect.LOGGER.info("Camera released, holding final pose.");
    }

    private static void applyPose(LocalPlayer player, CameraPath.Pose pose) {
        player.xo = player.getX();
        player.yo = player.getY();
        player.zo = player.getZ();
        player.yRotO = player.getYRot();
        player.xRotO = player.getXRot();

        // Keyframes are written as camera positions, which is what a script author thinks in.
        // The player entity sits an eye height below that.
        double eyeOffset = player.getEyeY() - player.getY();
        player.setPos(pose.position().x, pose.position().y - eyeOffset, pose.position().z);
        player.setYRot(pose.yaw());
        player.setXRot(pose.pitch());
        player.setYHeadRot(pose.yaw());
        player.setDeltaMovement(Vec3.ZERO);
        player.fallDistance = 0.0F;
    }
}
