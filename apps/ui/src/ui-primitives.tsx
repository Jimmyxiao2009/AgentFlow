import React from "react";
import { Check } from "lucide-react";
import { t, type Locale } from "@agentflow/localization";

export function Dot({ tone = "muted" }: { tone?: string }) {
  const color = {
    accent: "var(--accent)",
    success: "var(--success)",
    warning: "var(--warning)",
    danger: "var(--danger)",
    muted: "var(--text-muted)",
  }[tone];
  return (
    <span
      style={{
        width: 6,
        height: 6,
        borderRadius: 999,
        background: color,
        display: "inline-block",
        flexShrink: 0,
      }}
    />
  );
}

export function Badge({ tone = "muted", children }: { tone?: string; children: React.ReactNode }) {
  const bg = {
    accent: "var(--accent-dim)",
    success: "var(--success-dim)",
    warning: "var(--warning-dim)",
    danger: "var(--danger-dim)",
    muted: "var(--elevated)",
  }[tone];
  const fg = {
    accent: "var(--accent)",
    success: "var(--success)",
    warning: "var(--warning)",
    danger: "var(--danger)",
    muted: "var(--text-secondary)",
  }[tone];
  return (
    <span
      style={{
        background: bg,
        color: fg,
        fontSize: 11,
        padding: "2px 8px",
        borderRadius: 6,
        fontWeight: 500,
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </span>
  );
}

export function Menu({
  open,
  width = 240,
  align = "left",
  direction = "down",
  children,
}: {
  open: boolean;
  width?: number;
  align?: string;
  direction?: string;
  children: React.ReactNode;
}) {
  if (!open) return null;
  const posStyle =
    direction === "up" ? { bottom: "calc(100% + 6px)" } : { top: "calc(100% + 6px)" };
  return (
    <div
      className="af-fade-in"
      style={{
        position: "absolute",
        ...posStyle,
        [align]: 0,
        width,
        zIndex: 30,
        background: "var(--elevated)",
        border: "1px solid var(--border-strong)",
        borderRadius: 8,
        padding: 4,
        boxShadow: "0 12px 32px rgba(0,0,0,0.45)",
        maxHeight: 320,
        overflowY: "auto",
      }}
    >
      {children}
    </div>
  );
}

export function MenuItem({
  active,
  onClick,
  title,
  sub,
  disabled = false,
}: {
  active?: boolean;
  onClick?: () => void;
  title: React.ReactNode;
  sub?: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <div
      className="af-menu-item"
      onClick={disabled ? undefined : onClick}
      role="menuitem"
      aria-disabled={disabled}
      tabIndex={disabled ? -1 : 0}
      onKeyDown={(event) => {
        if (!disabled && (event.key === "Enter" || event.key === " ")) {
          event.preventDefault();
          onClick?.();
        }
      }}
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 8,
        padding: "8px 10px",
        borderRadius: 6,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <div style={{ width: 14, marginTop: 2, flexShrink: 0 }}>
        {active && <Check size={13} color="var(--accent)" />}
      </div>
      <div style={{ minWidth: 0 }}>
        <div
          style={{ fontSize: 12.5, color: "var(--text-primary)", fontWeight: active ? 600 : 400 }}
        >
          {title}
        </div>
        {sub && <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 1 }}>{sub}</div>}
      </div>
    </div>
  );
}

export function Toggle({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div
      onClick={() => onChange(!checked)}
      role="switch"
      tabIndex={0}
      aria-checked={checked}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onChange(!checked);
        }
      }}
      style={{
        width: 36,
        height: 20,
        borderRadius: 999,
        cursor: "pointer",
        position: "relative",
        flexShrink: 0,
        background: checked ? "var(--accent)" : "var(--border-strong)",
        transition: "background 150ms",
      }}
    >
      <div
        style={{
          position: "absolute",
          top: 2,
          left: checked ? 18 : 2,
          width: 16,
          height: 16,
          borderRadius: "50%",
          background: "var(--control-knob)",
          transition: "left 150ms",
        }}
      />
    </div>
  );
}

export function Segmented({
  options,
  value,
  onChange,
  labelFor = (option: string) => option,
}: {
  options: string[];
  value: string;
  onChange: (value: string) => void;
  labelFor?: (option: string) => string;
}) {
  return (
    <div
      role="radiogroup"
      style={{
        display: "flex",
        background: "var(--window)",
        border: "1px solid var(--border-subtle)",
        borderRadius: 8,
        padding: 2,
      }}
    >
      {options.map((o) => (
        <div
          key={o}
          onClick={() => onChange(o)}
          role="radio"
          tabIndex={value === o ? 0 : -1}
          aria-checked={value === o}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              onChange(o);
            }
          }}
          style={{
            padding: "5px 12px",
            borderRadius: 6,
            fontSize: 12,
            cursor: "pointer",
            whiteSpace: "nowrap",
            background: value === o ? "var(--elevated)" : "transparent",
            color: value === o ? "var(--text-primary)" : "var(--text-muted)",
            fontWeight: value === o ? 600 : 400,
          }}
        >
          {labelFor(o)}
        </div>
      ))}
    </div>
  );
}

export function StaticField({
  children,
  mono,
}: {
  children: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <div
      className={mono ? "af-mono" : ""}
      style={{
        fontSize: 12,
        color: "var(--text-secondary)",
        background: "var(--window)",
        border: "1px solid var(--border-subtle)",
        borderRadius: 6,
        padding: "6px 10px",
        minWidth: 200,
      }}
    >
      {children}
    </div>
  );
}

export function SettingsRow({
  title,
  desc,
  children,
}: {
  title: string;
  desc?: string;
  children: React.ReactNode;
}) {
  const accessibleControl = React.isValidElement(children)
    ? React.cloneElement(children as React.ReactElement<Record<string, unknown>>, {
        "aria-label": title,
      })
    : children;
  return (
    <div
      className="af-row"
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 24,
        padding: "13px 0",
        borderBottom: "1px solid var(--border-subtle)",
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 13 }}>{title}</div>
        {desc && (
          <div style={{ fontSize: 11.5, color: "var(--text-muted)", marginTop: 2 }}>{desc}</div>
        )}
      </div>
      <div style={{ flexShrink: 0 }}>{accessibleControl}</div>
    </div>
  );
}

export function SettingsGroup({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ marginBottom: 28 }}>
      <div
        style={{
          fontSize: 11,
          fontWeight: 600,
          letterSpacing: 0.4,
          color: "var(--text-muted)",
          marginBottom: 2,
          textTransform: "uppercase",
        }}
      >
        {title}
      </div>
      <div>{children}</div>
    </div>
  );
}

export function PermissionListInput({
  title,
  value,
  onChange,
  locale = "en-US",
}: {
  title: string;
  value: string[];
  onChange: (value: string[]) => void;
  locale?: Locale;
}) {
  return (
    <SettingsRow title={title} desc={t(locale, "SettingsText.OnePathOrCommandPerLine")}>
      <textarea
        aria-label={title}
        value={value.join("\n")}
        onChange={(event) =>
          onChange(
            event.target.value
              .split(/\r?\n/)
              .map((item) => item.trim())
              .filter(Boolean),
          )
        }
        rows={3}
        style={{
          width: 280,
          resize: "vertical",
          background: "var(--window)",
          border: "1px solid var(--border-subtle)",
          borderRadius: 6,
          color: "var(--text-primary)",
          padding: "6px 8px",
          fontFamily: "var(--font-mono)",
          fontSize: 11,
        }}
      />
    </SettingsRow>
  );
}
