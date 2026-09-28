export interface ClientDiagnostic {
  id: string; sessionId: string; occurredAt: string; build: string;
  source: string; message: string; stack?: string;
  context: Record<string, unknown>; environment: Record<string, unknown>;
  details: unknown; breadcrumbs: { at: string; source: string; details: unknown }[];
}
export interface StoredDiagnostic extends ClientDiagnostic {
  receivedAt: string; verifiedUserId: string | null; remoteAddress: string;
  forwardedFor: string | null; userAgent: string;
}
