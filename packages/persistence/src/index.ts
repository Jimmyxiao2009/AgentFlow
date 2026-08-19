import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { AuditEvent, TaskLease, WorkflowEvent } from "@agentflow/domain";

export interface StoredArtifact {
  id: string;
  kind: "diff" | "validation-log" | "transcript" | "report" | "generated-file";
  content: string;
  contentType: string;
  createdAt: string;
}

const migrations = [
  `CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);`,
  `CREATE TABLE IF NOT EXISTS workflow_events (id TEXT PRIMARY KEY, schema_version INTEGER NOT NULL, type TEXT NOT NULL, aggregate_id TEXT NOT NULL, conversation_id TEXT, change_request_id TEXT, task_id TEXT, run_id TEXT, sequence INTEGER NOT NULL, timestamp TEXT NOT NULL, source TEXT NOT NULL, role TEXT, payload_json TEXT NOT NULL, UNIQUE(aggregate_id, sequence));`,
  `CREATE INDEX IF NOT EXISTS idx_workflow_events_aggregate ON workflow_events(aggregate_id, sequence);`,
  `CREATE TABLE IF NOT EXISTS projections (name TEXT PRIMARY KEY, revision INTEGER NOT NULL, payload_json TEXT NOT NULL, updated_at TEXT NOT NULL);`,
  `CREATE TABLE IF NOT EXISTS audit_events (id TEXT PRIMARY KEY, actor TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL, detail TEXT NOT NULL, timestamp TEXT NOT NULL);`,
  `CREATE TABLE IF NOT EXISTS task_leases (id TEXT PRIMARY KEY, task_id TEXT NOT NULL UNIQUE, run_id TEXT NOT NULL, expires_at TEXT NOT NULL, acquired_at TEXT NOT NULL);`,
  `CREATE TABLE IF NOT EXISTS artifacts (id TEXT PRIMARY KEY, kind TEXT NOT NULL, content TEXT NOT NULL, content_type TEXT NOT NULL, created_at TEXT NOT NULL);`,
  `CREATE INDEX IF NOT EXISTS idx_artifacts_kind_created ON artifacts(kind, created_at);`,
];

export class SqliteEventStore {
  private readonly db: Database.Database;
  constructor(filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new Database(filePath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(migrations[0]!);
    let version = (
      this.db
        .prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations")
        .get() as { version: number }
    ).version;
    if (version === 0) {
      this.db
        .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
        .run(1, new Date().toISOString());
      version = 1;
    }
    for (let index = version; index < migrations.length; index += 1) {
      const transaction = this.db.transaction(() => {
        this.db.exec(migrations[index]!);
        this.db
          .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
          .run(index + 1, new Date().toISOString());
      });
      transaction();
    }
  }

  append<T>(event: WorkflowEvent<T>): boolean {
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO workflow_events (id, schema_version, type, aggregate_id, conversation_id, change_request_id, task_id, run_id, sequence, timestamp, source, role, payload_json) VALUES (@id, @schemaVersion, @type, @aggregateId, @conversationId, @changeRequestId, @taskId, @runId, @sequence, @timestamp, @source, @role, @payload)`,
      )
      .run({
        id: event.id,
        schemaVersion: event.schemaVersion,
        type: event.type,
        aggregateId: event.aggregateId,
        conversationId: event.conversationId ?? null,
        changeRequestId: event.changeRequestId ?? null,
        taskId: event.taskId ?? null,
        runId: event.runId ?? null,
        sequence: event.sequence,
        timestamp: event.timestamp,
        source: event.source,
        role: event.role ?? null,
        payload: JSON.stringify(event.payload),
      });
    return result.changes > 0;
  }

  appendAudit(event: AuditEvent): void {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO audit_events VALUES (@id, @actor, @action, @target, @detail, @timestamp)",
      )
      .run(event);
  }
  eventsFor(aggregateId: string): WorkflowEvent[] {
    const rows = this.db
      .prepare("SELECT * FROM workflow_events WHERE aggregate_id = ? ORDER BY sequence ASC")
      .all(aggregateId) as Array<Record<string, unknown>>;
    return rows.map((row) => this.rowToEvent(row));
  }
  private rowToEvent(row: Record<string, unknown>): WorkflowEvent {
    return {
      id: String(row.id),
      schemaVersion: Number(row.schema_version),
      type: String(row.type),
      aggregateId: String(row.aggregate_id),
      conversationId: row.conversation_id ? String(row.conversation_id) : undefined,
      changeRequestId: row.change_request_id ? String(row.change_request_id) : undefined,
      taskId: row.task_id ? String(row.task_id) : undefined,
      runId: row.run_id ? String(row.run_id) : undefined,
      sequence: Number(row.sequence),
      timestamp: String(row.timestamp),
      source: row.source as WorkflowEvent["source"],
      role: row.role as WorkflowEvent["role"],
      payload: JSON.parse(String(row.payload_json)),
    };
  }
  eventsForConversation(conversationId: string, limit = 500): WorkflowEvent[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM workflow_events WHERE conversation_id = ? ORDER BY sequence DESC LIMIT ?",
      )
      .all(conversationId, Math.max(1, limit)) as Array<Record<string, unknown>>;
    return rows.map((row) => this.rowToEvent(row)).reverse();
  }
  lastSequence(aggregateId: string): number {
    return Number(
      (
        this.db
          .prepare(
            "SELECT COALESCE(MAX(sequence), -1) AS sequence FROM workflow_events WHERE aggregate_id = ?",
          )
          .get(aggregateId) as { sequence: number }
      ).sequence,
    );
  }
  saveProjection(name: string, revision: number, payload: unknown): void {
    this.db
      .prepare(
        "INSERT INTO projections(name, revision, payload_json, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET revision=excluded.revision, payload_json=excluded.payload_json, updated_at=excluded.updated_at",
      )
      .run(name, revision, JSON.stringify(payload), new Date().toISOString());
  }
  readProjection<T>(name: string): { revision: number; payload: T } | undefined {
    const row = this.db
      .prepare("SELECT revision, payload_json FROM projections WHERE name = ?")
      .get(name) as { revision: number; payload_json: string } | undefined;
    return row ? { revision: row.revision, payload: JSON.parse(row.payload_json) as T } : undefined;
  }
  projectionNames(prefix: string): string[] {
    return (
      this.db
        .prepare("SELECT name FROM projections WHERE name LIKE ? ORDER BY name")
        .all(`${prefix}%`) as Array<{ name: string }>
    ).map((row) => row.name);
  }
  saveTaskLease(lease: TaskLease): void {
    this.db
      .prepare(
        "INSERT INTO task_leases(id, task_id, run_id, expires_at, acquired_at) VALUES (@id, @taskId, @runId, @expiresAt, @acquiredAt) ON CONFLICT(task_id) DO UPDATE SET id=excluded.id, run_id=excluded.run_id, expires_at=excluded.expires_at, acquired_at=excluded.acquired_at",
      )
      .run(lease);
  }
  deleteTaskLease(taskId: string): void {
    this.db.prepare("DELETE FROM task_leases WHERE task_id = ?").run(taskId);
  }
  taskLeases(): TaskLease[] {
    return (
      this.db
        .prepare(
          "SELECT id, task_id, run_id, expires_at, acquired_at FROM task_leases ORDER BY acquired_at",
        )
        .all() as Array<Record<string, string>>
    ).map((row) => ({
      id: String(row.id),
      taskId: String(row.task_id),
      runId: String(row.run_id),
      expiresAt: String(row.expires_at),
      acquiredAt: String(row.acquired_at),
    }));
  }
  saveArtifact(artifact: StoredArtifact): void {
    this.db
      .prepare(
        "INSERT INTO artifacts(id, kind, content, content_type, created_at) VALUES (@id, @kind, @content, @contentType, @createdAt) ON CONFLICT(id) DO NOTHING",
      )
      .run({
        id: artifact.id,
        kind: artifact.kind,
        content: artifact.content,
        contentType: artifact.contentType,
        createdAt: artifact.createdAt,
      });
  }
  readArtifact(id: string): StoredArtifact | undefined {
    const row = this.db
      .prepare("SELECT id, kind, content, content_type, created_at FROM artifacts WHERE id = ?")
      .get(id) as
      | {
          id: string;
          kind: StoredArtifact["kind"];
          content: string;
          content_type: string;
          created_at: string;
        }
      | undefined;
    return row
      ? {
          id: row.id,
          kind: row.kind,
          content: row.content,
          contentType: row.content_type,
          createdAt: row.created_at,
        }
      : undefined;
  }
  artifactCount(): number {
    return Number(
      (this.db.prepare("SELECT COUNT(*) AS count FROM artifacts").get() as { count: number }).count,
    );
  }
  /**
   * Deletes artifacts older than `retentionDays`, keeping the most recent N per
   * kind. Artifacts still referenced by a live PatchSet (diffArtifactId) or
   * ValidationRun (logArtifactId) are never deleted — their IDs are passed in
   * `keepIds` — so pruning retention never corrupts historical PatchSets whose
   * diff/transcript the user may still open.
   */
  pruneArtifacts(retentionDays: number, keepIds: ReadonlySet<string> = new Set()): number {
    const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString();
    // Build a parameterized NOT IN clause for referenced artifact IDs. Using a
    // temporary CTE-joined values list keeps the query shape stable regardless
    // of how many references exist (including zero).
    const keepList = [...keepIds];
    const keepClause = keepList.length
      ? `AND id NOT IN (${keepList.map(() => "?").join(",")})`
      : "";
    const result = this.db
      .prepare(
        `DELETE FROM artifacts WHERE created_at < ? AND id NOT IN (SELECT id FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY kind ORDER BY created_at DESC) AS rn FROM artifacts) t WHERE rn <= 50) ${keepClause}`,
      )
      .run(cutoff, ...keepList);
    return result.changes;
  }
  close(): void {
    this.db.close();
  }
}
