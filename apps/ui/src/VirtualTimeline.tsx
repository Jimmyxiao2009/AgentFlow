import React, { useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { AlertTriangle, Check, Circle, ChevronDown, ChevronRight, Copy } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { VirtualTimelineProps } from "./types";
import { btnGhost } from "./constants";
import { summarizeActivityGroup } from "./utils";

export const VirtualTimeline = React.memo(function VirtualTimeline({
  messages,
  onCopy,
  copyLabel = "Copy",
  jumpLabel = "Jump to latest",
  timelineLabel = "Conversation timeline",
  locale = "en-US",
}: VirtualTimelineProps) {
  const parentRef = useRef(null);
  const stickToBottomRef = useRef(true);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const [expandedGroups, setExpandedGroups] = useState(() => new Set());
  const toggleGroup = (groupId) =>
    setExpandedGroups((current) => {
      const next = new Set(current);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  const groupedMessages = useMemo(() => {
    const result = [];
    let currentGroup = null;
    for (const message of messages) {
      if (message.kind === "activity") {
        if (currentGroup) {
          currentGroup.items.push(message);
        } else {
          currentGroup = {
            id: `activity-group-${message.id}`,
            kind: "activity-group",
            items: [message],
          };
          result.push(currentGroup);
        }
      } else {
        currentGroup = null;
        result.push(message);
      }
    }
    return result;
  }, [messages]);
  const virtualizer = useVirtualizer({
    count: groupedMessages.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 76,
    getItemKey: (index) => groupedMessages[index]?.id || index,
    overscan: 8,
  });
  const lastMessageLength = messages.at(-1)?.text?.length ?? 0;
  // Detect a conversation switch (the first message identity changed, not just
  // a new message appended) and re-stick to bottom so the newly-loaded
  // conversation shows its latest messages instead of inheriting the scroll
  // position the user left the previous conversation at.
  const firstMessageIdRef = useRef<string | number | undefined>(undefined);
  useEffect(() => {
    const firstId = messages[0]?.id;
    if (firstId !== firstMessageIdRef.current) {
      firstMessageIdRef.current = firstId;
      stickToBottomRef.current = true;
      setShowJumpToLatest(false);
    }
  }, [messages]);
  useEffect(() => {
    if (!stickToBottomRef.current || !groupedMessages.length) return;
    window.requestAnimationFrame(() =>
      virtualizer.scrollToIndex(groupedMessages.length - 1, { align: "end" }),
    );
  }, [groupedMessages.length, lastMessageLength, virtualizer]);
  const handleScroll = (event) => {
    const element = event.currentTarget;
    const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
    stickToBottomRef.current = atBottom;
    setShowJumpToLatest(!atBottom);
  };
  const jumpToLatest = () => {
    stickToBottomRef.current = true;
    setShowJumpToLatest(false);
    virtualizer.scrollToIndex(Math.max(0, groupedMessages.length - 1), { align: "end" });
  };
  return (
    <div style={{ position: "relative", flex: 1, minHeight: 0, display: "flex" }}>
      <div
        ref={parentRef}
        data-testid="timeline-scroll"
        className="af-scroll"
        role="log"
        aria-label={timelineLabel}
        onScroll={handleScroll}
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          margin: "-4px -8px",
          padding: 8,
        }}
      >
        <div style={{ height: virtualizer.getTotalSize(), width: "100%", position: "relative" }}>
          {virtualizer.getVirtualItems().map((virtualItem) => {
            const message = groupedMessages[virtualItem.index];
            if (!message) return null;
            return (
              <div
                key={virtualItem.key}
                data-index={virtualItem.index}
                ref={virtualizer.measureElement}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  transform: `translateY(${virtualItem.start}px)`,
                  display: "flex",
                  justifyContent: message.role === "user" ? "flex-end" : "flex-start",
                  paddingBottom: 18,
                }}
              >
                {message.kind === "activity-group" ? (
                  <div
                    className="af-fade-in"
                    style={{
                      width: "min(560px, 100%)",
                      background: "var(--elevated)",
                      border: "1px solid var(--border-subtle)",
                      borderRadius: 8,
                      padding: "8px 10px",
                      fontSize: 12,
                      color: "var(--text-secondary)",
                    }}
                  >
                    <div
                      onClick={() => toggleGroup(message.id)}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 7,
                        cursor: "pointer",
                      }}
                    >
                      {message.items.some((item) => item.activity?.status === "failed") ? (
                        <AlertTriangle size={12} color="var(--danger)" />
                      ) : message.items.every((item) => item.activity?.status === "completed") ? (
                        <Check size={12} color="var(--success)" />
                      ) : (
                        <Circle size={10} color="var(--accent)" />
                      )}
                      <span style={{ flex: 1 }}>
                        {summarizeActivityGroup(message.items, locale)}
                      </span>
                      {expandedGroups.has(message.id) ? (
                        <ChevronDown size={12} color="var(--text-muted)" />
                      ) : (
                        <ChevronRight size={12} color="var(--text-muted)" />
                      )}
                    </div>
                    {expandedGroups.has(message.id) && (
                      <div
                        style={{
                          marginTop: 7,
                          paddingTop: 7,
                          borderTop: "1px solid var(--border-subtle)",
                          display: "flex",
                          flexDirection: "column",
                          gap: 7,
                        }}
                      >
                        {message.items.map((item) => (
                          <div key={item.id}>
                            <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                              {item.activity?.status === "failed" ? (
                                <AlertTriangle size={11} color="var(--danger)" />
                              ) : item.activity?.status === "completed" ? (
                                <Check size={11} color="var(--success)" />
                              ) : (
                                <Circle size={9} color="var(--accent)" />
                              )}
                              <span>{item.activity?.title || item.text}</span>
                            </div>
                            {item.activity?.detail && (
                              <div
                                className="af-mono"
                                style={{
                                  marginTop: 4,
                                  marginLeft: 18,
                                  color: "var(--text-muted)",
                                  fontSize: 10.5,
                                  whiteSpace: "pre-wrap",
                                  overflowWrap: "anywhere",
                                }}
                              >
                                {item.activity.detail}
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ) : (
                  <div
                    className="af-fade-in"
                    style={{
                      maxWidth: 560,
                      background: message.role === "user" ? "var(--elevated)" : "transparent",
                      borderRadius: 10,
                      padding: "10px 14px",
                      fontSize: 13.5,
                      color:
                        message.role === "user" ? "var(--text-primary)" : "var(--text-secondary)",
                      whiteSpace: message.role === "agent" ? "normal" : "pre-wrap",
                      overflowWrap: "anywhere",
                    }}
                  >
                    {message.role === "agent" ? (
                      <div className="af-markdown">
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.text}</ReactMarkdown>
                      </div>
                    ) : (
                      <div>{message.text}</div>
                    )}
                    {message.streaming && <span className="af-pulse">▍</span>}
                    {!message.streaming && message.text && onCopy && (
                      <button
                        onClick={() => onCopy(message.text)}
                        aria-label={copyLabel}
                        style={{
                          ...btnGhost,
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 4,
                          marginTop: 5,
                          padding: "2px 5px",
                          fontSize: 9.5,
                        }}
                      >
                        <Copy size={10} /> {copyLabel}
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
      {showJumpToLatest && (
        <button
          onClick={jumpToLatest}
          style={{
            ...btnGhost,
            position: "absolute",
            right: 12,
            bottom: 12,
            padding: "5px 9px",
            fontSize: 10.5,
            boxShadow: "0 4px 16px var(--shadow-color)",
          }}
        >
          {jumpLabel}
        </button>
      )}
    </div>
  );
});
