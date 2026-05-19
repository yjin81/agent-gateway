// harness/http.ts — HTTPHarness: forwards AgentRequest to an HTTP endpoint

import type { AgentHarness, AgentRequest, AgentResponse } from './types.js'
import { HarnessError } from '../lib/errors.js'

export class HTTPHarness implements AgentHarness {
  constructor(
    private readonly endpointUrl: string,
    private readonly getToken?: () => Promise<string>,
  ) {}

  async run(request: AgentRequest): Promise<AgentResponse> {
    const token = await this.getToken?.()

    // Serialize — AbortSignal and functions are not JSON-serializable.
    const body = serializeRequest(request)

    let resp: Response
    try {
      resp = await fetch(this.endpointUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token != null ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
        signal: request.abortSignal,
      })
    } catch (err) {
      throw new HarnessError(`HTTPHarness: fetch failed: ${String(err)}`, { cause: String(err) })
    }

    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      throw new HarnessError(`HTTPHarness: upstream returned ${resp.status}: ${text}`, {
        status: resp.status,
      })
    }

    let json: unknown
    try {
      json = await resp.json()
    } catch (err) {
      throw new HarnessError(`HTTPHarness: failed to parse response JSON: ${String(err)}`)
    }

    // Basic shape validation — full Zod validation happens in the pipeline.
    if (json == null || typeof json !== 'object') {
      throw new HarnessError('HTTPHarness: response is not an object')
    }

    return json as AgentResponse
  }
}

/** Strip non-serializable fields before sending over the wire. */
function serializeRequest(
  request: AgentRequest,
): Omit<AgentRequest, 'abortSignal' | 'progressCallback' | 'approvalCallback'> {
  const { abortSignal: _a, progressCallback: _p, approvalCallback: _ap, ...rest } = request
  return rest
}
