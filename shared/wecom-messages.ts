/** 通用消息管理独立于接口反馈；复用机器人配置，草稿、模板和发送回执保存在本机。 */
export type WecomMessageType = 'text' | 'markdown_v2';
export interface WecomMessageInput {
  title: string;
  msgtype: WecomMessageType;
  content: string;
}
export interface WecomMessagePreview {
  input: WecomMessageInput;
  previewId: string;
  groupName: string;
  content: string;
  bytes: number;
  limit: number;
  canSend: boolean;
  hash: string;
}
export interface WecomMessageRecord {
  id: string;
  fingerprint: string;
  preview: WecomMessagePreview;
  status: 'sending' | 'sent' | 'failed' | 'unknown';
  attemptedAt: string;
  finishedAt: string;
  message: string;
}
export interface WecomMessageSaved extends WecomMessageInput {
  id: string;
  kind: 'draft' | 'template';
  updatedAt: string;
}
export interface WecomMessageSendInput {
  input: WecomMessageInput;
  previewId: string;
  hash: string;
}
export const wecomMessageLimits = { text: 2048, markdown_v2: 4096 } as const;
