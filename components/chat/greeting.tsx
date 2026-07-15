import { motion } from "framer-motion";
import { Gamepad2Icon } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";

export const Greeting = () => (
  <div className="flex flex-col items-center px-4" key="overview">
    <motion.div
      animate={{ opacity: 1, y: 0 }}
      className="text-center font-semibold text-2xl tracking-tight text-foreground md:text-3xl"
      initial={{ opacity: 0, y: 10 }}
      transition={{ delay: 0.35, duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
    >
      What can I help with?
    </motion.div>
    <motion.div
      animate={{ opacity: 1, y: 0 }}
      className="mt-3 text-center text-muted-foreground/80 text-sm"
      initial={{ opacity: 0, y: 10 }}
      transition={{ delay: 0.5, duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
    >
      Ask a question, write code, or explore ideas.
    </motion.div>
    <motion.div
      animate={{ opacity: 1, y: 0 }}
      className="mt-5"
      initial={{ opacity: 0, y: 10 }}
      transition={{ delay: 0.65, duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
    >
      <Button asChild className="pointer-events-auto rounded-lg">
        <Link href="/game">
          <Gamepad2Icon className="size-4" />
          Game
        </Link>
      </Button>
    </motion.div>
  </div>
);
