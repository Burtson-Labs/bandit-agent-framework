import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentEvent } from "@burtson-labs/agent-core";
import type { AgentEventSource, AgentUIEventType } from "../types/ui-schema";

const DEFAULT_EVENT_TYPES: AgentUIEventType[] = [
  "plan:start",
  "plan:chunk",
  "plan:complete",
  "step:start",
  "step:complete",
  "diff:apply",
  "log",
  "telemetry",
  "context:updated",
  "report:chunk",
  "report:complete"
];

export interface UseAgentEventsOptions {
  eventTypes?: AgentUIEventType[];
  limit?: number;
  initialEvents?: AgentEvent[];
}

export interface UseAgentEventsResult {
  events: AgentEvent[];
  clear: () => void;
}

export const useAgentEvents = (
  source: AgentEventSource | null | undefined,
  options: UseAgentEventsOptions = {}
): UseAgentEventsResult => {
  const { initialEvents = [], limit = 200 } = options;
  const [events, setEvents] = useState<AgentEvent[]>(initialEvents);
  const bufferRef = useRef<AgentEvent[]>(initialEvents);
  const limitRef = useRef(limit);

  useEffect(() => {
    limitRef.current = limit;
  }, [limit]);

  const eventTypeList = useMemo<AgentUIEventType[]>(
    () => (options.eventTypes?.length ? [...options.eventTypes] : DEFAULT_EVENT_TYPES),
    [options.eventTypes ? options.eventTypes.join("|") : "default"]
  );
  const subscriptionKey = eventTypeList.join("|");

  useEffect(() => {
    if (!source) {
      bufferRef.current = initialEvents;
      setEvents(initialEvents);
      return;
    }

    const handleEvent = (event: AgentEvent): void => {
      bufferRef.current = [...bufferRef.current, event].slice(-limitRef.current);
      setEvents(bufferRef.current);
    };

    for (const type of eventTypeList) {
      source.on(type, handleEvent);
    }

    return () => {
      for (const type of eventTypeList) {
        source.off(type, handleEvent);
      }
    };
  }, [source, subscriptionKey, initialEvents, eventTypeList]);

  const clear = (): void => {
    bufferRef.current = [];
    setEvents([]);
  };

  return { events, clear };
};
