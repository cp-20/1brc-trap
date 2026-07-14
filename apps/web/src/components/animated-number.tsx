import NumberFlow, { type Format, NumberFlowGroup } from "@number-flow/react";
import { useEffect, useState } from "react";

import { formatRemaining } from "../utils/format.js";

import styles from "./animated-number.module.css";

const integerFormat: Format = {
  maximumFractionDigits: 0,
};
const clockFormat: Format = {
  minimumIntegerDigits: 2,
  useGrouping: false,
};
const sexagesimalDigits = { 1: { max: 5 } };
const hourDigits = { 1: { max: 2 } };

export function AnimatedNumber({
  value,
  suffix,
  className = "",
}: {
  value: number;
  suffix?: string;
  className?: string;
}) {
  const animated = useAnimatedAfterMount();
  return (
    <NumberFlow
      className={`${styles.number} ${className}`}
      value={value}
      locales="ja-JP"
      format={integerFormat}
      suffix={suffix ?? ""}
      animated={animated}
      isolate
    />
  );
}

export function AnimatedDuration({
  nanoseconds,
  className = "",
}: {
  nanoseconds: string | null;
  className?: string;
}) {
  const animated = useAnimatedAfterMount();
  if (!nanoseconds) return <span className={className}>—</span>;

  const seconds = Number(nanoseconds) / 1_000_000_000;
  const value = seconds < 1 ? seconds * 1_000 : seconds;
  return (
    <NumberFlow
      className={`${styles.number} ${className}`}
      value={value}
      locales="en-US"
      format={{
        minimumFractionDigits: seconds < 1 ? 2 : 3,
        maximumFractionDigits: seconds < 1 ? 2 : 3,
        useGrouping: false,
      }}
      suffix={seconds < 1 ? " ms" : " s"}
      animated={animated}
      isolate
    />
  );
}

export function AnimatedDurationDelta({
  nanoseconds,
  className = "",
}: {
  nanoseconds: string;
  className?: string;
}) {
  const seconds = Number(nanoseconds) / 1_000_000_000;
  const useMilliseconds = Math.abs(seconds) < 1;
  const value = useMilliseconds ? seconds * 1_000 : seconds;
  return (
    <NumberFlow
      className={`${styles.number} ${className}`}
      value={value}
      locales="en-US"
      format={{
        minimumFractionDigits: useMilliseconds ? 2 : 3,
        maximumFractionDigits: useMilliseconds ? 2 : 3,
        useGrouping: false,
      }}
      prefix={value > 0 ? "+" : value === 0 ? "±" : ""}
      suffix={useMilliseconds ? " ms" : " s"}
      isolate
    />
  );
}

export function AnimatedCountdown({ milliseconds }: { milliseconds: number }) {
  const animated = useAnimatedAfterMount();
  const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1_000));
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;

  return (
    <span
      className={styles.countdown}
      role="timer"
      aria-label={formatRemaining(milliseconds)}
    >
      <NumberFlowGroup>
        <span className={styles.countdownValues} aria-hidden="true">
          <span>
            <NumberFlow
              className={styles.number}
              value={days}
              locales="en-US"
              format={integerFormat}
              trend={-1}
              animated={animated}
              isolate
            />
            d
          </span>
          <span>
            <NumberFlow
              className={styles.number}
              value={hours}
              locales="en-US"
              format={clockFormat}
              digits={hourDigits}
              trend={-1}
              animated={animated}
            />
            h
          </span>
          <span>
            <NumberFlow
              className={styles.number}
              value={minutes}
              locales="en-US"
              format={clockFormat}
              digits={sexagesimalDigits}
              trend={-1}
              animated={animated}
            />
            m
          </span>
          <span>
            <NumberFlow
              className={styles.number}
              value={seconds}
              locales="en-US"
              format={clockFormat}
              digits={sexagesimalDigits}
              trend={-1}
              animated={animated}
              willChange
            />
            s
          </span>
        </span>
      </NumberFlowGroup>
    </span>
  );
}

function useAnimatedAfterMount(): boolean {
  const [animated, setAnimated] = useState(false);
  useEffect(() => setAnimated(true), []);
  return animated;
}
