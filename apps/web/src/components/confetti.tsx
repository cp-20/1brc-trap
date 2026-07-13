import confetti from "canvas-confetti";
import { useEffect, useRef } from "react";

const colors = ["#20beff", "#ffcd3c", "#ff6b6b", "#8bd450", "#b685ff"];

export function Confetti({ onDone }: { onDone: () => void }) {
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  useEffect(() => {
    let mounted = true;
    const common = {
      colors,
      disableForReducedMotion: true,
      particleCount: 80,
      spread: 70,
      startVelocity: 42,
      ticks: 220,
    };
    const animations = [
      confetti({ ...common, angle: 58, origin: { x: 0.22, y: 0.42 } }),
      confetti({ ...common, angle: 122, origin: { x: 0.78, y: 0.42 } }),
    ];

    void Promise.all(
      animations.map((animation) => Promise.resolve(animation)),
    ).then(() => {
      if (mounted) onDoneRef.current();
    });
    return () => {
      mounted = false;
    };
  }, []);

  return null;
}
