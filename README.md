# Miffy: the talking bunny

A private web app. She opens it on her phone and taps **Call**. It rings, the bunny picks up, and she talks to her plush bunny out loud. The bunny answers in its own voice while moving in 3D, and it remembers things between calls.

Stack: **Next.js 16** (App Router) on Vercel · **React Three Fiber** for the bunny · **OpenAI Realtime** (speech-to-speech over WebRTC) · **Supabase** for memories.

```
phone ──WebRTC audio──▶ OpenAI Realtime      (audio never touches the server)
  │
  └─ /api/session ──▶ mints a 10-min client secret + loads personality & memories
  └─ /api/memories ◀── transcript after the call → cheap model → 3–5 facts → Supabase
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
2. **Pick the voice** at `/voices`, then set `voice` in the config (or set `BUNNY_VOICE`).
3. **Optional photo:** add `public/bunny-photo.jpg` (square) and it replaces the drawn avatar on the contact card.
4. **Colours:** `scene` in the config controls the background gradient and bokeh. Match them to your flat.
5. Have about 10 test calls yourself and rewrite anything that sounds robotic. The prompt is built in `src/lib/prompt.ts`.

## Deploy (Vercel)

1. Push this repo and import it in Vercel.
2. Set environment variables: `OPENAI_API_KEY`, `BUNNY_PASSCODE`, `AUTH_SECRET` (`openssl rand -hex 32`), `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`. The optional ones are listed in `.env.example`.
3. **Supabase:** create a free project, run `supabase/schema.sql` in the SQL editor, and copy the URL and the **service role** key. Without Supabase, memories live in server RAM and disappear on every cold start.
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
  - tools: `get_time_of_day`, `do_trick` (hop / ear_flick / wiggle / spin) and `remember_this`
  - when the call ends, the transcript is sent to `/api/memories` and then discarded. Only the extracted facts are stored. No audio is ever stored.

### Animation (Phase 3)
`src/components/bunny/rig.ts` does all the animation in code, so no animator is needed:

| State | Motion |
| --- | --- |
| Idle | breathing (±2% body scale), sway, random ear twitches, a bit sleepy when not on a call |
| Listening | head tilts toward her, ears perk up, slight lean in |
| Thinking | head tilts the other way and looks up, one ear droops |
| Talking | head bob and body squish from reply volume (smoothed over ~80 ms), jaw/cheek squash, ears bounce on each "syllable" |
| Tricks | hop (with landing squash), ear flick, wiggle, spin |

The ears are damped springs that lag behind the head and the body's vertical movement. The mouth is never animated as lip shapes: the lower face just squashes in time with the volume.

The frame rate is capped at 30 fps on touch devices.

### The 3D model (Phase 1: do next, in Blender)
Until a real model exists, `ProceduralBunny.tsx` draws a placeholder bunny from simple shapes in code, using the same rig.

**To swap in the real bunny, put `bunny.glb` in `public/`.** It's detected automatically. If it fails to load, the app falls back to the placeholder.

The GLB should:
- be under 5 MB, Draco-compressed, with about 30–50k triangles
- stand upright on the origin, facing **+Y up, front toward the camera** (glTF export from Blender handles this). Size doesn't matter, because it's normalised to the same height.
- have these bones, matched by name (aliases in `BONE_NAMES` in `rig.ts`):

  | Bone | Notes |
  | --- | --- |
  | `root` | whole toy (hop, spin, sway) |
  | `body` | breathing and squish (scaled) |
  | `head` | child of body |
  | `jaw` | lower face / cheeks (scaled when talking) |
  | `ear_L_1`, `ear_L_2` | ear base → tip; 2 is a child of 1 |
  | `ear_R_1`, `ear_R_2` | same, right side |
  | `arm_L`, `arm_R` | |

  Bone axes follow Blender's convention, with local +Y running along the bone. If the right ear splays the wrong way, pass `earZSign: -1` in `GlbBunny.tsx`.

Check the result at `/preview`. Missing bones are logged in the browser console during development.

The fur look comes from `addFuzzRim` in `materials.ts`, a soft rim-light shader that's applied automatically to the GLB's materials.

## Privacy and safety
- The passcode lock (`src/proxy.ts`) covers every page and API route. Cookies are HMAC-signed, and changing the passcode logs every device out.
- The OpenAI key exists only on the server. The phone gets a 10-minute ephemeral key.
- No audio is stored. Transcripts are used once to extract facts, then dropped.
- The Supabase table has RLS enabled and no policies, so only the server's service-role key can reach it.

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
    bunny/ProceduralBunny.tsx placeholder bunny
    bunny/GlbBunny.tsx       Blender model loader
    bunny/materials.ts       terry-cloth material + fuzz rim
  lib/
    useBunnyCall.ts          Realtime session, tools, events, camera frames
    prompt.ts                system prompt builder
    memories.ts              Supabase (or in-memory) store
    sounds.ts                synthesised ringback / pickup / hang-up
supabase/schema.sql
scripts/make-icons.mjs       regenerates PWA icons from scripts/bunny-face.svg
```

## Optional: the bunny can see her
On a call, the camera button turns on her front camera, with a self-view in the corner. A small JPEG frame is sent to the model when she starts speaking (at most one every 4 s), so the bunny can say "ooh, nice jumper". It never triggers a reply on its own, and frames aren't stored.
