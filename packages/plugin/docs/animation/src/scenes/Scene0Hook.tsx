import { AbsoluteFill, interpolate, Easing, useCurrentFrame } from "remotion";
import { COLORS, FONT_FAMILY, FONT_FAMILY_MONO, SCENE_0_DURATION } from "../constants";
import { ContextBar } from "../components/ContextBar";

// Scene 0: The Hook (0-90 frames, 3s)
// The "Forgotten Promise" — emotionally specific, instantly recognizable

export const Scene0Hook: React.FC = () => {
  const frame = useCurrentFrame();

  // Frame ranges
  const PROMISE_START = 0;
  const PROMISE_END = 90;       // slower typing (3s)
  const FAST_FORWARD_START = 110; // hold 20 frames
  const FAST_FORWARD_END = 140;  // 30 frames blur (1s)
  const FORGOTTEN_START = 140;
  const FORGOTTEN_END = 200;    // 60 frames AI reply (2s)
  const PULSE_START = 220;
  const PULSE_END = 226;        // 6 frames pulse
  const TITLE_START = 226;
  const TITLE_END = 316;        // 90 frames title hold (3s)

  // Promise message typing animation
  const promiseText = "I'll refactor the auth module after we finish the API.";
  const promiseProgress = interpolate(
    frame,
    [PROMISE_START, PROMISE_END],
    [0, 1],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );
  const promiseChars = Math.floor(promiseProgress * promiseText.length);
  const visiblePromiseText = promiseText.slice(0, promiseChars);

  // Fast-forward blur effect
  const fastForwardOpacity = interpolate(
    frame,
    [FAST_FORWARD_START, FAST_FORWARD_START + 10, FAST_FORWARD_END - 10, FAST_FORWARD_END],
    [0, 1, 1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  // Context bar racing 20% → 95%
  const contextPct = interpolate(
    frame,
    [FAST_FORWARD_START, FAST_FORWARD_END],
    [20, 95],
    { easing: Easing.out(Easing.quad), extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  // Forgotten message typing
  const forgottenText = "I apologize — what were we refactoring?";
  const forgottenProgress = interpolate(
    frame,
    [FORGOTTEN_START, FORGOTTEN_END],
    [0, 1],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );
  const forgottenChars = Math.floor(forgottenProgress * forgottenText.length);
  const visibleForgottenText = forgottenText.slice(0, forgottenChars);

  // Pulse effect at 95%
  const pulse = frame >= PULSE_START && frame < PULSE_END
    ? Math.sin((frame - PULSE_START) * 0.5) * 0.3 + 0.7
    : 1;

  // Title card
  const titleOpacity = interpolate(
    frame,
    [TITLE_START, TITLE_START + 15, TITLE_END - 15, TITLE_END],
    [0, 1, 1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  // Smash cut to black
  const showContent = frame < PULSE_END;
  const contentOpacity = showContent ? 1 : 0;

  return (
    <AbsoluteFill style={{ background: COLORS.bg }}>
      {/* Main content (smash cut at PULSE_END) */}
      <div style={{ opacity: contentOpacity }}>
        {/* Promise message (user) */}
        {frame >= PROMISE_START && frame < FAST_FORWARD_END && (
          <div
            style={{
              position: "absolute",
              top: 180,
              left: "50%",
              transform: "translateX(-50%)",
              maxWidth: 560,
            }}
          >
            <div
              style={{
                background: COLORS.userBar,
                borderRadius: 12,
                padding: "16px 20px",
                opacity: interpolate(
                  frame,
                  [PROMISE_START, PROMISE_START + 10],
                  [0, 1],
                  { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
                ),
              }}
            >
              <span
                style={{
                  fontFamily: FONT_FAMILY,
                  fontSize: 16,
                  color: COLORS.textPrimary,
                  lineHeight: 1.5,
                }}
              >
                {visiblePromiseText}
                {frame < PROMISE_END && (
                  <span style={{ opacity: 0.7 }}>|</span>
                )}
              </span>
            </div>
          </div>
        )}

        {/* Fast-forward blur pile */}
        {frame >= FAST_FORWARD_START && frame < FAST_FORWARD_END && (
          <div
            style={{
              position: "absolute",
              top: 280,
              left: "50%",
              transform: "translateX(-50%)",
              opacity: fastForwardOpacity,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 4,
              filter: "blur(2px)",
            }}
          >
            {Array.from({ length: 8 }).map((_, i) => (
              <div
                key={i}
                style={{
                  width: 400 + Math.random() * 100,
                  height: 28,
                  background: i % 2 === 0 ? COLORS.userBar : COLORS.assistantBar,
                  borderRadius: 8,
                  opacity: 0.3 + (i / 8) * 0.5,
                }}
              />
            ))}
            <div
              style={{
                fontFamily: FONT_FAMILY_MONO,
                fontSize: 12,
                color: COLORS.textMuted,
                marginTop: 8,
              }}
            >
              200+ messages later...
            </div>
          </div>
        )}

        {/* Forgotten message (assistant) */}
        {frame >= FORGOTTEN_START && (
          <div
            style={{
              position: "absolute",
              top: 320,
              left: "50%",
              transform: "translateX(-50%)",
              maxWidth: 560,
            }}
          >
            <div
              style={{
                background: COLORS.assistantBar,
                borderRadius: 12,
                padding: "16px 20px",
                opacity: interpolate(
                  frame,
                  [FORGOTTEN_START, FORGOTTEN_START + 10],
                  [0, 1],
                  { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
                ),
              }}
            >
              <span
                style={{
                  fontFamily: FONT_FAMILY,
                  fontSize: 16,
                  color: COLORS.textPrimary,
                  lineHeight: 1.5,
                }}
              >
                {visibleForgottenText}
                {frame < FORGOTTEN_END && (
                  <span style={{ opacity: 0.7 }}>|</span>
                )}
              </span>
            </div>
          </div>
        )}
      </div>

      {/* Title card (after smash cut) */}
      {frame >= TITLE_START && (
        <div
          style={{
            position: "absolute",
            top: "50%",
            left: "50%",
            transform: "translate(-50%, -50%)",
            opacity: titleOpacity,
            textAlign: "center",
          }}
        >
          <div
            style={{
              fontFamily: FONT_FAMILY_MONO,
              fontSize: 48,
              fontWeight: 700,
              color: COLORS.textPrimary,
              letterSpacing: "0.05em",
            }}
          >
            magic-context
          </div>
          <div
            style={{
              width: 400,
              height: 1,
              background: COLORS.panelBorder,
              margin: "16px auto",
            }}
          />
          <div
            style={{
              fontFamily: FONT_FAMILY,
              fontSize: 20,
              color: COLORS.textSecondary,
            }}
          >
            Keep the plot. Lose the bloat.
          </div>
        </div>
      )}
    </AbsoluteFill>
  );
};
