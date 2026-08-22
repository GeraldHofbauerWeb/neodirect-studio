package net.geraldhofbauer.neodirect.client;

import net.geraldhofbauer.neodirect.NeoDirect;
import net.geraldhofbauer.neodirect.timeline.CameraPath;
import net.minecraft.client.Minecraft;
import net.minecraft.client.Screenshot;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.entity.Pose;
import net.minecraft.world.phys.Vec3;
import net.neoforged.api.distmarker.Dist;
import net.neoforged.bus.api.SubscribeEvent;
import net.neoforged.fml.common.EventBusSubscriber;
import net.neoforged.neoforge.client.event.ClientTickEvent;
import net.neoforged.neoforge.client.event.MovementInputUpdateEvent;
import net.neoforged.neoforge.event.tick.PlayerTickEvent;

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

    /**
     * Whether the camera is being held on a pose outside a take.
     *
     * <p>Composing a shot is the same problem as flying one: the moment the body is solid again
     * the server pushes it out of the machine it was standing in, and the frame the studio shows
     * is not the frame the take will record. So a parked camera keeps the filming body until
     * something releases it — a take starting, or the studio saying so.
     */
    private static boolean parked;

    /**
     * The camera's body while filming: 0.6 blocks cubed instead of 0.6 by 1.8, with the eye 0.4
     * off the floor of it rather than 1.62.
     *
     * <p>A standing player hangs more than a block and a half below the point the script calls the
     * camera, so a shot composed to sit in a one-block gap inside a machine puts the body in the
     * stone underneath it. This is the same trick a crawling mod uses, through the API NeoForge
     * provides for it, and it is why the eye height in {@link #applyPose} is read from the player
     * rather than assumed — the arithmetic follows the pose without being told.
     */
    private static final Pose FILMING_POSE = Pose.SWIMMING;

    /**
     * Holds the camera intangible, every tick, for as long as a take is running.
     *
     * <p>Setting {@code noPhysics} once at the start of a run does nothing: {@code Player#tick}
     * assigns {@code this.noPhysics = this.isSpectator()} unconditionally at the top of every
     * tick, on both sides, so outside spectator mode the flag is gone again a twentieth of a
     * second later. This runs after that assignment and puts it back.
     *
     * <p>Its twin on the server is what actually stops the stutter — see
     * {@code Director#holdCameraIntangible}. This side matters for the pose, and for the
     * client's own habit of shoving a solid player out of a wall.
     */
    @SubscribeEvent
    public static void onPlayerTick(PlayerTickEvent.Post event) {
        if ((!running && !parked) || !(event.getEntity() instanceof LocalPlayer player)) {
            return;
        }
        player.noPhysics = true;
        if (player.getForcedPose() != FILMING_POSE) {
            player.setForcedPose(FILMING_POSE);
        }
    }

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

        // Handing the player a block unlocks its recipe, which pops a "New Recipes Unlocked!" toast
        // over the top-right of the shot. Emptied every tick, running or not: the recorder starts a
        // second and a half before the take does, and a toast raised by whatever ran last — the
        // clear pass, say — was still on screen for the opening frames of the episode. This client
        // exists to record; there is no moment in it when a toast is wanted.
        mc.getToasts().clear();

        if (running) {
            parkCursor(mc);
            if (rig != null) {
                applyPose(player, rig.sample());
            }
        }

        grabScreenshotIfRequested(mc);
    }

    /**
     * Moves the mouse out of the shot whenever a take has a screen open.
     *
     * <p>Minecraft draws a tooltip under the pointer, and the pointer is wherever the person who
     * started the take happened to leave it. A materials chest opened on camera came out with
     * "Large Cogwheel — Hold [W] to Ponder" floating across the middle of it, which is not
     * something a viewer is meant to see and not something anybody would think to check.
     *
     * <p>Only while a screen is up. With none open the cursor is grabbed for looking, and nudging
     * it there would turn the camera for a frame before the next tick puts the rotation back.
     */
    private static void parkCursor(Minecraft mc) {
        if (mc.screen == null || mc.getWindow() == null) {
            return;
        }
        // Minecraft's own pointer, not the operating system's. glfwSetCursorPos was the obvious
        // way to do this and it silently does nothing: GLFW only honours it for a window with
        // input focus, and the studio window rarely has focus while a take is running — the
        // tooltip came out in the recording anyway. These two fields are opened by the access
        // transformer for exactly this.
        mc.mouseHandler.xpos = 0.0;
        mc.mouseHandler.ypos = 0.0;
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
        } else if (command instanceof ClientBridge.Command.SetPose set) {
            if (set.hold() && !running) {
                restoreNoPhysics = parked ? restoreNoPhysics : player.noPhysics;
                parked = true;
                player.getAbilities().flying = true;
            } else if (!set.hold()) {
                parked = false;
                player.noPhysics = restoreNoPhysics;
                player.setForcedPose(null);
            }
            applyPose(player, new CameraPath.Pose(
                    new Vec3(set.x(), set.y(), set.z()), set.yaw(), set.pitch()));
        } else if (command instanceof ClientBridge.Command.MoveCamera move) {
            rig = new CameraRig(move.keyframes(), move.durationMs(), move.linear());
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
        // A take may start while the studio has the camera parked on a keyframe. What the player
        // had before *that* is what gets handed back at the end, so the parked state is not
        // captured as though it were the human's own.
        if (!parked) {
            restoreNoPhysics = player.noPhysics;
        }
        parked = false;
        running = true;
        rig = null;

        player.getAbilities().flying = true;
        player.noPhysics = true;
        player.setForcedPose(FILMING_POSE);

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
        player.setForcedPose(null);
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
