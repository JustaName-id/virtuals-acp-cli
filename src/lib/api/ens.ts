import { ApiClient } from "./client";

export type EnsRecords = Record<string, string>;

export interface EnsProfile {
  ens: string | null;
  address: string | null;
  records: EnsRecords;
}

export interface EnsClaimResult {
  ens: string;
  address: string | null;
  records: EnsRecords;
}

export interface EnsAvailability {
  label: string;
  available: boolean;
}

/** Thrown by `claim` when the label is already owned by a different wallet. */
export class EnsLabelTakenError extends Error {
  constructor(message: string, public suggestion?: string) {
    super(message);
    this.name = "EnsLabelTakenError";
  }
}

// ApiClient throws `Error("HTTP <status>: <body>")`; pull the JSON body back out.
function parseApiError(
  err: unknown
): { status: number; code?: string; error?: string; suggestion?: string } | null {
  if (!(err instanceof Error)) return null;
  const m = err.message.match(/^HTTP (\d+): ([\s\S]*)$/);
  if (!m) return null;
  const status = Number(m[1]);
  try {
    return { status, ...(JSON.parse(m[2]) as Record<string, unknown>) };
  } catch {
    return { status };
  }
}

/**
 * ENS subname operations for an agent, backed by the ACP backend's `/ens`
 * endpoints. Names are offchain ENS subnames seeded with the agent's profile
 * (avatar/description) server-side. Reads (`resolve`/`reverse`/`available`)
 * need no signer; issuing/updating is authorized server-side.
 */
export class EnsApi {
  constructor(private readonly client: ApiClient) {}

  async claim(
    agentId: string,
    opts: { label?: string; records?: EnsRecords } = {}
  ): Promise<EnsClaimResult> {
    try {
      const res = await this.client.post<{ data: EnsClaimResult }>(
        `/agents/${agentId}/ens/claim`,
        { label: opts.label, records: opts.records ?? {} }
      );
      return res.data;
    } catch (err) {
      const parsed = parseApiError(err);
      if (parsed?.code === "ENS_LABEL_TAKEN") {
        throw new EnsLabelTakenError(
          parsed.error ?? "That ENS name is already taken.",
          parsed.suggestion
        );
      }
      throw err;
    }
  }

  async whoami(agentId: string): Promise<EnsProfile> {
    const res = await this.client.get<{ data: EnsProfile }>(
      `/agents/${agentId}/ens`
    );
    return res.data;
  }

  async setRecords(agentId: string, records: EnsRecords): Promise<EnsProfile> {
    const res = await this.client.patch<{ data: EnsProfile }>(
      `/agents/${agentId}/ens`,
      { records }
    );
    return res.data;
  }

  async resolve(name: string): Promise<EnsProfile> {
    const res = await this.client.get<{ data: EnsProfile }>(
      `/ens/resolve/${encodeURIComponent(name)}`
    );
    return res.data;
  }

  async reverse(address: string): Promise<EnsProfile> {
    const res = await this.client.get<{ data: EnsProfile }>(
      `/ens/reverse/${encodeURIComponent(address)}`
    );
    return res.data;
  }

  async available(label: string): Promise<EnsAvailability> {
    const res = await this.client.get<{ data: EnsAvailability }>(
      `/ens/available/${encodeURIComponent(label)}`
    );
    return res.data;
  }
}
