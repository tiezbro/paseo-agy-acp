import type { ErrorDetails, PermissionInfo, TaskDetails } from "./columns.js";
import type { StepPayload } from "./step-payload.js";

export type { StepPayload } from "./step-payload.js";

/** A row from the `steps` table of an agy conversation SQLite database. */
export type StepRow = {
  idx: number;
  stepType: number;
  /**
   * agy step status enum (from the `status` column):
   *   1/2 = active, 3 = completed, 6 = cancelled/aborted, 7 = failed,
   *   9 = RequestedInteraction (generic; not necessarily a permission menu).
   * Status-9 run_command and file read/write rows are bridged to ACP permissions.
   */
  status: number;
  stepPayload: StepPayload;
  /** Decoded `error_details` column, when the step carries an error. */
  error?: ErrorDetails | null;
  /** Decoded `permissions` column, when the step requested a permission. */
  permission?: PermissionInfo | null;
  /** Decoded `task_details` column, for background-task steps. */
  task?: TaskDetails | null;
};
