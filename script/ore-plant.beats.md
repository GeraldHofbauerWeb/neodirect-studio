# Ore Processing Plant — narration

Ten beats, English, voice *Chris* as in the pilot. The boiler is in now, as its
own beat at the front, because you were right that without it nothing turns.

**This is the file to mark up.** Overwrite the text under any beat and I read it
back into `script/ore-plant.beats.json`. Nothing goes to ElevenLabs until you
have been through it.

The **Check** lines are where I am inferring rather than reading. Those are the
ones I would like knocked down if they are wrong.

---

## b0 — What it costs

*~28 s · a double chest opens on camera and the counts are read off the real
inventory, not asserted*

> Three hundred and one blocks, forty-nine different kinds, and the whole lot
> fits in one double chest with room left over. Most of it is repetition —
> forty-six belt segments, twenty-eight encased chain drives, twenty-seven item
> vaults, twenty fluid tanks for the boiler. Nothing on that list is expensive,
> and nothing on it is clever either, which is worth saying now, because the
> part that makes this machine work is not really in the chest at all. It is the
> twenty filters, and the fact that no two of them are set the same way.

**Check** — counts are the machine only. The housing it stands in goes down
before the narration starts and is never mentioned.

---

## b1 — Where the power comes from

*~34 s · the boiler builds first, 86 blocks over four seconds*

> Start at the boiler, because nothing here moves without it and everything else
> is hung off what it turns. It looks like one boiler and it is five: five
> separate columns of fluid tank, four blocks high, each with its own steam
> engine on top. Under all of them runs a row of magma blocks, and no blaze
> burner anywhere — magma gives you passive heat, the lowest setting there is,
> and five small boilers on passive heat is enough for a plant this size and not
> a great deal more. Water comes up from the pool underneath through five
> mechanical pumps, and the pumps are turned by three water wheels standing in
> the same water they are pumping. Above the engines, one shaft. That shaft is
> the only thing connecting this end of the room to the machine at the other
> end.

**Verified** — read out of the block entities on both sides: `PassiveHeat 1`,
`ActiveHeat 0`, `Engines 1`, `Size 1`, `Height 4`, on the server and in the
studio alike. Five separate boilers is how it is built, not a multiblock that
failed to merge.

---

## b2 — The drive

*~26 s*

> From the boiler the line runs north along the ceiling and drops into the
> plant, and from there it is chain drives most of the way — twenty-eight of
> them, more of this build than any other single component, and the part you
> will never see in a screenshot of it. Gearboxes take the corners. A rotation
> speed controller sets the pace for everything downstream, so the crusher and
> the presses and the belts all run off one number instead of being tuned
> against each other. And there is a stressometer on the wall, which earns its
> place the first time you add something and the whole plant slows down.

---

## b3 — The dock

*~36 s · two `showFilter` cues, the allow and the deny opened one after the
other*

> This end is where the ore arrives. A mining train pulls in, parks, and empties
> itself through a portable storage interface — and if it looks familiar, that
> is the machine from the last episode, which has no idea what becomes of what
> it drops off. What becomes of it is two smart chutes, one above the other, and
> they are the first showing of a pattern that runs through this entire build.
> Both are set to the same eight things: cobblestone, cobbled deepslate, gravel,
> flint, basalt, soul sand, netherrack and blackstone. One of them allows that
> list. The one next to it denies it. Same list, opposite switch. Everything the
> train dropped goes down exactly one of the two, there is no priority to get
> wrong, and nothing sits in the middle waiting for somebody to decide.

**Check** — is the docking train really the pilot's? Its bill is identical:
108 vaults, 85 deployers, 54 drills, 16 chassis, a cart assembler, a plough.
And: are those eight stone types the spoil going out, or usable stone going in?

---

## b4 — The crusher

*~26 s · `showFilter` on the whitelist and its blacklist twin*

> Two crushing wheels with the controller between them, fed over a short belt
> loop. The wheels are not fussy about what you give them, which is mostly a
> virtue and occasionally a problem, because tunnel stone goes in alongside the
> ore and comes back out as gravel. So the head of the crusher is that same
> trick again: one funnel set to allow crushed iron, gold, copper and zinc, and
> the funnel beside it set to deny those four and nothing else. Ore carries on
> into the machine. Everything else turns off here.

**Check** — where does the denied side actually go? I can see the funnel, not
the end of its belt.

---

## b5 — Washing

*~29 s*

> Washing comes next, and the fan looks wrong the first time you see it. A fan
> only washes what it blows over if it is blowing through water, and there is no
> water in front of this one — there is a leaf block. It is waterlogged, and
> Create reads the fluid rather than the block holding it, so as far as the fan
> is concerned it is facing a pond. The whole stage is a fan, a leaf and a water
> wheel to turn it. And since washing gravel gives you clay, and clay is not
> ore, the clay comes out here the way everything comes out of everywhere in
> this machine: allow clay on one funnel, deny clay on the next.

**Check** — the biggest guess in the script. Was the leaf a deliberate way to
hide the water, or decoration that happens to be waterlogged?

---

## b6 — The sorter

*~35 s · six `showFilter` cues, one per lane*

> Six belts side by side, a funnel over each, one filter per funnel, and this is
> where the machine keeps most of its cleverness. Experience nuggets on the
> first lane. Lapis, emerald and diamond on the second — and each of those is
> listed twice there, once as the ore and once as the gem, because a crushing
> wheel handed a whole stone block gives you the ore back rather than what is
> inside it. Gunpowder and quartz. Redstone and coal. Copper and zinc nuggets.
> Iron and gold nuggets. Anything matching none of the six stays on the belt and
> comes round again, which means adding a metal later is a question of adding a
> lane rather than rebuilding the sorter.

**Check** — the ore-and-gem explanation is a guess. And does unmatched material
really loop back round, or does it go somewhere I have not found?

---

## b7 — Basins and presses

*~25 s · `showFilter` on all three basins*

> Nuggets are awkward to store and worse to carry, so they get pressed on the
> way past. Three basins with a mechanical press over each, and the filter on
> the basin decides which metals are allowed to meet: redstone and coal in the
> first, copper and zinc in the second, iron and gold in the third. That
> separation is not tidiness. A basin with two metals in it will happily make
> you something — it just will not be the thing you wanted. Over each output is
> a funnel set to the finished block, so nothing half-pressed gets past.

**Check** — is keeping them apart really about wrong recipes, or about
throughput?

---

## b8 — Storage, and the wall that reads it

*~30 s · a chest opens on camera, then the boards*

> Storage is deliberately dull: twenty-seven item vaults for bulk, and a row of
> twelve chests underneath them for the part a hopper or a hand can actually
> reach. What sits under the chests is the interesting half. A content observer
> beneath each one, a display link above, and a wall of sixteen display boards
> fed from those links. Eight lines: the power on the network in stress units,
> the fill level of the storage, and then one line per lane — gold and iron,
> copper and zinc, coal and redstone, byproducts, valuables, experience nuggets.
> That sounds like decoration right up to the first time a lane stops quietly,
> and a number that has not moved all evening tells you which of the twenty
> filters to go and look at.

**Verified** — the eight display links carry `create:kinetic_stress`,
`create:fill_level` and six `create:count_items`, with those labels. The wall
needs turning to change a line, which is a nice detail on its own: an unpowered
readout keeps showing the last thing it knew.

---

## b9 — Running it

*~24 s · the boiler lights, ore goes in at three points, one long slow orbit*

> One lever starts all of it. Off, a redstone torch burns, the wire beside it
> carries fifteen, and a powered clutch is a disengaged one — so the wheels turn
> nothing, the pumps stay still and the boiler stays dry. Throw it and the torch
> goes out and everything downstream of it wakes up at once. Then feed it: ore
> into the crusher, crushed ore onto the washer, nuggets straight onto the
> sorter, all at the same time, because a single batch takes longer to travel
> the whole line than we have here and a plant working in only its first third
> looks broken rather than busy. Give it a moment. Every lane moving, the wall
> counting up, and that is a Create ore plant.

**Verified** — it starts. Wheels at 8, pumps at 32, belts at 64, crushing
wheels and presses at 256, the wall reading 10,240 SU and the counts climbing.

---

## The four filter pairs

The spine of the episode: same item list, opposite switch, sitting next to each
other.

| allow | deny | separates |
|---|---|---|
| smart chute, 8 stone types | smart chute, the same 8 | ore from spoil, at the dock |
| brass funnel, 4 crushed ores | brass funnel, the same 4 | ore from stone, at the crusher |
| brass funnel, clay | belt funnel, clay | clay out of the washed stream |
| — | smart chute, rail | keeps the train's own rails out |

Twenty-two configured filters, four of them set to deny.
