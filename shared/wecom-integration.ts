/** 联调反馈与审核状态独立；群消息只发脱敏摘要，完整反馈保留在本机，机器人回执不代表已读或修复。 */
export interface WecomPublicConfig {
  hasWebhook: boolean;
  groupName: string;
}

export interface BackendFeedbackInput {
  interfaceId: string;
  summary: string;
  environment: string;
  parameters: string;
  actual: string;
  expected: string;
  contractReference: string;
  traceId: string;
}

export interface BackendFeedbackPreview {
  input: BackendFeedbackInput;
  request: string;
  groupName: string;
  content: string;
  bytes: number;
  truncated: boolean;
  canSend: boolean;
  hash: string;
}

export interface BackendFeedbackRecord {
  id: string;
  fingerprint: string;
  preview: BackendFeedbackPreview;
  status: 'sending' | 'sent' | 'failed' | 'unknown';
  attemptedAt: string;
  finishedAt: string;
  message: string;
}

export const feedbackStatusLabels = { sending: '发送中', sent: '机器人已接收', failed: '发送失败', unknown: '发送结果待确认' } as const;
