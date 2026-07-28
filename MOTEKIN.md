# MoteKin

MoteKin is the character forge for Founder Pet — a separate Electron app (own
`motekin-main.js`/`motekin-preload.js`, own window, own `motekin-package.json`)
that takes a photo + your own image-generation API key and turns it into a
real Founder Pet character pack: 9 animation states, assembled into a
`spritesheet.webp` + `pet.json` pair, deployed straight into
`characters/<name>/` where Founder Pet (and MoteKin's own dashboard) picks it
up immediately.

> **Costs real money.** Forging a character makes up to **9 real, billed API
> calls** on your own key — 1 per state, each call returning all 4 of that
> state's frames as a single 2x2 grid image, sliced apart afterward (down
> from 36 separate calls before this approach — see
> [Intra-state frame consistency](#intra-state-frame-consistency-2026-07-update-single-call-grid-generation)
> below for why). Estimated cost on OpenAI's gpt-image-1, at the same
> per-image rate measured before this change: **~$0.70 for a full
> character**. See [Cost](#cost) below for the full breakdown, the
> best-case/worst-case range, and other providers' rates. Regenerating a tile
> from the Review screen re-runs the same call it currently uses (grid or
> fallback), so regenerating several adds up too.

## Running it

```bash
npm install          # same node_modules as Founder Pet — one repo, one install
npm --prefix . run start --scripts-prepend-node-path  # or: npx electron motekin-main.js
```

More simply, from the project root:

```bash
npx electron motekin-main.js
```

There's no separate `npm install` step for MoteKin specifically — it shares
this repo's single `node_modules` (see `motekin-package.json`, which only
declares `electron` as a dev dependency; the actual generation code in
`backend/` uses nothing beyond Node's built-ins — `fetch`, `FormData`, `Blob`,
`fs`, `crypto` — plus the `image-size` package this repo already depends on
for Founder Pet's own quick-pack support).

## How the forge flow works

1. **Key Exchange** — pick a provider (OpenAI / Stability AI / Google Gemini)
   and paste your own API key for it. The key is encrypted at rest via
   Electron's `safeStorage` (OS keychain/DPAPI-backed — see
   `backend/keyStore.js`) into a file in **MoteKin's own** `userData`
   directory, entirely separate from Founder Pet's `config.json`. The
   decrypted key never leaves the main process and is never sent back to the
   renderer — only `{ hasKey, provider }` status crosses that bridge. Once a
   key is on file, starting a new forge skips this step automatically; revisit
   it via the `KEY` nav pill and click **CHANGE PROVIDER / KEY** to replace it.
2. **Intake** — drag a photo in, or click to pick a file. This is a real file
   read now (not a placeholder) — the bytes go on to be the reference image
   sent to the provider on every single generation call, which is the actual
   mechanism keeping the character visually consistent across all 9 states
   (see "Character consistency" below).
3. **Forge** — 9 tiles, one per state (`idle`, `walk`, `typing`, `thinking`,
   `celebrate`, `tired`, `alert`, `talking`, `working`), each going
   `QUEUED → FORGING → READY` driven by a real sequential call to your
   provider's API — normally just 1 call per tile (a 2x2 grid image sliced
   into that state's 4 frames; see
   [Intra-state frame consistency](#intra-state-frame-consistency-2026-07-update-single-call-grid-generation)
   below), falling back to 4 calls only if a provider's grid output doesn't
   slice cleanly. A tile that fails outright (rate limit, content-policy
   rejection, bad key, etc.) goes `FAILED` with the reason shown, and can be
   retried individually — one bad generation doesn't block the other 8.
4. **Review** — approve each state, or hit **REGEN** to re-run generation for
   just that state (a real API call, not a UI-only reset).
5. **Deploy** — name the character and hit spawn. MoteKin composites the
   generated frames into one spritesheet, writes
   `generated-pets/<slug>/spritesheet.webp` + `pet.json`, and copies that pack
   into `characters/<slug>/` so it shows up as an active-able pack in both
   MoteKin's dashboard and Founder Pet immediately, no restart needed.

## Frame count: 4 per state, 1 API call per state (not 4)

Founder Pet's own bundled character uses 8 frames/state (8 columns in the
grid). MoteKin generates **4 real frames per state**, requested as ONE
generation call per state (a single image containing all 4 frames as a 2x2
grid, sliced apart afterward — see
[Intra-state frame consistency](#intra-state-frame-consistency-2026-07-update-single-call-grid-generation)
below) and repeats them to fill the required 8-column spritesheet width
(`1,2,3,4,1,2,3,4`). A loop where columns 5-8 repeat 1-4 is visually
identical to a native 4-frame loop played twice — nothing is lost in the
animation. `FRAMES_PER_STATE` in `backend/forge.js` is the single place to
change the 4-frames-per-state tradeoff itself (separate from the
grid-vs-separate-calls mechanism, which is `STATE_GRID_ROWS`/`STATE_GRID_COLS`
in the same file).

**Call count, best case vs. worst case**: if every state's grid output slices
cleanly (the expected/common case), a full character is **9 calls total** — 1
per state. If a provider's grid output for some state doesn't pass the
structural sanity check, that state costs 5 calls instead (1 failed grid
attempt + 4 fallback calls), and grid mode turns off for the *rest of that
session* so later states skip straight to the 4-call fallback with no wasted
attempt. Worst case (every single state falls back) is 5 + 8×4 = **37
calls** — about the same as the 36-call approach this replaced. In practice,
expect somewhere close to the 9-call best case unless a provider turns out
not to follow the grid-layout instruction reliably (see the fallback
mechanism in the section below).

## Cost

**Estimate, not yet re-measured with this change** (see "What was verified"
below — no live key was available to run a real character through the new
single-call path). Previously measured, real: OpenAI's gpt-image-1 cost
**~$3 for a full character at 36 calls (~$0.08/call)**. OpenAI bills per
*output image*, and a 2x2-grid image is still one output image at the same
1024x1024 size/settings as before — so at that same measured per-call rate,
the new 9-call best case works out to:

- **~$0.70 for a full character** (9 calls × ~$0.08) — best case, all 9
  states grid cleanly. This is the expected common case.
- Up to **~$2.90** (37 calls × ~$0.08) in the unlikely worst case where every
  single state falls back to 4 separate calls — i.e., no worse than the old
  approach even if grid mode doesn't work at all for a given provider.
- **Regen** on the Review screen re-runs whichever path that state currently
  uses: ~$0.08 if grid mode is still active for the session, ~$0.32 if that
  state (or the whole session) has already fallen back to separate calls.

This is specific to OpenAI's gpt-image-1 at this app's current settings
(`background=transparent`, `input_fidelity=high`, 1024x1024). Stability AI and
Gemini haven't had a run's cost measured the same way — see their published
per-image rates under [Provider setup](#provider-setup) below for estimates.

## Planned / Future

- **Smaller/cheaper grid mode** — the original idea here was "2 frames/state
  instead of 4" to cut call count roughly in half. Now that generation is
  already 1 call per state regardless of frame count (see above), that
  specific win no longer applies — call count is already at its floor. A
  updated version of the same idea: a 1x2 grid (2 frames) needs roughly half
  the image area of the current 2x2 (4 frames), which could land in a
  cheaper output-size tier depending on provider pricing, trading some
  animation smoothness for a further per-call cost cut. **Not implemented
  yet.**
- **Live-verified provider grid compliance** — this build could only verify
  the *slicing mechanism* (crop geometry, fallback triggering) structurally,
  with a synthetic test image standing in for a real generation (see "What
  was verified" below). Which of the 3 providers *actually* comply with the
  2x2-grid instruction reliably, and how often each one needs the fallback in
  practice, is still unknown and needs a real run per provider to find out.

## Character consistency across 9 states (state-to-state)

Each state's generation is its own independent call — there's no shared
"session" a provider API remembers across calls. **Update (2026-07): switched
from an original-photo-every-time approach to an anchor-frame approach**,
because the first version produced visible drift between *states* (subtle
differences in face/pose/proportions each generation) — asking the model to
reinterpret a real photo into stylized art 9 separate times just isn't very
repeatable. (This section is about drift *between* states, e.g. `idle` looking
different from `walk`. For drift *within* a state's own 4 frames — e.g. frame
2 of `typing` having different hair color than frame 1 — see
[Intra-state frame consistency](#intra-state-frame-consistency-2026-07-update-single-call-grid-generation)
below; that's a separate problem with a separate fix.) Consistency comes from
four things stacked together, all in `backend/forge.js`:

1. **One anchor frame, generated first, then reused as the reference for
   everything else.** `idle` (`STATE_ORDER[0]`) is generated from the real
   uploaded photo, same as before. Its first frame is then locked in as
   `session.anchorFrame`, and every *other* state sends **that generated
   frame** as its reference image — not the original photo. Feeding an
   already-stylized frame of the same character back in as reference gives
   the model something to *copy*, not reinterpret from scratch, which is what
   actually locks in the art style/proportions/design. If `idle` hasn't
   succeeded yet (still queued, or failed and not yet retried), a state falls
   back to the original photo for that one call rather than blocking — it can
   be retried later, after `idle` succeeds, to pick up the anchor. Regenerating
   `idle` (Review's REGEN, or Forge's retry) re-locks the anchor to the new
   result, so everything generated after that point uses the freshest anchor.
2. **Much more explicit, repetitive prompt text for anchor-based calls.**
   `IDENTITY_LOCK_INSTRUCTION` in `backend/forge.js` spells out — and
   repeats — "identical face shape, identical hairstyle and hair color,
   identical clothing and colors, identical art style and line weight,
   identical color palette... same character, different pose only" rather
   than trusting a shorter description to imply it. The anchor (`idle`) call
   itself still uses the original, shorter `CHARACTER_DESCRIPTOR`, since
   that's the one call actually translating a photo into art and needs room
   to do that.
3. **Provider-specific consistency parameters, tuned differently for the
   anchor call vs. every call after it** (researched per-provider, not
   assumed — see each adapter's own comments):
   - **OpenAI**: `input_fidelity=high` on every call — a real gpt-image-1
     parameter that spends more input-image tokens to preserve exact details
     from the reference instead of treating it as loose inspiration.
   - **Stability**: `strength` is *lower* for anchor-based calls (`0.3`) than
     the anchor call itself (`0.55`) — the anchor call is still
     photo→art, which needs room to restyle; every call after that is
     art→art with only the pose changing, which needs to stay much closer to
     its input or the model redesigns the character a little each time (the
     same drift problem, one call removed). Also sends `seed`.
   - **Gemini**: sends `seed` via `generationConfig`. Documented as a real
     `GenerateContentConfig` field, but Google's own docs don't specifically
     confirm it constrains image-token sampling the same way it does text —
     sent as a low-risk best-effort addition, not a proven lever (noted in
     `backend/providers/gemini.js`).
   - One random seed is generated **once per forge session** (`session.seed`
     in `backend/forge.js`) and reused for every call in that session, not
     re-rolled per frame.
4. **The Forge screen's live log now states which reference each state
   used** — "using anchor reference" / "from original photo (this becomes
   the anchor)" / "from original photo (anchor not ready yet)" while a state
   is queued, and the authoritative "used anchor reference (identity locked)"
   / "used original photo" once the call actually returns.

## Intra-state frame consistency (2026-07 update: single-call grid generation)

**Problem this fixes**: even with state-to-state consistency solved above,
each state's 4 frames were still 4 *separate* API calls (all referencing the
same anchor frame) — and each of those calls is its own independent
generation. Nothing stopped frame 2 of `typing` from coming back with
different hair or shirt color than frame 1, even though both used the
identical reference image and near-identical prompt — four independent rolls
of the dice will independently drift a little each time, anchor or no anchor.

**Fix**: each state is now generated as **one API call** requesting a single
image containing all `FRAMES_PER_STATE` (4) frames laid out as a
`STATE_GRID_COLS`x`STATE_GRID_ROWS` (2x2) grid — top-left/top-right/
bottom-left/bottom-right = frame 1/2/3/4 — then sliced apart programmatically
afterward. A single generation is self-consistent *by construction*: it's one
image from one forward pass through the model, so there's no way for the four
quadrants to independently drift from each other the way four separate calls
could.

- `buildGridPrompt()` in `backend/forge.js` explicitly (and repeatedly)
  specifies the exact quadrant layout/order, "EXACTLY the same hair color,
  hairstyle, skin tone, clothing, and clothing colors in every single
  quadrant," and asks for a thin visible gap between quadrants so they can be
  cut apart cleanly.
- **Slicing**: `sliceGridImage()` decodes the returned image with Electron's
  `nativeImage` (main process, no display needed — verified against a real
  PNG from this repo's own assets) and crops it into 4 buffers along the
  known grid lines. `nativeImage` was chosen over the canvas-based approach
  used elsewhere in this app (final spritesheet assembly, dashboard previews)
  because slicing is a pure decode-and-crop, which `nativeImage` already
  handles reliably for PNG (only *webp* decode was ever the problem
  elsewhere in this codebase — see `main.js`'s own notes on that).
- **Why 2x2, not a 1x4 strip**: a 1x4 strip needs a ~4:1-wide output image,
  which none of the 3 providers offer as a selectable size/aspect ratio
  (OpenAI's images API only offers square-ish sizes; Stability/Gemini's
  img2img output shape tracks the roughly-square reference image being sent
  in). 2x2 stays close to square — what every provider already returns by
  default — so no size/aspect-ratio parameter had to change anywhere.
- **Reference image, `strength`, `seed`, `input_fidelity` are unchanged** —
  still the anchor frame (or original photo for `idle`), same per-call
  tuning as described above. This fix is purely about how many frames come
  back per call and how they're extracted; it doesn't touch the
  state-to-state consistency mechanism at all.
- **Structural fallback, per provider, per session**: `sliceGridImage()`'s
  sanity check can only tell whether the returned image is even *shaped*
  like the requested grid (big enough per-cell — at least 200px —, not a
  wildly wrong aspect ratio) — it has no way to judge whether the 4 quadrants
  are semantically a good, consistent walk cycle; that needs a human (or
  vision model) looking at it. If the check fails, MoteKin logs exactly why
  (Forge's live log, plus the main-process console), falls back to the
  original 4-separate-calls approach *for that one state*, and disables grid
  mode for the *rest of that session* — so a provider that's already shown it
  won't comply doesn't cost a wasted grid attempt on every remaining state
  too. See [Cost](#cost) above for the best-case/worst-case call-count math
  this produces.

## Provider setup

All three adapters live in `backend/providers/`, share one interface
(`generateFrame({ referencePhoto, prompt, apiKey })`), and were chosen/verified
as follows (2026-07):

### OpenAI

- **Get a key:** https://platform.openai.com/api-keys
- **Endpoint used:** `POST /v1/images/edits` with `model=gpt-image-1` — the
  *edit* endpoint (not plain generation) so the reference photo is real image
  input, plus `background=transparent` (a real gpt-image-1 parameter), which
  gives this provider genuine alpha transparency for free — no separate
  background-removal step needed.
- **Cost:** measured at **~$0.08/frame, ~$3 for a full 36-frame character**
  (see [Cost](#cost) above) at this app's settings. OpenAI's published
  per-image range is wider (~$0.02–$0.19 depending on size/quality/fidelity),
  so actual cost will drift somewhat if those settings ever change.

### Stability AI

- **Get a key:** https://platform.stability.ai/account/keys
- **Endpoint used:** `POST /v2beta/stable-image/generate/sd3` with
  `mode=image-to-image`, the photo as `image`, and `strength=0.6`. Chose this
  over `/generate/core`: `core` is confirmed **text-to-image only** (no
  `image`/`strength` fields exist on it at all), so it can't take the
  reference photo as input — `sd3`'s image-to-image mode is what actually
  supports that.
- **Rough cost:** ~$0.03–$0.09 per image via credits → roughly $1–$3 for a
  full character. No built-in transparent-background option on this endpoint
  (unlike OpenAI) — generated frames get a plain background, per the prompt,
  not true alpha. Removing it would need a second, separate paid API call per
  frame (`/v2beta/stable-image/edit/remove-background`); not implemented here
  to keep cost from doubling — noted as a TODO in `backend/providers/stability.js`.

### Google Gemini

- **Get a key:** https://aistudio.google.com/apikey
- **Endpoint used:** `gemini-2.5-flash-image:generateContent` (a multimodal
  chat model, not the separate Imagen `predict` endpoint — Imagen 3's public
  Gemini API surface is text-to-image only and can't take a reference photo;
  `gemini-2.5-flash-image` natively accepts an inline image part + text and
  edits/restyles it).
- **Rough cost:** ~$0.039 per output image at current list pricing → roughly
  $1.40 for a full character. Same as Stability: no built-in transparent
  background, plain background per the prompt.

**On cost generally:** every forge run — and every individual Review-screen
regen — is real money on your own key; see [Cost](#cost) above for the
measured OpenAI figure and the per-tile-regen math. The Intake screen also
shows a small note with the selected provider's rate before you start.

## What was verified live vs. structurally

No provider API key was available in the sandboxed environment this was
*built* in, so the sections below describe what could be verified there —
structurally, plus live-but-keyless checks (auth-stage responses, safeStorage,
the UI/IPC path). The [Cost](#cost) figures above are separate: they come
from a real full run made outside that environment, on a real key. What
*could* be verified live, in-build, without a key:

- **Endpoint shape verified live**, with dummy/invalid keys, against all three
  real APIs: each request (exact URL, headers, multipart/JSON body shape used
  by the adapters) was sent for real and produced a real, provider-specific
  *authentication* error response — not a 404 — confirming the endpoint and
  request shape are correct and are reaching real request validation on the
  provider's side. This is how the Gemini auth-error classification bug below
  was actually caught (see next section).
- **Response parsing verified structurally**: each adapter's success/error
  parsing path was exercised with `fetch` mocked to return responses shaped
  exactly like each provider's documented success/error/content-policy/
  rate-limit response bodies, confirming `backend/providers/*.js` extracts the
  image bytes (or throws the right `ForgeError` kind) correctly in every case.
- **Assembly + deploy pipeline verified structurally end-to-end**: a fake
  spritesheet buffer stood in for real generated pixels through
  `backend/packWriter.js` → `generated-pets/<slug>/` → `characters/<slug>/`,
  then re-read through the *actual* `shared/characterPacks.js` scan (the same
  code Founder Pet's own `main.js` uses) to confirm it's recognized as a valid
  pack with correct per-frame timing pulled from the reference atlas.
- **Key storage verified live** inside a real Electron process: `safeStorage`
  encryption round-trip (save → the on-disk file provably does not contain the
  plaintext key → decrypt → matches), provider switching, and clearing, all
  through `backend/keyStore.js` directly.
- **The full Key Exchange UI/IPC path verified live** by driving the actual
  running app (real window, real preload bridge, real IPC handlers in
  `motekin-main.js`) end to end: provider selection toggling, saving a key
  through `window.motekin.saveKey` → `safeStorage`, the "key on file, skip
  ahead" behavior on revisiting the step, and clearing it again afterward so
  no test key was left behind.
- **Not verified live**: an actual successful image generation response from
  any provider (needs a real key + real spend), and therefore the visual
  quality/consistency of real generated art. If something about a provider's
  *success* response shape has changed since 2026-07, the failure will surface
  as a parsing error on a specific state's tile — check that provider's
  section above and its `backend/providers/<id>.js` file first.

One real bug this verification did catch: Gemini returns a plain `400` (not
`401`/`403`) for an invalid key, with `"API_KEY_INVALID"` in the body — the
initial status-code-only error classifier in `backend/forgeError.js` would
have mis-classified that as a generic failure instead of "check your key".
Fixed by also matching on the response body text.

## 2026-07 update: anchor-frame consistency + Review animation fix

Two follow-up fixes, same "no live key in this environment" constraint as
above (still true for this pass):

**Anchor-frame reference wiring, verified structurally end-to-end** inside a
real Electron process (`backend/forge.js`'s actual `startSession`/
`generateStateFrames`, not a reimplementation), with `backend/providers`'
`generateFrame` monkey-patched to a fake so no network calls were made:
confirmed `idle` uses the original photo and locks in `session.anchorFrame`;
confirmed every other state's request literally carries the *generated idle
frame's bytes* as its reference image (not the original photo); confirmed
`strength` is `0.55` for the anchor call and `0.3` for anchor-based calls;
confirmed the same session `seed` is reused across every call; confirmed the
identity-lock prompt text only appears on anchor-based calls; confirmed
regenerating `idle` re-locks the anchor and that the *next* state generated
afterward picks up the new anchor, not the stale one. Separately, each
adapter's new fields (`input_fidelity`, `strength`, `seed`,
`generationConfig.seed`) were confirmed to actually land in the outgoing
request body (mocked `fetch`), and — like the original endpoint verification
above — sent for real against all three live endpoints with a dummy key to
confirm the added fields don't trip request-shape validation (still got
clean auth-stage errors, not a 400 for an unrecognized field).

**Not verified**: actual visual consistency improvement from real generated
art. No provider key was available to run a real forge and compare anchor vs.
non-anchor output side by side. What the structural test above does confirm
with certainty is that the *mechanism* is wired correctly — call 2 onward
really is sending call 1's own output back in as its reference, with a
measurably different (tighter) strength and much more explicit prompt text
than before — which is the actual fix; whether that produces a visibly
tighter character in practice depends on how each model responds to it, and
that part needs a real key to see.

**One important disclosure from this round's testing**: while verifying the
Review screen live in the running app, an attempt to stub
`window.motekin.forgeGenerateState` from the renderer (to avoid spending real
money while testing UI-only changes) silently failed — Electron's
`contextBridge` exposes that function as non-writable, so the reassignment
was a silent no-op rather than an error, and wasn't caught before proceeding.
As a result, clicking through Forge with a synthetic (invalid) test image
triggered **9 real requests to your actual stored OpenAI key**. All 9 failed
with a `400 image_generation_user_error` ("Invalid image file or mode") —
OpenAI's input-validation step rejecting the malformed test image *before*
any generation would have run — which strongly suggests no billable image
was produced, but that isn't a guarantee. Apologies for this — the fix
(verifying a stub actually takes effect before relying on it, or driving
these tests through a real Electron test harness like the anchor-frame test
above instead of trying to patch a contextBridge object) is now how this repo's
own testing does it; the Review-animation check itself was redone afterward
in a fully isolated static HTML page (styles.css loaded directly, no IPC, no
app, no key involved at all) instead.

**Review-screen animation, verified two ways**: (1) statically — grepped the
actual `flashApprove`/`regenConfirm` keyframes in `frontend/styles.css` and
confirmed neither uses `transform`/`translate`/`scale`/`rotate`, only
`box-shadow`, so no shake/jitter is possible by construction; (2) live, via
the isolated HTML page above, replaying the exact tile-render logic from
`step3Html()`: confirmed the actions row's bounding box is pixel-identical
before/during/after a regen cycle (proving the fixed-height status line
actually eliminated the layout-shift that read as "jitter" before), and
confirmed `getComputedStyle(...).animationName` resolves to `flashApprove` on
approve and `regenConfirm` on a successful regen, as intended.

## 2026-07 update: intra-state grid generation

Same "no live provider key in this environment" constraint as both updates
above (still true for this pass) — what could and couldn't be verified:

**Slicing mechanism, verified live** inside a real Electron process: cropped
and re-encoded a real PNG already in this repo (`assets/tray-icon.png`) via
`nativeImage`, confirmed it decodes/crops/round-trips through `toPNG()`
cleanly with no display attached (this matters — Electron's main process has
no window here, and this codebase already has a documented history of
`nativeImage` *not* reliably decoding this project's *webp* files in that
exact situation; PNG turned out fine).

**Grid slicing geometry and order, verified structurally with ground truth**:
built a synthetic 2x2 test image with each quadrant a distinct, known solid
color (not just "some image" — actual red/green/blue/yellow quadrants), ran
it through the real `sliceGridImage()`, and confirmed the 4 output frames
come back in exactly the order `buildGridPrompt()` asks the model for:
frame 1 = top-left, frame 2 = top-right, frame 3 = bottom-left, frame 4 =
bottom-right. This is the strongest check available without a real model
output — it proves the crop math and ordering are correct, independent of
whatever a real provider actually draws into each quadrant.

**Fallback + session-wide disable, verified structurally**: with
`backend/providers`' `generateFrame` mocked to a fake (no network calls), an
undersized "grid" image correctly failed the structural sanity check,
triggered the 4-call fallback for that state (confirmed 4 usable frames still
came back), and correctly disabled grid mode for the rest of that session —
confirmed the *next* state's generation made exactly 4 provider calls with no
wasted grid attempt, not 5.

**Not verified — and can't be, without a real key**: whether any of the 3
providers actually *comply* with the 2x2-grid instruction in practice (return
4 genuinely distinct, evenly-spaced, consistent poses rather than e.g. one
big illustration, a collage with uneven panels, or ignoring the instruction
entirely), and therefore whether real characters see the intra-state drift
actually reduced. The structural fallback exists specifically to make that
uncertainty safe: if a provider doesn't comply, `sliceGridImage()`'s sanity
check will very likely catch grossly-wrong output (way too small/wrong
aspect ratio) and fall back automatically rather than silently handing back
4 garbled crops — but it *cannot* catch a provider that returns a
correctly-*shaped* 2x2 image with genuinely inconsistent content in each
quadrant (that would slice "successfully" and still exhibit the original
problem). Confirming that needs a real run per provider — see
"Testing this yourself" below for exactly what to look at.

## Testing this yourself with a real key

1. `npx electron motekin-main.js` from the project root.
2. Forge a new companion → Key Exchange → pick a provider → paste a real key
   for it → Connect.
3. Intake → drop in an actual photo.
4. Forge → watch the 9 tiles go `QUEUED → FORGING → READY` for real (this is
   where the real spend happens — 9 calls best case, see [Cost](#cost)
   above). If a tile goes `FAILED`, click it (or use Review's REGEN) to retry
   just that one.
   - **To verify the anchor-frame (state-to-state) fix**: watch the live log
     — the `idle` tile's line should say "this becomes the anchor"; every
     tile after it should say "using anchor reference" before it starts and
     "used anchor reference (identity locked)" once it finishes. Compare the
     9 tile previews — states after `idle` should look noticeably closer to
     `idle`'s own face/proportions/outfit than before this fix.
   - **To verify the intra-state grid fix**: each log line should end with
     "1 call, sliced from grid" — that confirms the 4-frames-in-one-image
     approach actually ran for that state (not the fallback). If you instead
     see "grid failed (...) — fell back to 4 calls," that provider's output
     didn't pass the structural check for that state; note which provider and
     what the logged reason was. Once a tile is `READY`, check its 4
     individual frames (Review screen thumbnails, or the assembled
     spritesheet after Deploy) for the actual problem this was meant to fix:
     do all 4 frames of the same state show the *same* hair color, same
     outfit/colors, same character — not drifting frame to frame the way they
     did before this change.
   - **To sanity-check the cost drop**: your provider dashboard's usage log
     for this run should show close to 9 requests (not 36), assuming no tile
     hit the fallback.
5. Review → approve each state (or REGEN one you don't like — confirm this
   feels like a calm color-fill flash across the tile, not a shake or bounce;
   approve should feel like a ring expanding outward from the border).
6. Deploy → name it, hit spawn. Check `generated-pets/<your-name>/` and
   `characters/<your-name>/` on disk for a real `spritesheet.webp` + `pet.json`,
   and confirm the new pack shows up (and can be activated) on MoteKin's own
   dashboard and in Founder Pet's Settings → Pets list.

## Where things live

```
motekin-main.js        MoteKin's own Electron main process — the dashboard's
                        character-pack IPC (shared with Founder Pet's scan
                        logic) plus every forge-flow IPC handler.
motekin-preload.js     window.motekin bridge — plaintext API key only ever
                        crosses it once, on save; never read back out.
motekin-package.json   MoteKin's own package.json (own `start` script).
frontend/              MoteKin's UI (plain HTML/CSS/JS, same style as
                        Founder Pet's own renderer — no framework).
backend/
  keyStore.js           safeStorage-encrypted key+provider storage.
  providers/            One adapter per provider, common generateFrame()
                         interface — openai.js, stability.js, gemini.js,
                         index.js (registry).
  forge.js              Session management, state prompts, character
                         descriptor, per-state generation orchestration —
                         including the grid-image prompt/slicing (via
                         nativeImage) and its per-provider fallback.
  packWriter.js          Writes generated-pets/<slug>/ and deploys into
                         characters/<slug>/, reusing shared/
                         characterPacks.js's atlas generation.
  forgeError.js          Typed error (auth/rate_limit/content_policy/
                         network/unknown) shared by all three adapters.
generated-pets/         Source-of-truth output of every forge run, one
                        folder per character (gitignored contents aside
                        from .gitkeep).
```
