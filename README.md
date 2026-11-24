# Oney: the talking bunny

A private web app. Mommy taps **Call** on her phone, and her plush bunny Oney picks up as a fluffy 3D bunny on a FaceTime-style call. Oney talks back in a little girl's voice, moves, and remembers things between calls.

**Everything (how it works, setup, workflows, tests) is in [AGENTS.md](AGENTS.md).**

Quick start:

```bash
npm install
cp .env.example .env.local     # set OPENAI_API_KEY
npm run dev                    # http://localhost:3000  (/preview shows the bunny without a call)
```

Reference photos of the real toy are in `reference/photos/`.
