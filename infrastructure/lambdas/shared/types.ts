export interface AgentRequest {
  agent: string;
  files: Record<string, string>;           // filepath → file contents
  blast_radius: string[];                   // list of all files in scope
  previous_reports: AgentReport[];          // reports from agents that ran before this one
  additional_context?: Record<string, any>; // e.g., Bearer report for security agent
}

export interface AgentReport {
  agent: string;
  status: 'pass' | 'fail' | 'warn';
  timestamp: string;
  files_analyzed: string[];
  files_modified: string[];
  findings: Finding[];
  summary: string;
  commit_sha?: string;
  token_usage: {
    input_tokens: number;
    output_tokens: number;
  };
}

export interface Finding {
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  file: string;
  line?: number;
  message: string;
  fixed: boolean;
  fix_description?: string;
}

export interface AgentResponse {
  report: AgentReport;
  fixed_files: Record<string, string>; // filepath → updated file contents
}
