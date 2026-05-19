// sdk-ts/src/harness/http.ts — HTTPHarness for SDK consumers

import type { AgentHarness, AgentRequest, AgentResponse } from '../types.js'

export class HTTPHarness implements AgentHarness {
  constructor(
    private readonly endpointUrl: string,
    private readonly getToken?: () => Promise<string>,
  ) {}

  async run(request: AgentRequest): Promise<AgentResponse> {
    const token = await this.getToken?.()
    const { abortSignal: _a, progressCallback: _p, approvalCallback: _ap, ...body } = request

    const resp = await fetch(this.endpointUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token != null ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
      signal: request.abortSignal,
    })

    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      throw new Error(`HTTPHarness: upstream returned ${resp.status}: ${text}`)
    }

    return resp.json() as Promise<AgentResponse>
  }
}
