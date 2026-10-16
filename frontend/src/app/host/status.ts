import type { NightStatus } from "@/lib/api";

export const STATUS_LABEL: Record<NightStatus, string> = {
  draft: "Building the shortlist",
  voting: "Voting",
  revealed: "Winner revealed",
  tonight: "Watching tonight",
  closed: "Closed",
};
