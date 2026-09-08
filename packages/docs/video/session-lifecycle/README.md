# Session lifecycle video

An editable HyperFrames explainer: **84 seconds, 1920×1080, 30 fps, H.264 MP4**. It is deliberately silent; all narration is carried by on-screen copy. See [storyboard.md](storyboard.md) for timings and every caption verbatim.

## Render from a clean checkout

Prerequisites: Node.js **22 or newer**, npm/npx, and `ffmpeg`/`ffprobe` on `PATH`. Network access is required the first time npx downloads the pinned HyperFrames CLI and HyperFrames installs its headless Chrome. No HeyGen account, API key, root workspace install, or narration service is needed.

From the repository root:

```sh
cd packages/docs/video/session-lifecycle
npm ci --ignore-scripts --workspaces=false
npm run check
npm run render
ffprobe -v error -show_entries stream=codec_name,width,height,r_frame_rate,nb_frames:format=duration,size -of json out/session-lifecycle.mp4
```

The render script pins **HyperFrames 0.8.31**, uses two workers and software-browser screenshot capture, and writes `out/session-lifecycle.mp4`. It should report 2520 frames, 84 seconds, 1920×1080 and 30/1 fps. Software capture avoids relying on experimental GPU capture behavior. The package lock contains no package dependencies; npx resolves the explicitly versioned CLI. Fonts and GSAP are checked in under `assets/`, so composition capture makes no CDN requests. See [asset notices](assets/NOTICE.md).

`npm run check` samples the story at 18 explicit times. The current project passes runtime, layout, and contrast checks. Three `timeline_track_too_dense` warnings are expected: the captions and supporting cards share one composition so the context bar never cuts away. These are authoring-organization warnings, not rendering defects. No layout or contrast finding is suppressed except the intentional above-bar placement of the threshold label.

## Preview and edit

```sh
npm run dev
```

Open the Studio URL printed by HyperFrames. `index.html` contains the local CSS, timed caption/card clips, and one paused GSAP timeline registered as `session`. Edit copy in the HTML and update the corresponding verbatim copy in `storyboard.md`. Stable clip IDs support Studio edits.

The `states` array near the bottom is `[start time, transition duration, segment percentages]`, in this order: system, memory, history, settled conversation, live conversation, tool output. The bar always uses the same elements. Sizes are illustrative; the 45% landing reproduces the docs' worked example and the later ~60% landing shows why a trigger is not a target. The default history budget is 15% **of context at the execute threshold**, not 15% of the whole window.

To inspect specific moments before a render:

```sh
npx --yes hyperframes@0.8.31 snapshot --at 1,9,18,26,31,36,40,50.5,58,69,82
```

For a native-resolution frame from the actual MP4:

```sh
ffmpeg -ss 69 -i out/session-lifecycle.mp4 -frames:v 1 out/recall.png
```

`out/`, `snapshots/`, and `.hyperframes/` are gitignored. Do not commit rendered files or local browser state.

## Scope and fidelity

- This is one primary session, with time compressed into 84 seconds, not a recording of a real user's data.
- `ctx_reduce` is queued first and materialized only on an explicitly labeled rebuilding pass. The early passes are not claims that every reduction waits for 65%.
- The historian produces prompt-resident compartments. They are distinct from dropped placeholders. Shorter tiers are illustrated at a history rebuild, not as continuous prefix churn.
- The remembered exchange is invented explanatory copy. Search and expansion use the exact tool names.
- No audio, stock footage, avatars, hosted render, publishing, or deployment is involved.

Source references are recorded in [BRIEF.md](BRIEF.md) and the storyboard. Product behavior should be rechecked against those docs before changing this video's claims.
