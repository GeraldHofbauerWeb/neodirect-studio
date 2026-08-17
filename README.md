# NeoDirect

A director for scripted Minecraft tutorial recordings. A timeline drives block placement, camera
moves and presentation cues on a wall clock derived from pre-rendered narration durations, so an
episode is reproducible: change a sentence, re-render the audio, re-run the take.

NeoForge 1.21.1 · Java 21 · Create 6.0.10 · runs only in a local recording instance.

## Status

First full episode is shot: `out/episode.mp4`, 80 seconds, Chris narrating, subtitles from
ElevenLabs' character alignment. `script/episode.json` is the deliverable: four beats, 100 seconds, building the whole contraption
and ending with it glued and complete. Verified after every run — 271/271 blocks, 14/14 glue
bonds, nothing dropped on the floor.

The two pilot scripts are the original feasibility test and are kept as the record of that
decision: the same 30-second scene shot twice, five blocks each, to answer whether server-side
placement reads as a *tutorial* or as a *magic trick*.

| | `script/pilot-a.json` | `script/pilot-b.json` |
|---|---|---|
| camera, timing, blocks | identical | identical |
| held item, arm swing, place sound, particles | off | on |

It reads as a tutorial, and the reason is that `player.swing()` does animate the first-person
arm — the assumption that server-side placement has no hand was wrong. That only works because
the camera is the player in creative flight; a spectator renders neither hand nor held item.

## Quick start

```bash
./gradlew installPilotSchematic     # schematics/ -> runs/client/schematics/
./gradlew runClient                 # creates/opens the studio world by itself

curl 127.0.0.1:8777/health          # is the director up
QT_QPA_PLATFORM=xcb obs &
node tools/obs-setup.mjs
node tools/take.mjs script/pilot-b.json --capture obs
```

Credentials live in `~/.config/neodirect/` — `obs.env` and `elevenlabs.env`, both `chmod 600`.

`runClient` *is* the recording instance: exactly Create + NeoDirect, no modpack ballast, a flat
creative world with daylight, weather and mob spawning switched off. The modpack instance
`~/.minecraft-instances/sebsmodpack4` is only ever read from.

## How it fits together

**Control server** — `127.0.0.1:8777`, built on the JDK's own `com.sun.net.httpserver`, so the
mod ships with zero dependencies.

| endpoint | |
|---|---|
| `GET /health` | up? take running? plus the client's pid, which is how the capture tools find the right window |
| `POST /run` | body is a timeline; responds when the take finishes, with every cue's planned vs. actual millisecond |
| `GET /screenshot` | grabs the game's own framebuffer |
| `POST /verify` | same timeline body; compares the built world against the schematic |

**From script to timeline** — this is the loop the whole project is arranged around:

```bash
node tools/render-voice.mjs render script/pilot.beats.json          # measures every beat
node tools/make-timeline.mjs script/episode.storyboard.json script/episode.json
node tools/take.mjs script/episode.json --capture obs --voice out/voice/narration.mp3
```

Text-to-speech is not deterministic, so `render` takes an optional beat id and re-speaks only that
beat, rebuilding offsets and subtitles from the alignments it keeps beside each mp3. Fixing one
sentence otherwise rerolls every other beat's phrasing and length for nothing.

Phrasing is checkable rather than a matter of listening: `render` prints every pause over 300 ms
with the words either side of it. Worth knowing that ElevenLabs returns a *contiguous* timeline —
silence is held by a space or a comma, not left as a gap between characters, so measuring the gaps
finds nothing at all in a beat that pauses eight times. Also worth knowing that Chris barely
pauses at a comma (150 ms) and reliably pauses at a full stop (450–700 ms), so a break the script
needs has to be a sentence boundary, not punctuation inside one.

The storyboard places cues *inside* a beat as fractions — "three quarters of the way through beat
one, the deployer goes down" — and the generator resolves them against the audio that actually
came back. Rewrite a sentence, re-render, regenerate, re-shoot. Chris turned out to speak 20%
faster than the hand estimate (80 s against 100 s), and nothing needed adjusting by hand.

**Timeline** (`script/*.json`, generated) — `place` cues name what to build: explicit indices for the blocks
a beat actually talks about, `{"ofType": "create:deployer"}` for "and now all of these", `"rest"`
for whatever is left, `"all"` for everything. A tutorial says "the same drill across the whole
face", not "blocks 118 through 171", and the script gets to say it that way.

`"rest"` also takes an exception list — `{"rest": true, "except": ["create:item_vault"]}` — and it
earns its keep. "Everything else now" and "the storage goes on last" are both true of the same
script, and without a way to say the first while holding back the second, the sweep-up cue wins
silently: the vaults went down during the chest beat, walling off the middle, while the closing
beat that was supposed to place them set blocks that already stood there. Holding a type back is
paired with a warning at load time naming any block no cue places, so excluding something and then
forgetting to place it is loud rather than invisible. `camera` cues carry
keyframes and a duration — `tools/aim.mjs` converts "camera here, looking at there" into the
yaw/pitch they need. Everything is scheduled against a wall clock, because the narration and the recorder
are on wall clocks too.

**Schematic** — `schematics/mining_drill_1.nbt` is *not* the raw export. It is the export plus the
edits recorded in `schematics/edits.json`, replayed by `tools/schematic_edit.py`; the file in the
modpack instance is only ever read. Keeping the edits as data rather than as a one-off script is
the difference between a derived asset and a mystery file.

Create writes plain vanilla structure NBT, so `SchematicSource` reads it with
`NbtUtils.readBlockState` and needs no Create API at all. Block states *and* block-entity data
come across for free: rail shape, chassis axis, drill and deployer facing, deployer filters. The
`entities` list carries the 14 `create:super_glue` bonds — without them the assembler has nothing
to pick up — plus a furnace minecart.

**Correctness** — `script/full-build.json` builds the whole contraption and `tools/verify.mjs`
compares the result against the schematic: every block state, entity counts per type, loose items
on the ground, and whether any camera move passes through the build. "It should look exactly like
the schematic" is checked, not eyeballed — and so is "the camera does not fly through a wall",
which is not something you reliably catch by watching.

```
blocks: 271/271 match  missing 0  wrong state 0
  create:super_glue: 14/14
  minecraft:furnace_minecart: 1/1
loose items on the ground: 0
camera paths: clear
OK — the world matches the schematic
```

The clearance check samples the *curve*, not the keyframes. Catmull-Rom passes through every
keyframe but bows outward between them, so a path whose every waypoint sits clear of the
contraption can still bulge into the drill face. `CameraPath` is shared between the client that
flies the move and the verifier that checks it, so a shot cannot pass the check and then fly
something else.

**Materials chest** — a `materialsChest` cue places a double chest holding the whole bill of
materials, counted from the schematic (13 stacks: 108 item vaults, 85 deployers, 54 drills, …).
Counted rather than listed, so it cannot drift out of step with the build it supplies — and that
includes items held *inside* block entities, which is how the 84 configured deployer filters made
it into the bill. They go in configured, not blank. A `screen` cue opens the chest on camera, so
the viewer reads the stack counts off the real inventory instead of being told them.

**Camera** — the player in creative flight, not a spectator. Spectator mode renders neither the
held item nor the hand, which would make the entire presentation layer untestable. Smoothness is
vanilla's: `Camera#setup` interpolates between `entity.xo/yo/zo` and the current position by
partial tick, so writing the previous pose before each tick's update is all a smooth 200 fps pan
requires. Positions follow a Catmull-Rom spline with smoothstep easing.

## Tools

| | |
|---|---|
| `tools/take.mjs` | full pipeline: record → run → stop → rename → mux narration. `--capture obs` (default quality path), `x11`, or `none` |
| `tools/obs-setup.mjs` | builds the OBS scene, source and output config from scratch over the WebSocket API |
| `tools/obs.mjs` | obs-websocket v5 client, no dependency (Node 22+ has a native WebSocket) |
| `tools/make-timeline.mjs` | resolves a storyboard against the measured narration into a runnable timeline |
| `tools/aim.mjs` | "camera here, looking at there" → the yaw/pitch a keyframe needs |
| `tools/verify.mjs` | compares the built world against the schematic |
| `tools/render-voice.mjs` | ElevenLabs: `audition` compares voices on a real beat, `render [beatId]` measures durations and writes subtitles — naming one beat re-speaks only that one |
| `tools/preview.mjs` | runs a take and grabs stills at chosen milliseconds; for iterating on framing without recording |
| `tools/framegrab.mjs` | builds a take from the game's own framebuffer — no capture stack at all, but ~19 fps |
| `tools/capture.mjs` | ffmpeg `x11grab`. **Records pure black on this machine** — see below |

### Recording

Start the game, then:

```bash
QT_QPA_PLATFORM=xcb obs &          # the platform variable is not optional, see below
node tools/obs-setup.mjs           # scene, source, 1920x1080@60, x264
node tools/take.mjs script/pilot-b.json --capture obs
```

Four things had to be true before OBS would record this, none of them obvious:

1. **OBS must run under XWayland** (`QT_QPA_PLATFORM=xcb`). As a native Wayland client its only
   capture source is PipeWire screen capture, which demands a portal consent dialog — a human
   click in the middle of a scripted pipeline. Under XWayland it also offers `xcomposite_input`,
   which grabs an X11 window directly with no consent at all.
2. **The window must be set by value, never chosen from OBS's list.** Enumerating windows crashes
   OBS on this desktop (`basic_string: construction from null`): several visible windows carry no
   name and the plugin builds a `std::string` from a null pointer.
3. **The encoder must be forced to x264.** OBS picks QSV for the Arc card, QSV fails to
   initialise MFX here, and the failure is silent in the worst way — `StartRecord` reports
   success, no output ever starts, and `StopRecord` fails with no message. NVENC is unavailable
   too (`cuda_init_100`). `ffmpeg_vaapi_tex` is present if CPU load ever matters.
4. **Wait for the file to stop growing before touching it.** OBS finishes remuxing `hybrid_mp4`
   after `StopRecord` returns; probing too early reports a truncated duration.
5. **A container screen dims the world behind it** — that is vanilla, not a lighting fault. Two
   shots of the same world look wildly different in brightness purely because one has a chest open.
6. **Fill the right half of a double chest first.** `ChestBlock.getBlockType` maps `ChestType.RIGHT`
   to `BlockType.FIRST`, so the right chest's slots are the top three rows of the combined screen.
   Filling left-first leaves the visible half empty.
7. **Pin the time of day at take start.** `doDaylightCycle false` stops the clock but says nothing
   about where it stopped.
8. **Offset the narration by the recording lead.** Recording starts before the take does, so
   muxing the audio at zero puts every word ahead of the block it describes. `take.mjs` measures
   the lead rather than assuming it. And never `-shortest` — that trims the video down to the
   narration and discards the tail where the finished machine is on screen.

`x11grab` (`tools/capture.mjs`) records pure black here: although Minecraft runs through XWayland,
XWayland does not hand another client's pixels to a screen grabber. The code is kept because it is
correct on a real X11 session.

## Open work

- **Batch pacing.** A cue that places 54 drills fires them all in one tick with a single arm
  swing. It reads as a deliberate time-lapse, but staggering each batch over a second or two would
  look less abrupt.
- **Pacing.** The beat texts are a first draft and the batch placements (54 drills in one cue)
  land all at once, which reads as a deliberate time-lapse but could be staggered over a second or
  two if it feels abrupt.
- **Offline rendering.** Decoupling the director's clock from wall time would let a take render
  slower than real time while every frame is grabbed, giving a perfect 60 fps master with no
  capture stack at all.

## Notes for future me

- NeoForge must be on the **21.1** line. Create 6.0.x bundles Flywheel, which requires 21.1.66+;
  VanillaPlusAdditions' 21.0.167 fails mod loading with Create present.
- **`clearStage` wipes the schematic's bounding box, not its occupied positions.** Delete a block
  from the schematic and the old one otherwise keeps standing in the world forever, because
  nothing claims that spot any more — a removed wall torch survived three takes that way.
- **Re-run `installPilotSchematic` after editing the schematic.** The director reads from
  `runs/client/schematics/`, not from the project copy, so an edit that is not installed is an
  edit that does not happen. `/verify` catches it: the block count comes out wrong.
- **Restart the client after recompiling.** Classes load lazily, so a running `runClient` picks
  up a newly compiled class against an old caller and dies with `NoSuchMethodError` the moment
  that code path is first reached — a signature change to `BillOfMaterials` crashed a take 130
  seconds in this way.
- **A deployer has no screen; its filter does.** In Create the filter is a separate item in a slot
  on the block, and it is that item which opens a menu. `showFilter` copies the filter out of the
  block's saved data, puts it in the player's hand and uses it.
- **The recording instance needs every mod the schematic touches.** A block whose mod is absent
  reads as air — `NbtUtils.readBlockState` cannot report failure — so it vanishes from the build
  and nothing complains. The pilot lost a `quark:oak_chest` this way, which is why Quark and Zeta
  are in `libs/` and why `SchematicSource` now checks the registry itself and reports unknown
  names. Biolith is Quark's other hard dependency and rides along as jar-in-jar.
- **Empty a block entity before replacing it.** `Clearable.tryClear` first, then `setBlock` —
  otherwise `onRemove` scatters the inventory across the grass, which is how a second take ended
  up surrounded by loose deployer filters.
- **A take must clean up its predecessor's entities, not just its blocks.** Super glue is an
  entity, so the block-level clear never touched it and each run stacked another 14 bonds on the
  last; the verifier read 28 of 14 after two runs.
- The dev client's working directory is `runs/client/`, not `run/`.
- Bind the control server to `127.0.0.1` explicitly. `InetAddress.getLoopbackAddress()` resolves
  to `::1` on this JVM and then every client dialling 127.0.0.1 is refused.
- A single-player integrated server stops ticking whenever a pause screen is up, and losing window
  focus opens one by default. `StudioWorld` turns `pauseOnLostFocus` off; without it a take
  silently freezes and every cue fires at once when ticking resumes.
