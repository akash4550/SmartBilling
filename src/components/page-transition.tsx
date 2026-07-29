"use client";

import { motion, useReducedMotion } from "framer-motion";
import type { ReactNode } from "react";

interface PageTransitionProps {
  children: ReactNode;
  /** Optional className for the wrapper div. */
  className?: string;
}

/**
 * Wrap a page's main content in a subtle fade + slide-up animation that
 * plays when the component mounts (i.e. on route changes).
 *
 * - Uses a short, natural spring curve (no jarring linear fades).
 * - Respects the user's `prefers-reduced-motion` setting: when enabled,
 *   content renders without animation for accessibility.
 */
export function PageTransition({ children, className }: PageTransitionProps) {
  const prefersReducedMotion = useReducedMotion();

  const variants = prefersReducedMotion
    ? {
        initial: { opacity: 1 },
        animate: { opacity: 1 },
        exit: { opacity: 1 },
      }
    : {
        initial: { opacity: 0, y: 8 },
        animate: { opacity: 1, y: 0 },
        exit: { opacity: 0, y: -4 },
      };

  return (
    <motion.div
      className={className}
      initial="initial"
      animate="animate"
      exit="exit"
      variants={variants}
      transition={{
        duration: 0.35,
        ease: [0.22, 1, 0.36, 1], // smooth ease-out-expo feel
      }}
    >
      {children}
    </motion.div>
  );
}
