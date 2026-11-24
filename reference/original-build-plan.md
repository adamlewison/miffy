# Talking Bunny App — Build Plan

Nov 23, 2026 · @Adam Lewison

A private web app where my wife opens a FaceTime-style call with her plush bunny, talks out loud, and the bunny answers in its own voice while moving in 3D. A first working version is a weekend build; polish takes about two more weeks of evenings.

## What she experiences

1. She opens a link on her phone and taps **Call**. A ringing screen shows, then the bunny picks up.
2. The bunny sits full-screen, looking like her real toy: same tan fur, cream tummy, floppy ears.
3. She just talks. No buttons. The bunny listens with its ears perked and head tilted.
4. The bunny replies within about a second, in a soft voice, with its head bobbing, body squishing and ears flopping as it speaks.
5. She can interrupt it mid-sentence, like a real call.
6. It knows her name, its own name and their shared history, and remembers things between calls.

**Success means:** she uses it more than once because it makes her smile, not because it is a tech demo.

## How it fits together

Stack: Next.js on Vercel, React Three Fiber for the 3D bunny, OpenAI Realtime for voice, Supabase for memories. Audio flows directly between her phone and OpenAI, so your server never slows the conversation down.

&#91;embedded content: architecture · phone, voice, server, memory\]

The server's only jobs are minting a short-lived key and loading the bunny's personality and memories into the session.

## Phase 1: Build the 3D bunny

Goal: a single `bunny.glb` file, under 5 MB, that looks like her toy and has a simple skeleton.

Everything happens in Blender, driven by Claude Code through [Blender MCP](https://github.com/ahujasid/blender-mcp). All free.

1. **Set up:** install Blender and the Blender MCP addon (`addon.py`), click Connect, then run `claude mcp add blender uvx mcp-for-blender`. Turn on Hyper3D in the addon panel to get the free trial key.
2. **Photograph her** (secretly) in daylight against a plain wall. Take 8 shots: front, back, both sides and the four diagonals, all at her eye level. Add one close-up of the face.
3. **Route A: AI generation.** Ask Claude to generate her from the photos with Hyper3D Rodin. The free key has a daily limit, so spread attempts across days if needed. Free backup: upload a photo to the Hunyuan3D or TRELLIS demo on Hugging Face and import the GLB.
4. **Route B: Claude models her by hand.** If the AI face looks wrong, have Claude build her from simple shapes in Blender Python: a pear-shaped body, round head, long ears, stubby arms, big feet, cream tummy and face patches, and a terry-cloth material. Claude checks viewport screenshots against the photos and adjusts. The result is cute and recognisable rather than an exact copy.
5. **Clean up and rig.** Claude separates the ears, reduces to about 30–50k triangles, and adds the 8 bones: root, body, head, jaw/cheeks, two per ear, one per arm. Route B builds the rig at the same time as the model.
6. **Export** as GLB with Draco compression.

**Fallback:** if neither route looks right, commission a Blender artist on Fiverr (roughly £100–300, 1–2 weeks).

## Phase 2: Make her talk

Goal: a live, two-way voice call in the browser, with replies in under a second and the ability to interrupt.

Use the [OpenAI Realtime API](https://developers.openai.com/api/docs/guides/realtime-webrtc) over WebRTC. It is speech-to-speech, so there's no separate transcription or text-to-speech step, and WebRTC gives echo cancellation for free.

1. **Token endpoint.** A Next.js route (`/api/session`) holds the real API key. It creates a short-lived client secret via `/v1/realtime/client_secrets` and returns it to the browser. The real key never reaches the phone.
2. **Browser connects.** Use the `@openai/agents/realtime` SDK (`RealtimeAgent` + `RealtimeSession`) with the ephemeral key. It handles the mic, speaker and WebRTC handshake.
3. **Pick the voice.** Test the built-in voices and choose the softest, warmest one. If none feels right, the upgrade path is ElevenLabs Agents with a custom-designed voice.
4. **Expose the reply audio.** Route the bunny's incoming audio track through a Web Audio `AnalyserNode`. Phase 3 uses this to drive the talking animation.
5. **Listen for events.** Speech started/stopped (to switch between listening and talking poses) and transcripts (used for memory in Phase 4).

Tip: older tutorials call `/realtime/sessions`. That is the beta endpoint and will fail.

## Phase 3: Bring her to life

Goal: the bunny feels alive and stays looking like a plush toy, never like a realistic animal.

Render with React Three Fiber (Three.js), using `@react-three/drei` for loading the GLB and soft studio lighting. Every animation is procedural code, so no animator is needed.

| State | What moves | Driven by |
| --- | --- | --- |
| Idle | Slow breathing (body scale ±2%), gentle sway, occasional ear twitch | Timers + noise |
| Listening | Head tilts toward camera, ears lift slightly | User speech started |
| Talking | Head bob, body squish, cheek/jaw nudge, ears bounce | Reply audio volume (`AnalyserNode`) |
| Thinking | Small head tilt, one ear droops | Gap between her speech and the reply |
| Excited | Little hop, both ears flick up | Keyword or tool call from the model |

Key details:

- **Ears use spring physics.** Each ear bone follows the head with a damped spring. That lag and wobble is the most "alive" thing on screen.
- **Don't animate a real mouth.** Her face is stitched. A small squash of the lower face timed to volume reads as speech; lip shapes would look creepy.
- **Smooth the audio.** Average volume over about 80 ms so movement isn't jittery.
- **Scene:** a soft blurred background in her home's colours, warm key light, plus a fuzzy-fur shader (rim light) so it reads as terry cloth.

## Phase 4: Give her a personality

Goal: it sounds like *her* bunny, not a generic assistant. This phase matters more than the graphics.

1. **Write the character sheet** as the system prompt:
   - Name, age ("how long she's had me"), and what she calls the bunny.
   - Personality: e.g. gentle, a bit cheeky, easily impressed, loves naps.
   - The bunny's world: where it sits in the flat, what it sees during the day.
   - Ten real memories and inside jokes only you two would know.
   - Rules: replies of 1–3 sentences, never says it's an AI, gives no serious advice.
2. **Add memory.** After each call, send the transcript to a cheap text model and ask for 3–5 new facts worth remembering. Store them in Supabase (one table: `memories`). Inject the latest 30 into the prompt at the start of the next call.
3. **Small tools** the model can call: `get_time_of_day` (so it says good morning or goodnight), and `do_trick` (triggers the hop animation).
4. **Tune by testing.** Have 10 test chats yourself and rewrite anything that sounds robotic.

## Phase 5: FaceTime feel, polish and deploy

1. **Call flow:** a contact card with the bunny's photo → "Calling…" with a ringtone → she picks up → an end-call button. Optionally, a small self-view of her front camera in the corner.
2. **Mobile first:** full-screen, portrait, and installable to the home screen as a PWA with the bunny as the app icon. iOS Safari needs a tap before the mic and audio start, which the Call button provides.
3. **Privacy:** a simple passcode or magic-link login so only she can call. Don't store audio; store only the extracted memories.
4. **Deploy** to Vercel (free tier). Keep the API key in Vercel environment variables. Set a monthly spend cap in the OpenAI dashboard.
5. **Optional extra:** let the bunny see her through the camera (send a frame every few seconds) so it can say "ooh, nice jumper".

## Timeline

About three weeks of evenings and weekends, using Claude Code for most of the code.

1. **Weekend 1:** scaffold Next.js + R3F with a placeholder bunny; get the voice call working end to end (Phases 2 and 3 basics).
2. **Week 1 evenings:** photograph the toy, generate and fix the model, rig and swap it in (Phase 1).
3. **Weekend 2:** animation states, ear springs, write the personality and memories (Phases 3 and 4).
4. **Week 2 evenings:** call UI, PWA, passcode, deploy; 10 test calls yourself (Phase 5).
5. **Reveal:** hand her the phone with the bunny calling.

## Costs (approximate)

| Item | Cost |
| --- | --- |
| Blender + Blender MCP + Hyper3D trial key | Free |
| OpenAI Realtime voice | Pay per use; set a cap of \~£20/month |
| Vercel + Supabase | Free tiers |
| Blender artist (only if both routes fail) | \~£100–300 |

Check current Realtime pricing before launch; it is billed per audio token, so long calls add up.

## Risks

- **The 3D model looks "off".** This is the biggest risk. Mitigation: multiple generations, hand fixes in Blender, or the artist fallback.
- **Lag on her phone.** Mitigation: keep the model under 50k triangles, cap the frame rate at 30 on mobile.
- **The bunny says something out of character.** Mitigation: a tight system prompt and short replies; test before the reveal.
- **iOS audio quirks.** Mitigation: start everything from the Call tap and test on her actual phone model.

## Open questions

- [ ] What's the bunny's name, and what does she call it?
- [ ] What voice should it have: high and squeaky, soft and sleepy, or something else?
- [ ] Is this a surprise, or will she help shape the personality?
- [ ] Which phone does she use (iPhone or Android)?
