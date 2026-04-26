import { motion, type HTMLMotionProps } from "motion/react";

export const FadeInBlur = ({ children, ...rest }: HTMLMotionProps<"div">) => (
  <motion.div
    transition={{ type: "spring", bounce: 0.1 }}
    initial={{ opacity: 0, filter: "blur(5px)" }}
    animate={{
      opacity: 1,
      filter: "blur(0px)",
      transition: { delay: 0.05 },
    }}
    {...rest}
  >
    {children}
  </motion.div>
);
