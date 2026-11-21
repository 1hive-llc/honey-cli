export type HexAddress = `0x${string}`;
export type HexData = `0x${string}`;
export type ChainId = 100 | 10200 | 31337;

export type OneHiveToolError = {
  code: string;
  message: string;
  retryable: boolean;
  details?: unknown;
};

export type ToolWarning = {
  category: 'runtime' | 'policy' | 'security' | 'operator-guidance' | 'degraded-service';
  severity: 'info' | 'warning' | 'critical';
  message: string;
};

export type OneHiveToolResult<T> = {
  ok: boolean;
  data?: T;
  warnings: string[];
  warningDetails?: ToolWarning[];
  error?: OneHiveToolError;
};

export type PolicyCheck = {
  name: string;
  status: 'pass' | 'fail' | 'warn';
  detail: string;
};

export type TxPreview = {
  chainId: ChainId;
  from?: HexAddress;
  to: HexAddress;
  value: string;
  data: HexData;
  decoded: {
    contractName: string;
    method: string;
    args: Record<string, unknown>;
    humanSummary: string;
  };
  simulation: {
    status: 'success' | 'revert' | 'not-run';
    gasEstimate?: string;
    revertReason?: string;
  };
  policy: {
    risk: 'low' | 'medium' | 'high' | 'critical';
    requiresConfirmation: true;
    confirmationPhrase: string;
    checks: PolicyCheck[];
  };
};

function warningFromString(message: string): ToolWarning {
  const lower = message.toLowerCase();
  const category: ToolWarning['category'] = lower.includes('collateral') || lower.includes('penalt') || lower.includes('unlimited') || lower.includes('secret')
    ? 'security'
    : lower.includes('subgraph') || lower.includes('rpc') || lower.includes('stale') || lower.includes('unhealthy')
      ? 'degraded-service'
      : lower.includes('policy') || lower.includes('simulation') || lower.includes('approval')
        ? 'policy'
        : 'operator-guidance';
  const severity: ToolWarning['severity'] = lower.includes('critical') || lower.includes('collateral') || lower.includes('unlimited') ? 'critical' : 'warning';
  return { category, severity, message };
}

export function ok<T>(data: T, warnings: string[] = []): OneHiveToolResult<T> {
  return { ok: true, data, warnings, warningDetails: warnings.map(warningFromString) };
}

export function fail<T = never>(code: string, message: string, details?: unknown, retryable = false): OneHiveToolResult<T> {
  return {
    ok: false,
    warnings: [],
    warningDetails: [],
    error: { code, message, retryable, details }
  };
}

export function notImplemented<T = never>(feature: string): OneHiveToolResult<T> {
  return fail('not_implemented', `${feature} is scaffolded but not implemented yet. Follow GOAL.md milestones.`, undefined, false);
}

export const addressPattern = '^0x[a-fA-F0-9]{40}$';
export const uintStringPattern = '^[0-9]+(\\.[0-9]+)?$';
