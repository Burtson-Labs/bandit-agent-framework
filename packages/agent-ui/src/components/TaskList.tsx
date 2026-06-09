import { ArrowsPointingInIcon } from "@heroicons/react/24/outline";
import type { JSX } from "react";
import type { Goal, Task, TaskStatus } from "@burtson-labs/agent-core";
import { classNames } from "../utils/classNames";

export interface TaskListProps {
  goal: Goal;
  className?: string;
  onCollapse?: () => void;
}

const STATUS_LABELS: Record<TaskStatus, string> = {
  pending: "Pending",
  in_progress: "In progress",
  completed: "Completed",
  failed: "Failed"
};

const STATUS_CLASS_MAP: Record<TaskStatus, string> = {
  pending: "is-pending",
  in_progress: "is-active",
  completed: "is-done",
  failed: "is-error"
};

export const TaskList = ({ goal, className, onCollapse }: TaskListProps): JSX.Element => {
  const tasks: Task[] = goal.tasks ?? [];
  const completed = tasks.filter((task) => task.status === "completed").length;
  const totalLabel = tasks.length > 0 ? `${completed}/${tasks.length} complete` : "No tasks yet";

  return (
    <section className={classNames("agent-ui-panel agent-ui-task-list", className)}>
      <header className="agent-ui-panel__header">
        <div>
          <p className="agent-ui-panel__eyebrow">Goal</p>
          <h3 className="agent-ui-panel__title">{goal.title}</h3>
          {goal.summary && <p className="agent-ui-panel__subtitle">{goal.summary}</p>}
        </div>
        <div className="agent-ui-panel__meta">
          {totalLabel}
          {onCollapse && (
            <button
              type="button"
              className="collapsible-toggle"
              onClick={onCollapse}
              aria-label="Collapse task list"
            >
              <ArrowsPointingInIcon aria-hidden="true" />
            </button>
          )}
        </div>
      </header>

      {tasks.length === 0 ? (
        <p className="agent-ui-plan-step__description">The agent has not created any tasks yet.</p>
      ) : (
        <ol className="agent-ui-plan-list">
          {tasks.map((task, index) => (
            <li
              key={task.id}
              className={classNames("agent-ui-plan-step", "plan-card-step", STATUS_CLASS_MAP[task.status])}
            >
              <span className="agent-ui-plan-step__rail plan-card-step-rail" aria-hidden="true" />
              <span className="agent-ui-plan-step__index plan-card-index">{index + 1}</span>
              <div className="agent-ui-plan-step__body plan-card-step-body">
                <div className="agent-ui-plan-step__row">
                  <p className="agent-ui-plan-step__title plan-card-step-title">{task.title}</p>
                  <span className="agent-ui-plan-step__badge">{STATUS_LABELS[task.status]}</span>
                </div>
                {task.description && (
                  <p className="agent-ui-plan-step__description plan-card-step-summary">{task.description}</p>
                )}
                {task.files && task.files.length > 0 && (
                  <p className="agent-ui-plan-step__description plan-card-step-summary">
                    Files: {task.files.join(", ")}
                  </p>
                )}
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
};
