/** 写入权可能只由空闲客户端持有，不能把 active writer 等同于任务正在执行。 */
export const codexWriterHeldMessage = 'Codex 原会话的写入权被其他客户端持有，未必有任务运行；请重试续接，或在原客户端继续';
export const codexRunningMessage = 'Codex 原会话确有任务正在执行，本次未启动；请等待完成后重试';
const previousWriterMessage = 'Codex 原会话已有正在执行的任务，请等待其完成或结束后重新执行';

export function codexWriterThreadId(message: string) {
  return message.match(/^thread ([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}) already has an active writer$/i)?.[1];
}

export function codexSessionErrorText(message: string) {
  return codexWriterThreadId(message) || message === previousWriterMessage ? codexWriterHeldMessage : message;
}
