// lib/errors.ts — GatewayError hierarchy (Section 17.2)

export class GatewayError extends Error {
  constructor(message: string, public readonly context?: Record<string, unknown>) {
    super(message)
    this.name = this.constructor.name
  }
}

// ── Startup errors (always fatal) ──────────────────────────────────────────

/** Invalid gateway.config.yaml */
export class ConfigValidationError extends GatewayError {}

/** startAccount() failed — may be retryable (network) or fatal (auth) */
export class ConnectorStartupError extends GatewayError {
  constructor(
    message: string,
    public readonly retryable: boolean,
    context?: Record<string, unknown>,
  ) {
    super(message, context)
  }
}

// ── Connector runtime errors (isolated, not fatal to gateway) ──────────────

/** Error in normalize() or event dispatch */
export class ConnectorReceiveError extends GatewayError {}

/** Error in connector.send() after all retries exhausted */
export class ConnectorSendError extends GatewayError {}

// ── Pipeline errors ────────────────────────────────────────────────────────

/** harness.run() threw or returned a malformed response */
export class HarnessError extends GatewayError {}

/** harness.run() did not return within the configured deadline */
export class HarnessTimeoutError extends HarnessError {}

/** Approval not received within approvalTimeoutMs */
export class ApprovalTimeoutError extends GatewayError {}

// ── Session errors ─────────────────────────────────────────────────────────

/** SQLite read/write failure */
export class SessionRegistryError extends GatewayError {}
