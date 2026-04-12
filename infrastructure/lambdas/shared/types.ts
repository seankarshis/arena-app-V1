export interface AgentRequest {
  agent: string;
  files: Record<string, string>;
  blastRadius: string[];
  previousReports: AgentReport[];
  additionalContext?: Record<string, unknown>;
}

export interface AgentReport {
  agent: string;
  status: 'pass' | 'fail' | 'warn';
  timestamp: string;
  filesAnalyzed: string[];
  filesModified: string[];
  findings: Finding[];
  summary: string;
  commitSha?: string;
  tokenUsage: {
    inputTokens: number;
    outputTokens: number;
  };
}

export interface Finding {
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  file: string;
  line?: number;
  message: string;
  fixed: boolean;
  fixDescription?: string;
}

export interface AgentResponse {
  report: AgentReport;
  fixedFiles: Record<string, string>;
}
