import type { Diagnostic } from "../structure/kernel/validate";

const DEFAULT_MAX_ENTRIES = 40;

export type ValidationLogLevel = "ERROR" | "WARNING" | "NOTICE" | "OK";

/** Mutable string target consumed by Tweakpane's multiline monitor binding. */
export interface ValidationLogMirror {
  text: string;
}

/**
 * A bounded, human-readable history of validation events.
 *
 * The status row remains useful as a glanceable verdict; this log preserves
 * the context that row necessarily truncates. It owns one joined string rather
 * than Tweakpane's sampled monitor buffer so ordinary `pane.refresh()` calls do
 * not duplicate the latest entry.
 */
export class ValidationLog {
  readonly mirror: ValidationLogMirror = { text: "No validation events yet." };

  private readonly entries: string[] = [];
  private diagnosticSignature: string | null = null;

  constructor(
    private readonly now: () => Date = () => new Date(),
    private readonly maxEntries = DEFAULT_MAX_ENTRIES,
  ) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new RangeError("Validation log capacity must be a positive integer.");
    }
  }

  rejected(change: string, message: string): void {
    this.append("ERROR", "Edit rejected", [
      change,
      message,
      "Recovered: restored the previous valid configuration.",
    ]);
  }

  /** Records a changed diagnostic set, including the transition back to OK. */
  diagnostics(diagnostics: readonly Diagnostic[]): void {
    const signature = JSON.stringify(diagnostics);

    if (signature === this.diagnosticSignature) {
      return;
    }

    this.diagnosticSignature = signature;

    if (diagnostics.length === 0) {
      this.append("OK", "No structural diagnostics");
      return;
    }

    const level = worstLevel(diagnostics);
    this.append(
      level,
      `${diagnostics.length} structural diagnostic${diagnostics.length === 1 ? "" : "s"}`,
      diagnostics.flatMap(formatDiagnostic),
    );
  }

  clear(): void {
    this.entries.length = 0;
    this.diagnosticSignature = null;
    this.mirror.text = "No validation events yet.";
  }

  private append(
    level: ValidationLogLevel,
    title: string,
    details: readonly string[] = [],
  ): void {
    const timestamp = this.now().toLocaleTimeString([], { hour12: false });
    const body = details.map((detail) => `  ${detail}`).join("\n");
    this.entries.push(
      `[${timestamp}] ${level} — ${title}${body.length > 0 ? `\n${body}` : ""}`,
    );

    if (this.entries.length > this.maxEntries) {
      this.entries.splice(0, this.entries.length - this.maxEntries);
    }

    this.mirror.text = this.entries.join("\n\n");
  }
}

function worstLevel(diagnostics: readonly Diagnostic[]): ValidationLogLevel {
  if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    return "ERROR";
  }
  if (diagnostics.some((diagnostic) => diagnostic.severity === "warning")) {
    return "WARNING";
  }
  return "NOTICE";
}

function formatDiagnostic(diagnostic: Diagnostic): string[] {
  const heading = `${diagnostic.severity.toUpperCase()} ${diagnostic.code}`;
  const details = [
    heading,
    `message: ${diagnostic.message}`,
    `entity: ${diagnostic.entityId}`,
  ];

  if (diagnostic.resolved !== undefined) {
    details.push(`resolved: ${diagnostic.resolved}`);
  }

  return details;
}
