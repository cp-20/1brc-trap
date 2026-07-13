export type ContestSchedule = {
  startAt: string;
  endAt: string;
};

export function hasContestStarted(
  contest: ContestSchedule,
  now = new Date(),
): boolean {
  return now >= new Date(contest.startAt);
}

export function isSubmissionOpen(
  contest: ContestSchedule,
  now = new Date(),
): boolean {
  return hasContestStarted(contest, now) && now <= new Date(contest.endAt);
}

export type ContestPhase = {
  label: string;
  target: Date;
  tone: "success" | "warning" | "neutral";
};

export function getContestPhase(
  contest: ContestSchedule,
  now = new Date(),
): ContestPhase {
  const startsAt = new Date(contest.startAt);
  const endsAt = new Date(contest.endAt);
  if (now < startsAt)
    return { label: "開始まで", target: startsAt, tone: "warning" };
  if (now < endsAt)
    return { label: "終了まで", target: endsAt, tone: "success" };
  return { label: "終了", target: endsAt, tone: "neutral" };
}
