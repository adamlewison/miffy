# Oney: the talking bunny

A private web app. She opens it on her phone and taps **Call**. It rings, the bunny picks up, and she talks to her plush bunny out loud. The bunny answers in its own voice while moving in 3D, and it remembers things between calls.

Stack: **Next.js 16** (App Router) on Vercel · **React Three Fiber** for the bunny · **OpenAI Realtime** (speech-to-speech over WebRTC) · **Turso** (libSQL) for memories.

```
phone ──WebRTC audio──▶ OpenAI Realtime      (audio never touches the server)
  │
  └─ /api/session ──▶ mints a 10-min client secret + loads personality & memories
  └─ /api/memories ◀── transcript after the call → cheap model → 3–5 facts → Turso
```

## Quick start

```bash
npm install
cp .env.example .env.local     # add OPENAI_API_KEY at minimum
npm run dev
```

Open http://localhost:3000. If you're testing on a phone, the mic needs HTTPS. Run `npx next dev --experimental-https`, or deploy a preview to Vercel.

| Page | What it's for |
| --- | --- |
| `/` | The app: contact card → ringing → live call → call ended |
| `/preview` | Animation test bench: switch states, fake speech, trigger tricks. Use it to tune `rig.ts` or check a new `bunny.glb` |
| `/voices` | Audition the built-in voices with a sample line |
| `/memories` | See, add, and delete what the bunny remembers |
| `/login` | Passcode screen (only when `BUNNY_PASSCODE` is set) |

None of the helper pages are linked from the call UI.

## Make it *her* bunny (do this before the reveal)

1. **Edit `src/bunny.config.ts`**: the name, what she calls it, her name, its age, personality, where it lives, and **ten real memories and inside jokes**. Lines starting with `TODO` are left out of the prompt until you replace them.
2. **Pick the voice** at `/voices`, then set `voice` in the config (or set `BUNNY_VOICE`). The built-in voices are all grown-ups, so the phone pitch-shifts the bunny's voice up (`pitchSemitones`, or the `BUNNY_PITCH` env var; default +4 = little girl). The `/voices` page has a slider that plays samples through the same shifter.
3. **Optional photo:** add `public/bunny-photo.jpg` (square) and it replaces the drawn avatar on the contact card.
4. **Colours:** `scene` in the config controls the background gradient and bokeh. Match them to your flat.
5. Have about 10 test calls yourself and rewrite anything that sounds robotic. The prompt is built in `src/lib/prompt.ts`.

## Deploy (Vercel)

1. Push this repo and import it in Vercel.
2. Set environment variables: `OPENAI_API_KEY`, `BUNNY_PASSCODE`, `AUTH_SECRET` (`openssl rand -hex 32`), `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`. The optional ones are listed in `.env.example`.
3. **Turso:** create a free database (`turso db create bunny`), then copy its URL (`turso db show bunny --url`) and a token (`turso db tokens create bunny`). The `memories` table is created automatically on first use (`db/schema.sql` is there for reference). Without Turso, memories live in server RAM and disappear on every cold start. Locally you can use `TURSO_DATABASE_URL=file:local.db`.
4. **Set a monthly spend cap** in the OpenAI dashboard (about £20). Realtime is billed per audio token. Calls are hard-capped at `NEXT_PUBLIC_MAX_CALL_MINUTES` (default 20).
5. On her phone: open the URL, enter the passcode once (the cookie lasts a year), then **Share → Add to Home Screen**. It installs as a full-screen app with the bunny icon.

## How it works

### Voice (Phase 2)
- `src/app/api/session/route.ts` creates the ephemeral key with `POST /v1/realtime/client_secrets`. It uses semantic VAD, near-field noise reduction and input transcription. The real key stays on the server.
- `src/lib/useBunnyCall.ts` runs the call with `@openai/agents/realtime` (`RealtimeAgent` + `RealtimeSession` over WebRTC):
  - everything starts from the Call tap: the AudioContext unlock, mic permission and the ringback tone (iOS needs this)
  - the bunny's incoming audio track goes into a Web Audio `AnalyserNode`, which drives the talking animation
  - server events switch the animation between listening, thinking, talking and idle
  - interruption is built in: when she starts talking, the reply is cut off
  - the bunny speaks first when it "picks up"
  - tools: `get_time_of_day`, `express` (body language: wave / nuzzle / sad, plus hop / wiggle / spin / ear_flick) and `remember_this`
  - she waves hello automatically when she picks up
  - when the call ends, the transcript is sent to `/api/memories` and then discarded. Only the extracted facts are stored. No audio is ever stored.

### Animation (Phase 3)
`src/components/bunny/rig.ts` does all the animation in code, so no animator is needed:

| State | Motion |
| --- | --- |
| Idle | breathing (±2% body scale), sway, random ear twitches, a bit sleepy when not on a call |
| Listening | head tilts toward her, ears perk up, slight lean in |
| Thinking | head tilts the other way and looks up, one ear droops |
| Talking | head bob and body squish from reply volume (smoothed over ~80 ms), jaw/cheek squash, ears bounce on each "syllable" |
| Wave | left paw up beside her face, little side-to-side waves, head tilts toward it |
| Sad | head sags, both ears flop down, paws come up to cover her face |
| Nuzzle | leans in toward the camera, rubs her head side to side, arms come forward in a cuddle |
| Tricks | hop (with landing squash), ear flick, wiggle, spin |

The ears are damped springs that lag behind the head and the body's vertical movement. The mouth is never animated as lip shapes: the lower face just squashes in time with the volume.

The frame rate is capped at 30 fps on touch devices.

### The 3D model (Phase 1)
Oney is built **procedurally in Blender** from the reference photos by `blender/build_oney.py`, so she can be rebuilt and tweaked at any time:

```bash
python3 -m venv .bvenv && .bvenv/bin/pip install bpy     # Blender as a Python module (headless)
.bvenv/bin/python blender/build_oney.py --out public/bunny.glb --renders /tmp/oney   # ~3 min, includes the AO bake
```

The script models her as sewn plush panels:
- **Head:** egg-shaped, with a centre seam, a wing-shaped cream muzzle, a big mustard triangle nose, a stitched mouth, and embroidered eyes with highlights.
- **Ears:** long lop ears that twist and cup around the head, tan outside with a beige lining and cream piping.
- **Body:** a squat pear-shaped body with a cream tummy and chest fold.
- **Limbs:** arms with cream paw tips and stitches, and big feet with cream soles and toe stitches.
- **Tail:** a cream pom-pom.

It then:
- bakes ambient occlusion into vertex colours, writes a per-vertex fur-length mask (`_furlen`) so the face and patches stay crisp, and rigs everything to the bones below
- exports `public/bunny.glb` (about 3 MB)
- with `--renders`, writes Cycles previews from the same angles as the photos

**Fur** is rendered live in the browser by `src/components/bunny/fur.ts` using shell texturing:
- Every fabric part is redrawn 10 times on phones and 20 on desktop, each layer pushed slightly further out along the surface.
- Strands are cut out of 3D cell noise on the rest-pose surface, so they move with her.
- Strands taper, lean in random directions and vary in length; roots are darker, tips lighter, and a soft rim glow gives the fuzzy halo.
- Strand edges are anti-aliased with alpha-to-coverage.

Override the layer count with `?shells=N`. Fur lengths and densities per material are in `FUR_PROFILES`.

`/preview` shows every state and gesture without a call:
- `?view=face` or `?view=side` changes the camera.
- `?hold=1` keeps gestures on so you can inspect them.

If `public/bunny.glb` is missing or fails to load, the app falls back to the simple shapes-in-code bunny (`ProceduralBunny.tsx`).

Bones (matched by name, aliases in `BONE_NAMES` in `rig.ts`). Each bone's local axes are world-aligned (in Blender, every bone points straight up with roll 0), so the same animation code drives both bunnies:

| Bone | Notes |
| --- | --- |
| `root` | whole toy (hop, spin, sway) |
| `body` | breathing and squish (scaled) |
| `head` | child of body |
| `jaw` | lower face / cheeks (scaled when talking) |
| `ear_L_1`, `ear_L_2` | ear root → middle; 2 is a child of 1 |
| `ear_R_1`, `ear_R_2` | same, right side |
| `arm_L`, `arm_R` | shoulders |

Model-specific animation settings live in `GlbBunny.tsx`: the lop-ear direction and amount, and the arm poses for wave, sad and nuzzle, which were solved for her proportions.

## Privacy and safety
- The passcode lock (`src/proxy.ts`) covers every page and API route. Cookies are HMAC-signed, and changing the passcode logs every device out.
- The OpenAI key exists only on the server. The phone gets a 10-minute ephemeral key.
- No audio is stored. Transcripts are used once to extract facts, then dropped.
- The Turso database is reached only from the server, using an auth token that never reaches the phone.

## Project map
```
src/
  bunny.config.ts            ← character sheet, voice, colours (edit me)
  proxy.ts                   passcode gate
  app/
    page.tsx                 call app
    api/session              ephemeral key + instructions
    api/memories             extract / list / add / delete memories
    api/login, api/logout    passcode cookie
    api/voice-sample         TTS voice audition
    preview, voices, memories, login
  components/
    CallApp.tsx              FaceTime-style UI
    bunny/BunnyScene.tsx     canvas, lights, framing, fps cap, GLB detection
    bunny/rig.ts             all procedural animation
    bunny/ProceduralBunny.tsx fallback bunny (simple shapes)
    bunny/GlbBunny.tsx       loads public/bunny.glb, fur + lop-ear rig settings
    bunny/fur.ts             shell-texture plush fur shader
    bunny/materials.ts       terry-cloth material + fuzz rim
  lib/
    useBunnyCall.ts          Realtime session, tools, events, camera frames
    prompt.ts                system prompt builder
    memories.ts              Turso (or in-memory) store
    sounds.ts                synthesised ringback / pickup / hang-up
db/schema.sql
scripts/make-icons.mjs       regenerates PWA icons from scripts/bunny-face.svg
blender/build_oney.py        builds public/bunny.glb (Oney's 3D model) from code
```

## Optional: the bunny can see her
On a call, the camera button turns on her front camera, with a self-view in the corner. A small JPEG frame is sent to the model when she starts speaking (at most one every 4 s), so the bunny can say "ooh, nice jumper". It never triggers a reply on its own, and frames aren't stored.
