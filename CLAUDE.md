# Oney — project notes for Claude

A private talking-bunny web app (see README.md). The bunny is **Oney**, a little
girl plush bunny who video-calls "Mommy".

## The north star: she is a 3–4 year old little girl
Every change to voice, prompt or personality must keep this true:
- **Voice:** a small child's — high, squeaky, bubbly. Realtime voices are adults,
  so we use `coral` + a client-side pitch shift (`pitchSemitones`, default +4,
  `public/pitch-shifter.worklet.js`).
- **Pronunciation:** toddler sounds (da/den/dat, w for r/l, "pasketti", "nana",
  "free" for three) — about one or two baby-words per sentence, always understandable.
- **Grammar:** "I runned", "me so happy", "bestest", talks about herself as "Oney".
- **Sentence structure:** tiny sentences, "and... and... and den", repetition,
  sudden topic jumps, "why?" questions. Never grown-up phrases.
- **Body language:** wave (paw beside face), nuzzle/cuddle, sad (head sags, paws
  over face), plus hops — via the `express` tool, never narrated.

All of this lives in `src/bunny.config.ts` (`speech`, `voiceStyle`, examples) and
`src/lib/prompt.ts`. Test changes with a realtime run and read the transcripts:
if any line sounds like a grown-up, it's a bug.
