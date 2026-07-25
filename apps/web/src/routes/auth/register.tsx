import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { AnimatePresence, motion, MotionConfig } from "motion/react";

import { Spinner } from "@repo/ui/components/spinner";
import { useDelayedFlag } from "@repo/ui/hooks/use-delayed-flag";
import { BLUR_FADE } from "@repo/ui/lib/motion";

import { RegisterForm } from "@/components/auth/auth-form";

/**
 * A local invite check answers in ~60ms; anything under this and the footer
 * never moves at all, which is the right amount of feedback for a wait the
 * user cannot perceive.
 */
const SPINNER_DELAY_MS = 200;

const SUBTITLE_CLASS = "text-muted-foreground text-sm";

/**
 * Both subtitles share one grid cell so the crossfade can't reflow the form
 * below — they are different heights.
 */
const SUBTITLE_STACK = "grid grid-cols-1 grid-rows-1 [&>*]:col-start-1 [&>*]:row-start-1";

/**
 * Same one-cell stack, with the height pinned to the login prompt's line box
 * (`text-xs` → 1rem): the spinner that replaces it is taller, and without a
 * fixed height that difference would shift the page every time it swapped.
 */
const FOOTER_STACK = `mt-6 h-4 items-center justify-items-center ${SUBTITLE_STACK}`;

/**
 * A plain crossfade: the subtitle is context for the step change, not the
 * thing moving, so it shouldn't compete with the form's own motion.
 */
const SUBTITLE_MOTION = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0 },
  transition: { duration: 0.16 },
};

/**
 * The heading stays put across both steps so the form below lands where
 * login's does; only the subtitle swaps. The footer doubles as the progress
 * surface — while the invite code is being checked, the login prompt blurs
 * out and a spinner takes its place, so the feedback sits where the eye
 * already is instead of crowding the code row.
 */
function RegisterPage() {
  const [verifiedCode, setVerifiedCode] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);
  const showSpinner = useDelayedFlag(verifying, SPINNER_DELAY_MS);

  const changeCode = (code: string | null) => {
    setVerifiedCode(code);
    setVerifying(false);
  };

  return (
    <MotionConfig reducedMotion="user">
      <div className="mx-auto flex w-full flex-col sm:w-[350px]">
        <div className="space-y-6">
          <div className="grid text-center">
            <h1 className="text-lg font-light">Create an account</h1>
            <div className={SUBTITLE_STACK}>
              <AnimatePresence mode="popLayout" initial={false}>
                {verifiedCode === null ? (
                  <motion.p key="hint" {...SUBTITLE_MOTION} className={SUBTITLE_CLASS}>
                    Early preview — an{" "}
                    <a
                      className="underline"
                      href="https://x.com/kaiyuhsu"
                      target="_blank"
                      rel="noreferrer"
                    >
                      invite code
                    </a>{" "}
                    is required to sign up.
                  </motion.p>
                ) : (
                  <motion.p key="verified" {...SUBTITLE_MOTION} className={SUBTITLE_CLASS}>
                    Invite code <span className="text-foreground font-mono">{verifiedCode}</span>{" "}
                    verified.{" "}
                    <button
                      type="button"
                      onClick={() => changeCode(null)}
                      className="cursor-pointer underline"
                    >
                      Change
                    </button>
                  </motion.p>
                )}
              </AnimatePresence>
            </div>
          </div>
          <RegisterForm
            verifiedCode={verifiedCode}
            onVerifiedCodeChange={changeCode}
            onVerifyingChange={setVerifying}
          />
        </div>
        <div className={FOOTER_STACK}>
          <AnimatePresence mode="popLayout" initial={false}>
            {showSpinner ? (
              <motion.span
                key="checking"
                {...BLUR_FADE}
                role="status"
                aria-label="Checking invite code"
                className="text-muted-foreground"
              >
                <Spinner className="size-4" />
              </motion.span>
            ) : (
              <motion.p
                key="login-prompt"
                {...BLUR_FADE}
                className="text-muted-foreground px-8 text-center text-xs"
              >
                Already have an account?{" "}
                <Link to="/auth/login" className="underline">
                  Login
                </Link>
              </motion.p>
            )}
          </AnimatePresence>
        </div>
      </div>
    </MotionConfig>
  );
}

export const Route = createFileRoute("/auth/register")({
  head: () => ({ meta: [{ title: "Register" }] }),
  component: RegisterPage,
});
