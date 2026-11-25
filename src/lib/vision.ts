/**
 * Oney watches Miri's camera, on the phone itself.
 *
 * MediaPipe's face landmarker (with blendshapes: smiles, frowns, brows) and
 * gesture recogniser (open palm, thumbs up, "I love you" sign) run in the
 * browser on the self-view <video>. Nothing from this is uploaded: only the
 * resulting *events* are used, to make the bunny react instantly (wave back,
 * cheer, giggle, cuddle) and to tell the voice model what she just saw.
 *
 * `ReactionLogic` is the pure state machine (easy to reason about and test);
 * `VisionWatcher` feeds it from the camera.
 */
import { bunnyState, triggerGesture, triggerTrick } from "./bunnyState";
import { getQuality } from "@/components/bunny/quality";

export type VisionEvent = "face_seen" | "smile" | "wave" | "sad" | "thumbs_up" | "love";

/** One analysed frame. Any field may be missing (face and hands run on alternate ticks). */
export type VisionFrame = {
  t: number; // seconds
  face?: { present: boolean; smile: number; frown: number; browUp: number };
  hands?: { gesture: string; score: number }[];
};

const MEDIAPIPE_VERSION = "1.2.2"; // keep in step with package.json
const WASM_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/wasm`;
const FACE_MODEL = "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";
const GESTURE_MODEL = "https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task";

/**
 * Turns noisy per-frame signals into a few clear events, with hold times (a
 * smile must last a moment) and cooldowns (she doesn't wave back ten times).
 */
export class ReactionLogic {
  private lastFaceAt = -1e9;
  private faceRun = 0;
  private seenOnce = false;
  private smileRun = 0;
  private sadSince: number | null = null;
  private smileArmed = true;
  private smileLowSince: number | null = null;
  private last: Record<VisionEvent, number> = { face_seen: -1e9, smile: -1e9, wave: -1e9, sad: -1e9, thumbs_up: -1e9, love: -1e9 };
  private handHist: { t: number; g: string }[] = [];
  /** Latest smoothed scores, for debugging (/preview?debug=1). */
  scores = { smile: 0, sad: 0, face: false, hand: "" };

  constructor(private emit: (e: VisionEvent) => void) {}

  private fire(e: VisionEvent, t: number, cooldown: number) {
    if (t - this.last[e] < cooldown) return;
    this.last[e] = t;
    this.emit(e);
  }

  push(f: VisionFrame) {
    const t = f.t;
    if (f.face) {
      const { present, smile, frown, browUp } = f.face;
      this.scores.face = present;
      if (present) {
        this.faceRun++;
        // Seeing her (again): the first time, or after she'd been away for a while.
        if (this.faceRun >= 2 && (!this.seenOnce || t - this.lastFaceAt > 20)) {
          this.seenOnce = true;
          this.fire("face_seen", t, 8);
        }
        if (this.faceRun >= 2) this.lastFaceAt = t;

        this.scores.smile = smile;
        // Many resting faces already read ~0.3-0.4 "smile", so fire high and re-arm just below.
        if (smile > 0.55) {
          this.smileLowSince = null;
          // Two smiling looks in a row (~0.25 s on a phone): a real smile, not a blip.
          if (++this.smileRun >= 2 && this.smileArmed) {
            this.smileArmed = false; // once per smile; re-arms when the smile has properly faded
            this.fire("smile", t, 30);
          }
        } else if (smile < 0.45) {
          this.smileRun = 0;
          // Talking and laughing make the score flicker around the threshold, so a
          // smile only counts as "over" after a couple of seconds without it.
          this.smileLowSince ??= t;
          if (t - this.smileLowSince >= 2) this.smileArmed = true;
        }

        // A sad face: mouth corners down and/or brows pinched up, and no smile.
        const sad = smile < 0.2 ? Math.max(frown * 1.3, frown + 0.6 * browUp) : 0;
        this.scores.sad = sad;
        if (sad > 0.42) {
          this.sadSince ??= t;
          if (t - this.sadSince >= 1.4) this.fire("sad", t, 45);
        } else this.sadSince = null;
      } else {
        this.faceRun = 0;
        this.smileRun = 0;
        this.smileLowSince = null;
        this.sadSince = null;
      }
    }
    if (f.hands) {
      const best = f.hands.filter((h) => h.score > 0.55).sort((a, b) => b.score - a.score)[0];
      this.scores.hand = best?.gesture ?? "";
      this.handHist.push({ t, g: best?.gesture ?? "None" });
      // The last few hand looks (however fast this device analyses), within a couple of seconds.
      this.handHist = this.handHist.filter((h) => t - h.t < 2.5).slice(-4);
      const count = (g: string) => this.handHist.filter((h) => h.g === g).length;
      // On a video call, a palm held up to the camera *is* a wave.
      if (count("Open_Palm") >= 2) this.fire("wave", t, 7);
      if (count("Thumb_Up") >= 2) this.fire("thumbs_up", t, 10);
      if (count("ILoveYou") >= 2) this.fire("love", t, 10);
    }
  }
}

/**
 * What the voice model hears about the camera. Her *body* reacts to every
 * event (`reactLocally`); her *voice* hears about it rarely, because every note
 * stays in the conversation and colours her next replies. (Sending a "say
 * something about her smile" note on every smile made her compliment Miri's
 * smile in every single sentence.)
 *
 * - `saw`: what happened, as plain background.
 * - `speak`: added only when she is allowed to speak up about it right now
 *   (nobody talking, see `onVision` in useBunnyCall.ts). null = never prompts her.
 * - `later`: what to do with it in her next reply when she can't speak up right
 *   now (someone is talking). null = a passing moment (a smile, a wave): dropped,
 *   not queued, because by her next turn it would be stale.
 * - `every`: tell the voice model at most once per this many seconds.
 */
export type VideoNote = { saw: string; speak: string | null; later: string | null; every: number };

export const VIDEO_NOTES: Record<VisionEvent, VideoNote> = {
  face_seen: {
    saw: "Miwi's face just came onto the video.",
    speak: "You're happy to see her. Say a tiny, sweet hello about seeing her (you're already cheering — never describe it).",
    later: "In your next answer, a tiny happy \"I can see you!\" bit, then answer her.",
    every: 60,
  },
  wave: {
    saw: "Miwi waved at you on the video (you're already waving back).",
    speak: "Just a tiny \"hi!\", nothing more.",
    later: null,
    every: 30,
  },
  smile: {
    saw: "Miwi smiled at you on the video just now.",
    speak:
      "At most a tiny giggle or two or three happy words, then carry on with whatever you were talking about. Don't compliment her smile if you already did on this call.",
    later: null,
    every: 300,
  },
  sad: {
    saw: "Miwi looks a bit sad on the video.",
    speak:
      'Be her sweet little comforter: gentle and cuddly, ask like a kid ("Miwi, why you got a sad face?"), offer a big cuggle, and say something silly to make her giggle. (You\'re already cuddling — don\'t describe it.)',
    later: "In your next answer be extra sweet and cheerful, and if it fits, ask like a kid why she's sad and offer a cuggle.",
    every: 120,
  },
  thumbs_up: {
    saw: "Miwi gave you a thumbs up on the video (you're clapping).",
    speak: "A tiny proud reaction, two or three words.",
    later: null,
    every: 120,
  },
  love: {
    saw: "Miwi did the I-love-you hand sign on the video (you're cuddling).",
    speak: "A tiny, soft \"wuv you too\".",
    later: "In your next answer, tell her you wuv her too (tiny), then answer her.",
    every: 120,
  },
};

/** The `[video]` system note for an event: with its cue if she's speaking up about it, else as background. */
export function videoNoteText(e: VisionEvent, speaking: boolean): string {
  const n = VIDEO_NOTES[e];
  if (speaking && n.speak) return `[video] ${n.saw} ${n.speak}`;
  return `[video] ${n.saw} ${n.later ?? "(Background only. Don't mention it unless it really fits what you're saying.)"}`;
}

/** Her body's instant reaction to what she sees (the voice reaction comes from the model). */
export function reactLocally(e: VisionEvent) {
  const busy = bunnyState.gesture && bunnyState.gesture.until > performance.now();
  switch (e) {
    case "face_seen":
      triggerGesture("cheer");
      setTimeout(() => triggerTrick("hop"), 2300);
      break;
    case "wave":
      triggerGesture("wave");
      break;
    case "smile":
      if (!busy) triggerTrick("giggle");
      break;
    case "sad":
      triggerGesture("nuzzle", 4.5);
      break;
    case "thumbs_up":
      triggerGesture("clap");
      break;
    case "love":
      triggerGesture("nuzzle");
      break;
  }
}

type Tasks = typeof import("@mediapipe/tasks-vision");

/** Runs the detectors on a <video> (or canvas) a few times a second. */
export class VisionWatcher {
  private face: import("@mediapipe/tasks-vision").FaceLandmarker | null = null;
  private hands: import("@mediapipe/tasks-vision").GestureRecognizer | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private tick = 0;
  private stopped = false;
  logic: ReactionLogic;

  constructor(
    private source: HTMLVideoElement,
    onEvent: (e: VisionEvent) => void,
  ) {
    this.logic = new ReactionLogic(onEvent);
  }

  async start() {
    const mp: Tasks = await import("@mediapipe/tasks-vision");
    const files = await mp.FilesetResolver.forVisionTasks(WASM_URL);
    const make = async <T,>(fn: (delegate: "GPU" | "CPU") => Promise<T>) => {
      try {
        return await fn("GPU");
      } catch {
        return await fn("CPU");
      }
    };
    const [face, hands] = await Promise.all([
      make((delegate) =>
        mp.FaceLandmarker.createFromOptions(files, {
          baseOptions: { modelAssetPath: FACE_MODEL, delegate },
          runningMode: "VIDEO",
          numFaces: 1,
          outputFaceBlendshapes: true,
        }),
      ),
      make((delegate) =>
        mp.GestureRecognizer.createFromOptions(files, {
          baseOptions: { modelAssetPath: GESTURE_MODEL, delegate },
          runningMode: "VIDEO",
          numHands: 2,
        }),
      ),
    ]);
    if (this.stopped) {
      face.close();
      hands.close();
      return;
    }
    this.face = face;
    this.hands = hands;
    this.loop();
  }

  private loop = () => {
    if (this.stopped) return;
    // A few analyses a second (fewer on phones), alternating face and hands, so it runs beside the fur.
    this.timer = setTimeout(this.loop, getQuality().visionIntervalMs);
    const v = this.source;
    if (v.readyState < 2 || v.videoWidth === 0 || document.hidden) return;
    const now = performance.now();
    const t = now / 1000;
    try {
      if (this.tick++ % 2 === 0 && this.face) {
        const r = this.face.detectForVideo(v, now);
        const bs = r.faceBlendshapes?.[0]?.categories ?? [];
        const g = (n: string) => bs.find((c) => c.categoryName === n)?.score ?? 0;
        this.logic.push({
          t,
          face: {
            present: r.faceLandmarks.length > 0,
            smile: (g("mouthSmileLeft") + g("mouthSmileRight")) / 2,
            frown: (g("mouthFrownLeft") + g("mouthFrownRight")) / 2,
            browUp: g("browInnerUp"),
          },
        });
      } else if (this.hands) {
        const r = this.hands.recognizeForVideo(v, now);
        this.logic.push({
          t,
          hands: r.gestures.map((gs) => ({ gesture: gs[0]?.categoryName ?? "None", score: gs[0]?.score ?? 0 })),
        });
      }
    } catch (e) {
      console.warn("[vision]", e);
    }
  };

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.face?.close();
    this.hands?.close();
    this.face = this.hands = null;
  }
}
