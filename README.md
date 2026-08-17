# NeoDirect

**A director for scripted Minecraft tutorial recordings.**

A timeline drives block placement, camera moves and presentation cues on a wall clock derived from
pre-rendered narration, so an episode is *reproducible*. Change a sentence, re-render that line,
re-run the take — and the build, the camera and the subtitles all follow. Nothing is performed by
hand, so nothing has to be performed again.

NeoForge 1.21.1 · Java 21 · Create 6.0.10 · MIT licensed · runs only in a local recording instance.

---

## Why it exists

Recording a build tutorial by hand is a performance: you fly the camera, you place the blocks, you
talk, and if the fourth sentence is wrong you do the whole thing again. Every retake is a fresh
performance, so nothing is ever quite the same twice.

This inverts that. The episode is a document — beats of narration, and a storyboard saying what
happens *inside* each beat. The narration is rendered once and measured; the measurements produce
a timeline; the game plays the timeline back while a recorder runs. A rewritten sentence is a
re-render of one line and another pass, not another performance.

The prototype had one question to answer: does server-side block placement read as a **tutorial**
or as a **magic trick**? Two takes of the same 30-second scene — identical camera, identical
timing, identical blocks — differing only in the presentation layer:

| | `script/pilot-a.json` | `script/pilot-b.json` |
|---|---|---|
| camera, timing, blocks | identical | identical |
| held item, arm swing, place sound, particles | off | on |

It reads as a tutorial, and the reason is a detail that contradicted the initial assumption:
`player.swing()` **does** animate the first-person arm, so a server-side placement can still have a
hand attached to it. That only works because the camera is the player in creative flight — a
spectator renders neither the hand nor the held item.

## What it produces

A single 2:42 episode building a Create mining train, from an empty flat world to a glued,
complete contraption: narration by ElevenLabs, subtitles from the same character alignment that
timed the beats, and 270 blocks placed in didactic order.

Every take is checked against the schematic when it finishes:

```
blocks: 270/270 match  missing 0  wrong state 0
  create:super_glue: 14/14
  minecraft:furnace_minecart: 1/1
loose items on the ground: 0
camera paths: clear

OK — the world matches the schematic
```

"It should look exactly like the schematic" is a property, not an impression, so it is machine-
checked rather than eyeballed. So is "the camera does not fly through a wall", which is not
something you reliably catch by watching.

## Requirements

| | |
|---|---|
| Java 21 | the toolchain Gradle resolves against |
| Node 22+ | the tools use the built-in `fetch` and `WebSocket`, no npm dependencies at all |
| ffmpeg | duration measurement and muxing |
| OBS 28+ | recording, over the built-in obs-websocket |
| ElevenLabs API key | narration; optional if you bring your own audio |
| Create 6.0.10 | plus whatever else your schematic touches — see below |

**Mod jars are not in this repository.** Drop them into `libs/` yourself:

```
libs/create-1.21.1-6.0.10.jar
libs/create-nested/flywheel-neoforge-1.21.1-1.0.6.jar
libs/create-nested/ponder-neoforge-1.0.81+mc1.21.1.jar
libs/create-nested/Registrate-MC1.21-1.3.0+67.jar
libs/Quark-4.1-477.jar          # only because this schematic contains a quark:oak_chest
libs/Zeta-1.1-40.jar            # Quark's dependency
```

Create ships Flywheel, Ponder and Registrate as jar-in-jar; extract them into `libs/create-nested/`
(they are plain zip entries). The recording instance needs **every mod your schematic touches** —
see the field note about blocks silently becoming air.

## Quick start

```bash
./gradlew installPilotSchematic     # schematics/ -> runs/client/schematics/
./gradlew runClient                 # creates and opens the studio world by itself

curl 127.0.0.1:8777/health          # is the director up?

QT_QPA_PLATFORM=xcb obs &           # the platform variable is not optional, see Recording
node tools/obs-setup.mjs            # scene, source, 1920x1080@60, x264
node tools/take.mjs script/pilot-b.json --capture obs
```

`runClient` *is* the recording instance: Create plus NeoDirect, no modpack ballast, a flat creative
world with the daylight cycle, weather and mob spawning switched off, and the pause-on-lost-focus
option disabled so the take does not freeze when the window loses focus.

Credentials are read from `~/.config/neodirect/` — `obs.env` and `elevenlabs.env`, both `chmod 600`.

## The loop

```bash
node tools/render-voice.mjs render script/pilot.beats.json          # measure every beat
node tools/render-voice.mjs render script/pilot.beats.json b0       # …or re-speak just one
node tools/make-timeline.mjs script/episode.storyboard.json script/episode.json
node tools/take.mjs script/episode.json --capture obs --voice out/voice/narration.mp3
node tools/verify.mjs script/episode.json
```

Three files, in order of authority:

**`script/pilot.beats.json`** — the narration, one entry per beat, plus the duration ElevenLabs
actually produced. Text-to-speech is not deterministic, so `render` takes an optional beat id and
re-speaks only that beat, rebuilding the offsets and subtitles for the rest from the alignments it
keeps beside each mp3. Fixing one sentence otherwise rerolls every other beat's phrasing and
length for nothing.

**`script/episode.storyboard.json`** — what happens *inside* a beat, written as a fraction of it:
"at 0.28 of the closing beat, the vaults go down". Fractions rather than timestamps, because the
timestamps are not knowable until the audio comes back.

**`script/episode.json`** — generated, never hand-edited. The storyboard resolved against the
measured narration into absolute milliseconds.

### Phrasing is measurable

`render` prints every pause over 300 ms with the words on either side:

```
b0: 23917 ms (estimate 24000 ms, -83)  -> out/voice/b0.mp3
       441 ms pause after "…achine is made of." before "All of it fits in…"
       696 ms pause after "…k before we start." before "A hundred and eigh…"
```

Two things are worth knowing here. ElevenLabs returns a *contiguous* timeline: silence is held
**by** a space or a comma, not left as a gap between two characters — so measuring the gaps between
characters finds nothing at all in a beat that pauses eight times. And a comma is not a pause: the
voice used here barely pauses at one (150 ms) and reliably pauses at a full stop (450–700 ms), so a
break the script needs has to be a sentence boundary rather than punctuation inside a sentence.

## Cue reference

Every cue carries an `atMs`; the storyboard generator fills it in from `beat` + `at`.

| type | what it does |
|---|---|
| `place` | put schematic blocks into the world, with the held item, arm swing, sound and particles |
| `camera` | fly keyframes over `durationMs` |
| `entities` | spawn the schematic's entities — for a Create contraption, the super glue |
| `materialsChest` | set down a chest holding the whole bill of materials, counted from the schematic |
| `fill` | put specific items into a container that is part of the build |
| `showFilter` | hold up a block's filter and open it, so the camera can read what the machine accepts |
| `screen` | open or close a container's screen on camera |
| `marker` | a no-op that shows up in the take log, for lining video up against narration |

### Naming blocks

A `place` cue's `blocks` field accepts several shapes, because a tutorial says "the same drill
across the whole face", not "blocks 118 through 171":

| | |
|---|---|
| `[11, 12, 13]` | explicit indices, for the blocks a beat actually talks about |
| `{"from": 0, "to": 40}` | a range |
| `{"ofType": "create:deployer"}` | every block of a type, in the schematic's own order |
| `"rest"` | everything no earlier cue has claimed |
| `{"rest": true, "except": ["create:item_vault"]}` | …minus types a later beat is built around |
| `"all"` | everything |

The exception list earns its keep. "Everything else now" and "the storage goes on last" are both
true of the same script, and without a way to say the first while holding back the second, the
sweep-up cue wins silently: the vaults went down during the chest beat, walling off the middle of
the machine, while the closing beat that was supposed to place them set blocks that already stood
there. Nothing looks wrong in a log where every cue ran. Holding a type back is therefore paired
with a warning at load time naming any block that no cue places, so excluding something and then
forgetting to place it is loud rather than invisible.

`camera` cues carry keyframes and a duration; `tools/aim.mjs` turns "camera here, looking at there"
into the yaw/pitch a keyframe needs. Everything is scheduled against a wall clock, because the
narration and the recorder are on wall clocks too — counting ticks would drift the moment the game
stutters.

## How it fits together

**Control server** — `127.0.0.1:8777`, built on the JDK's own `com.sun.net.httpserver`, so the mod
ships with zero dependencies and no classpath risk inside the mod loader.

| endpoint | |
|---|---|
| `GET /health` | up? take running? plus the client's pid, which is how the capture tools find the right window |
| `POST /run` | body is a timeline; responds when the take finishes, with every cue's planned vs. actual millisecond |
| `GET /screenshot` | grabs the game's own framebuffer |
| `POST /verify` | same timeline body; compares the built world against the schematic |

**Director** (server side) — flattens cues into a time-ordered list of steps and runs them off
`ServerTickEvent`. One `place` cue becomes up to three steps — equip, swing, set — because that is
the sequence a human hand performs, and the illusion lives entirely in that ordering. The clock
starts on the first server tick rather than at submit time: an integrated server does not tick
while the client is still loading terrain, and a clock started too early makes every cue in the
take come due at once the moment ticking resumes.

**Client** — camera, arm swing and keyboard suppression. The camera is the player in creative
flight; smoothness is vanilla's, since `Camera#setup` interpolates between `entity.xo/yo/zo` and the
current position by partial tick, so writing the previous pose before each tick's update is all a
smooth 200 fps pan requires. Positions follow a Catmull-Rom spline with smoothstep easing.

**Schematic** — Create writes plain vanilla structure NBT, so `SchematicSource` reads it with
`NbtUtils.readBlockState` and needs no Create API at all. Block states *and* block-entity data come
across for free: rail shape, chassis axis, drill and deployer facing, deployer filters. The
`entities` list carries the 14 `create:super_glue` bonds — without them the assembler has nothing to
pick up — plus a furnace minecart.

`schematics/mining_drill_1.nbt` is *not* a raw export. It is an export plus the edits recorded in
`schematics/edits.json` and replayed by `tools/schematic_edit.py`; the original in the modpack
instance is only ever read from. Keeping the edits as data rather than as a one-off script is the
difference between a derived asset and a mystery file.

**Materials chest** — a `materialsChest` cue places a chest holding the whole bill of materials,
counted from the schematic rather than listed in the script, so it cannot drift out of step with
the build it supplies. That count includes items held *inside* block entities, which is how the 85
configured deployer filters made it into the chest — they go in configured, not blank. A `screen`
cue then opens it on camera, so the viewer reads the stack counts off the real inventory instead of
being told them. For this contraption the whole bill is 14 stacks: 108 item vaults, 85 deployers,
54 drills, 16 chassis, and a handful of singles.

**Verifier** — block states compared exactly, entity counts per type, loose item entities (litter
means a block entity was destroyed and spilled its inventory), unknown block names, and camera
clearance. The clearance check samples the **curve**, not the keyframes: Catmull-Rom passes through
every keyframe but bows outward between them, so a path whose every waypoint sits clear of the
build can still bulge into the drill face — which is exactly how one shot ended up glitching
through it. `CameraPath` is shared between the client that flies the move and the verifier that
checks it, so a shot cannot pass the check and then fly something else.

## Tools

| | |
|---|---|
| `tools/take.mjs` | the full pipeline: record → run → stop → rename → mux narration |
| `tools/obs-setup.mjs` | builds the OBS scene, source and output config from scratch over the WebSocket API |
| `tools/obs.mjs` | obs-websocket v5 client, no dependency (Node 22+ has a native `WebSocket`) |
| `tools/render-voice.mjs` | ElevenLabs: `audition` compares voices on a real beat, `render [beatId]` measures durations, reports pauses and writes subtitles |
| `tools/make-timeline.mjs` | resolves a storyboard against the measured narration into a runnable timeline |
| `tools/aim.mjs` | "camera here, looking at there" → the yaw/pitch a keyframe needs |
| `tools/verify.mjs` | compares the built world against the schematic |
| `tools/preview.mjs` | runs a take and grabs stills at chosen milliseconds, for iterating on framing without recording |
| `tools/framegrab.mjs` | builds a take from the game's own framebuffer — no capture stack at all, but ~19 fps |
| `tools/capture.mjs` | ffmpeg `x11grab`; correct on X11, useless under Wayland (see below) |
| `tools/schematic_edit.py` | replays `schematics/edits.json` against an untouched export |

## Recording

```bash
QT_QPA_PLATFORM=xcb obs &
node tools/obs-setup.mjs
node tools/take.mjs script/episode.json --capture obs --voice out/voice/narration.mp3
```

Four things had to be true before OBS would record this reliably, none of them obvious:

1. **OBS must run under XWayland** (`QT_QPA_PLATFORM=xcb`). As a native Wayland client its only
   capture source is PipeWire screen capture, which demands a portal consent dialog — a human click
   in the middle of a scripted pipeline. Under XWayland it also offers `xcomposite_input`, which
   grabs an X11 window directly with no consent at all.
2. **The window must be set by value, never chosen from OBS's list.** Enumerating windows crashes
   OBS on this desktop (`basic_string: construction from null`): several visible windows carry no
   name and the plugin builds a `std::string` from a null pointer. `obs-setup.mjs` matches the
   window against the pid that `/health` reports, which also stops it filming a different Minecraft.
3. **Force x264.** OBS picks QSV for an Arc card, QSV fails to initialise MFX here, and the failure
   is silent in the worst way — `StartRecord` reports success, no output ever starts, and
   `StopRecord` fails with no message.
4. **Wait for the file to stop growing before touching it.** OBS finishes remuxing `hybrid_mp4`
   after `StopRecord` returns; probing too early reports a truncated duration.

**`x11grab` records pure black under Wayland.** Minecraft runs through XWayland, but XWayland does
not hand another client's pixels to a screen grabber. It fails silently — the take runs, a file is
written, and only watching it reveals there is nothing in it — so `take.mjs` refuses the x11 path
when `XDG_SESSION_TYPE=wayland` rather than recording an hour of black. The code is kept because it
is correct on a real X11 session.

**Offset the narration by the recording lead.** Recording starts before the take does, so muxing
the audio at zero puts every word ahead of the block it describes; `take.mjs` measures the lead
rather than assuming it. Apply it with `adelay` rather than `-itsoffset` — the latter leaves the
audio stream starting at a non-zero timestamp, which some players handle by playing no sound at
all. And never `-shortest`: it trims the video down to the narration and discards the tail where
the finished machine is on screen.

## Field notes

Things that cost a take to discover, kept so they only cost one:

- **NeoForge must be on the 21.1 line.** Create 6.0.x bundles Flywheel, which requires 21.1.66+.
- **Restart the client after recompiling.** Classes load lazily, so a running `runClient` picks up a
  newly compiled class against an old caller and dies with `NoSuchMethodError` the moment that code
  path is first reached — a signature change crashed a take 130 seconds in this way.
- **Re-run `installPilotSchematic` after editing the schematic.** The director reads from
  `runs/client/schematics/`, not from the project copy, so an edit that is not installed is an edit
  that does not happen. `/verify` catches it: the block count comes out wrong.
- **A missing mod's block reads as air.** `NbtUtils.readBlockState` cannot report failure, so the
  block vanishes from the build and nothing complains. A `quark:oak_chest` disappeared this way,
  which is why `SchematicSource` now checks the registry itself and reports unknown names.
- **Empty a block entity before replacing it.** `Clearable.tryClear` first, then `setBlock` —
  otherwise `onRemove` scatters the inventory across the grass, which is how one take ended up
  surrounded by loose deployer filters.
- **A take must clean up its predecessor's *entities*, not just its blocks.** Super glue is an
  entity, so a block-level clear never touches it and each run stacks another 14 bonds on the last;
  the verifier read 28 of 14 after two runs.
- **`clearStage` wipes the schematic's bounding box, not its occupied positions.** Delete a block
  from the schematic and the old one otherwise keeps standing in the world forever, because nothing
  claims that spot any more — a removed wall torch survived three takes that way.
- **A deployer has no screen; its filter does.** In Create the filter is a separate item in a slot
  on the block, and it is that item which opens a menu.
- **Fill the right half of a double chest first.** `ChestBlock.getBlockType` maps `ChestType.RIGHT`
  to `BlockType.FIRST`, so the right chest's slots are the top three rows of the combined screen.
  Filling left-first leaves the visible half empty.
- **Pin the time of day at take start.** `doDaylightCycle false` stops the clock but says nothing
  about where it stopped, so a world created in the evening films every take at dusk.
- **A container screen dims the world behind it.** That is vanilla, not a lighting fault — two shots
  of the same world differ wildly in brightness purely because one has a chest open.
- **Bind the control server to `127.0.0.1` explicitly.** `InetAddress.getLoopbackAddress()` resolves
  to `::1` on this JVM, and then every client dialling 127.0.0.1 is refused.
- **A single-player integrated server stops ticking whenever a pause screen is up**, and losing
  window focus opens one by default. Without `pauseOnLostFocus = false` a take silently freezes and
  every cue fires at once when ticking resumes.
- **Empty the toast queue during a take.** Handing the player a block unlocks its recipe, which pops
  a "New Recipes Unlocked!" toast over the top-right of the shot.
- The dev client's working directory is `runs/client/`, not `run/`.

## Limits and open work

- **Batch pacing.** A cue that places 54 drills fires them all in one tick with a single arm swing.
  It reads as a deliberate time-lapse, but staggering each batch over a second or two would look
  less abrupt.
- **Camera clearance is checked against the finished build.** That is the safe direction — the
  director only ever adds blocks, so a path clear at the end was clear throughout — but it would not
  complain about a path that is only clear because the blocks are not there yet.
- **Offline rendering.** Decoupling the director's clock from wall time would let a take render
  slower than real time while every frame is grabbed, giving a perfect 60 fps master with no capture
  stack at all.
- **Audio is not in this repository.** The rendered mp3s are left out deliberately; the character
  alignments and the finished `.srt` are included, so subtitles and timings are reproducible without
  an API key even though the voice is not.

## License

MIT — see [LICENSE](LICENSE).

Create, Quark and Zeta are third-party mods under their own licenses and are not distributed here.
This project is not affiliated with the Create team or with Mojang.
