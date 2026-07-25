import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { AnimatePresence, motion, MotionConfig } from "motion/react";

import { RegisterForm } from "@/components/auth/auth-form";

const SUBTITLE_CLASS = "text-muted-foreground text-sm";

/**
 * Both subtitles share one grid cell so the crossfade can't reflow the form
 * below — they are different heights.
 */
const SUBTITLE_STACK = "grid grid-cols-1 grid-rows-1 [&>*]:col-start-1 [&>*]:row-start-1";

/**
 * A plain crossfade: the subtitle is context for the step change, not the
 * thing moving, so it shouldn't compete with the form's slide.
 */
const SUBTITLE_MOTION = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0 },
  transition: { duration: 0.16 },
};

/**
 * The heading stays put across both steps so the form below lands where
 * login's does; only the subtitle swaps.
 */
function RegisterPage() {
  const [verifiedCode, setVerifiedCode] = useState<string | null>(null);

  return (
    <div className="mx-auto flex w-full flex-col sm:w-[350px]">
      <div className="space-y-6">
        <MotionConfig reducedMotion="user">
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
                      onClick={() => setVerifiedCode(null)}
                      className="underline"
                    >
                      Change
                    </button>
                  </motion.p>
                )}
              </AnimatePresence>
            </div>
          </div>
        </MotionConfig>
        <RegisterForm verifiedCode={verifiedCode} onVerifiedCodeChange={setVerifiedCode} />
      </div>
      <p className="text-muted-foreground mt-6 px-8 text-center text-xs">
        Already have an account?{" "}
        <Link to="/auth/login" className="underline">
          Login
        </Link>
      </p>
    </div>
  );
}

export const Route = createFileRoute("/auth/register")({
  head: () => ({ meta: [{ title: "Register" }] }),
  component: RegisterPage,
});
