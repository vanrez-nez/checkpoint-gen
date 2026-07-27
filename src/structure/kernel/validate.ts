/**
 * Structural diagnostics.
 *
 * Range checks on individual controls throw — `validateControls` guards the
 * generator's inputs and a bad slider value is simply not runnable. Structural
 * validation is different: a configuration can be geometrically valid and still
 * violate a preferred rule, and the useful answer is the whole list rather than
 * whichever violation happened to be found first. So this collects.
 */

export type Severity = "error" | "warning" | "notice";

export interface Diagnostic {
  /**
   * `error` — generation cannot produce a valid result.
   * `warning` — usable, but a preferred rule was violated.
   * `notice` — unusual condition, or an automatic repair was applied.
   */
  readonly severity: Severity;
  /** Stable machine-readable code, e.g. "band.setback_inverts_footprint". */
  readonly code: string;
  /** The entity the diagnostic is about, so it can be selected in an editor. */
  readonly entityId: string;
  readonly message: string;
  /** What the generator used instead, when it repaired rather than refused. */
  readonly resolved?: string;
}

export class DiagnosticCollector {
  private readonly entries: Diagnostic[] = [];

  error(code: string, entityId: string, message: string): void {
    this.entries.push({ severity: "error", code, entityId, message });
  }

  /**
   * `resolved` records the value actually used, so a repaired build stays
   * reproducible from its report alone.
   */
  notice(code: string, entityId: string, message: string, resolved?: string): void {
    this.entries.push(
      resolved === undefined
        ? { severity: "notice", code, entityId, message }
        : { severity: "notice", code, entityId, message, resolved },
    );
  }

  get all(): readonly Diagnostic[] {
    return this.entries;
  }
}
