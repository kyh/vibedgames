import { motion } from "motion/react";
import type { HTMLMotionProps } from "motion/react";

export const FadeInBlur = ({ children, ...rest }: HTMLMotionProps<"div">) => (
  <motion.div
    transition={{ bounce: 0.1, type: "spring" }}
    initial={{ filter: "blur(5px)", opacity: 0 }}
    animate={{
      filter: "blur(0px)",
      opacity: 1,
      transition: { delay: 0.05 },
    }}
    {...rest}
  >
    {children}
  </motion.div>
);
